import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCANNER_PARAMS as P, bookStats, capturableHalfSpreadBps, quantile, rankPairs, scorePair, screenUniverse, tradeStats,
  type BookStats, type PairMeasurement, type UniverseRow,
} from './pair-scanner';

const row = (o: Partial<UniverseRow> = {}): UniverseRow => ({
  symbol: 'ABCUSDT', base: 'ABC', quote: 'USDT', tradable: true, flagged: false, makerFeeRate: 0,
  minNotional: 1, tickSize: 0.0001, quoteVolume24h: 1e6, hasReference: true, ...o,
});

const book = (o: Partial<BookStats> = {}): BookStats => ({
  samples: 120, validFrac: 1, midP50: 1, tickBps: 1, spreadTicksP10: 6, spreadTicksP50: 8, spreadBpsP50: 8, sigma60Bps: 3, midMoveFrac: 0.4, ...o,
});

const meas = (o: Partial<PairMeasurement> = {}, b: Partial<BookStats> = {}): PairMeasurement => ({
  row: row(), book: book(b), trades: { n: 1000, spanMin: 50, perMin: 20, notionalPerMin: 500, medianNotional: 20, buyShare: 0.5 }, referenceBasisBps: 3, ...o,
});

describe('pair scanner — universe gates', () => {
  it('keeps a clean pair and rejects each failure with a reason', () => {
    const rows = [
      row(),
      row({ symbol: 'X1', quote: 'USDC' }),
      row({ symbol: 'X2', tradable: false }),
      row({ symbol: 'X3', flagged: true }),
      row({ symbol: 'BTC3LUSDT', base: 'BTC3L' }),
      row({ symbol: 'X5', makerFeeRate: 0.0001 }),
      row({ symbol: 'X6', minNotional: 5 }), // 5·1.1 > 20% of 15 → one order would exceed the inventory cap
      row({ symbol: 'X7', quoteVolume24h: 50_000 }),
      row({ symbol: 'X8', hasReference: false }),
    ];
    const { pass, rejected } = screenUniverse(rows, P);
    expect(pass.map((r) => r.symbol)).toEqual(['ABCUSDT']);
    expect(rejected.map((r) => [r.symbol, r.reasons.length])).toEqual(rows.slice(1).map((r) => [r.symbol, 1]));
    expect(screenUniverse([row({ hasReference: false })], { ...P, requireReference: false }).pass).toHaveLength(1);
  });
});

