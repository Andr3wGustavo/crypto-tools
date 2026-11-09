import { normalQuantile, studentTCdf, studentTQuantile } from '../math/special';

/**
 * Normal-Inverse-Gamma model of the net edge (bps) of the strategy.
 * x_i ~ N(μ, σ²), (μ, σ²) ~ NIG(μ0, κ0, α0, β0). Conjugate, so the posterior is exact.
 * Marginal posterior of μ: Student-t with ν = 2α, location μ_n, scale² = β_n / (α_n κ_n).
 *
 * Observations should be PnL *mark-to-market per time window* (e.g. per hour, in bps of equity),
 * not only completed round-trips — that would ignore one-sided inventory losses (survivorship bias).
 */
export interface NigPrior {
  mu0: number;
  kappa0: number;
  alpha0: number;
  beta0: number;
}

/** Sufficient statistics in Welford form (numerically stable, order-independent up to fp error). */
export interface NigState {
  n: number;
  mean: number;
  m2: number;
}

export interface NigPosterior {
  n: number;
  mu: number;
  kappa: number;
  alpha: number;
  beta: number;
  df: number;
  scale: number;
}

export type EdgeVerdict = 'GO' | 'NO_GO' | 'CONTINUE';

export interface EdgeGateConfig {
  /** Minimum observations before any verdict. */
  minN: number;
  /** GO requires P(μ > goMinEdge) > goProb. */
  goMinEdge: number;
  goProb: number;
  /** NO_GO when P(μ > 0) < noGoProb. */
  noGoProb: number;
}

/** Skeptical prior: zero edge, prior E[σ²] = β0/(α0−1) = 100 bps² (σ ≈ 10 bps). */
export const DEFAULT_EDGE_PRIOR: NigPrior = { mu0: 0, kappa0: 1, alpha0: 2, beta0: 100 };

export const DEFAULT_EDGE_GATE: EdgeGateConfig = { minN: 168, goMinEdge: 1, goProb: 0.95, noGoProb: 0.05 };

export class NigEstimator {
  private s: NigState;

  constructor(
    readonly prior: NigPrior = DEFAULT_EDGE_PRIOR,
    state?: NigState,
  ) {
    if (!(prior.kappa0 > 0) || !(prior.alpha0 > 0) || !(prior.beta0 > 0)) {
      throw new RangeError('NIG prior requires kappa0, alpha0, beta0 > 0');
    }
    this.s = state ? { ...state } : { n: 0, mean: 0, m2: 0 };
  }

  update(x: number): void {
    if (!Number.isFinite(x)) throw new RangeError(`observation must be finite, got ${x}`);
    const n = this.s.n + 1;
    const delta = x - this.s.mean;
    const mean = this.s.mean + delta / n;
    this.s = { n, mean, m2: this.s.m2 + delta * (x - mean) };
  }

  get state(): NigState {
    return { ...this.s };
  }

  get n(): number {
    return this.s.n;
  }

  posterior(): NigPosterior {
    const { mu0, kappa0, alpha0, beta0 } = this.prior;
    const { n, mean, m2 } = this.s;
    const kappa = kappa0 + n;
    const mu = n === 0 ? mu0 : (kappa0 * mu0 + n * mean) / kappa;
    const alpha = alpha0 + n / 2;
    const beta = n === 0 ? beta0 : beta0 + 0.5 * m2 + (kappa0 * n * (mean - mu0) ** 2) / (2 * kappa);
    const df = 2 * alpha;
    const scale = Math.sqrt(beta / (alpha * kappa));
    return { n, mu, kappa, alpha, beta, df, scale };
  }

  /** P(μ > m | data). */
  probGreaterThan(m: number): number {
    const p = this.posterior();
    return studentTCdf((p.mu - m) / p.scale, p.df);
  }

  /** Equal-tailed credible interval for μ. */
  credibleInterval(level = 0.95): [number, number] {
    const p = this.posterior();
    const tq = studentTQuantile(0.5 + level / 2, p.df);
    return [p.mu - tq * p.scale, p.mu + tq * p.scale];
  }

  verdict(cfg: EdgeGateConfig = DEFAULT_EDGE_GATE): { verdict: EdgeVerdict; pGo: number; pPositive: number } {
    const pGo = this.probGreaterThan(cfg.goMinEdge);
    const pPositive = this.probGreaterThan(0);
    if (this.s.n < cfg.minN) return { verdict: 'CONTINUE', pGo, pPositive };
    if (pGo > cfg.goProb) return { verdict: 'GO', pGo, pPositive };
    if (pPositive < cfg.noGoProb) return { verdict: 'NO_GO', pGo, pPositive };
    return { verdict: 'CONTINUE', pGo, pPositive };
  }
}

/** n ≈ (z·σ/μ)² observations to detect edge μ with one-sided confidence z. */
export function requiredSampleSize(mu: number, sigma: number, z = 1.6448536269514722): number {
  if (!(mu > 0) || !(sigma > 0)) throw new RangeError('mu and sigma must be > 0');
  return Math.ceil(((z * sigma) / mu) ** 2);
}

/** One-sided z for family-wise error α across m simultaneous tests (Bonferroni). */
export function bonferroniZ(alpha: number, m: number): number {
  if (!(alpha > 0 && alpha < 1) || !(m >= 1)) throw new RangeError('invalid alpha or m');
  return normalQuantile(1 - alpha / m);
}
