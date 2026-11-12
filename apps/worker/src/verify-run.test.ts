import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShadowEngine } from './engine/shadow-engine';
import { NdjsonRecorder } from './recorder/ndjson';
import { SnapshotStore } from './state/boot';
import { syntheticInputs, testEngineOptions as opts } from './testing/synthetic-inputs';
import { verifyRun } from './verify-run';

/** A run directory as the worker leaves it: meta.json, recordings, periodic snapshots. */
async function makeRun(records: number, every: number) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-vr-'));
  const dir = path.join(parent, 'cfg-test');
  const engine = new ShadowEngine(opts);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { config: opts.config, startQuote: opts.startQuote, latencyMs: opts.latencyMs, info: { makerFeeRate: opts.makerFeeRate }, edgeWindowMs: opts.edgeWindowMs, configHash: engine.configHash };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  const store = new SnapshotStore(path.join(dir, 'state'));
  const rec = new NdjsonRecorder(parent, 'cfg-test', { segment: 1 });
  syntheticInputs(6, 4).slice(0, records).forEach((r, i) => {
    rec.write(r);
    engine.process(r);
    if ((i + 1) % every === 0) store.save({ engine: engine.snapshot(), cursor: rec.position(), writtenAt: '' });
  });
  await rec.close();
  return { dir, store };
}

describe('verify-run (backup restore test)', () => {
  it('a consistent run: snapshot + tail = genesis, and the run directory is not modified', async () => {
    const { dir, store } = await makeRun(2_500, 1_000);
    const before = store.list();
    const r = await verifyRun(dir);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.from).toBe('snapshot');
    expect(r.records).toBe(2_500);
    expect(r.replayedFromSnapshot).toBe(500);
    expect(r.snapshotDigest).toBe(r.genesisDigest);
    expect(store.list()).toEqual(before);
    expect(fs.existsSync(path.join(store.dir, 'rejected'))).toBe(false);
  });

  it('snapshots that do not restore are caught', async () => {
    const { dir, store } = await makeRun(2_500, 1_000);
    for (const n of store.list()) {
      const s = store.load(n);
      s.engine.ledger = []; // drop the opening deposit: the ledger no longer balances against the state
      fs.writeFileSync(path.join(store.dir, n), JSON.stringify(s));
    }
    const r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('no snapshot is consistent with the recordings');
  });
});
