import { TimeEwma } from '../stats/vol';

/**
 * Cross-venue lead–lag. The reference venue (Binance) leads price discovery; the local venue
 * (MEXC) follows with latency. We quote around
 *   fair = refMid · exp(basis),   basis = EWMA(ln(localMid / refMid))
 * and pull the side that would be picked off when the reference jumps:
 *   reference up sharply  → our ask is stale-cheap  → pull ask
 *   reference down sharply → our bid is stale-rich  → pull bid
 * "Sharply" = at least toxicMoveBps AND at least toxicZ standard deviations of a normal move over
 * the window (σ·√window). With a fixed 4 bps only, a volatile small cap (σ ≈ 5 bps/√s → ~3.5 bps
 * per 500 ms) was "toxic" most of the time and stopped quoting its reducing side for minutes.
 */
export interface LeadLagParams {
  basisHalfLifeMs: number;
  /** Reference older than this is ignored (fair falls back to the local mid). */
  maxRefAgeMs: number;
  moveWindowMs: number;
  toxicMoveBps: number;
  /** A move is toxic only beyond this many σ of a normal move over the window (0 = off). */
  toxicZ: number;
  cooldownMs: number;
}

export const DEFAULT_LEAD_LAG: LeadLagParams = {
  basisHalfLifeMs: 60_000,
  maxRefAgeMs: 2_000,
  moveWindowMs: 500,
  toxicMoveBps: 4,
  toxicZ: 2.5,
  cooldownMs: 1_500,
};

export interface FairPrice {
  fair: number;
  source: 'reference' | 'local';
  basisBps: number;
}

export interface Toxicity {
  toxic: boolean;
  direction: 'up' | 'down' | null;
  moveBps: number;
}

export class LeadLagModel {
  private readonly basis: TimeEwma;
  private hist: Array<{ ts: number; mid: number }> = [];
  private toxicUntil = 0;
  private toxicDir: 'up' | 'down' | null = null;
  private lastMove = 0;

  constructor(private readonly p: LeadLagParams = DEFAULT_LEAD_LAG) {
    this.basis = new TimeEwma(p.basisHalfLifeMs);
  }

  /** @param sigmaBps current volatility in bps per √second (scales the toxic threshold). */
  onReference(ts: number, mid: number, sigmaBps = 0): void {
    if (!(mid > 0)) return;
    this.hist.push({ ts, mid });
    const cutoff = ts - Math.max(this.p.moveWindowMs * 4, this.p.maxRefAgeMs);
    while (this.hist.length > 2 && this.hist[0]!.ts < cutoff) this.hist.shift();
    this.updateToxicity(ts, sigmaBps);
  }

  /** Move (bps) that counts as toxic at this volatility. */
  threshold(sigmaBps: number): number {
    return Math.max(this.p.toxicMoveBps, (this.p.toxicZ ?? 0) * sigmaBps * Math.sqrt(this.p.moveWindowMs / 1000));
  }

  onLocal(ts: number, localMid: number): void {
    const ref = this.latestRef(ts);
    if (ref && localMid > 0) this.basis.update(ts, Math.log(localMid / ref.mid));
  }

  fair(ts: number, localMid: number): FairPrice {
    const ref = this.latestRef(ts);
    if (ref && this.basis.initialized) {
      const b = this.basis.value;
      return { fair: ref.mid * Math.exp(b), source: 'reference', basisBps: b * 1e4 };
    }
    return { fair: localMid, source: 'local', basisBps: 0 };
  }

  toxicity(ts: number): Toxicity {
    const toxic = ts < this.toxicUntil;
    return { toxic, direction: toxic ? this.toxicDir : null, moveBps: this.lastMove };
  }

  private latestRef(ts: number): { ts: number; mid: number } | undefined {
    const last = this.hist[this.hist.length - 1];
    return last && ts - last.ts <= this.p.maxRefAgeMs ? last : undefined;
  }

  private updateToxicity(ts: number, sigmaBps: number): void {
    const last = this.hist[this.hist.length - 1];
    if (!last) return;
    // Oldest sample inside the window (or the earliest we have).
    let base = this.hist[0]!;
    for (const h of this.hist) {
      if (h.ts >= ts - this.p.moveWindowMs) {
        base = h;
        break;
      }
    }
    const move = (last.mid / base.mid - 1) * 1e4;
    this.lastMove = move;
    if (Math.abs(move) >= this.threshold(sigmaBps)) {
      this.toxicUntil = ts + this.p.cooldownMs;
      this.toxicDir = move > 0 ? 'up' : 'down';
    }
  }
}
