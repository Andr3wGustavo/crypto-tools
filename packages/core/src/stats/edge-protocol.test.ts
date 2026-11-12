import { describe, expect, it } from 'vitest';
import { gaussian, mulberry32 } from '../math/rng';
import {
  DEFAULT_EDGE_PROTOCOL_RULE as RULE, decidePair, evaluateLook, goProbabilityThreshold, minimumDetectableEdge,
  validateEdgeProtocolRule, type EdgeProtocolRule, type PairSeries,
} from './edge-protocol';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 15);

/** Hourly windows with AR(1) noise: x_t = μ + e_t, e_t = φ·e_{t−1} + √(1−φ²)·σ·z (marginal sd = σ). */
function series(rand: () => number, opts: { mu: number; sigma: number; hours: number; phi?: number; fillsPerHour?: number; gaps?: Array<[number, number]> }): PairSeries {
  const phi = opts.phi ?? 0;
  const observations: PairSeries['observations'] = [];
  const fillTs: number[] = [];
  let e = opts.sigma * gaussian(rand);
  let start = T0;
  for (let h = 0; h < opts.hours; h++) {
    const gap = opts.gaps?.find(([at]) => at === h);
    const len = gap ? (1 + gap[1]) * H : H;
    observations.push({ startTs: start, endTs: start + len, returnBps: opts.mu + e });
    for (let f = 0; f < (opts.fillsPerHour ?? 3); f++) fillTs.push(start + (f + 0.5) * (H / (opts.fillsPerHour ?? 3)));
    start += len;
    e = phi * e + Math.sqrt(1 - phi * phi) * opts.sigma * gaussian(rand);
  }
  return { observations, fillTs, dataEndTs: start };
}

