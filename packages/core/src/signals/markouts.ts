/**
 * Markouts: how the mid moved after each of our fills (positive = good for us).
 *   BUY  fill at p: (mid(t+h)/p − 1)·1e4
 *   SELL fill at p: (1 − mid(t+h)/p)·1e4
 * Adverse selection estimate AS = −mean(markout at the reference horizon), shrunk toward a prior
 * and floored at 0. It is the "c" (cost) in δ* = c + 1/k.
 */
export interface MarkoutFill {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  ts: number;
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
  private pending: Array<MarkoutFill & { done: Set<number> }> = [];
  private sum = 0;
  private count = 0;

  constructor(private readonly p: MarkoutParams = DEFAULT_MARKOUTS) {}

  addFill(f: MarkoutFill): void {
    this.pending.push({ ...f, done: new Set() });
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
          this.sum += bps;
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
    const est = (w * this.p.priorAsBps + -this.sum) / (w + this.count);
    return Math.max(0, est);
  }

  get observed(): number {
    return this.count;
  }
}
