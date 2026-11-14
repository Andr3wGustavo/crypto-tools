import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../math/rng';
import { DEFAULT_AS_PARAMS, computeAsQuote, liquidityTermBps } from './avellaneda';
import { fitFillIntensity, maxProfitRate, optimalDeltaBps, profitRate, tradeDistanceBps } from './fill-intensity';
import { QuoteSanityError, buildQuoteOrders, sellableQty, type SymbolRules } from './quote-builder';
import { BN, ceilToStep, decimalsOf, floorToStep } from './tick';

describe('tick rounding', () => {
  it('floors and ceils to arbitrary steps exactly', () => {
    expect(decimalsOf('0.0010')).toBe(3);
    expect(floorToStep(100.0179, '0.01')).toBe('100.01');
    expect(ceilToStep(100.0101, '0.01')).toBe('100.02');
    expect(floorToStep('0.123456789', '0.0001')).toBe('0.1234');
    expect(floorToStep(0.3, '0.1')).toBe('0.3'); // no float drift
  });
});

describe('Avellaneda–Stoikov in bps', () => {
  const p = { ...DEFAULT_AS_PARAMS, minHalfSpreadBps: 0, maxHalfSpreadBps: 1e6, maxSkewBps: 1e6 };

  it('is symmetric at zero inventory', () => {
    const q = computeAsQuote(p, { fair: 100, sigmaBps: 1.5, q: 0, costBps: 2 });
    expect(q.skewBps).toBe(0);
    expect(q.reservation).toBe(100);
    expect(100 - q.bid).toBeCloseTo(q.ask - 100, 10);
    const expected = 2 + liquidityTermBps(p.gamma, p.k) + (p.gamma * 1.5 ** 2 * p.tauSec) / 2;
    expect(q.halfSpreadBps).toBeCloseTo(expected, 12);
  });

  it('tends to δ* = c + 1/k as γ → 0', () => {
    const q = computeAsQuote({ ...p, gamma: 1e-15 }, { fair: 100, sigmaBps: 1, q: 0, costBps: 3 });
    expect(q.halfSpreadBps).toBeCloseTo(3 + 1 / p.k, 9);
  });

  it('long inventory lowers both quotes (encourages selling)', () => {
    const flat = computeAsQuote(p, { fair: 100, sigmaBps: 2, q: 0, costBps: 1 });
    const long = computeAsQuote(p, { fair: 100, sigmaBps: 2, q: 1, costBps: 1 });
    expect(long.bid).toBeLessThan(flat.bid);
    expect(long.ask).toBeLessThan(flat.ask);
  });

  it('defaults never produce the v2 bug (129% spread): spread stays within bounds', () => {
    const q = computeAsQuote(DEFAULT_AS_PARAMS, { fair: 100_000, sigmaBps: 50, q: 1, costBps: 10 });
    expect(q.halfSpreadBps).toBeLessThanOrEqual(DEFAULT_AS_PARAMS.maxHalfSpreadBps);
    expect(Math.abs(q.skewBps)).toBeLessThanOrEqual(DEFAULT_AS_PARAMS.maxSkewBps);
    expect(q.ask / q.bid - 1).toBeLessThan(0.02);
  });
});

describe('fill intensity λ(δ) = A·e^(−kδ)', () => {
  it('recovers k and A from exponential trade distances', () => {
    const rand = mulberry32(5);
    const k = 0.4;
    const T = 3600;
    const d = Array.from({ length: 40_000 }, () => -Math.log(1 - rand()) / k);
    const fit = fitFillIntensity(d, T)!;
    expect(fit.k).toBeGreaterThan(0.38);
    expect(fit.k).toBeLessThan(0.42);
    expect(fit.A).toBeGreaterThan((40_000 / (2 * T)) * 0.9);
    expect(fit.A).toBeLessThan((40_000 / (2 * T)) * 1.1);
    expect(fit.r2).toBeGreaterThan(0.99);
  });

  it('δ* = c + 1/k maximizes π(δ) (checked numerically)', () => {
    const A = 3;
    const k = 0.35;
    const c = 1.2;
    let best = 0;
    let bestD = 0;
    for (let d = 0; d <= 30; d += 0.0005) {
      const v = profitRate(A, k, d, c);
      if (v > best) {
        best = v;
        bestD = d;
      }
    }
    expect(bestD).toBeCloseTo(optimalDeltaBps(k, c), 3);
    expect(best).toBeCloseTo(maxProfitRate(A, k, c), 6);
  });

  it('measures trade distance on the aggressor side', () => {
    expect(tradeDistanceBps(99.9, 100, 'sell')).toBeCloseTo(10, 9);
    expect(tradeDistanceBps(100.1, 100, 'buy')).toBeCloseTo(10, 9);
  });
});

