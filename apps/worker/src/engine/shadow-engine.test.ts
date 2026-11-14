import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NdjsonRecorder, listRecordings } from '../recorder/ndjson';
import { replay } from '../replay';
import { syntheticInputs as inputs, testConfig as config, testEngineOptions as opts } from '../testing/synthetic-inputs';
import { ShadowEngine, stateDigest, type EngineOutput, type EngineSnapshot, type InputRecord } from './shadow-engine';

function runHash(recs: InputRecord[], e = new ShadowEngine(opts)) {
  const h = crypto.createHash('sha256');
  for (const r of recs) for (const o of e.process(r)) h.update(JSON.stringify(o));
  return { hash: h.digest('hex'), engine: e };
}

const viaJson = (s: EngineSnapshot): EngineSnapshot => JSON.parse(JSON.stringify(s)) as EngineSnapshot;
const meta = { config, startQuote: 15, latencyMs: 150, info: { makerFeeRate: 0 }, edgeWindowMs: 10 * 60_000 };

describe('ShadowEngine', () => {
  it('golden: shadow decisions are frozen (any change here is a new experiment, not a refactor)', () => {
    // Re-pinned 2026-11-13 for behavior v2 (AFK review: dead-zone + float-residue fixes, inventory cap
    // under the risk hard cap, risk events on change). v1 froze after ~3 min of this market: 78 fills.
    const { hash, engine } = runHash(inputs(60));
    expect(engine.fillCount).toBe(783);
    expect(hash).toBe('6d4ec2bc56d8af64e53d476d4aa514204079198c12717a5f6b1a1ae773ba01f4');
  });

  it('replay is bit-exact, including through the gzip NDJSON recorder', async () => {
    const recs = inputs(30);
    const a = runHash(recs);
    const b = runHash(recs);
    expect(a.hash).toBe(b.hash);
    expect(a.engine.fillCount).toBeGreaterThan(0);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-rec-'));
    const rec = new NdjsonRecorder(dir, 'mexc-SOLUSDT');
    recs.forEach((r) => rec.write(r));
    await rec.close();
    const files = listRecordings(dir);
    expect(files.length).toBeGreaterThan(0);
    const fromDisk = await replay(files, meta);
    expect(fromDisk.records).toBe(recs.length);
    expect(fromDisk.fills).toBe(a.engine.fillCount);
    expect(fromDisk.outputHash).toBe(a.hash);
    expect(fromDisk.stateDigest).toBe(stateDigest(a.engine.snapshot()));
    const again = await replay(files, meta);
    expect(again.outputHash).toBe(fromDisk.outputHash);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ledger stays balanced and matches the strategy balances to the cent', () => {
    const { engine } = runHash(inputs(30));
    for (const [, v] of engine.ledger.totals()) expect(v.isZero()).toBe(true);
    const s = engine.strategy.snapshot();
    expect(engine.ledger.balance('cash:USDT', 'USDT').toNumber()).toBeCloseTo(s.quoteTotal, 8);
    expect(engine.ledger.balance('cash:SOL', 'SOL').toNumber()).toBeCloseTo(s.baseTotal, 10);
  });

  it('closes MTM edge windows (hourly in production, 10 min here)', () => {
    const e = new ShadowEngine(opts);
    const edges = inputs(35).flatMap((r) => e.process(r)).filter((o) => o.kind === 'edge');
    expect(edges.length).toBe(3);
    expect(e.edge.n).toBe(3);
  });
});

describe('ShadowEngine snapshot / restore', () => {
  const recs = inputs(20, 11);
  const full = runHash(recs);

  it('restore at any cut point continues bit-exactly (outputs and final state)', () => {
    expect(full.engine.fillCount).toBeGreaterThan(2);
    const finalDigest = stateDigest(full.engine.snapshot());
    const cuts = [1, 2, 37, 1_000, Math.floor(recs.length / 3), Math.floor(recs.length / 2), recs.length - 1];
    for (const cut of cuts) {
      const a = new ShadowEngine(opts);
      for (const r of recs.slice(0, cut)) a.process(r);
      const b = ShadowEngine.restore(opts, viaJson(a.snapshot()));
      expect(stateDigest(b.snapshot())).toBe(stateDigest(a.snapshot()));
      const restOfA = runHash(recs.slice(cut), a).hash;
      const restOfB = runHash(recs.slice(cut), b).hash;
      expect(restOfB).toBe(restOfA);
      expect(stateDigest(b.snapshot())).toBe(finalDigest);
      expect(b.ledger.balance('cash:USDT', 'USDT').toFixed()).toBe(full.engine.ledger.balance('cash:USDT', 'USDT').toFixed());
    }
  });

  it('restores mid-flight state: working orders, sim queue, clientOrderId sequence', () => {
    const a = new ShadowEngine(opts);
    let cut = 0;
    // Find a point with live orders on both the strategy and the simulated exchange.
    for (; cut < recs.length; cut++) {
      a.process(recs[cut]!);
      if (cut > 2_000 && a.strategy.snapshot().workingOrders.length > 0 && a.sim.openOrders > 0) break;
    }
    expect(cut).toBeLessThan(recs.length);
    const b = ShadowEngine.restore(opts, viaJson(a.snapshot()));
    expect(b.strategy.snapshot()).toEqual(a.strategy.snapshot());
    expect(b.sim.openOrders).toBe(a.sim.openOrders);
    expect(b.strategy.snapshot().seq).toBeGreaterThan(0); // no duplicate clientOrderIds after a restart
  });

  it('refuses a snapshot from a different configuration or a tampered header/ledger', () => {
    const a = new ShadowEngine(opts);
    for (const r of recs.slice(0, 500)) a.process(r);
    const s = viaJson(a.snapshot());
    expect(() => ShadowEngine.restore({ ...opts, latencyMs: 151 }, s)).toThrow(/different configuration/);
    expect(() => ShadowEngine.restore(opts, { ...s, records: s.records + 1 })).toThrow(/header/);
    const unbalanced = viaJson(s);
    unbalanced.ledger[0]!.postings[0]!.amount = '16';
    expect(() => ShadowEngine.restore(opts, unbalanced)).toThrow(/sums to/);
    // Balanced but not the strategy's history (here: no deposit at all) — caught by reconciliation on load.
    expect(() => ShadowEngine.restore(opts, { ...s, ledger: [] })).toThrow(/does not match the strategy balances/);
  });

  it('health and command records drive risk deterministically', () => {
    const e = new ShadowEngine(opts);
    for (const r of recs.slice(0, 3_000)) e.process(r);
    const ts = recs[2_999]!.ts;
    const lag = e.process({ t: 'health', ts, errorsLastMin: 0, eventLoopLagMs: 500, clockSkewMs: 0 });
    expect(lag.some((o: EngineOutput) => o.kind === 'action' && o.action.kind === 'risk' && o.action.action === 'pause')).toBe(true);
    expect(e.strategy.snapshot().quoting).toBe(false);
    e.process({ t: 'health', ts: ts + 1, errorsLastMin: 0, eventLoopLagMs: 5, clockSkewMs: 0 });
    expect(e.strategy.snapshot().quoting).toBe(true);
    e.process({ t: 'command', ts: ts + 2, command: 'pause' });
    expect(e.strategy.snapshot().status).toBe('paused');
  });
});
