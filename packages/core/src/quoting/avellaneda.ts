/**
 * Avellaneda–Stoikov quoting, dimensionally consistent in basis points.
 *
 *   σ        : volatility in bps / √s
 *   γ        : risk aversion in 1/bps
 *   k        : fill-intensity decay in 1/bps   (λ(δ) = A·e^(−kδ))
 *   τ        : inventory horizon in seconds
 *   q        : normalized inventory in [−1, 1] (1 = at inventory cap)
 *
 *   skew     = q·γ·σ²·τ                       (reservation offset, bps)
 *   half     = c + (1/γ)·ln(1 + γ/k) + γ·σ²·τ/2  (half spread, bps; → c + 1/k as γ → 0)
 *
 * v2 used fractions with γ = 0.1, k = 1.5 which produced a 129% spread. Here every term is bps
 * and the result is clamped to [minHalfSpreadBps, maxHalfSpreadBps].
 */
export interface AsParams {
  gamma: number;
  k: number;
  tauSec: number;
  minHalfSpreadBps: number;
  maxHalfSpreadBps: number;
  maxSkewBps: number;
}

export interface AsInput {
  fair: number;
  sigmaBps: number;
  q: number;
  costBps: number;
}

export interface AsQuote {
  fair: number;
  reservation: number;
  halfSpreadBps: number;
  skewBps: number;
  varianceBps2: number;
  bid: number;
  ask: number;
}

export const DEFAULT_AS_PARAMS: AsParams = {
  gamma: 0.05,
  k: 0.3,
  tauSec: 30,
  minHalfSpreadBps: 2,
  maxHalfSpreadBps: 50,
  maxSkewBps: 15,
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function liquidityTermBps(gamma: number, k: number): number {
  if (!(k > 0)) throw new RangeError('k must be > 0');
  return gamma > 1e-12 ? Math.log1p(gamma / k) / gamma : 1 / k;
}

export function computeAsQuote(p: AsParams, input: AsInput): AsQuote {
  const { fair, sigmaBps, costBps } = input;
  if (!(fair > 0) || !Number.isFinite(fair)) throw new RangeError(`fair must be > 0, got ${fair}`);
  if (!(sigmaBps >= 0)) throw new RangeError('sigmaBps must be >= 0');
  if (p.minHalfSpreadBps > p.maxHalfSpreadBps) throw new RangeError('minHalfSpread > maxHalfSpread');
  const q = clamp(input.q, -1, 1);
  const varianceBps2 = sigmaBps * sigmaBps * p.tauSec;
  const rawHalf = Math.max(0, costBps) + liquidityTermBps(p.gamma, p.k) + (p.gamma * varianceBps2) / 2;
  const halfSpreadBps = clamp(rawHalf, p.minHalfSpreadBps, p.maxHalfSpreadBps);
  const skewBps = clamp(q * p.gamma * varianceBps2, -p.maxSkewBps, p.maxSkewBps);
  const reservation = fair * (1 - skewBps / 1e4);
  return {
    fair,
    reservation,
    halfSpreadBps,
    skewBps,
    varianceBps2,
    bid: reservation * (1 - halfSpreadBps / 1e4),
    ask: reservation * (1 + halfSpreadBps / 1e4),
  };
}
