import crypto from 'node:crypto';
import { BN } from '@cortex/core';
import type { ExecEvent } from '@cortex/exchange';
import { LiveEngine, type LiveEngineOptions, type LiveInputRecord, type LiveOutput, type WithdrawRequest } from '../live/live-engine';
import { testConfig } from './synthetic-inputs';

export const opts: LiveEngineOptions = { config: testConfig, capitalQuote: 15 };
export const SYM = 'SOLUSDT';

type Dec = InstanceType<typeof BN>;
type VOrder = { orderId: string; side: 'BUY' | 'SELL'; price: string; qty: Dec; filled: Dec };

/**
 * Closed loop: engine outputs → a fake MEXC (orders, balances, trades) → exchange replies as
 * input records → engine. Every input is recorded, so the session can be replayed afterwards.
 */
export class Harness {
  readonly inputs: LiveInputRecord[] = [];
  readonly outs: LiveOutput[] = [];
  readonly open = new Map<string, VOrder>();
  readonly done = new Map<string, { status: 'FILLED' | 'CANCELED'; o: VOrder }>();
  readonly trades: Array<Extract<ExecEvent, { kind: 'fill' }>> = [];
  quote = new BN(15);
  base = new BN(0);
  ts = 1_000_000;
  seq = 0;
  placeMode: 'ack' | 'reject' | 'unknown-placed' | 'unknown-not-placed' = 'ack';
  dropStreamFills = false;
  stripClientIds = false;
  autoSync = true;
  /** The withdrawer side (E9): sees every withdraw request; answers by calling `withdrawAnswer`. */
  onWithdrawRequest: ((r: WithdrawRequest) => void) | undefined;
  /** Every record's outputs, right after the engine processed it (persistence taps). */
  onRecord: ((outs: LiveOutput[]) => void) | undefined;
  private queue: LiveInputRecord[] = [];

  constructor(public engine = new LiveEngine(opts)) {}

  feed(r: LiveInputRecord): void {
    this.queue.push(r);
    while (this.queue.length > 0) {
      const x = this.queue.shift()!;
      this.inputs.push(x);
      const outs = this.engine.process(x);
      this.onRecord?.(outs);
      for (const o of outs) {
        this.outs.push(o);
        this.handle(o);
      }
    }
  }

  private exec(e: ExecEvent): void {
    this.queue.push({ t: 'exec', ts: e.ts, e });
  }

  private now(): number {
    return ++this.ts;
  }

  private snap(cid: string, o: VOrder, status: string): ExecEvent {
    return { kind: 'order', ts: this.now(), symbol: SYM, clientOrderId: cid, orderId: o.orderId, side: o.side, status: status as 'NEW', statusCode: null, price: o.price, qty: o.qty.toFixed(), cumQty: o.filled.toFixed(), remainQty: o.qty.minus(o.filled).toFixed(), source: 'rest' };
  }

  private cancelOne(cid: string): void {
    const o = this.open.get(cid);
    if (!o) return this.exec({ kind: 'unknown', ts: this.now(), clientOrderId: cid, op: 'cancel', detail: 'Unknown order sent' });
    this.open.delete(cid);
    this.done.set(cid, { status: 'CANCELED', o });
    this.exec(this.snap(cid, o, o.filled.isZero() ? 'CANCELED' : 'PARTIALLY_CANCELED'));
  }

