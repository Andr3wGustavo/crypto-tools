/**
 * Fill-intensity model λ(δ) = A·e^(−kδ), δ in bps from fair, calibrated from public trades.
 * A trade "reaches" depth δ on its side if it printed at least δ bps away from fair:
 *   aggressive sell (hits bids):  d = (fair − price)/fair·1e4
 *   aggressive buy  (lifts asks): d = (price − fair)/fair·1e4
 * λ(δ) ≈ #{d ≥ δ} / (2·T)  (per side, per second).  Fit ln λ = ln A − kδ by OLS.
 *
 * With cost c (fee + adverse selection) the expected profit rate of a quote at δ is
 *   π(δ) = λ(δ)·(δ − c)  → maximized at δ* = c + 1/k with π* = (A/k)·e^(−1 − k·c).
 */
export type Aggressor = 'buy' | 'sell';

export function tradeDistanceBps(price: number, fair: number, aggressor: Aggressor): number {
  return aggressor === 'sell' ? ((fair - price) / fair) * 1e4 : ((price - fair) / fair) * 1e4;
}

export interface IntensityFit {
  A: number;
  k: number;
  r2: number;
  nTrades: number;
  points: Array<{ deltaBps: number; ratePerSec: number }>;
}

export const DEFAULT_DELTA_GRID_BPS: number[] = Array.from({ length: 40 }, (_, i) => 0.5 * (i + 1));

export function fitFillIntensity(
  distancesBps: readonly number[],
  durationSec: number,
  gridBps: readonly number[] = DEFAULT_DELTA_GRID_BPS,
  minCount = 3,
): IntensityFit | null {
  if (!(durationSec > 0)) throw new RangeError('durationSec must be > 0');
  const sorted = distancesBps.filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  const n = sorted.length;
  const points: IntensityFit['points'] = [];
  let idx = 0;
  for (const delta of gridBps) {
    while (idx < n && sorted[idx]! < delta) idx++;
    const count = n - idx;
    if (count < minCount) break;
    points.push({ deltaBps: delta, ratePerSec: count / (2 * durationSec) });
  }
  if (points.length < 3) return null;
  const xs = points.map((p) => p.deltaBps);
  const ys = points.map((p) => Math.log(p.ratePerSec));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  const slope = sxy / sxx;
  const k = -slope;
  if (!(k > 0)) return null;
  const A = Math.exp(my - slope * mx);
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 1;
  return { A, k, r2, nTrades: n, points };
}

export const optimalDeltaBps = (k: number, costBps: number): number => costBps + 1 / k;

/** Expected profit in bps-of-notional per second for a quote at δ. */
export const profitRate = (A: number, k: number, deltaBps: number, costBps: number): number =>
  A * Math.exp(-k * deltaBps) * (deltaBps - costBps);

export const maxProfitRate = (A: number, k: number, costBps: number): number =>
  (A / k) * Math.exp(-1 - k * costBps);
