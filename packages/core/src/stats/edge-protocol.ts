import { normalQuantile, studentTQuantile } from '../math/special';
import { DEFAULT_EDGE_PRIOR, NigEstimator, type NigPrior } from './nig';

/**
 * Pre-registered GO/NO-GO decision for a multi-pair shadow (E4 → E10). Pure and deterministic.
 *
 * Why a protocol and not just "look at the dashboard": with m pairs evaluated at K moments, the
 * chance that at least one pair *looks* good by luck grows with m·K (multiple comparisons and
 * optional stopping). The rule below controls the family-wise probability of a false GO:
 *
 *   P(any pair, at any look, is declared GO | every pair's true edge μ ≤ ε) ≤ familyAlpha
 *
 * by Bonferroni over pairs × looks: pair i is GO at look k iff P(μ_i > ε | data up to look k) ≥
 * 1 − familyAlpha/(m·K). With the weak, skeptical NIG prior this posterior probability is a
 * one-sided t-test of H0: μ ≤ ε (slightly conservative), so the union bound gives the guarantee.
 *
 * Rules that make the guarantee real (each one closes a known way of fooling yourself):
 * - Only the pre-registered looks are evaluated, each on exactly its own time span, so running
 *   the evaluator more often (or later) never changes a result.
 * - m counts every pre-registered pair, including pairs that die or are never evaluated.
 * - Observations are the MTM equity return per window (inventory included, no survivorship bias).
 * - Positive lag-1 autocorrelation (inventory carries over windows) shrinks the effective sample:
 *   the variance is inflated by (1+ρ)/(1−ρ); negative autocorrelation is never used to deflate it.
 * - A look that misses too much time (downtime, dead feed, delisting) is not decisive, and the
 *   final look fails closed: anything but GO is NO_GO.
 * - Futility (P(μ > 0) < futilityProb) may stop a pair early; stopping for futility cannot cause
 *   a false GO, so it needs no correction.
 */
export interface EdgeProtocolRule {
  /** One observation = MTM equity return over one engine edge window, in bps of the window-start equity. */
  windowMs: number;
  /** Pre-registered looks, in hours since the evaluation start. Strictly increasing. */
  looksHours: number[];
  /** Family-wise probability of a false GO across all pairs and all looks. */
  familyAlpha: number;
  /** GO requires P(μ > goMinEdgeBps) ≥ 1 − familyAlpha/(m·K). In bps of equity per window. */
  goMinEdgeBps: number;
  /** NO_GO (futility) when P(μ > 0) < futilityProb at a valid look. */
  futilityProb: number;
  /** GO also requires at least this many simulated fills inside the look. */
  minFills: number;
  /** A look whose observations miss more than this fraction of its time span is not decisive. */
  maxGapFraction: number;
  /** A look is evaluated with partial data once this long has passed after its end (dead pair). */
  graceMs: number;
  prior: NigPrior;
  /** Inflate the variance by the AR(1) factor when the lag-1 autocorrelation is positive. */
  autocorrelationAdjust: boolean;
}

/**
 * Master plan §3.6: ≥ 7 days and ≥ 300 fills, GO if P(μ > 1 bp) is high, NO_GO if P(μ > 0) < 5 %,
 * Bonferroni. Looks at 7, 14 and 21 days; the window closes at 21 days.
 */
export const DEFAULT_EDGE_PROTOCOL_RULE: EdgeProtocolRule = {
  windowMs: 3_600_000,
  looksHours: [168, 336, 504],
  familyAlpha: 0.05,
  goMinEdgeBps: 1,
  futilityProb: 0.05,
  minFills: 300,
  maxGapFraction: 0.05,
  graceMs: 24 * 3_600_000,
  prior: DEFAULT_EDGE_PRIOR,
  autocorrelationAdjust: true,
};

const HOUR_MS = 3_600_000;
/** Cap for the lag-1 autocorrelation used in the variance inflation (factor ≤ 19). */
const RHO_CAP = 0.9;

export function validateEdgeProtocolRule(r: EdgeProtocolRule): void {
  const bad = (m: string) => {
    throw new RangeError(`edge protocol: ${m}`);
  };
  if (!(r.windowMs > 0)) bad('windowMs must be > 0');
  if (r.looksHours.length === 0) bad('at least one look');
  r.looksHours.forEach((h, i) => {
    if (!(h > 0) || (i > 0 && !(h > r.looksHours[i - 1]!))) bad('looksHours must be positive and strictly increasing');
    if (h * HOUR_MS < 2 * r.windowMs) bad('each look must span at least two windows');
  });
  if (!(r.familyAlpha > 0 && r.familyAlpha < 0.5)) bad('familyAlpha must be in (0, 0.5)');
  if (!(r.futilityProb > 0 && r.futilityProb < 0.5)) bad('futilityProb must be in (0, 0.5)');
  if (!Number.isFinite(r.goMinEdgeBps) || r.goMinEdgeBps < 0) bad('goMinEdgeBps must be ≥ 0');
  if (!Number.isInteger(r.minFills) || r.minFills < 0) bad('minFills must be a non-negative integer');
  if (!(r.maxGapFraction >= 0 && r.maxGapFraction < 1)) bad('maxGapFraction must be in [0, 1)');
  if (!(r.graceMs >= 0)) bad('graceMs must be ≥ 0');
}

