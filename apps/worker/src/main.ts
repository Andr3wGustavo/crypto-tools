import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { disconnectPrisma } from '@cortex/db';
import { BinanceMarketStream, MexcMarketStream, MexcRest } from '@cortex/exchange';
import { loadConfig } from './config';
import { engineConfigHash, stateDigest, type EngineOutput, type InputRecord, type ShadowEngineOptions } from './engine/shadow-engine';
import { createLogger } from './logger';
import { NdjsonRecorder } from './recorder/ndjson';
import { PostgresSink } from './sinks/postgres-sink';
import { RedisSink } from './sinks/redis-sink';
import { SnapshotStore, bootEngine } from './state/boot';
import { shadowStrategyConfig } from './strategy-config';

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' ? Number(v) : d);

/**
 * Cortex Farm worker — SHADOW mode.
 * Real public market data (MEXC execution venue + Binance reference) → deterministic strategy →
 * conservative simulated exchange. Every input (market data, clock, process health, commands) is
 * recorded, so the run can be replayed bit-for-bit and resumed exactly after a crash or restart.
 * No API keys are used and no orders are sent.
 *
 * Data layout: <MARKET_DATA_DIR>/mexc-<SYMBOL>/cfg-<configHash12>/
 *   meta.json            — the pre-registered experiment (config, symbol rules, simulator)
 *   <YYYY-MM-DD>/*.gz    — recorded inputs
 *   state/snap-*.json    — engine snapshots (boot restore = newest valid snapshot + tail replay)
 * A different configuration is a different experiment and gets its own directory.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  log.info({ mode: cfg.TRADING_MODE, symbol: cfg.BOT_SYMBOL, reference: cfg.BOT_REFERENCE_SYMBOL }, 'Cortex Farm worker starting (SHADOW: no orders are sent)');

  const rest = new MexcRest();
  let clockSkewMs = 0;
  const sync = await rest.syncTime();
  clockSkewMs = sync.offsetMs;
  log.info(sync, 'MEXC clock sync');
  const info = await rest.symbolInfo(cfg.BOT_SYMBOL);
  if (!info.tradable) throw new Error(`${info.symbol} is not tradable on MEXC`);
  log.info({ rules: info.rules, makerFeeRate: info.makerFeeRate, takerFeeRate: info.takerFeeRate }, 'MEXC symbol rules');

  const botId = `mexc:${info.symbol}:shadow`;
  const config = shadowStrategyConfig(botId, info, cfg.SHADOW_START_QUOTE);
  const engineOpts: ShadowEngineOptions = { config, startQuote: cfg.SHADOW_START_QUOTE, latencyMs: cfg.SHADOW_LATENCY_MS, makerFeeRate: info.makerFeeRate };
  const configHash = engineConfigHash(engineOpts);
  const runId = `cfg-${configHash.slice(0, 12)}`;
  const runParent = path.join(cfg.MARKET_DATA_DIR, `mexc-${info.symbol}`);
  const root = path.join(runParent, runId);
  fs.mkdirSync(root, { recursive: true });
  const metaPath = path.join(root, 'meta.json');
  if (!fs.existsSync(metaPath)) {
    const meta = { botId, info, config, startQuote: cfg.SHADOW_START_QUOTE, latencyMs: cfg.SHADOW_LATENCY_MS, configHash, createdAt: new Date().toISOString() };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  // ---- boot restore: newest valid snapshot + replay of everything recorded after it
  const store = new SnapshotStore(path.join(root, 'state'));
  const bootStart = Date.now();
  const boot = await bootEngine(engineOpts, root, store);
  const engine = boot.engine;
  const bootSnap = engine.snapshot();
  log.info({
    run: runId, from: boot.from, snapshot: boot.snapshot, replayed: boot.replayed, rejected: boot.rejected, truncated: boot.truncated,
    ms: Date.now() - bootStart, records: engine.recordCount, fills: engine.fillCount,
    status: engine.strategy.snapshot().status, equity: engine.strategy.snapshot().equity, stateDigest: stateDigest(bootSnap),
  }, boot.from === 'snapshot' || boot.replayed > 0 ? 'engine restored' : 'engine started fresh');

  // Created after boot: it starts a new segment that sorts after every existing file.
  const recorder = new NdjsonRecorder(runParent, runId);

  let pg: PostgresSink | undefined;
  if (cfg.PERSIST_ENABLED && cfg.DATABASE_URL) {
    const sink = new PostgresSink(
      botId, info.symbol, 'shadow',
      () => ({ ...engine.edge.state, prior: engine.edge.prior }),
      (id) => engine.ledger.transactions.find((t) => t.id === id),
      log,
    );
    try {
      await sink.init('mexc', info.symbol, config);
      pg = sink;
      log.info('Postgres persistence enabled');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Postgres unavailable — continuing with file recording only');
    }
  }
  let redis: RedisSink | undefined;
  if (cfg.REDIS_URL) {
    const sink = new RedisSink(cfg.REDIS_URL, botId, log);
    try {
      await sink.init();
      redis = sink;
      log.info('Redis real-time fan-out enabled');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Redis unavailable — continuing without real-time fan-out');
    }
  }

  // Errors in the last minute (data-feed errors/stalls, strategy errors) feed the risk manager.
  const errorTimes: number[] = [];
  const noteError = () => errorTimes.push(Date.now());

  const notable = (outs: EngineOutput[]) => {
    for (const o of outs) {
      if (o.kind === 'sim' && o.event.kind === 'fill') log.info({ fill: o.event }, 'shadow fill');
      else if (o.kind === 'action' && o.action.kind === 'error') {
        noteError();
        log.error({ action: o.action }, 'strategy error');
      } else if (o.kind === 'action' && o.action.kind === 'status') log.warn({ action: o.action }, 'strategy status');
      else if (o.kind === 'action' && o.action.kind === 'risk' && o.action.action !== 'reduce_only') log.warn({ risk: o.action }, 'risk');
      else if (o.kind === 'reconcile') log.error({ reconcile: o }, 'ledger/strategy divergence — halted');
      else if (o.kind === 'edge') log.info({ edge: o }, 'edge window closed');
    }
  };

  let stopping = false;
  let engineFailed = false;
  const outputHash = crypto.createHash('sha256');
  const handle = (r: InputRecord) => {
    if (stopping) return;
    recorder.write(r);
    let outs: EngineOutput[];
    try {
      outs = engine.process(r);
    } catch (err) {
      // Fail-closed: unknown error in the trading loop ⇒ stop. The partial state is never
      // snapshotted; the next boot resumes from the last good snapshot (and, the engine being
      // deterministic, will hit the same error on the same record: a loud crash loop, not trading).
      engineFailed = true;
      log.fatal({ err, record: r }, 'engine threw — fail-closed shutdown');
      void shutdown('engine_error', 1);
      return;
    }
    for (const o of outs) outputHash.update(JSON.stringify(o));
    pg?.push(outs);
    redis?.push(outs, () => engine.strategy.snapshot(), r.ts);
    notable(outs);
  };

  const onFeedStatus = (venue: string) => (s: { state: string; detail?: string }) => {
    if (s.state === 'error' || s.state === 'stale') {
      noteError();
      log.warn(s, `${venue} stream`);
    } else log.info(s, `${venue} stream`);
  };
  const mexc = new MexcMarketStream([info.symbol], {
    onBook: (b) => handle({ t: 'book', venue: 'local', ts: b.ts, bid: b.bid, bidQty: b.bidQty, ask: b.ask, askQty: b.askQty }),
    onTrade: (t) => handle({ t: 'trade', ts: t.ts, price: t.price, qty: t.qty, aggressor: t.aggressor }),
    onStatus: onFeedStatus('mexc'),
  });
  const binance = new BinanceMarketStream([cfg.BOT_REFERENCE_SYMBOL], {
    onBook: (b) => handle({ t: 'book', venue: 'reference', ts: b.ts, bid: b.bid, bidQty: b.bidQty, ask: b.ask, askQty: b.askQty }),
    onStatus: onFeedStatus('binance'),
  });
  mexc.start();
  binance.start();

  const clock = setInterval(() => handle({ t: 'clock', ts: Date.now() }), 1_000);

  // Process health is an input too (recorded → replayable): event-loop lag, error rate, clock skew.
  const healthLag = monitorEventLoopDelay({ resolution: 20 });
  healthLag.enable();
  const health = setInterval(() => {
    const now = Date.now();
    while (errorTimes.length > 0 && errorTimes[0]! < now - 60_000) errorTimes.shift();
    handle({ t: 'health', ts: now, errorsLastMin: errorTimes.length, eventLoopLagMs: Math.round(healthLag.percentile(99) / 1e6), clockSkewMs });
    healthLag.reset();
  }, num(process.env.HEALTH_EVERY_MS, 5_000));
  const resync = setInterval(() => {
    rest.syncTime().then(
      (s) => {
        clockSkewMs = s.offsetMs;
        log.debug(s, 'MEXC clock re-sync');
      },
      (err: Error) => {
        noteError();
        log.warn({ err: err.message }, 'MEXC clock re-sync failed');
      },
    );
  }, 10 * 60_000);

  const saveSnapshot = (): string | undefined => {
    const cursor = recorder.position();
    if (!cursor) return undefined; // nothing new recorded by this process: the boot snapshot still applies
    return store.save({ engine: engine.snapshot(), cursor, writtenAt: new Date().toISOString() });
  };
  const snapshots = setInterval(() => {
    try {
      saveSnapshot();
    } catch (err) {
      noteError();
      log.error({ err }, 'snapshot failed');
    }
  }, num(process.env.SNAPSHOT_EVERY_MS, 60_000));

  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const status = setInterval(() => {
    const s = engine.strategy.snapshot();
    const v = engine.edge.verdict();
    log.info({
      status: s.status, quoting: s.quoting, fair: Number(s.fair.toFixed(4)), equity: s.equity && Number(s.equity.toFixed(4)),
      pnl: s.equity && s.startEquity ? Number((s.equity - s.startEquity).toFixed(4)) : 0,
      inventory: s.baseTotal, sigmaBps: Number(s.sigmaBps.toFixed(3)), asBps: Number(s.adverseSelectionBps.toFixed(3)),
      fills: engine.fillCount, working: s.workingOrders.map((o) => `${o.side}@${o.priceStr}`),
      edge: { n: engine.edge.n, pGo: Number(v.pGo.toFixed(3)), verdict: v.verdict },
      records: engine.recordCount, recordedThisProcess: recorder.count, sinkErrors: (pg?.errors ?? 0) + (redis?.errors ?? 0),
      errorsLastMin: errorTimes.length, clockSkewMs,
      loopLagP99Ms: Number((loopDelay.percentile(99) / 1e6).toFixed(1)),
      dataAgeMs: { mexc: mexc.lastMessageAgeMs(), binance: binance.lastMessageAgeMs() },
    }, 'status');
    loopDelay.reset();
  }, num(process.env.STATUS_EVERY_MS, 30_000));

  /**
   * Drain (shadow): stop the inputs → flush and close the recording → final snapshot of the state
   * that exactly matches the recording → close sinks. (Live, E8, adds: cancel all and wait for the
   * acks before the snapshot.) A hard kill skips all of this; boot restore covers that case.
   */
  async function shutdown(reason: string, code = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(code || 1), 15_000).unref(); // never hang on a stuck sink
    log[code === 0 ? 'info' : 'error']({ reason }, 'shutting down');
    for (const t of [clock, health, resync, snapshots, status]) clearInterval(t);
    mexc.stop();
    binance.stop();
    await recorder.close();
    let digest: string | undefined;
    let snapshot: string | undefined;
    if (!engineFailed) {
      try {
        snapshot = saveSnapshot();
        digest = stateDigest(engine.snapshot());
      } catch (err) {
        log.error({ err }, 'final snapshot failed (next boot replays from the previous one)');
      }
    }
    const s = engine.strategy.snapshot();
    log.info({
      run: runId, records: engine.recordCount, recordedThisProcess: recorder.count, fills: engine.fillCount,
      startEquity: s.startEquity, endEquity: s.equity, snapshot, stateDigest: digest, outputHash: outputHash.digest('hex'),
    }, 'session summary (stateDigest must equal a full replay of the run)');
    await pg?.close();
    await redis?.close();
    await disconnectPrisma().catch(() => undefined);
    log.info('bye');
    process.exit(code);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Fail-closed on anything unexpected; boot restore makes a restart lossless.
  process.on('unhandledRejection', (err) => {
    log.fatal({ err }, 'unhandledRejection — shutting down (fail-closed)');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaughtException — shutting down (fail-closed)');
    void shutdown('uncaughtException', 1);
  });

  const runForMs = num(process.env.RUN_FOR_MS, 0);
  if (runForMs > 0) setTimeout(() => void shutdown('RUN_FOR_MS elapsed'), runForMs);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
