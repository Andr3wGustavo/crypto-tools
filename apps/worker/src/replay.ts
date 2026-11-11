import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { StrategyConfig } from '@cortex/core';
import { ShadowEngine, stateDigest, type EngineOutput } from './engine/shadow-engine';
import { listRecordings, readNdjsonGz } from './recorder/ndjson';

/**
 * Deterministic replay of a recorded shadow session.
 *   npx tsx apps/worker/src/replay.ts data/market/mexc-SOLUSDT/cfg-<hash12>
 * Prints a summary and a SHA-256 of every engine output: two replays of the same recording
 * (or a replay vs the live run) must print the same hash.
 */
export interface ReplaySummary {
  records: number;
  outputs: number;
  fills: number;
  places: number;
  cancels: number;
  startEquity: number | undefined;
  endEquity: number | undefined;
  pnl: number;
  edgeWindows: number;
  outputHash: string;
  /** Digest of the final engine state: equals the live worker's `stateDigest` for the same records. */
  stateDigest: string;
}

export interface ReplayMeta {
  config: StrategyConfig;
  startQuote: number;
  latencyMs: number;
  info: { makerFeeRate: number };
  timerMs?: number;
  edgeWindowMs?: number;
  /** Written by the worker since E3; checked when present. */
  configHash?: string;
}

export async function replay(files: string[], meta: ReplayMeta): Promise<ReplaySummary> {
  const engine = new ShadowEngine({
    config: meta.config, startQuote: meta.startQuote, latencyMs: meta.latencyMs, makerFeeRate: meta.info.makerFeeRate,
    ...(meta.timerMs !== undefined ? { timerMs: meta.timerMs } : {}),
    ...(meta.edgeWindowMs !== undefined ? { edgeWindowMs: meta.edgeWindowMs } : {}),
  });
  if (meta.configHash && meta.configHash !== engine.configHash) {
    throw new Error(`meta.json configHash ${meta.configHash.slice(0, 12)} ≠ engine ${engine.configHash.slice(0, 12)} (engine version or config changed)`);
  }
  const hash = crypto.createHash('sha256');
  let records = 0;
  let outputs = 0;
  let places = 0;
  let cancels = 0;
  let edgeWindows = 0;
  const count = (o: EngineOutput) => {
    outputs++;
    hash.update(JSON.stringify(o));
    if (o.kind === 'action' && o.action.kind === 'place') places++;
    if (o.kind === 'action' && o.action.kind === 'cancel') cancels++;
    if (o.kind === 'edge') edgeWindows++;
  };
  for await (const r of readNdjsonGz(files, (f, d) => console.warn(`[replay] ${f}: ${d}`))) {
    records++;
    engine.process(r).forEach(count);
  }
  const s = engine.strategy.snapshot();
  return {
    records, outputs, fills: engine.fillCount, places, cancels,
    startEquity: s.startEquity, endEquity: s.equity,
    pnl: s.equity !== undefined && s.startEquity !== undefined ? s.equity - s.startEquity : 0,
    edgeWindows, outputHash: hash.digest('hex'), stateDigest: stateDigest(engine.snapshot()),
  };
}

async function cli(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: tsx apps/worker/src/replay.ts <run dir containing meta.json, e.g. data/market/mexc-SOLUSDT/cfg-…>');
    process.exit(2);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const files = listRecordings(dir);
  if (files.length === 0) throw new Error(`no recordings under ${dir}`);
  const summary = await replay(files, meta);
  console.log(JSON.stringify({ files: files.length, ...summary }, null, 2));
}

if (require.main === module) {
  cli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
