import type { BookTop, Side } from '../quoting/quote-builder';

/**
 * Conservative shadow-mode fill simulator over real public market data.
 *  - Latency: an order is live only `latencyMs` after placement; a cancel takes `latencyMs` to land
 *    (the order can still fill meanwhile — exactly the risk a real maker faces).
 *  - Post-only: if the order would cross the book at activation, it is REJECTED.
 *  - Queue: price better than best → front of queue (0 ahead); equal to best → behind the whole
 *    displayed size; worse than best → only trade-throughs can fill it.
 *  - A trade at our price consumes queue first; a trade *through* our price fills us.
 *  - Each trade's quantity is consumed once across our orders.
 */
export interface SimParams {
  latencyMs: number;
  makerFeeRate: number;
}

export const DEFAULT_SIM: SimParams = { latencyMs: 150, makerFeeRate: 0 };

export interface SimTrade {
  ts: number;
  price: number;
  qty: number;
  aggressor: 'buy' | 'sell';
}

export type SimEvent =
  | { kind: 'order'; ts: number; clientOrderId: string; status: 'NEW' | 'CANCELED' | 'REJECTED'; reason?: string }
  | { kind: 'fill'; ts: number; clientOrderId: string; fillId: string; side: Side; price: number; qty: number; fee: number; feeAsset: 'quote' };

interface SimOrder {
  clientOrderId: string;
  side: Side;
  price: number;
  remaining: number;
  activeAt: number;
  active: boolean;
  cancelAt?: number;
  queueAhead: number;
  fills: number;
}

export class SimExecutor {
  private orders = new Map<string, SimOrder>();
  private book: BookTop | undefined;

  constructor(private readonly p: SimParams = DEFAULT_SIM) {}

  place(ts: number, o: { clientOrderId: string; side: Side; price: number; qty: number }): SimEvent[] {
    if (this.orders.has(o.clientOrderId)) return []; // idempotent
    this.orders.set(o.clientOrderId, {
      clientOrderId: o.clientOrderId, side: o.side, price: o.price, remaining: o.qty,
      activeAt: ts + this.p.latencyMs, active: false, queueAhead: Number.POSITIVE_INFINITY, fills: 0,
    });
    return this.advance(ts);
  }

  cancel(ts: number, clientOrderId: string): SimEvent[] {
    const o = this.orders.get(clientOrderId);
    if (o && o.cancelAt === undefined) o.cancelAt = ts + this.p.latencyMs;
    return this.advance(ts);
  }

  onBook(ts: number, book: BookTop): SimEvent[] {
    const out = this.advance(ts);
    this.book = book;
    // Hard bound, not an assumption: everyone ahead of us at our level is displayed at that level,
    // so the queue ahead can never exceed the displayed size there. Without this cap an order that
    // lost its place to cancellations could only fill on trade-throughs, which over-samples the most
    // toxic fills and distorts the measured adverse selection.
    for (const o of this.orders.values()) {
      if (!o.active) continue;
      const displayed = o.side === 'BUY' ? (o.price === book.bid ? book.bidQty : undefined) : (o.price === book.ask ? book.askQty : undefined);
      if (displayed !== undefined && displayed < o.queueAhead) o.queueAhead = displayed;
    }
    return out;
  }

  onTrade(t: SimTrade): SimEvent[] {
    const out = this.advance(t.ts);
    let available = t.qty;
    const candidates = [...this.orders.values()]
      .filter((o) => o.active && (o.cancelAt === undefined || t.ts < o.cancelAt))
      .filter((o) => (o.side === 'BUY' ? t.aggressor === 'sell' && t.price <= o.price : t.aggressor === 'buy' && t.price >= o.price))
      .sort((a, b) => (a.side === 'BUY' ? b.price - a.price : a.price - b.price));
    for (const o of candidates) {
      if (available <= 0) break;
      let fillQty = 0;
      const through = o.side === 'BUY' ? t.price < o.price : t.price > o.price;
      if (through) {
        fillQty = Math.min(o.remaining, available);
      } else if (Number.isFinite(o.queueAhead)) {
        const consumed = Math.min(available, o.queueAhead);
        o.queueAhead -= consumed;
        available -= consumed;
        if (o.queueAhead <= 0) fillQty = Math.min(o.remaining, available);
      }
      // Quantities are decimal on the exchange. Snap away binary-float residue (0.02 − 0.0079 =
      // 0.012100000000000001) so the exact ledger never sees a quantity the venue could not print.
      fillQty = snapQty(fillQty);
      if (fillQty > 0) {
        available -= fillQty;
        o.remaining = snapQty(o.remaining - fillQty);
        o.fills++;
        const notional = fillQty * o.price;
        out.push({
          kind: 'fill', ts: t.ts, clientOrderId: o.clientOrderId, fillId: `${o.clientOrderId}-f${o.fills}`,
          side: o.side, price: o.price, qty: fillQty, fee: notional * this.p.makerFeeRate, feeAsset: 'quote',
        });
        if (o.remaining <= 1e-15) this.orders.delete(o.clientOrderId);
      }
    }
    return out;
  }

  /** Process activations and cancellations due at or before ts, in time order. */
  advance(ts: number): SimEvent[] {
    const due: Array<{ at: number; o: SimOrder; type: 'activate' | 'cancel' }> = [];
    for (const o of this.orders.values()) {
      if (!o.active && o.activeAt <= ts) due.push({ at: o.activeAt, o, type: 'activate' });
      if (o.cancelAt !== undefined && o.cancelAt <= ts) due.push({ at: o.cancelAt, o, type: 'cancel' });
    }
    due.sort((a, b) => a.at - b.at || (a.type === 'activate' ? -1 : 1));
    const out: SimEvent[] = [];
    for (const d of due) {
      if (!this.orders.has(d.o.clientOrderId)) continue;
      if (d.type === 'activate') {
        const b = this.book;
        const crosses = b && (d.o.side === 'BUY' ? d.o.price >= b.ask : d.o.price <= b.bid);
        if (crosses) {
          this.orders.delete(d.o.clientOrderId);
          out.push({ kind: 'order', ts: d.at, clientOrderId: d.o.clientOrderId, status: 'REJECTED', reason: 'post_only_would_cross' });
          continue;
        }
        d.o.active = true;
        d.o.queueAhead = queueAhead(d.o, b);
        out.push({ kind: 'order', ts: d.at, clientOrderId: d.o.clientOrderId, status: 'NEW' });
      } else {
        this.orders.delete(d.o.clientOrderId);
        out.push({ kind: 'order', ts: d.at, clientOrderId: d.o.clientOrderId, status: 'CANCELED' });
      }
    }
    return out;
  }

  get openOrders(): number {
    return this.orders.size;
  }
}

function queueAhead(o: SimOrder, b: BookTop | undefined): number {
  if (!b) return Number.POSITIVE_INFINITY;
  if (o.side === 'BUY') {
    if (o.price > b.bid) return 0;
    if (o.price === b.bid) return b.bidQty;
    return Number.POSITIVE_INFINITY;
  }
  if (o.price < b.ask) return 0;
  if (o.price === b.ask) return b.askQty;
  return Number.POSITIVE_INFINITY;
}

/** Round to 12 decimals (far below any exchange step) to remove binary-float residue. */
export const snapQty = (x: number): number => Number(x.toFixed(12));
