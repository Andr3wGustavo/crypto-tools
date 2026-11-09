import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_LIMITS, evaluateRisk, worstCaseLoss, type RiskInputs } from '../risk/risk-manager';
import { LeadLagModel } from './lead-lag';
import { MarkoutTracker } from './markouts';

describe('LeadLagModel', () => {
  const p = { basisHalfLifeMs: 1000, maxRefAgeMs: 2000, moveWindowMs: 500, toxicMoveBps: 4, cooldownMs: 1500 };

  it('learns the basis and prices fair off the reference', () => {
    const m = new LeadLagModel(p);
    for (let t = 0; t <= 20_000; t += 100) {
      m.onReference(t, 100);
      m.onLocal(t, 100.1);
    }
    const f = m.fair(20_000, 100.1);
    expect(f.source).toBe('reference');
    expect(f.fair).toBeCloseTo(100.1, 6);
    expect(f.basisBps).toBeCloseTo(Math.log(1.001) * 1e4, 4);
  });

  it('falls back to the local mid when the reference is stale', () => {
    const m = new LeadLagModel(p);
    m.onReference(0, 100);
    m.onLocal(0, 100);
    expect(m.fair(5_000, 101).source).toBe('local');
  });

  it('flags toxic flow on a sharp reference move, with direction and cooldown', () => {
    const m = new LeadLagModel(p);
    m.onReference(0, 100);
    m.onReference(400, 100.06); // +6 bps in 400 ms
    expect(m.toxicity(400)).toMatchObject({ toxic: true, direction: 'up' });
    expect(m.toxicity(1_899).toxic).toBe(true);
    expect(m.toxicity(1_901).toxic).toBe(false);
    m.onReference(2_000, 100.06);
    m.onReference(2_300, 99.99);
    expect(m.toxicity(2_300)).toMatchObject({ toxic: true, direction: 'down' });
  });
});

describe('MarkoutTracker', () => {
  it('scores fills at each horizon (positive = good for us)', () => {
    const m = new MarkoutTracker({ horizonsMs: [1000, 5000], referenceHorizonMs: 5000, priorAsBps: 2, priorWeight: 0 });
    m.addFill({ id: 'b1', side: 'BUY', price: 100, ts: 0 });
    m.addFill({ id: 's1', side: 'SELL', price: 100, ts: 0 });
    expect(m.onMid(500, 101)).toEqual([]);
    const r1 = m.onMid(1000, 101);
    expect(r1.find((r) => r.fillId === 'b1')!.bps).toBeCloseTo(100, 9);
    expect(r1.find((r) => r.fillId === 's1')!.bps).toBeCloseTo(-100, 9);
    m.onMid(5000, 99);
    // Reference markouts: buy −100, sell +100 → mean 0 → AS 0
    expect(m.adverseSelectionBps()).toBeCloseTo(0, 9);
  });

  it('shrinks toward the prior and never goes negative', () => {
    const m = new MarkoutTracker({ horizonsMs: [1000], referenceHorizonMs: 1000, priorAsBps: 2, priorWeight: 20 });
    expect(m.adverseSelectionBps()).toBe(2);
    for (let i = 0; i < 20; i++) {
      m.addFill({ id: `f${i}`, side: 'BUY', price: 100, ts: i });
      m.onMid(i + 1000, 99.94); // −6 bps each
    }
    expect(m.adverseSelectionBps()).toBeCloseTo((20 * 2 + 20 * 6) / 40, 6);
    const good = new MarkoutTracker({ horizonsMs: [1000], referenceHorizonMs: 1000, priorAsBps: 0, priorWeight: 1 });
    good.addFill({ id: 'g', side: 'BUY', price: 100, ts: 0 });
    good.onMid(1000, 110);
    expect(good.adverseSelectionBps()).toBe(0);
  });
});

describe('evaluateRisk', () => {
  const base: RiskInputs = {
    equity: 15, peakEquity: 15, dayStartEquity: 15, startEquity: 15, inventoryNotional: 0,
    tickerAgeMs: 100, errorsLastMin: 0, eventLoopLagMs: 5, clockSkewMs: 10, reconcileDiverged: false,
  };
  const L = DEFAULT_RISK_LIMITS;

  it('ok when healthy', () => expect(evaluateRisk(L, base).action).toBe('ok'));
  it('kill on loss budget ($3 on $15)', () => expect(evaluateRisk(L, { ...base, equity: 12 }).action).toBe('kill'));
  it('halt on drawdown from peak', () => expect(evaluateRisk(L, { ...base, peakEquity: 20, equity: 16.9, startEquity: 16 }).action).toBe('halt'));
  it('halt on daily loss', () => expect(evaluateRisk(L, { ...base, dayStartEquity: 17, equity: 15.2, peakEquity: 17.5, startEquity: 15 }).action).toBe('halt'));
  it('halt on reconciliation divergence', () => expect(evaluateRisk(L, { ...base, reconcileDiverged: true }).action).toBe('halt'));
  it('pause on stale ticker / errors / lag / skew', () => {
    expect(evaluateRisk(L, { ...base, tickerAgeMs: 10_000 }).action).toBe('pause');
    expect(evaluateRisk(L, { ...base, errorsLastMin: 50 }).action).toBe('pause');
    expect(evaluateRisk(L, { ...base, eventLoopLagMs: 900 }).action).toBe('pause');
    expect(evaluateRisk(L, { ...base, clockSkewMs: -5000 }).action).toBe('pause');
  });
  it('reduce_only over inventory cap', () => expect(evaluateRisk(L, { ...base, inventoryNotional: 4 }).action).toBe('reduce_only'));
  it('the most severe action wins', () => {
    const d = evaluateRisk(L, { ...base, equity: 11, tickerAgeMs: 10_000, inventoryNotional: 5 });
    expect(d.action).toBe('kill');
    expect(d.violations.length).toBeGreaterThanOrEqual(3);
  });
  it('worst-case loss bound for $15 live = $4.50', () => expect(worstCaseLoss(L)).toBeCloseTo(4.5, 12));
});
