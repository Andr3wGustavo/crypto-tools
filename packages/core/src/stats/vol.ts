/**
 * Time-aware estimators for irregularly sampled market data.
 * All decay is expressed as a half-life in milliseconds, so behaviour does not depend on tick rate.
 */

/** Exponentially weighted mean with time-based decay. */
export class TimeEwma {
  private v = 0;
  private lastTs = 0;
  private init = false;

  constructor(private readonly halfLifeMs: number) {
    if (!(halfLifeMs > 0)) throw new RangeError('halfLifeMs must be > 0');
  }

  update(ts: number, x: number): number {
    if (!Number.isFinite(x)) return this.v;
    if (!this.init) {
      this.v = x;
      this.lastTs = ts;
      this.init = true;
      return this.v;
    }
    const dt = Math.max(0, ts - this.lastTs);
    const a = 1 - Math.pow(2, -dt / this.halfLifeMs);
    this.v += a * (x - this.v);
    this.lastTs = ts;
    return this.v;
  }

  get value(): number {
    return this.v;
  }

  get initialized(): boolean {
    return this.init;
  }
}

export interface VolParams {
  halfLifeMs: number;
  /** Minimum spacing between samples; suppresses microstructure noise (bid-ask bounce). */
  sampleMs: number;
  initialSigmaBps: number;
  minSigmaBps: number;
  maxSigmaBps: number;
}

export const DEFAULT_VOL_PARAMS: VolParams = {
  halfLifeMs: 5 * 60_000,
  sampleMs: 1_000,
  initialSigmaBps: 1.5,
  minSigmaBps: 0.2,
  maxSigmaBps: 50,
};

/**
 * Realized volatility as σ in bps per √second, from log-returns of a reference price.
 * Variance rate EWMA: v ← v + a·(r²/Δt − v), a = 1 − 2^(−Δt/halfLife).
 */
export class VolEstimator {
  private varRate: number; // (log-return)² per second
  private lastTs: number | undefined;
  private lastPrice: number | undefined;
  private n = 0;

  constructor(private readonly p: VolParams = DEFAULT_VOL_PARAMS) {
    const s = p.initialSigmaBps / 1e4;
    this.varRate = s * s;
  }

  onPrice(ts: number, price: number): void {
    if (!(price > 0) || !Number.isFinite(price)) return;
    if (this.lastTs === undefined || this.lastPrice === undefined) {
      this.lastTs = ts;
      this.lastPrice = price;
      return;
    }
    const dt = ts - this.lastTs;
    if (dt < this.p.sampleMs) return;
    const r = Math.log(price / this.lastPrice);
    const rate = (r * r) / (dt / 1000);
    const a = 1 - Math.pow(2, -dt / this.p.halfLifeMs);
    this.varRate += a * (rate - this.varRate);
    this.lastTs = ts;
    this.lastPrice = price;
    this.n++;
  }

  sigmaBps(): number {
    const s = Math.sqrt(this.varRate) * 1e4;
    return Math.min(this.p.maxSigmaBps, Math.max(this.p.minSigmaBps, s));
  }

  get samples(): number {
    return this.n;
  }
}