  private handle(o: LiveOutput): void {
    if (o.kind === 'action' && o.action.kind === 'place') {
      const a = o.action;
      const vo: VOrder = { orderId: `X${++this.seq}`, side: a.side, price: a.price, qty: new BN(a.qty), filled: new BN(0) };
      if (this.placeMode === 'reject') return this.exec({ kind: 'reject', ts: this.now(), clientOrderId: a.clientOrderId, op: 'place', reason: 'post only would cross', code: 30010 });
      if (this.placeMode !== 'unknown-not-placed') this.open.set(a.clientOrderId, vo);
      if (this.placeMode.startsWith('unknown')) return this.exec({ kind: 'unknown', ts: this.now(), clientOrderId: a.clientOrderId, op: 'place', detail: 'TimeoutError' });
      this.exec({ kind: 'ack', ts: this.now(), clientOrderId: a.clientOrderId, orderId: vo.orderId });
      return;
    }
    if (o.kind === 'action' && o.action.kind === 'cancel') return this.cancelOne(o.action.clientOrderId);
    if (o.kind === 'withdraw_request') return this.onWithdrawRequest?.(o);
    if (o.kind !== 'request') return;
    switch (o.op) {
      case 'cancel':
        return this.cancelOne(o.clientOrderId);
      case 'cancel_all':
        for (const cid of [...this.open.keys()]) this.cancelOne(cid);
        return;
      case 'query': {
        const op = this.open.get(o.clientOrderId);
        const d = this.done.get(o.clientOrderId);
        if (op) return this.exec(this.snap(o.clientOrderId, op, op.filled.isZero() ? 'NEW' : 'PARTIALLY_FILLED'));
        if (d) return this.exec(this.snap(o.clientOrderId, d.o, d.status));
        return this.exec({ kind: 'missing', ts: this.now(), clientOrderId: o.clientOrderId });
      }
      case 'trades':
        for (const t of this.trades) this.exec({ ...t, ts: this.now() });
        return;
      case 'sync':
        if (!this.autoSync) return;
        for (const t of this.trades) this.exec({ ...t, ts: this.now() }); // recent fills first (deduplicated)
        this.queue.push(this.syncRecord(o.epoch));
        return;
    }
  }

  syncRecord(epoch: number): LiveInputRecord {
    return {
      t: 'sync', ts: this.now(), epoch, open: [...this.open].map(([clientOrderId, o]) => ({ clientOrderId, orderId: o.orderId })),
      balances: { USDT: { free: this.quote.toFixed(), locked: '0' }, SOL: { free: this.base.toFixed(), locked: '0' } },
    };
  }

  market(ms: number, bid = 88, ask = 88.1): void {
    const end = this.ts + ms;
    while (this.ts < end) {
      this.ts += 250;
      this.feed({ t: 'book', venue: 'local', ts: this.ts, bid, bidQty: 5, ask, askQty: 5 });
      if (this.ts % 1000 < 250) this.feed({ t: 'clock', ts: this.ts });
    }
  }

  stream(up: boolean): void {
    this.feed({ t: 'stream', ts: this.now(), up, ...(up ? {} : { reason: 'test' }) });
  }

  /** Fills one of our resting orders on the exchange (a taker hits it). */
  fill(side: 'BUY' | 'SELL', qty?: string): Extract<ExecEvent, { kind: 'fill' }> {
    const [cid, o] = [...this.open].find(([, x]) => x.side === side)!;
    const q = qty ? new BN(qty) : o.qty.minus(o.filled);
    o.filled = o.filled.plus(q);
    const notional = q.times(o.price);
    if (side === 'BUY') { this.quote = this.quote.minus(notional); this.base = this.base.plus(q); } else { this.quote = this.quote.plus(notional); this.base = this.base.minus(q); }
    if (o.filled.gte(o.qty)) { this.open.delete(cid); this.done.set(cid, { status: 'FILLED', o }); }
    const t: Extract<ExecEvent, { kind: 'fill' }> = {
      kind: 'fill', ts: this.now(), symbol: SYM, clientOrderId: this.stripClientIds ? '' : cid, orderId: o.orderId, tradeId: `T${++this.seq}`, side,
      price: o.price, qty: q.toFixed(), fee: '0', feeAsset: 'USDT', isMaker: true, selfTrade: false,
    };
    this.trades.push(t);
    if (!this.dropStreamFills) this.feed({ t: 'exec', ts: t.ts, e: t });
    return t;
  }

  /** The withdrawer's report (queued like any exchange answer). */
  withdrawAnswer(a: Omit<Extract<LiveInputRecord, { t: 'withdraw' }>, 't' | 'ts'>): void {
    this.queue.push({ t: 'withdraw', ts: this.now(), ...a });
  }

  /** Opens the session: market, user stream up, opening sync. */
  start(): void {
    this.market(3_000);
    this.stream(true);
    this.market(12_000);
  }

  get holds(): Array<string | null> {
    return this.outs.flatMap((o) => (o.kind === 'action' && o.action.kind === 'status' && o.action.reason.startsWith('venue') ? [o.action.reason] : []));
  }

  outputHash(): string {
    return crypto.createHash('sha256').update(JSON.stringify(this.outs)).digest('hex');
  }
}

