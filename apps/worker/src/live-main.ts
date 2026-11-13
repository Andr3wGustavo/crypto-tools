import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import 'dotenv/config';
import { BinanceMarketStream, MexcMarketStream, MexcRest, MexcUserStream } from '@cortex/exchange';
import Redis from 'ioredis';
import { z } from 'zod';
import type { EvaluationReport } from './evaluate';
import { LIVE_STATE_VERSION, LiveEngine, liveConfigHash, type LiveEngineOptions, type LiveInputRecord, type LiveOutput } from './live/live-engine';
import { checkLiveGate } from './live/live-gate';
import { LiveSession } from './live/live-session';
import { createLogger } from './logger';
import { BotViewBuilder, toWireEvents } from './ops/bot-view';
import { CommandSource } from './ops/command-source';
import { heartbeatFile, writeHeartbeat } from './ops/heartbeat';
import { IoRedisStreamClient } from './ops/redis-stream-client';
import { NdjsonRecorder } from './recorder/ndjson';
import { IoRedisLive, RedisSink } from './sinks/redis-sink';
import { SnapshotStore, bootAny } from './state/boot';
import { shadowStrategyConfig } from './strategy-config';
import {
  WITHDRAW_EVT_STREAM, WITHDRAW_REQ_STREAM, WITHDRAW_STREAM_MAX, WithdrawReportMsgSchema, decodeMessage, encodeMessage, validChannelSecret,
  type WithdrawRequestMsg,
} from './withdraw/channel';
import { StreamTail, appendCapped } from './withdraw/stream-tail';
import { WITHDRAW_DAILY_CAP_CEILING, WITHDRAW_MIN_FLOOR } from './withdraw/withdraw-gate';

const env = z.object({
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LIVE_REPORT_FILE: z.string().min(1),
  BOT_REFERENCE_SYMBOL: z.string().regex(/^[A-Z0-9]{4,20}$/).optional(),
  LIVE_DATA_DIR: z.string().default('./data/live'),
  LIVE_PAPER_OFFSET_BPS: z.coerce.number().min(0).max(5_000).default(0),
  REDIS_URL: z.string().optional(),
  /** Treasury withdrawals (E9): plan floor US$20, daily cap ≤ 1000. Part of the configuration. */
  LIVE_WITHDRAW_MIN: z.coerce.number().min(WITHDRAW_MIN_FLOOR).default(WITHDRAW_MIN_FLOOR),
  LIVE_WITHDRAW_DAILY_CAP: z.coerce.number().min(WITHDRAW_MIN_FLOOR).max(WITHDRAW_DAILY_CAP_CEILING).default(100),
  /** Shared with the withdrawer only. Absent ⇒ no withdrawal channel (the treasury just accumulates). */
  WITHDRAW_CHANNEL_SECRET: z.string().optional(),
});

/**
 * Cortex Farm worker — LIVE mode (phase E8). Same strategy as the GO'd shadow, real MEXC orders.
 * Refuses to start unless the live gate opens (official GO report, LIVE_ACK, capital cap, key
 * attestation). Every input — market data, exchange answers, stream state, syncs, commands — is
 * recorded, so a live session replays exactly like a shadow one.
 *
 *   data: <LIVE_DATA_DIR>/mexc-<SYMBOL>/live-<configHash12>/{meta.json, <date>/*.gz, state/}
 */