/** Posterior probability a pair needs for GO: 1 − α/(m·K). */
export function goProbabilityThreshold(rule: EdgeProtocolRule, pairs: number): number {
  if (!Number.isInteger(pairs) || pairs < 1) throw new RangeError('pairs must be a positive integer');
  return 1 - rule.familyAlpha / (pairs * rule.looksHours.length);
}

/**
 * Smallest mean edge (bps per window) that reaches GO at a look with probability ≈ 50 %, for a
 * per-window standard deviation σ (normal approximation, no autocorrelation). Use it to state
 * honestly what the shadow can and cannot prove before the window opens.
 */
export function minimumDetectableEdge(rule: EdgeProtocolRule, pairs: number, sigmaBps: number, lookIndex: number): number {
  const hours = rule.looksHours[lookIndex];
  if (hours === undefined) throw new RangeError(`no look ${lookIndex}`);
  if (!(sigmaBps > 0)) throw new RangeError('sigmaBps must be > 0');
  const n = (hours * HOUR_MS) / rule.windowMs;
  return rule.goMinEdgeBps + normalQuantile(goProbabilityThreshold(rule, pairs)) * (sigmaBps / Math.sqrt(n));
}

export interface EdgeObservation {
  startTs: number;
  endTs: number;
  returnBps: number;
}

/** Everything the protocol needs from one pair's run, already restricted to ts ≥ registration. */
export interface PairSeries {
  /** Consecutive edge windows, in time order. */
  observations: EdgeObservation[];
  /** Simulated fill timestamps, in time order. */
  fillTs: number[];
  /** Timestamp of the last input record of the run. */
  dataEndTs: number;
}

export type LookVerdict = 'GO' | 'NO_GO' | 'CONTINUE' | 'INVALID';

export interface LookResult {
  look: number;
  hours: number;
  endTs: number;
  verdict: LookVerdict;
  reasons: string[];
  n: number;
  /** Effective sample size after the autocorrelation adjustment. */
  nEff: number;
  rho1: number;
  meanBps: number;
  sdBps: number;
  /** P(μ > goMinEdgeBps | data). */
  pGo: number;
  /** P(μ > 0 | data). */
  pPositive: number;
  threshold: number;
  /** One-sided lower credible bound for μ at the corrected level (bps per window). */
  lowerBoundBps: number;
  fills: number;
  gapFraction: number;
}

export interface PairDecision {
  decision: 'GO' | 'NO_GO' | 'PENDING';
  reason: string;
  startTs?: number;
  decidedAtLook?: number;
  /** For PENDING: the look the pair is waiting for. */
  nextLook?: number;
  looks: LookResult[];
}

function lag1Autocorrelation(xs: number[], mean: number): number {
  if (xs.length < 3) return 0;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i]! - mean;
    den += d * d;
    if (i + 1 < xs.length) num += d * (xs[i + 1]! - mean);
  }
  return den > 0 ? num / den : 0;
}

function countInRange(sorted: number[], lo: number, hi: number): number {
  const lowerBound = (x: number, strict: boolean) => {
    let a = 0;
    let b = sorted.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (strict ? sorted[mid]! <= x : sorted[mid]! < x) a = mid + 1;
      else b = mid;
    }
    return a;
  };
  return lowerBound(hi, true) - lowerBound(lo, false);
}

