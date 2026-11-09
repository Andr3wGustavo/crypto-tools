import { TimeEwma } from '../stats/vol';

/**
 * Cross-venue lead–lag. The reference venue (Binance) leads price discovery; the local venue
 * (MEXC) follows with latency. We quote around
 *   fair = refMid · exp(basis),   basis = EWMA(ln(localMid / refMid))
 * and pull the side that would be picked off when the reference jumps:
 *   reference up sharply  → our ask is stale-cheap  → pull ask
 *   reference down sharply → our bid is stale-rich  → pull bid
 */
export interface LeadLagParams {
  basisHalfLifeMs: number;
  /** Reference older than this is ignored (fair falls back to the local mid). */
  maxRefAgeMs: number;
  moveWindowMs: number;
  toxicMoveBps: number;
  cooldownMs: number;
}

export const DEFAULT_LEAD_LAG: LeadLagParams = {
  basisHalfLifeMs: 60_000,
  maxRefAgeMs: 2_000,
  moveWindowMs: 500,
  toxicMoveBps: 4,
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

  onReference(ts: number, mid: number): void {
    if (!(mid > 0)) return;
    this.hist.push({ ts, mid });
    const cutoff = ts - Math.max(this.p.moveWindowMs * 4, this.p.maxRefAgeMs);
    while (this.hist.length > 2 && this.hist[0]!.ts < cutoff) this.hist.shift();
    this.updateToxicity(ts);
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

  private updateToxicity(ts: number): void {
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
    if (Math.abs(move) >= this.p.toxicMoveBps) {
      this.toxicUntil = ts + this.p.cooldownMs;
      this.toxicDir = move > 0 ? 'up' : 'down';
    }
  }
}
