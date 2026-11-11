import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultStrategyConfig, syntheticMarket } from '@cortex/core';
import { NdjsonRecorder, listRecordings } from '../recorder/ndjson';
import { replay } from '../replay';
import { ShadowEngine, type InputRecord } from './shadow-engine';

const rules = { tickSize: '0.01', stepSize: '0.01', minQty: '0.01', minNotional: 1 };
const base = defaultStrategyConfig({ botId: 'mexc:SOLUSDT:shadow', base: 'SOL', quote: 'USDT', rules });
const config = { ...base, as: { ...base.as, gamma: 0.02, k: 0.5 } };

function inputs(minutes: number): InputRecord[] {
  const out: InputRecord[] = [];
  let nextClock = 0;
  for (const m of syntheticMarket({ seed: 9, durationMs: minutes * 60_000, startPrice: 88, spreadTicks: 10, tradeRatePerSec: 3, sweepProb: 0.5 })) {
    if (m.ts >= nextClock) {
      out.push({ t: 'clock', ts: m.ts });
      nextClock = m.ts + 1000;
    }
    if (m.kind === 'trade') out.push({ t: 'trade', ts: m.ts, price: m.price, qty: m.qty, aggressor: m.aggressor });
    else out.push({ t: 'book', venue: m.kind === 'ref' ? 'reference' : 'local', ts: m.ts, bid: m.bid, bidQty: m.bidQty, ask: m.ask, askQty: m.askQty });
  }
  return out;
}

function runHash(recs: InputRecord[]) {
  const e = new ShadowEngine({ config, startQuote: 15, latencyMs: 150, makerFeeRate: 0, edgeWindowMs: 10 * 60_000 });
  const h = crypto.createHash('sha256');
  for (const r of recs) for (const o of e.process(r)) h.update(JSON.stringify(o));
  return { hash: h.digest('hex'), engine: e };
}

describe('ShadowEngine', () => {
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
    const fromDisk = await replay(files, { config, startQuote: 15, latencyMs: 150, info: { makerFeeRate: 0 } });
    expect(fromDisk.records).toBe(recs.length);
    expect(fromDisk.fills).toBe(a.engine.fillCount);
    const again = await replay(files, { config, startQuote: 15, latencyMs: 150, info: { makerFeeRate: 0 } });
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
    const e = new ShadowEngine({ config, startQuote: 15, latencyMs: 150, makerFeeRate: 0, edgeWindowMs: 10 * 60_000 });
    const edges = inputs(35).flatMap((r) => e.process(r)).filter((o) => o.kind === 'edge');
    expect(edges.length).toBe(3);
    expect(e.edge.n).toBe(3);
  });
});