/** One pre-registered look of one pair, on exactly [startTs, startTs + hours]. */
export function evaluateLook(series: PairSeries, startTs: number, lookIndex: number, rule: EdgeProtocolRule, pairs: number): LookResult {
  const hours = rule.looksHours[lookIndex];
  if (hours === undefined) throw new RangeError(`no look ${lookIndex}`);
  const lookMs = hours * HOUR_MS;
  const endTs = startTs + lookMs;
  const threshold = goProbabilityThreshold(rule, pairs);
  const used = series.observations.filter((o) => o.startTs >= startTs && o.endTs <= endTs);
  const xs = used.map((o) => o.returnBps);
  const n = xs.length;
  const covered = used.reduce((a, o) => a + Math.min(o.endTs - o.startTs, rule.windowMs), 0);
  const gapFraction = Math.max(0, 1 - covered / lookMs);
  const fills = countInRange(series.fillTs, startTs, endTs);
  const reasons: string[] = [];
  const base = { look: lookIndex, hours, endTs, n, threshold, fills, gapFraction };

  if (n < 2) {
    return { ...base, verdict: 'INVALID', reasons: ['fewer than 2 observations'], nEff: n, rho1: 0, meanBps: n ? xs[0]! : 0, sdBps: 0, pGo: 0, pPositive: 0, lowerBoundBps: Number.NEGATIVE_INFINITY };
  }
  let mean = 0;
  let m2 = 0;
  xs.forEach((x, i) => {
    const d = x - mean;
    mean += d / (i + 1);
    m2 += d * (x - mean);
  });
  const variance = m2 / (n - 1);
  const rho1 = lag1Autocorrelation(xs, mean);
  const rho = rule.autocorrelationAdjust ? Math.min(Math.max(rho1, 0), RHO_CAP) : 0;
  const nEff = Math.max(n * ((1 - rho) / (1 + rho)), 1 + 1e-9);
  const est = new NigEstimator(rule.prior, { n: nEff, mean, m2: variance * (nEff - 1) });
  const pGo = est.probGreaterThan(rule.goMinEdgeBps);
  const pPositive = est.probGreaterThan(0);
  const post = est.posterior();
  const lowerBoundBps = post.mu - studentTQuantile(threshold, post.df) * post.scale;

  let verdict: LookVerdict;
  if (gapFraction > rule.maxGapFraction) {
    verdict = 'INVALID';
    reasons.push(`data covers ${((1 - gapFraction) * 100).toFixed(1)} % of the look (needs ≥ ${((1 - rule.maxGapFraction) * 100).toFixed(1)} %)`);
  } else if (pGo >= threshold && fills >= rule.minFills) {
    verdict = 'GO';
    reasons.push(`P(μ > ${rule.goMinEdgeBps} bp) = ${pGo.toFixed(5)} ≥ ${threshold.toFixed(5)} with ${fills} fills`);
  } else if (pPositive < rule.futilityProb) {
    verdict = 'NO_GO';
    reasons.push(`futility: P(μ > 0) = ${pPositive.toFixed(5)} < ${rule.futilityProb}`);
  } else {
    verdict = 'CONTINUE';
    if (pGo < threshold) reasons.push(`P(μ > ${rule.goMinEdgeBps} bp) = ${pGo.toFixed(5)} < ${threshold.toFixed(5)}`);
    if (fills < rule.minFills) reasons.push(`${fills} fills < ${rule.minFills}`);
  }
  return { ...base, verdict, reasons, nEff, rho1, meanBps: mean, sdBps: Math.sqrt(variance), pGo, pPositive, lowerBoundBps };
}

export interface DecideOptions {
  /** Evaluation time: lets looks of a pair that stopped recording be closed after the grace period. */
  asOf?: number;
  /** Registration time: a pair with no observations by registration + last look + grace is NO_GO. */
  registeredAt?: number;
}

/**
 * Sequential decision for one pair: walk the pre-registered looks in order and stop at the first
 * GO or NO_GO. A look is evaluated only when the data has passed its end (or, for a pair that
 * stopped recording, when `asOf` is past its end + grace). At the last look, anything but GO is
 * NO_GO, and a pair that never produced data is NO_GO once the whole window could have elapsed.
 */
export function decidePair(series: PairSeries, rule: EdgeProtocolRule, pairs: number, opts: DecideOptions = {}): PairDecision {
  validateEdgeProtocolRule(rule);
  const asOf = opts.asOf ?? Number.NEGATIVE_INFINITY;
  const first = series.observations[0];
  if (!first) {
    const deadline = opts.registeredAt === undefined ? Number.POSITIVE_INFINITY : opts.registeredAt + rule.looksHours[rule.looksHours.length - 1]! * HOUR_MS + rule.graceMs;
    return asOf >= deadline
      ? { decision: 'NO_GO', reason: `no data by the deadline ${new Date(deadline).toISOString()} (fail-closed)`, looks: [] }
      : { decision: 'PENDING', reason: 'no observations after the registration', nextLook: 0, looks: [] };
  }
  const startTs = first.startTs;
  const looks: LookResult[] = [];
  const last = rule.looksHours.length - 1;
  for (let k = 0; k <= last; k++) {
    const endTs = startTs + rule.looksHours[k]! * HOUR_MS;
    if (series.dataEndTs < endTs && asOf < endTs + rule.graceMs) {
      return { decision: 'PENDING', reason: `waiting for look ${k} (${rule.looksHours[k]} h) at ${new Date(endTs).toISOString()}`, startTs, nextLook: k, looks };
    }
    const r = evaluateLook(series, startTs, k, rule, pairs);
    looks.push(r);
    if (r.verdict === 'GO' || r.verdict === 'NO_GO') return { decision: r.verdict, reason: r.reasons.join('; '), startTs, decidedAtLook: k, looks };
    if (k === last) {
      return { decision: 'NO_GO', reason: `final look without GO (fail-closed): ${r.reasons.join('; ')}`, startTs, decidedAtLook: k, looks };
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}