async function main(): Promise<void> {
  const e = env.parse(process.env);
  const log = createLogger(e.LOG_LEVEL);
  const version = process.env.APP_VERSION ?? 'dev';
  const startedAt = Date.now();

  // ---- the gate (nothing touches the exchange's order endpoints before it opens)
  const report = readReport(e.LIVE_REPORT_FILE);
  const rest = new MexcRest({ apiKey: process.env.MEXC_API_KEY, apiSecret: process.env.MEXC_API_SECRET, recvWindow: 5_000 });
  const time = await rest.syncTime();
  if (Math.abs(time.offsetMs) > 1_000) log.warn(time, 'clock offset vs MEXC above 1 s: signed requests compensate, the engine holds while health reports it');
  const account = await rest.account().catch((err: Error) => {
    log.error({ err: err.message }, 'MEXC account not readable with these keys');
    return undefined;
  });
  const gate = checkLiveGate(process.env, report, account);
  const info = await rest.symbolInfo(gate.symbol);
  if (!info.tradable) throw new Error(`${info.symbol} is not tradable on MEXC`);

  const botId = `mexc:${info.symbol}:live`;
  const engineOpts: LiveEngineOptions = {
    config: shadowStrategyConfig(botId, info, gate.capitalQuote), capitalQuote: gate.capitalQuote,
    // Always on: without a running withdrawer a request just waits, then is aborted as stale.
    treasury: { withdraw: { minAmount: e.LIVE_WITHDRAW_MIN, dailyCap: Math.max(e.LIVE_WITHDRAW_MIN, e.LIVE_WITHDRAW_DAILY_CAP) } },
  };
  const hash = liveConfigHash(engineOpts);
  const runId = `live-${hash.slice(0, 12)}`;
  const runParent = path.join(e.LIVE_DATA_DIR, `mexc-${info.symbol}`);
  const root = path.join(runParent, runId);
  fs.mkdirSync(root, { recursive: true });
  const metaPath = path.join(root, 'meta.json');
  if (!fs.existsSync(metaPath)) {
    fs.writeFileSync(metaPath, JSON.stringify({ botId, mode: 'live', info, config: engineOpts.config, capitalQuote: gate.capitalQuote, configHash: hash, ack: gate.ack, report: report?.protocolHash, createdAt: new Date().toISOString() }, null, 2));
  }
  log.warn({ symbol: info.symbol, capital: gate.capitalQuote, run: runId, ack: gate.ack, paperOffsetBps: e.LIVE_PAPER_OFFSET_BPS, version }, e.LIVE_PAPER_OFFSET_BPS > 0
    ? 'Cortex Farm LIVE starting in PAPER mode (real orders, priced far from the market)'
    : 'Cortex Farm LIVE starting: REAL ORDERS');

  // ---- boot: newest valid snapshot + tail, else genesis replay of the live recording
  const store = new SnapshotStore(path.join(root, 'state'));
  const boot = await bootAny<LiveEngine, LiveInputRecord>({
    configHash: hash, stateVersion: LIVE_STATE_VERSION, create: () => new LiveEngine(engineOpts), restore: (s) => LiveEngine.restore(engineOpts, s),
  }, root, store);
  const engine = boot.engine;
  log.info({ from: boot.from, snapshot: boot.snapshot, replayed: boot.replayed, rejected: boot.rejected, fills: engine.fillCount, opened: engine.isOpened }, 'live engine booted');
  const recorder = new NdjsonRecorder(runParent, runId);

  // ---- withdrawal channel (E9): signed requests out, signed reports in (see withdraw/channel.ts)
  const channelSecret = e.WITHDRAW_CHANNEL_SECRET;
  let wdWriter: Redis | undefined;
  let wdReader: Redis | undefined;
  if (e.REDIS_URL && validChannelSecret(channelSecret)) {
    wdWriter = new Redis(e.REDIS_URL, { maxRetriesPerRequest: 3 });
    wdReader = new Redis(e.REDIS_URL, { maxRetriesPerRequest: null });
    for (const c of [wdWriter, wdReader]) c.on('error', () => undefined);
  } else {
    log.warn('no withdrawal channel (REDIS_URL + WITHDRAW_CHANNEL_SECRET): profit accumulates in the treasury, nothing is withdrawn');
  }
  const publishWithdraw = (outs: LiveOutput[]) => {
    for (const o of outs) {
      if (o.kind !== 'withdraw_request' || !wdWriter) continue;
      const msg: WithdrawRequestMsg = { v: 1, botId, id: o.id, asset: o.asset, amount: o.amount, createdTs: o.createdTs, sentTs: Date.now(), mode: o.mode };
      appendCapped(wdWriter, WITHDRAW_REQ_STREAM, WITHDRAW_STREAM_MAX, encodeMessage(msg, channelSecret!))
        .catch((err: Error) => log.warn({ err: err.message, id: o.id }, 'withdraw request not published (the engine re-asks)'));
    }
  };

  // ---- sinks: dashboard view (Redis) + logs
  // The treasury wallet is shown on the dashboard only (this process never sends money).
  const wallet = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(process.env.WITHDRAW_ADDRESS ?? '') ? process.env.WITHDRAW_ADDRESS! : null;
  const viewer = new BotViewBuilder({ botId, mode: 'live', symbol: info.symbol, base: info.base, quote: info.quote, run: runId, version, startedAt, treasuryWallet: wallet });
  let redisConn: IoRedisLive | undefined;
  let redis: RedisSink | undefined;
  if (e.REDIS_URL) {
    const conn = new IoRedisLive(e.REDIS_URL, log);
    try {
      await conn.connect();
      redis = new RedisSink(conn, botId, log);
      await redis.init();
      redisConn = conn;
    } catch (err) {
      await conn.close();
      log.warn({ err: (err as Error).message }, 'Redis unavailable: no dashboard / alerts for this run');
    }
  }
  const errorTimes: number[] = [];
  const noteError = () => errorTimes.push(Date.now());
  const notable = (outs: LiveOutput[]) => {
    for (const o of outs) {
      if (o.kind === 'exec_fill') log.warn({ fill: o.event }, 'LIVE fill');
      else if (o.kind === 'exec_warning') { noteError(); log.error({ msg: o.message }, 'live exec warning'); }
      else if (o.kind === 'sync' && !o.ok) log.warn({ sync: o }, 'live sync not ok');
      else if (o.kind === 'request') log.info({ request: o }, 'live request');
      else if (o.kind === 'treasury') log.warn({ treasury: o }, 'profit moved to the treasury');
      else if (o.kind === 'withdrawal') log.warn({ withdrawal: o.w }, `treasury withdrawal ${o.w.status}`);
      else if (o.kind === 'reconcile') log.error({ reconcile: o }, 'ledger/exchange divergence — halted');
      else if (o.kind === 'action' && (o.action.kind === 'status' || o.action.kind === 'error')) {
        if (o.action.kind === 'error') noteError();
        log.warn({ action: o.action }, 'strategy');
      }
    }
  };

  let stopping = false; // inputs closed
  let shuttingDown = false; // shutdown started (guards re-entry, e.g. a fatal during the drain)
  // Created below; referenced lazily by the session's output hook.
  let mexc: MexcMarketStream | undefined;
  let binance: BinanceMarketStream | undefined;
  const session = new LiveSession({
    engine, rest, symbol: info.symbol,
    record: (r) => recorder.write(r),
    onOutputs: (r, outs) => {
      viewer.observe(r, outs);
      redis?.push(toWireEvents(outs), r.ts, () => viewer.view(engine, { mexcAgeMs: mexc?.lastMessageAgeMs() ?? null, binanceAgeMs: binance?.lastMessageAgeMs() ?? null }), (v) => viewer.point(v));
      notable(outs);
      publishWithdraw(outs);
    },
    onFatal: (err) => {
      log.fatal({ err }, 'live trading loop failed — fail-closed shutdown');
      void shutdown('fatal', 1);
    },
    log: (o) => log.info(o, String(o.msg ?? 'live')),
    ...(e.LIVE_PAPER_OFFSET_BPS > 0 ? { paper: { offsetBps: e.LIVE_PAPER_OFFSET_BPS, tickSize: info.rules.tickSize } } : {}),
  });

  // A restart is an input: the engine holds until the user stream is up and a fresh sync lands.
  session.input({ t: 'stream', ts: Date.now(), up: false, reason: 'restart' });
  await session.boot(); // cancel-all must be confirmed, or we never start

  const handle = (r: LiveInputRecord) => {
    if (!stopping) session.input(r);
  };
  mexc = new MexcMarketStream([info.symbol], {
    onBook: (b) => handle({ t: 'book', venue: 'local', ts: b.ts, bid: b.bid, bidQty: b.bidQty, ask: b.ask, askQty: b.askQty }),
    onTrade: (t) => handle({ t: 'trade', ts: t.ts, price: t.price, qty: t.qty, aggressor: t.aggressor }),
    onStatus: (s) => (s.state === 'error' || s.state === 'stale' ? (noteError(), log.warn(s, 'mexc stream')) : log.info(s, 'mexc stream')),
  });
  binance = new BinanceMarketStream([e.BOT_REFERENCE_SYMBOL ?? info.symbol], {
    onBook: (b) => handle({ t: 'book', venue: 'reference', ts: b.ts, bid: b.bid, bidQty: b.bidQty, ask: b.ask, askQty: b.askQty }),
    onStatus: (s) => log.info(s, 'binance stream'),
  });
  const user = new MexcUserStream({
    onExec: (evs) => { if (!stopping) session.stream.onExec(evs); },
    onState: (s) => { log.warn(s, 'user stream'); if (!stopping) session.stream.onState(s); },
    onLog: (o) => log.info(o, 'user stream'),
  }, { rest });
  mexc.start();
  binance.start();
  user.start();

  let commandConn: Redis | undefined;
  let commands: CommandSource | undefined;
  if (e.REDIS_URL) {
    commandConn = new Redis(e.REDIS_URL, { maxRetriesPerRequest: 1 });
    commandConn.on('error', () => undefined);
    commands = new CommandSource({ botId, client: new IoRedisStreamClient(commandConn), log, onError: noteError, apply: (c) => handle({ t: 'command', ts: Date.now(), command: c.command }) });
    commands.start();
  }

  // Withdrawer reports → recorded engine inputs.
  let wdReading = !!wdReader;
  const readReports = async () => {
    const tail = new StreamTail(wdReader!, WITHDRAW_EVT_STREAM);
    while (wdReading) {
      try {
        for (const entry of await tail.next(5_000)) {
          const d = decodeMessage(entry.fields, WithdrawReportMsgSchema, channelSecret!);
          if (!d.ok || d.msg.botId !== botId) {
            if (!d.ok) { noteError(); log.error({ entry: entry.id, reason: d.reason }, 'withdraw report refused (not authenticated / invalid)'); }
            continue;
          }
          const { v: _v, botId: _b, sentTs: _s, ...rep } = d.msg;
          handle({ t: 'withdraw', ts: Date.now(), ...rep });
        }
      } catch (err) {
        if (!wdReading) break;
        log.warn({ err: (err as Error).message }, 'withdraw report stream read failed; retrying');
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  };
  if (wdReader) void readReports();

  let clockSkewMs = time.offsetMs;
  const clock = setInterval(() => handle({ t: 'clock', ts: Date.now() }), 1_000);
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const health = setInterval(() => {
    const now = Date.now();
    while (errorTimes.length > 0 && errorTimes[0]! < now - 60_000) errorTimes.shift();
    handle({ t: 'health', ts: now, errorsLastMin: errorTimes.length, eventLoopLagMs: Math.round(lag.percentile(99) / 1e6), clockSkewMs });
    lag.reset();
  }, 5_000);
  const resync = setInterval(() => {
    rest.syncTime().then((s) => (clockSkewMs = s.offsetMs), (err: Error) => { noteError(); log.warn({ err: err.message }, 'MEXC clock re-sync failed'); });
  }, 10 * 60_000);
  const saveSnapshot = () => {
    const cursor = recorder.position();
    if (cursor) store.save({ engine: engine.snapshot(), cursor, writtenAt: new Date().toISOString() });
  };
  const snapshots = setInterval(() => {
    try { saveSnapshot(); } catch (err) { noteError(); log.error({ err }, 'snapshot failed'); }
  }, 60_000);
  const hb = heartbeatFile(process.env.HEARTBEAT_DIR ?? path.join(e.LIVE_DATA_DIR, '..', 'health'), `${info.symbol}-live`);
  const heartbeat = setInterval(() => {
    try {
      const s = engine.strategy.snapshot();
      writeHeartbeat(hb, { symbol: info.symbol, run: runId, version, pid: process.pid, startedAt, ts: Date.now(), records: engine.recordCount, fills: engine.fillCount, status: s.status, mexcAgeMs: mexc?.lastMessageAgeMs() ?? null, binanceAgeMs: binance?.lastMessageAgeMs() ?? null, equity: s.equity ?? null });
    } catch (err) {
      noteError();
      log.warn({ err: (err as Error).message }, 'heartbeat write failed');
    }
  }, 10_000);

  /**
   * Drain (live): stop quoting and cancel everything while the exchange connections are still up,
   * wait for the answers (bounded), then stop inputs, close the recording and snapshot the state
   * that exactly matches it. A hard kill skips this: the next boot cancels all before anything.
   */
  async function shutdown(reason: string, code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn({ reason }, 'live shutting down: canceling all orders');
    setTimeout(() => process.exit(code || 1), 25_000).unref();
    await Promise.race([session.shutdown(), new Promise((r) => setTimeout(r, 15_000))]).catch((err: unknown) => log.error({ err }, 'live drain failed'));
    stopping = true;
    for (const t of [clock, health, resync, snapshots, heartbeat]) clearInterval(t);
    mexc?.stop();
    binance?.stop();
    await user.stop();
    const stopCommands = commands?.stop();
    commandConn?.disconnect();
    wdReading = false;
    wdReader?.disconnect();
    wdWriter?.disconnect();
    await stopCommands;
    await recorder.close();
    try { saveSnapshot(); } catch (err) { log.error({ err }, 'final snapshot failed (next boot replays from the previous one)'); }
    const s = engine.strategy.snapshot();
    log.warn({ run: runId, records: engine.recordCount, fills: engine.fillCount, startEquity: s.startEquity, endEquity: s.equity, hold: engine.venueHold }, 'live session summary');
    await redis?.flush();
    await redisConn?.close();
    process.exit(code);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => { log.fatal({ err }, 'unhandledRejection — fail-closed'); void shutdown('unhandledRejection', 1); });
  process.on('uncaughtException', (err) => { log.fatal({ err }, 'uncaughtException — fail-closed'); void shutdown('uncaughtException', 1); });
}

function readReport(file: string): EvaluationReport | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as EvaluationReport;
  } catch {
    return undefined;
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
