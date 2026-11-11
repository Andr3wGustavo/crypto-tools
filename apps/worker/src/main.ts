import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { disconnectPrisma } from '@cortex/db';
import { BinanceMarketStream, MexcMarketStream, MexcRest } from '@cortex/exchange';
import { loadConfig } from './config';
import { ShadowEngine, type EngineOutput, type InputRecord } from './engine/shadow-engine';
import { createLogger } from './logger';
import { NdjsonRecorder } from './recorder/ndjson';
import { PostgresSink } from './sinks/postgres-sink';
import { RedisSink } from './sinks/redis-sink';
import { shadowStrategyConfig } from './strategy-config';

/**
 * Cortex Farm worker — SHADOW mode.
 * Real public market data (MEXC execution venue + Binance reference) → deterministic strategy →
 * conservative simulated exchange. Every input is recorded for bit-exact replay.
 * No API keys are used and no orders are sent.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  log.info({ mode: cfg.TRADING_MODE, symbol: cfg.BOT_SYMBOL, reference: cfg.BOT_REFERENCE_SYMBOL }, 'Cortex Farm worker starting (SHADOW: no orders are sent)');

  const rest = new MexcRest();
  const sync = await rest.syncTime();
  log.info(sync, 'MEXC clock sync');
  const info = await rest.symbolInfo(cfg.BOT_SYMBOL);
  if (!info.tradable) throw new Error(`${info.symbol} is not tradable on MEXC`);
  log.info({ rules: info.rules, makerFeeRate: info.makerFeeRate, takerFeeRate: info.takerFeeRate }, 'MEXC symbol rules');

  const botId = `mexc:${info.symbol}:shadow`;
  const config = shadowStrategyConfig(botId, info, cfg.SHADOW_START_QUOTE);
  const engine = new ShadowEngine({ config, startQuote: cfg.SHADOW_START_QUOTE, latencyMs: cfg.SHADOW_LATENCY_MS, makerFeeRate: info.makerFeeRate });

  const botKey = `mexc-${info.symbol}`;
  const recorder = new NdjsonRecorder(cfg.MARKET_DATA_DIR, botKey);
  fs.mkdirSync(path.join(cfg.MARKET_DATA_DIR, botKey), { recursive: true });
  fs.writeFileSync(
    path.join(cfg.MARKET_DATA_DIR, botKey, 'meta.json'),
    JSON.stringify({ botId, info, config, startQuote: cfg.SHADOW_START_QUOTE, latencyMs: cfg.SHADOW_LATENCY_MS, writtenAt: new Date().toISOString() }, null, 2),
  );

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

  const notable = (outs: EngineOutput[]) => {
    for (const o of outs) {
      if (o.kind === 'sim' && o.event.kind === 'fill') log.info({ fill: o.event }, 'shadow fill');
      else if (o.kind === 'action' && (o.action.kind === 'status' || o.action.kind === 'error')) log.warn({ action: o.action }, 'strategy event');
      else if (o.kind === 'action' && o.action.kind === 'risk' && o.action.action !== 'reduce_only') log.warn({ risk: o.action }, 'risk');
      else if (o.kind === 'edge') log.info({ edge: o }, 'edge window closed');
    }
  };

  const outputHash = crypto.createHash('sha256');
  const handle = (r: InputRecord) => {
    recorder.write(r);
    const outs = engine.process(r);
    for (const o of outs) outputHash.update(JSON.stringify(o));
    pg?.push(outs);
    redis?.push(outs, () => engine.strategy.snapshot(), r.ts);
    notable(outs);
  };

  const mexc = new MexcMarketStream([info.symbol], {
    onBook: (b) => handle({ t: 'book', venue: 'local', ts: b.ts, bid: b.bid, bidQty: b.bidQty, ask: b.ask, askQty: b.askQty }),
    onTrade: (t) => handle({ t: 'trade', ts: t.ts, price: t.price, qty: t.qty, aggressor: t.aggressor }),
    onStatus: (s) => (s.state === 'error' || s.state === 'stale' ? log.warn(s, 'mexc stream') : log.info(s, 'mexc stream')),
  });
  const binance = new BinanceMarketStream([cfg.BOT_REFERENCE_SYMBOL], {
    onBook: (b) => handle({ t: 'book', venue: 'reference', ts: b.ts, bid: b.bid, bidQty: b.bidQty, ask: b.ask, askQty: b.askQty }),
    onStatus: (s) => (s.state === 'error' || s.state === 'stale' ? log.warn(s, 'binance stream') : log.info(s, 'binance stream')),
  });
  mexc.start();
  binance.start();

  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const clock = setInterval(() => handle({ t: 'clock', ts: Date.now() }), 1_000);
  const statusEveryMs = Number(process.env.STATUS_EVERY_MS ?? 30_000);
  const status = setInterval(() => {
    const s = engine.strategy.snapshot();
    const v = engine.edge.verdict();
    log.info({
      status: s.status, quoting: s.quoting, fair: Number(s.fair.toFixed(4)), equity: s.equity && Number(s.equity.toFixed(4)),
      pnl: s.equity && s.startEquity ? Number((s.equity - s.startEquity).toFixed(4)) : 0,
      inventory: s.baseTotal, sigmaBps: Number(s.sigmaBps.toFixed(3)), asBps: Number(s.adverseSelectionBps.toFixed(3)),
      fills: engine.fillCount, working: s.workingOrders.map((o) => `${o.side}@${o.priceStr}`),
      edge: { n: engine.edge.n, pGo: Number(v.pGo.toFixed(3)), verdict: v.verdict },
      recorded: recorder.count, sinkErrors: (pg?.errors ?? 0) + (redis?.errors ?? 0),
      loopLagP99Ms: Number((loopDelay.percentile(99) / 1e6).toFixed(1)),
      dataAgeMs: { mexc: mexc.lastMessageAgeMs(), binance: binance.lastMessageAgeMs() },
    }, 'status');
    loopDelay.reset();
  }, statusEveryMs);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    clearInterval(clock);
    clearInterval(status);
    mexc.stop();
    binance.stop();
    await recorder.close();
    const s = engine.strategy.snapshot();
    log.info({ records: recorder.count, fills: engine.fillCount, startEquity: s.startEquity, endEquity: s.equity, outputHash: outputHash.digest('hex') }, 'session summary (compare with replay)');
    await pg?.close();
    await redis?.close();
    await disconnectPrisma().catch(() => undefined);
    log.info('bye');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => {
    // Shadow: nothing is live on an exchange, but stop cleanly so the recording stays consistent.
    log.fatal({ err }, 'uncaughtException — shutting down (fail-closed)');
    void shutdown('uncaughtException');
  });

  const runForMs = Number(process.env.RUN_FOR_MS ?? 0);
  if (runForMs > 0) setTimeout(() => void shutdown('RUN_FOR_MS elapsed'), runForMs);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