describe('buildQuoteOrders', () => {
  const rules: SymbolRules = { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: 1 };
  const params = { orderNotional: 2.25, costBps: 2, reduceMinEdgeBps: 2, pennyMinSpreadTicks: 0, maxDeviationBps: 300, cashBufferPct: 0.01 };
  const book = { bid: 99.9, bidQty: 10, ask: 100.1, askQty: 10 };
  const quote = computeAsQuote({ ...DEFAULT_AS_PARAMS, minHalfSpreadBps: 5, maxHalfSpreadBps: 5 }, { fair: 100, sigmaBps: 0, q: 0, costBps: 0 });

  it('rounds bid down and ask up, sizes by notional', () => {
    const r = buildQuoteOrders(quote, book, rules, { quoteFree: 15, baseFree: 1 }, params);
    expect(r.bid).toMatchObject({ price: '99.95', qty: '0.022' });
    expect(r.ask).toMatchObject({ price: '100.05', qty: '0.022' });
  });

  it('never sells inventory it does not hold and never overspends cash', () => {
    const r = buildQuoteOrders(quote, book, rules, { quoteFree: 1, baseFree: 0 }, params);
    expect(r.bid).toBeUndefined();
    expect(r.ask).toBeUndefined();
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(['insufficient_cash', 'no_inventory']);
  });

  it('clamps to post-only and drops the side when the edge disappears', () => {
    const tight = { bid: 99.99, bidQty: 10, ask: 100.0, askQty: 10 };
    const r = buildQuoteOrders(quote, tight, rules, { quoteFree: 15, baseFree: 1 }, params);
    expect(r.bid?.price).toBe('99.95');
    expect(Number(r.bid!.price)).toBeLessThan(tight.ask);
    expect(Number(r.ask!.price)).toBeGreaterThan(tight.bid);
  });

  it('a model quote past the edge floor is clamped to the floor and placed, not dropped', () => {
    // Long inventory skews the ask below fair (sell urgently), but the reducing side may not go
    // below fair · (1 + reduceMinEdge) yet: the ask sits at that floor instead of disappearing.
    const skewed = { ...quote, ask: 99.98, bid: 99.9 };
    const r = buildQuoteOrders(skewed, { bid: 99.9, bidQty: 10, ask: 100.1, askQty: 10 }, rules, { quoteFree: 15, baseFree: 1 }, { ...params, reduceMinEdgeBps: 1 });
    expect(r.ask?.price).toBe('100.01'); // ceil(100 · 1.0001)
    expect(r.ask!.edgeBps).toBeGreaterThanOrEqual(1);
    const rich = buildQuoteOrders({ ...quote, bid: 99.99 }, { bid: 99.9, bidQty: 10, ask: 100.1, askQty: 10 }, rules, { quoteFree: 15, baseFree: 0 }, { ...params, costBps: 3 });
    expect(rich.bid?.price).toBe('99.97'); // floor(100 · (1 − 0.0003))
  });

  it('pennies the best by one tick only when the edge survives', () => {
    const wide = { bid: 99.95, bidQty: 10, ask: 100.05, askQty: 10 };
    const r = buildQuoteOrders(quote, wide, rules, { quoteFree: 15, baseFree: 1 }, { ...params, pennyMinSpreadTicks: 3 });
    expect(r.bid?.price).toBe('99.96');
    expect(r.ask?.price).toBe('100.04');
  });

  it('throws (fail-closed) when a price is absurdly far from fair', () => {
    const bad = { ...quote, bid: 50, ask: 150 };
    expect(() => buildQuoteOrders(bad, { bid: 49, bidQty: 1, ask: 151, askQty: 1 }, rules, { quoteFree: 15, baseFree: 1 }, params)).toThrow(QuoteSanityError);
  });

  // AFK deadlock review (2026-11-13): coarse steps (0.01 SOL ≈ US$0.88 < US$1 minimum).
  describe('coarse step vs exchange minimum', () => {
    const sol: SymbolRules = { tickSize: '0.01', stepSize: '0.01', minQty: '0.01', minNotional: 1 };
    const solBook = { bid: 87.9, bidQty: 5, ask: 88.1, askQty: 5 };
    const solQuote = computeAsQuote({ ...DEFAULT_AS_PARAMS, minHalfSpreadBps: 5, maxHalfSpreadBps: 5 }, { fair: 88, sigmaBps: 0, q: 0, costBps: 0 });

    it('rounds a bid up to the smallest valid size, by at most one step', () => {
      const r = buildQuoteOrders(solQuote, solBook, sol, { quoteFree: 15, baseFree: 0 }, { ...params, bidNotional: 1.1 });
      expect(r.bid?.qty).toBe('0.02'); // floor(1.1/88) = 0.01 → US$0.88 < US$1 → 0.02
      const tiny = buildQuoteOrders(solQuote, solBook, sol, { quoteFree: 15, baseFree: 0 }, { ...params, bidNotional: 0.05 });
      expect(tiny.bid).toBeUndefined(); // more than one step away: refused, not inflated
      expect(tiny.skipped).toContainEqual({ side: 'BUY', reason: 'below_min' });
      // …and never past a hard ceiling (the room under the inventory cap): 0.02 = US$1.76 > 1.5.
      const capped = buildQuoteOrders(solQuote, solBook, sol, { quoteFree: 15, baseFree: 0 }, { ...params, bidNotional: 1.5, bidNotionalMax: 1.5 });
      expect(capped.bid).toBeUndefined();
    });

    it('sells everything instead of leaving unsellable dust', () => {
      const r = buildQuoteOrders(solQuote, solBook, sol, { quoteFree: 15, baseFree: 0.03 }, params);
      expect(r.ask?.qty).toBe('0.03'); // 0.02 would leave 0.01 ≈ US$0.88, which could never be sold
    });

    it('sellableQty: the largest step multiple not above what we hold', () => {
      expect(sellableQty('0.029999999999', '0.01')).toBe('0.02'); // floorToStep alone snaps to 0.03
      expect(sellableQty('0.03', '0.01')).toBe('0.03');
      expect(sellableQty(0.0128, '0.01')).toBe('0.01');
      expect(sellableQty('0.009', '0.01')).toBe('0.00');
    });

    it('never sells more than it holds, even when step snapping would round up', () => {
      const r = buildQuoteOrders(solQuote, solBook, sol, { quoteFree: 15, baseFree: 0.029999999999 }, { ...params, orderNotional: 5 });
      expect(Number(r.ask?.qty)).toBeLessThanOrEqual(0.029999999999);
      expect(r.ask?.qty).toBe('0.02');
    });
  });

  it('property: outputs are always exchange-valid and never take liquidity', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1000, noNaN: true }),
        fc.integer({ min: 1, max: 30 }),
        fc.double({ min: 0, max: 30, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: 0, max: 0.2, noNaN: true }),
        (fair, spreadTicks, sigma, q, cash, base) => {
          const tick = fair > 100 ? 0.01 : 0.001;
          const r: SymbolRules = { tickSize: String(tick), stepSize: '0.0001', minQty: '0.0001', minNotional: 1 };
          const mid = Math.round(fair / tick) * tick;
          const b = { bid: Number((mid - Math.floor(spreadTicks / 2) * tick).toFixed(6)), bidQty: 5, ask: Number((mid + Math.ceil(spreadTicks / 2) * tick).toFixed(6)), askQty: 5 };
          const aq = computeAsQuote(DEFAULT_AS_PARAMS, { fair: mid, sigmaBps: sigma, q, costBps: 1 });
          const res = buildQuoteOrders(aq, b, r, { quoteFree: cash, baseFree: base }, { ...params, costBps: 1, reduceMinEdgeBps: -5, pennyMinSpreadTicks: 3 });
          for (const o of [res.bid, res.ask]) {
            if (!o) continue;
            expect(new BN(o.price).mod(r.tickSize).isZero()).toBe(true);
            expect(new BN(o.qty).mod(r.stepSize).isZero()).toBe(true);
            expect(Number(o.price) * Number(o.qty)).toBeGreaterThanOrEqual(r.minNotional - 1e-9);
          }
          if (res.bid) {
            expect(Number(res.bid.price)).toBeLessThan(b.ask);
            expect(Number(res.bid.price) * Number(res.bid.qty)).toBeLessThanOrEqual(cash + 1e-9);
          }
          if (res.ask) {
            expect(Number(res.ask.price)).toBeGreaterThan(b.bid);
            expect(Number(res.ask.qty)).toBeLessThanOrEqual(base + 1e-12);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
