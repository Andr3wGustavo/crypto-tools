import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { gaussian, mulberry32 } from '../math/rng';
import { normalCdf } from '../math/special';
import { NigEstimator, bonferroniZ, requiredSampleSize } from './nig';
import { TimeEwma, VolEstimator } from './vol';

const prior = { mu0: 0, kappa0: 1, alpha0: 2, beta0: 100 };

describe('NigEstimator', () => {
  it('equals the prior with no data', () => {
    const e = new NigEstimator(prior);
    expect(e.posterior()).toMatchObject({ mu: 0, kappa: 1, alpha: 2, beta: 100 });
    expect(e.probGreaterThan(0)).toBeCloseTo(0.5, 12);
  });

  it('matches the closed-form conjugate update', () => {
    const e = new NigEstimator(prior);
    [1, 2, 3, 4, 5].forEach((x) => e.update(x));
    const p = e.posterior();
    expect(p.kappa).toBe(6);
    expect(p.mu).toBeCloseTo(2.5, 12);
    expect(p.alpha).toBe(4.5);
    expect(p.beta).toBeCloseTo(108.75, 10);
    expect(p.df).toBe(9);
    expect(p.scale).toBeCloseTo(Math.sqrt(108.75 / 27), 12);
  });

  it('approaches the frequentist z-test with a weak prior and many samples', () => {
    const rand = mulberry32(7);
    const e = new NigEstimator({ mu0: 0, kappa0: 1e-6, alpha0: 1e-3, beta0: 1e-3 });
    const xs = Array.from({ length: 4000 }, () => 0.4 + 10 * gaussian(rand));
    xs.forEach((x) => e.update(x));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
    expect(e.probGreaterThan(0)).toBeCloseTo(normalCdf(mean / (sd / Math.sqrt(xs.length))), 3);
  });

  it('verdict: GO on real positive edge, NO_GO on negative edge', () => {
    const rand = mulberry32(3);
    const good = new NigEstimator(prior);
    const bad = new NigEstimator(prior);
    for (let i = 0; i < 3000; i++) {
      good.update(2 + 10 * gaussian(rand));
      bad.update(-1 + 10 * gaussian(rand));
    }
    expect(good.verdict().verdict).toBe('GO');
    expect(bad.verdict().verdict).toBe('NO_GO');
    const [lo, hi] = good.credibleInterval(0.95);
    expect(lo).toBeLessThan(2);
    expect(hi).toBeGreaterThan(2);
  });

  it('verdict: CONTINUE before the minimum sample', () => {
    const e = new NigEstimator(prior);
    for (let i = 0; i < 10; i++) e.update(50);
    expect(e.verdict({ minN: 168, goMinEdge: 1, goProb: 0.95, noGoProb: 0.05 }).verdict).toBe('CONTINUE');
  });

  it('property: posterior is order-invariant and restorable from state', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: -100, max: 100, noNaN: true }), { minLength: 1, maxLength: 60 }), (xs) => {
        const a = new NigEstimator(prior);
        const b = new NigEstimator(prior);
        xs.forEach((x) => a.update(x));
        [...xs].reverse().forEach((x) => b.update(x));
        expect(b.posterior().mu).toBeCloseTo(a.posterior().mu, 6);
        expect(b.posterior().beta).toBeCloseTo(a.posterior().beta, 3);
        const restored = new NigEstimator(prior, a.state);
        expect(restored.posterior()).toEqual(a.posterior());
      }),
    );
  });

  it('sample size and Bonferroni helpers', () => {
    expect(requiredSampleSize(2, 15)).toBe(153);
    expect(bonferroniZ(0.05, 1)).toBeCloseTo(1.6449, 3);
    expect(bonferroniZ(0.05, 10)).toBeCloseTo(2.5758, 3);
  });
});

describe('volatility', () => {
  it('TimeEwma halves the gap after one half-life', () => {
    const e = new TimeEwma(1000);
    e.update(0, 0);
    expect(e.update(1000, 10)).toBeCloseTo(5, 12);
  });

  it('recovers σ of a GBM within 10%', () => {
    const rand = mulberry32(11);
    const v = new VolEstimator({ halfLifeMs: 30 * 60_000, sampleMs: 1000, initialSigmaBps: 0.5, minSigmaBps: 0.01, maxSigmaBps: 100 });
    const sigma = 2 / 1e4; // 2 bps/√s
    let p = 100;
    for (let t = 0; t <= 4 * 3600_000; t += 1000) {
      p *= Math.exp(sigma * gaussian(rand));
      v.onPrice(t, p);
    }
    expect(v.sigmaBps()).toBeGreaterThan(1.8);
    expect(v.sigmaBps()).toBeLessThan(2.2);
  });

  it('ignores samples closer than sampleMs (microstructure noise)', () => {
    const v = new VolEstimator({ halfLifeMs: 1000, sampleMs: 1000, initialSigmaBps: 1, minSigmaBps: 0, maxSigmaBps: 1000 });
    v.onPrice(0, 100);
    v.onPrice(10, 200);
    expect(v.samples).toBe(0);
    expect(v.sigmaBps()).toBeCloseTo(1, 12);
  });
});
