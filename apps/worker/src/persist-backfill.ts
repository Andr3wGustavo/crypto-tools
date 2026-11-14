import fs from 'node:fs';
import path from 'node:path';
import { disconnectPrisma, prisma, type PrismaClient } from '@cortex/db';
import type { StrategyConfig } from '@cortex/core';
import { ShadowEngine, type InputRecord } from './engine/shadow-engine';
import { metaToOptions, type ReplayMeta } from './engine/run-meta';
import { LiveEngine, liveConfigHash, type LiveEngineOptions, type LiveInputRecord, type LiveTreasuryOptions } from './live/live-engine';
import { listRecordings, readNdjsonLines } from './recorder/ndjson';
import { LedgerTap, PostgresSink, type SinkContext } from './sinks/postgres-sink';

interface LiveMeta {
  mode: 'live';
  botId: string;
  info: { symbol: string; base: string; quote: string };
  config: StrategyConfig;
  capitalQuote: number;
  treasury?: LiveTreasuryOptions;
  configHash: string;
}
type ShadowMeta = ReplayMeta & { mode?: 'shadow'; botId?: string; info: ReplayMeta['info'] & { symbol: string } };

export interface BackfillResult {
  run: string;
  records: number;
  written: number;
  persistedSeq: number;
}

/**
 * Rebuilds a run's Postgres rows from its recording: genesis replay of every record, every output
 * re-sent. Rows are keyed, so whatever is already in the database stays as it is and only what is
 * missing is added (an outage longer than the worker's queue, a run started while Postgres was
 * down, or a restored database). Safe while the worker runs: both write the same keyed rows.
 */
export async function backfillRun(dir: string, db: PrismaClient = prisma, log: (o: Record<string, unknown>) => void = () => undefined): Promise<BackfillResult> {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as LiveMeta | ShadowMeta;
  const run = path.basename(path.resolve(dir));
  let engine: ShadowEngine | LiveEngine;
  let step: (r: unknown) => ReturnType<LiveEngine['process']>;
  let config: StrategyConfig;
  let ctx: SinkContext;
  if (meta.mode === 'live') {
    if (!meta.treasury) throw new Error('live meta.json without `treasury` (written before persistence existed): cannot rebuild the engine options');
    const o: LiveEngineOptions = { config: meta.config, capitalQuote: meta.capitalQuote, treasury: meta.treasury };
    const hash = liveConfigHash(o);
    if (hash !== meta.configHash) throw new Error(`meta.json configHash ${meta.configHash.slice(0, 12)} ≠ engine ${hash.slice(0, 12)} (engine version or config changed)`);
    const live = new LiveEngine(o);
    engine = live;
    step = (r) => live.process(r as LiveInputRecord);
    config = o.config;
    ctx = { botId: meta.botId, run, mode: 'live', venue: 'mexc', symbol: meta.info.symbol, base: meta.info.base, quote: meta.info.quote };
  } else {
    const o = metaToOptions(meta);
    const shadow = new ShadowEngine(o);
    engine = shadow;
    step = (r) => shadow.process(r as InputRecord);
    config = o.config;
    ctx = { botId: meta.botId ?? o.config.botId, run, mode: 'shadow', venue: 'mexc', symbol: meta.info.symbol, base: o.config.base, quote: o.config.quote };
  }

  const sink = new PostgresSink(ctx, { error: (o: object, msg: string) => log({ level: 'error', msg, ...o }) }, db);
  const before = await sink.init(config);
  sink.persistedSeq = 0; // re-send everything: the cursor may sit above a hole
  const tap = new LedgerTap(engine);
  let records = 0;
  let written = 0;
  for await (const l of readNdjsonLines(listRecordings(dir))) {
    const outs = step(JSON.parse(l.text));
    const item = tap.item(outs);
    if (item.outs.length > 0 || item.txs.length > 0) written++;
    sink.push(item);
    records++;
    if (sink.backlog >= 5_000 && !(await sink.drain())) throw new Error('Postgres write failed (see the log); nothing is lost, run the backfill again');
    if (records % 200_000 === 0) log({ msg: 'backfill progress', records });
  }
  if (!(await sink.close())) throw new Error('Postgres write failed (see the log); nothing is lost, run the backfill again');
  const cur = await db.persistCursor.findUnique({ where: { botId_run: { botId: ctx.botId, run } } });
  log({ msg: 'backfill done', run, records, items: written, cursorBefore: before, cursor: cur ? Number(cur.seq) : 0 });
  return { run, records, written, persistedSeq: cur ? Number(cur.seq) : 0 };
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(path.join(dir, 'meta.json'))) {
    console.error('usage: persist-backfill <run dir containing meta.json, e.g. /data/market/mexc-SOLUSDT/cfg-…>  (DATABASE_URL = that mode\'s database)');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (farm_shadow for cfg-… runs, farm_live for live-… runs)');
    process.exit(2);
  }
  const r = await backfillRun(dir, prisma, (o) => console.log(JSON.stringify(o)));
  console.log(`BACKFILL OK ${r.run}: ${r.records} records replayed, cursor ${r.persistedSeq}`);
  await disconnectPrisma();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('Fatal:', (err as Error).message);
    await disconnectPrisma().catch(() => undefined);
    process.exit(1);
  });
}
