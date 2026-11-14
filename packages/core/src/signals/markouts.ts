/**
 * Two numbers per fill, the standard decomposition of a market maker's fill:
 *
 * - Markout (reported): the fill's PnL marked at t+h, from the FILL PRICE (positive = good).
 *     BUY at p: (mid(t+h)/p − 1)·1e4      SELL at p: (1 − mid(t+h)/p)·1e4
 *   It equals the half spread we captured minus the adverse move.
 *
 * - Adverse selection (the cost "c" in δ* = c + 1/k): how far the fair price moved AGAINST us
 *   after the fill, from the fair price AT THE FILL (m0):
 *     BUY: (1 − mid(t+h)/m0)·1e4           SELL: (mid(t+h)/m0 − 1)·1e4
 *   AS = mean at the reference horizon, shrunk toward a prior, floored at 0.
 *
 * Fixed 2026-11-13: AS used to be −mean(markout), i.e. measured from the fill price, so it was
 * (true AS − captured half spread) and almost always floored to 0: the quoting cost was
 * understated by the half spread and the bot quoted too tight against informed flow.
 */
export interface MarkoutFill {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  ts: number;
  /** Fair (or mid) price when the fill happened. Defaults to the fill price. */
  mid?: number;
}

export interface MarkoutResult {
  fillId: string;
  horizonMs: number;
  bps: number;
  ts: number;
}

export interface MarkoutParams {
  horizonsMs: number[];
  referenceHorizonMs: number;
  priorAsBps: number;
  priorWeight: number;
}

export const DEFAULT_MARKOUTS: MarkoutParams = {
  horizonsMs: [1_000, 5_000, 30_000],
  referenceHorizonMs: 5_000,
  priorAsBps: 2,
  priorWeight: 20,
};

export class MarkoutTracker {
  private pending: Array<MarkoutFill & { m0: number; done: Set<number> }> = [];
  private sum = 0;
  private count = 0;

  constructor(private readonly p: MarkoutParams = DEFAULT_MARKOUTS) {}

  addFill(f: MarkoutFill): void {
    this.pending.push({ ...f, m0: f.mid !== undefined && f.mid > 0 ? f.mid : f.price, done: new Set() });
  }

  onMid(ts: number, mid: number): MarkoutResult[] {
    if (!(mid > 0)) return [];
    const out: MarkoutResult[] = [];
    for (const f of this.pending) {
      for (const h of this.p.horizonsMs) {
        if (f.done.has(h) || ts < f.ts + h) continue;
        const bps = f.side === 'BUY' ? (mid / f.price - 1) * 1e4 : (1 - mid / f.price) * 1e4;
        f.done.add(h);
        out.push({ fillId: f.id, horizonMs: h, bps, ts });
        if (h === this.p.referenceHorizonMs) {
          this.sum += f.side === 'BUY' ? (1 - mid / f.m0) * 1e4 : (mid / f.m0 - 1) * 1e4;
          this.count++;
        }
      }
    }
    this.pending = this.pending.filter((f) => f.done.size < this.p.horizonsMs.length);
    return out;
  }

  /** Shrunk adverse-selection estimate in bps (≥ 0). */
  adverseSelectionBps(): number {
    const w = this.p.priorWeight;
    const est = (w * this.p.priorAsBps + this.sum) / (w + this.count);
    return Math.max(0, est);
  }

  get observed(): number {
    return this.count;
  }
}
