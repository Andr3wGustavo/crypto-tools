import { logger } from '../../utils/logger';

/**
 * Bayesian Edge Estimator using Normal-Inverse-Gamma conjugate prior.
 * Models net PnL per round-trip (in bps) as Normal with unknown mean and variance.
 * Trade only if P(mu > 0 | data) > threshold (default 0.95).
 */
export class EdgeEstimatorService {
    // NIG prior parameters
    private mu0: number;       // prior mean
    private kappa0: number;    // prior precision (pseudo-observations for mean)
    private alpha0: number;    // prior shape (pseudo-observations for variance)
    private beta0: number;     // prior scale

    // Posterior state
    private kappa: number;
    private alpha: number;
    private beta: number;
    private mu: number;       // posterior mean
    private n: number;        // number of observations
    private sumX: number;     // sum of observations
    private sumX2: number;    // sum of squared observations

    private threshold: number;

    constructor(
        priorMean = 0,          // conservative: assume zero edge
        priorPrecision = 1,     // pseudo-observations for mean
        priorShape = 1,         // pseudo-observations for variance
        priorScale = 100,       // prior variance scale (bps^2)
        threshold = 0.95
    ) {
        this.mu0 = priorMean;
        this.kappa0 = priorPrecision;
        this.alpha0 = priorShape;
        this.beta0 = priorScale;
        this.threshold = threshold;

        // Initialize posterior = prior
        this.kappa = priorPrecision;
        this.alpha = priorShape;
        this.beta = priorScale;
        this.mu = priorMean;
        this.n = 0;
        this.sumX = 0;
        this.sumX2 = 0;
    }

    /**
     * Update posterior with a new round-trip PnL observation (in bps).
     */
    update(pnlBps: number): void {
        this.n++;
        this.sumX += pnlBps;
        this.sumX2 += pnlBps * pnlBps;

        // NIG posterior update
        this.kappa = this.kappa0 + this.n;
        this.mu = (this.kappa0 * this.mu0 + this.sumX) / this.kappa;
        this.alpha = this.alpha0 + this.n / 2;
        // beta update: beta0 + 0.5*(sumX2 - sumX^2/n) + (kappa0*n*(mu0 - mean)^2)/(2*(kappa0+n))
        const sampleMean = this.sumX / this.n;
        const ss = this.sumX2 - (this.sumX * this.sumX) / this.n;
        const meanDiff = this.mu0 - sampleMean;
        this.beta = this.beta0 + 0.5 * ss + (this.kappa0 * this.n * meanDiff * meanDiff) / (2 * (this.kappa0 + this.n));
    }

    /**
     * Compute P(mu > 0 | data) using the posterior predictive t-distribution.
     * For NIG, the marginal of mu is a Student-t with 2*alpha degrees of freedom.
     */
    getProbPositiveEdge(): number {
        // Posterior mean of mu
        const posteriorMean = this.mu;
        // Posterior variance of mu: beta / (alpha * kappa)  (approx for NIG)
        const posteriorVar = this.beta / (this.alpha * this.kappa);
        const posteriorStd = Math.sqrt(posteriorVar);
        // Degrees of freedom
        const df = 2 * this.alpha;
        // t-statistic
        const t = posteriorMean / posteriorStd;
        // P(mu > 0) = P(T_df > -t) = 1 - CDF(-t) = CDF(t)
        // Approximate using normal CDF for large df, or t CDF
        return this.tCDF(t, df);
    }

    /**
     * Get posterior mean edge (in bps).
     */
    getPosteriorMean(): number {
        return this.mu;
    }

    /**
     * Get posterior standard deviation.
     */
    getPosteriorStd(): number {
        return Math.sqrt(this.beta / (this.alpha * this.kappa));
    }

    /**
     * Number of observations.
     */
    getN(): number {
        return this.n;
    }

    /**
     * Should we trade? Gate: P(mu > 0) > threshold.
     */
    shouldTrade(): boolean {
        if (this.n < 5) return false; // need minimum data
        return this.getProbPositiveEdge() > this.threshold;
    }

    /**
     * Approximate Student-t CDF using normal approximation for large df.
     * For small df, use a simple approximation.
     */
    private tCDF(t: number, df: number): number {
        // Use normal CDF approximation (good for df > 30)
        // For exact, would need incomplete beta function
        if (df > 30) {
            return this.normalCDF(t);
        }
        // For small df, use Cornish-Fisher-ish adjustment
        const adjustment = 1 + (t * t) / (4 * df);
        return this.normalCDF(t / Math.sqrt(adjustment));
    }

    private normalCDF(x: number): number {
        // Abramowitz and Stegun approximation
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const p = 0.3275911;
        const sign = x < 0 ? -1 : 1;
        const ax = Math.abs(x) / Math.sqrt(2);
        const t = 1.0 / (1.0 + p * ax);
        const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
        return 0.5 * (1.0 + sign * y);
    }

    /**
     * Get a summary for logging.
     */
    getSummary(): string {
        return `EdgeEstimator: n=${this.n}, mu=${this.mu.toFixed(3)}bps, std=${this.getPosteriorStd().toFixed(3)}, P(mu>0)=${(this.getProbPositiveEdge() * 100).toFixed(1)}%, shouldTrade=${this.shouldTrade()}`;
    }
}