describe('pair scanner — measurements', () => {
  it('book stats: spreads in ticks/bps, validity, and realised vol from irregular samples', () => {
    const s = [
      { ts: 0, bid: 0.9996, ask: 1.0004 }, // 8 ticks
      { ts: 5_000, bid: 0.9996, ask: 1.0004 },
      { ts: 10_000, bid: 1.0, ask: 0.99 }, // crossed → invalid
      { ts: 20_000, bid: 1.0006, ask: 1.0014 }, // mid +10 bps after 15 s (gap handled by Σdt)
    ];
    const b = bookStats(s, 0.0001);
    expect(b.validFrac).toBe(0.75);
    expect(b.spreadTicksP50).toBe(8);
    expect(b.spreadBpsP50).toBeCloseTo(8, 6);
    const r = Math.log(1.001);
    expect(b.sigma60Bps).toBeCloseTo(Math.sqrt((r * r) / 20_000 * 60_000) * 1e4, 9);
    expect(b.midMoveFrac).toBeCloseTo(1 / 2, 12);
  });

  it('realised vol scales per minute: ±1 bp every second ⇒ 1 bp · √60', () => {
    const s = Array.from({ length: 61 }, (_, i) => ({ ts: i * 1_000, bid: (i % 2 ? 1.0001 : 1) - 0.0004, ask: (i % 2 ? 1.0001 : 1) + 0.0004 }));
    const b = bookStats(s, 0.0001);
    expect(b.sigma60Bps).toBeCloseTo(Math.abs(Math.log(1.0001 / 1)) * Math.sqrt(60) * 1e4, 6);
  });

  it('trade stats: rate over the covered span, buy share, median notional', () => {
    const t = Array.from({ length: 61 }, (_, i) => ({ time: i * 1_000, price: 2, qty: i === 0 ? 100 : 1, isBuyerMaker: i % 4 === 0 }));
    const s = tradeStats(t);
    expect(s.perMin).toBeCloseTo(60, 9); // 60 intervals in 1 min
    expect(s.medianNotional).toBe(2);
    expect(s.buyShare).toBeCloseTo(45 / 61, 12);
    expect(tradeStats([]).perMin).toBe(0);
    expect(tradeStats([{ time: 5, price: 1, qty: 1, isBuyerMaker: true }, { time: 5, price: 1, qty: 1, isBuyerMaker: true }]).spanMin).toBeCloseTo(1 / 60, 12);
  });

  it('nearest-rank quantile', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.1)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe('pair scanner — scoring', () => {
  it('capturable half spread: one tick inside each side', () => {
    expect(capturableHalfSpreadBps(1, 2)).toBe(0);
    expect(capturableHalfSpreadBps(3, 2)).toBe(1);
    expect(capturableHalfSpreadBps(8, 1)).toBe(3);
  });

  it('gates: tight books, thin flow, a mismatched reference (same ticker, other token) are ineligible', () => {
    expect(scorePair(meas(), P).eligible).toBe(true);
    expect(scorePair(meas({}, { spreadTicksP50: 1, spreadBpsP50: 1.2 }), P).reasons.join()).toMatch(/spread 1 ticks/);
    expect(scorePair(meas({}, { spreadBpsP50: 400, spreadTicksP50: 400 }), P).reasons.join()).toMatch(/bps > 150/);
    expect(scorePair(meas({ trades: { n: 3, spanMin: 60, perMin: 0.03, notionalPerMin: 1, medianNotional: 5, buyShare: 1 } }), P).eligible).toBe(false);
    expect(scorePair(meas({ trades: undefined }), P).reasons).toContain('trades not measured');
    expect(scorePair(meas({ referenceBasisBps: 2_500 }), P).reasons.join()).toMatch(/different token/);
    expect(scorePair(meas({}, { validFrac: 0.5 }), P).eligible).toBe(false);
  });

  it('property: score rises with spread, falls with volatility, saturates with flow', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 60 }), fc.double({ min: 0.5, max: 50, noNaN: true }), fc.double({ min: 0, max: 100, noNaN: true }), (ticks, sigma, perMin) => {
        const at = (t: number, s: number, f: number) => scorePair(meas({ trades: { n: 100, spanMin: 1, perMin: f, notionalPerMin: 1, medianNotional: 1, buyShare: 0.5 } }, { spreadTicksP50: t, sigma60Bps: s }), P).score;
        expect(at(ticks + 1, sigma, perMin)).toBeGreaterThanOrEqual(at(ticks, sigma, perMin));
        expect(at(ticks, sigma * 2, perMin)).toBeLessThanOrEqual(at(ticks, sigma, perMin));
        expect(at(ticks, sigma, Math.max(perMin, P.flowSaturationPerMin) * 3)).toBe(at(ticks, sigma, P.flowSaturationPerMin));
      }),
    );
  });

  it('ranking: eligible first by score, deterministic ties, top N selected', () => {
    const ms = [
      meas({ row: row({ symbol: 'BBB' }) }, { spreadTicksP50: 10 }),
      meas({ row: row({ symbol: 'AAA' }) }, { spreadTicksP50: 10 }),
      meas({ row: row({ symbol: 'ZZZ' }) }, { spreadTicksP50: 30 }),
      meas({ row: row({ symbol: 'BAD' }) }, { spreadTicksP50: 1 }),
    ];
    const { ranked, selected } = rankPairs(ms, { ...P, topN: 2 });
    expect(ranked.map((r) => r.symbol)).toEqual(['ZZZ', 'AAA', 'BBB', 'BAD']);
    expect(selected.map((r) => r.symbol)).toEqual(['ZZZ', 'AAA']);
  });
});
