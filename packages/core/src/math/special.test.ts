import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  logGamma, normalCdf, normalQuantile, regularizedIncompleteBeta, studentTCdf, studentTQuantile,
} from './special';

describe('special functions', () => {
  it('logGamma matches known values', () => {
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
    expect(logGamma(10.5)).toBeCloseTo(13.940625219403763, 10);
  });

  it('incomplete beta matches closed forms', () => {
    expect(regularizedIncompleteBeta(1, 1, 0.37)).toBeCloseTo(0.37, 12);
    expect(regularizedIncompleteBeta(3, 1, 0.3)).toBeCloseTo(0.027, 12); // I_x(a,1) = x^a
    expect(regularizedIncompleteBeta(1, 4, 0.2)).toBeCloseTo(1 - 0.8 ** 4, 12); // I_x(1,b) = 1-(1-x)^b
  });

  it('Student-t CDF matches statistical tables', () => {
    expect(studentTCdf(0, 7)).toBe(0.5);
    expect(studentTCdf(1, 1)).toBeCloseTo(0.75, 12); // Cauchy
    expect(studentTCdf(2.2281389, 10)).toBeCloseTo(0.975, 6);
    expect(studentTCdf(1.8124611, 10)).toBeCloseTo(0.95, 6);
    expect(studentTCdf(2.0859634, 20)).toBeCloseTo(0.975, 6);
    expect(studentTCdf(-2.0859634, 20)).toBeCloseTo(0.025, 6);
  });

  it('Student-t converges to the normal for large ν', () => {
    expect(studentTCdf(1.959964, 1e7)).toBeCloseTo(0.975, 5);
  });

  it('normal CDF and quantiles', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.6448536269514722)).toBeCloseTo(0.95, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 4);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.2281389, 5);
  });

  it('property: t CDF is symmetric and monotone', () => {
    fc.assert(
      fc.property(fc.double({ min: -50, max: 50, noNaN: true }), fc.double({ min: 0.5, max: 500, noNaN: true }), (t, nu) => {
        const a = studentTCdf(t, nu);
        expect(a + studentTCdf(-t, nu)).toBeCloseTo(1, 9);
        expect(studentTCdf(t + 0.1, nu)).toBeGreaterThanOrEqual(a - 1e-12);
      }),
    );
  });
});