describe('edge protocol (pre-registered GO/NO-GO)', () => {
  it('threshold is Bonferroni over pairs × looks', () => {
    expect(goProbabilityThreshold(RULE, 1)).toBeCloseTo(1 - 0.05 / 3, 12);
    expect(goProbabilityThreshold(RULE, 8)).toBeCloseTo(1 - 0.05 / 24, 12);
    expect(() => goProbabilityThreshold(RULE, 0)).toThrow();
  });

  it('rejects malformed rules', () => {
    const bad = (p: Partial<EdgeProtocolRule>) => () => validateEdgeProtocolRule({ ...RULE, ...p });
    expect(bad({ looksHours: [] })).toThrow();
    expect(bad({ looksHours: [168, 168] })).toThrow();
    expect(bad({ looksHours: [1] })).toThrow(/two windows/);
    expect(bad({ familyAlpha: 0 })).toThrow();
    expect(bad({ minFills: 1.5 })).toThrow();
    expect(bad({ maxGapFraction: 1 })).toThrow();
    expect(() => validateEdgeProtocolRule(RULE)).not.toThrow();
  });

  it('controls the family-wise false-GO rate at the worst null (μ = ε) with 8 pairs × 3 looks', () => {
    const rand = mulberry32(2026);
    const trials = 300;
    let falseGo = 0;
    for (let t = 0; t < trials; t++) {
      let any = false;
      for (let p = 0; p < 8; p++) {
        const d = decidePair(series(rand, { mu: RULE.goMinEdgeBps, sigma: 10, hours: 504 }), RULE, 8);
        if (d.decision === 'GO') any = true;
      }
      if (any) falseGo++;
    }
    expect(falseGo / trials).toBeLessThanOrEqual(RULE.familyAlpha);
  });

  it('autocorrelated inventory: the AR(1) adjustment keeps the false-GO rate controlled (and is needed)', () => {
    const run = (adjust: boolean) => {
      const rand = mulberry32(77);
      const rule = { ...RULE, autocorrelationAdjust: adjust };
      let go = 0;
      for (let t = 0; t < 600; t++) {
        if (decidePair(series(rand, { mu: RULE.goMinEdgeBps, sigma: 10, hours: 504, phi: 0.5 }), rule, 1).decision === 'GO') go++;
      }
      return go / 600;
    };
    const adjusted = run(true);
    const naive = run(false);
    expect(adjusted).toBeLessThanOrEqual(RULE.familyAlpha);
    expect(naive).toBeGreaterThan(2 * RULE.familyAlpha); // ignoring autocorrelation would over-claim edges
  });

  it('a strong real edge is GO at the first look; a losing strategy is NO_GO early', () => {
    const rand = mulberry32(5);
    const good = decidePair(series(rand, { mu: 6, sigma: 10, hours: 504 }), RULE, 8);
    expect(good.decision).toBe('GO');
    expect(good.decidedAtLook).toBe(0);
    expect(good.looks[0]!.lowerBoundBps).toBeGreaterThan(RULE.goMinEdgeBps);
    const bad = decidePair(series(rand, { mu: -3, sigma: 10, hours: 504 }), RULE, 8);
    expect(bad.decision).toBe('NO_GO');
    expect(bad.decidedAtLook).toBe(0);
    expect(bad.reason).toMatch(/futility/);
  });

  it('GO needs the minimum number of fills', () => {
    const s = series(mulberry32(5), { mu: 6, sigma: 10, hours: 504 });
    s.fillTs = s.fillTs.filter((_, i) => i % 7 === 0); // ≈ 216 fills in 504 h
    const d = decidePair(s, RULE, 8);
    expect(d.decision).toBe('NO_GO');
    expect(d.looks.every((l) => l.verdict !== 'GO')).toBe(true);
    expect(d.looks[0]!.reasons.join()).toMatch(/fills </);
  });

  it('only pre-registered looks are evaluated, on exactly their own span: more data never changes a look', () => {
    const rand = mulberry32(11);
    const full = series(rand, { mu: 0.5, sigma: 10, hours: 504 });
    const cut = (hours: number): PairSeries => ({
      observations: full.observations.filter((o) => o.endTs <= T0 + hours * H),
      fillTs: full.fillTs.filter((t) => t <= T0 + hours * H),
      dataEndTs: T0 + hours * H,
    });
    const at200 = decidePair(cut(200), RULE, 8);
    const at400 = decidePair(cut(400), RULE, 8);
    expect(at200.looks).toHaveLength(1);
    expect(at400.looks).toHaveLength(2);
    expect(at400.looks[0]).toEqual(at200.looks[0]);
    expect(decidePair(cut(100), RULE, 8)).toMatchObject({ decision: 'PENDING', nextLook: 0, looks: [] });
  });

  it('downtime makes a look non-decisive, and a dead pair fails closed at the end', () => {
    const rand = mulberry32(3);
    const gappy = series(rand, { mu: 6, sigma: 10, hours: 480, gaps: [[50, 12]] }); // 12 h outage in week 1
    const d = decidePair(gappy, RULE, 8);
    expect(d.looks[0]!.verdict).toBe('INVALID');
    expect(d.looks[0]!.gapFraction).toBeGreaterThan(RULE.maxGapFraction);

    const dead = series(rand, { mu: 6, sigma: 10, hours: 200 }); // stopped recording after 200 h
    expect(decidePair(dead, RULE, 8).decision).toBe('GO'); // look 0 was complete and strong
    const deadEarly = series(rand, { mu: 0, sigma: 10, hours: 100 });
    expect(decidePair(deadEarly, RULE, 8).decision).toBe('PENDING');
    const later = T0 + (504 + 48) * H;
    const final = decidePair(deadEarly, RULE, 8, { asOf: later });
    expect(final.decision).toBe('NO_GO');
    expect(final.looks.every((l) => l.verdict === 'INVALID' || l.verdict === 'NO_GO')).toBe(true);
  });

  it('a pair that never produces data is NO_GO once the whole window could have elapsed', () => {
    const empty: PairSeries = { observations: [], fillTs: [], dataEndTs: Number.NEGATIVE_INFINITY };
    const deadline = T0 + 504 * H + RULE.graceMs;
    expect(decidePair(empty, RULE, 8, { registeredAt: T0, asOf: deadline - 1 }).decision).toBe('PENDING');
    expect(decidePair(empty, RULE, 8, { registeredAt: T0, asOf: deadline })).toMatchObject({ decision: 'NO_GO', reason: expect.stringMatching(/fail-closed/) });
    expect(decidePair(empty, RULE, 8, { asOf: deadline * 2 }).decision).toBe('PENDING'); // no registration time ⇒ no deadline
  });

  it('evaluateLook statistics match a direct computation', () => {
    const s = series(mulberry32(1), { mu: 2, sigma: 4, hours: 168 });
    const r = evaluateLook(s, T0, 0, { ...RULE, autocorrelationAdjust: false }, 1);
    const xs = s.observations.map((o) => o.returnBps);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
    expect(r.n).toBe(168);
    expect(r.nEff).toBe(168);
    expect(r.meanBps).toBeCloseTo(mean, 10);
    expect(r.sdBps).toBeCloseTo(sd, 10);
    expect(r.gapFraction).toBeCloseTo(0, 12);
    expect(r.fills).toBe(168 * 3);
  });

  it('minimum detectable edge states what the window can prove', () => {
    // 8 pairs, σ = 10 bps/h: the first look (168 h) needs a mean of ≈ 1 + 2.86·10/√168 ≈ 3.2 bps/h
    expect(minimumDetectableEdge(RULE, 8, 10, 0)).toBeCloseTo(1 + 2.8627 * (10 / Math.sqrt(168)), 2);
    expect(minimumDetectableEdge(RULE, 8, 10, 2)).toBeLessThan(minimumDetectableEdge(RULE, 8, 10, 0));
  });
});
