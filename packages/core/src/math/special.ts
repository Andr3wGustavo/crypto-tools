/**
 * Special functions for the Bayesian edge estimator. Pure and deterministic.
 * References: Lanczos approximation (g = 7, n = 9); Numerical Recipes betacf / erfcc.
 */

const LANCZOS_G = 7;
const LANCZOS_COEF = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
] as const;

/** ln Γ(x) for x > 0. */
export function logGamma(x: number): number {
  if (!(x > 0)) throw new RangeError(`logGamma requires x > 0, got ${x}`);
  if (x < 0.5) {
    // Reflection formula: Γ(x)Γ(1 − x) = π / sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS_COEF[0];
  const t = z + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_COEF.length; i++) a += LANCZOS_COEF[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAX_ITER = 500;
  const EPS = 1e-15;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (!(a > 0) || !(b > 0)) throw new RangeError('a and b must be > 0');
  if (x < 0 || x > 1 || Number.isNaN(x)) throw new RangeError(`x must be in [0, 1], got ${x}`);
  if (x === 0 || x === 1) return x;
  const lnFront =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  const front = Math.exp(lnFront);
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** CDF of Student's t with ν degrees of freedom. */
export function studentTCdf(t: number, nu: number): number {
  if (!(nu > 0)) throw new RangeError(`nu must be > 0, got ${nu}`);
  if (Number.isNaN(t)) return Number.NaN;
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = nu / (nu + t * t);
  const tail = 0.5 * regularizedIncompleteBeta(nu / 2, 0.5, x); // P(T > |t|)
  return t >= 0 ? 1 - tail : tail;
}

/** Complementary error function (Numerical Recipes erfcc, fractional error < 1.2e-7). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** Standard normal CDF Φ(x). */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** Generic monotone inverse by bracketing + bisection (robust, ~1e-12 precision). */
function invertMonotone(cdf: (x: number) => number, p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`p must be in (0, 1), got ${p}`);
  let lo = -1;
  let hi = 1;
  while (cdf(lo) > p) lo *= 2;
  while (cdf(hi) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  return 0.5 * (lo + hi);
}

/** Quantile of Student's t. */
export function studentTQuantile(p: number, nu: number): number {
  return invertMonotone((x) => studentTCdf(x, nu), p);
}

/** Quantile of the standard normal. */
export function normalQuantile(p: number): number {
  return invertMonotone(normalCdf, p);
}
