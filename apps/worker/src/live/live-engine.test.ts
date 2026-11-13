import crypto from 'node:crypto';
import { BN } from '@cortex/core';
import type { ExecEvent } from '@cortex/exchange';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../testing/synthetic-inputs';
import { LiveEngine, type LiveEngineOptions, type LiveInputRecord, type LiveOutput } from './live-engine';

const opts: LiveEngineOptions = { config: testConfig, capitalQuote: 15 };
const SYM = 'SOLUSDT';

type Dec = InstanceType<typeof BN>;
type VOrder = { orderId: string; side: 'BUY' | 'SELL'; price: string; qty: Dec; filled: Dec };

/**
 * Closed loop: engine outputs → a fake MEXC (orders, balances, trades) → exchange replies as
 * input records → engine. Every input is recorded, so the session can be replayed afterwards.
 */
class Harness {
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
  private queue: LiveInputRecord[] = [];

  constructor(public engine = new LiveEngine(opts)) {}

  feed(r: LiveInputRecord): void {
    this.queue.push(r);
    while (this.queue.length > 0) {
      const x = this.queue.shift()!;
      this.inputs.push(x);
      for (const o of this.engine.process(x)) {
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

const places = (outs: LiveOutput[]) => outs.filter((o) => o.kind === 'action' && o.action.kind === 'place');
const requests = (outs: LiveOutput[], op: string) => outs.filter((o) => o.kind === 'request' && o.op === op);
const status = (h: Harness) => h.engine.strategy.snapshot();

describe('LiveEngine: opening and holds', () => {
  it('quotes nothing until the stream is up and the opening sync booked the real balances', () => {
    const h = new Harness();
    h.quote = new BN('14.731');
    h.market(5_000);
    expect(places(h.outs)).toEqual([]);
    expect(h.engine.venueHold).toBe('opening');
    h.stream(true);
    h.market(12_000);
    expect(h.engine.isOpened).toBe(true);
    expect(h.engine.venueHold).toBeNull();
    expect(h.engine.ledger.balance('cash:USDT', 'USDT').toFixed()).toBe('14.731');
    expect(status(h).quoteTotal).toBeCloseTo(14.731, 12);
    expect(status(h).startEquity).toBeCloseTo(14.731, 9); // risk budget measured from the real balance
    expect(places(h.outs).length).toBeGreaterThan(0);
    expect(h.open.size).toBeGreaterThan(0);
  });

  it('refuses to open with more capital than configured, or with inventory on the account', () => {
    const rich = new Harness();
    rich.quote = new BN(100);
    rich.start();
    expect(rich.engine.venueHold).toBe('fatal:capital_exceeds');
    expect(places(rich.outs)).toEqual([]);

    const inv = new Harness();
    inv.base = new BN('0.5');
    inv.start();
    expect(inv.engine.venueHold).toBe('fatal:inventory_at_start');
    // The operator flattens the account and resets the halt: the next sync opens normally.
    inv.base = new BN(0);
    inv.feed({ t: 'command', ts: inv.ts + 1, command: 'reset_halt' });
    inv.market(20_000);
    expect(inv.engine.isOpened).toBe(true);
    expect(inv.engine.venueHold).toBeNull();
  });

  it('stream down ⇒ cancel all + hold; a stale sync is ignored; a fresh one resumes', () => {
    const h = new Harness();
    h.start();
    expect(h.open.size).toBeGreaterThan(0);
    const epochBefore = (requests(h.outs, 'sync').at(-1) as { epoch: number }).epoch;
    const mark = h.outs.length;
    h.stream(false);
    expect(h.engine.venueHold).toBe('stream_down');
    expect(h.open.size).toBe(0); // cancel-all over REST
    h.market(5_000);
    expect(places(h.outs.slice(mark))).toEqual([]);
    h.autoSync = false;
    h.stream(true);
    h.feed(h.syncRecord(epochBefore)); // snapshot taken before the stream came back
    expect(h.engine.venueHold).toBe('syncing');
    expect(h.outs.at(-1)).toMatchObject({ kind: 'sync', ok: false });
    h.autoSync = true;
    h.market(20_000); // the resync timer asks again
    expect(h.engine.venueHold).toBeNull();
    expect(h.open.size).toBeGreaterThan(0);
  });

  it('rate limit and clock problems hold for a while, auth is fatal until a human resets it', () => {
    const h = new Harness();
    h.start();
    h.feed({ t: 'exec', ts: h.ts + 1, e: { kind: 'venue', ts: h.ts + 1, state: 'rate_limited', detail: '429' } });
    expect(h.engine.venueHold).toBe('rate_limited');
    expect(h.open.size).toBe(0);
    h.market(11_000);
    expect(h.engine.venueHold).toBeNull();
    h.feed({ t: 'exec', ts: h.ts + 1, e: { kind: 'venue', ts: h.ts + 1, state: 'auth', detail: 'signature' } });
    h.market(60_000);
    expect(h.engine.venueHold).toBe('fatal:auth');
    h.feed({ t: 'command', ts: h.ts + 1, command: 'reset_halt' });
    h.market(2_000);
    expect(h.engine.venueHold).toBeNull();
  });
});

describe('LiveEngine: orders and fills', () => {
  it('fills are booked exactly once (stream + REST recovery), by orderId when the push has no client id', () => {
    const h = new Harness();
    h.start();
    h.stripClientIds = true;
    const t = h.fill('BUY');
    expect(h.engine.fillCount).toBe(1);
    h.feed({ t: 'exec', ts: h.ts + 1, e: { ...t, ts: h.ts + 1 } }); // the same trade again
    h.feed({ t: 'exec', ts: h.ts + 2, e: { ...t, ts: h.ts + 2, clientOrderId: '' } });
    expect(h.engine.fillCount).toBe(1);
    expect(h.engine.ledger.balance('cash:SOL', 'SOL').toFixed()).toBe(h.base.toFixed());
    expect(h.engine.ledger.balance('cash:USDT', 'USDT').toFixed()).toBe(h.quote.toFixed());
    expect(h.outs.some((o) => o.kind === 'reconcile')).toBe(false);
  });

  it('a fill lost by the stream is recovered by the next sync, and balances still match', () => {
    const h = new Harness();
    h.start();
    h.dropStreamFills = true;
    h.fill('BUY');
    expect(h.engine.fillCount).toBe(0);
    h.market(70_000); // periodic sync (60 s) injects recent trades first
    expect(h.engine.fillCount).toBe(1);
    expect(h.engine.ledger.balance('cash:SOL', 'SOL').toFixed()).toBe(h.base.toFixed());
    expect(status(h).status).toBe('running');
    expect(h.outs.some((o) => o.kind === 'reconcile')).toBe(false);
  });

  it('balances that the ledger cannot explain halt on the second consecutive sync (sticky)', () => {
    const h = new Harness();
    h.start();
    h.quote = h.quote.minus('0.5'); // money left the account without any trade
    h.market(65_000);
    expect(h.outs.some((o) => o.kind === 'sync' && o.reason === 'mismatch, confirming')).toBe(true);
    h.market(20_000);
    expect(h.outs.some((o) => o.kind === 'reconcile' && !o.ok)).toBe(true);
    expect(status(h).status).toBe('halted');
    expect(h.open.size).toBe(0);
    h.market(120_000);
    expect(status(h).status).toBe('halted');
  });

  it('a place with no answer becomes UNKNOWN, is queried, and resolves either way', () => {
    const resting = new Harness();
    resting.placeMode = 'unknown-placed';
    resting.start();
    expect(resting.open.size).toBeGreaterThan(0);
    const cids = [...resting.open.keys()];
    expect(cids.every((c) => resting.engine.strategy.workingOrder(c)?.status === 'NEW')).toBe(true);

    const never = new Harness();
    never.placeMode = 'unknown-not-placed';
    never.market(3_000);
    never.stream(true);
    never.market(1_000);
    expect(requests(never.outs, 'query').length).toBeGreaterThan(0);
    // Missing on the exchange ⇒ closed locally (never stuck UNKNOWN); the side quotes again.
    const missing = never.inputs.filter((r) => r.t === 'exec' && r.e.kind === 'missing').map((r) => (r as { e: { clientOrderId: string } }).e.clientOrderId);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((c) => never.engine.strategy.workingOrder(c) === undefined)).toBe(true);
    never.placeMode = 'ack';
    never.market(10_000);
    expect(never.open.size).toBeGreaterThan(0);
    expect(status(never).workingOrders.some((o) => o.status === 'UNKNOWN')).toBe(false);
  });

  it('a refused place is REJECTED and retried later; orphans and foreign orders are handled', () => {
    const h = new Harness();
    h.placeMode = 'reject';
    h.start();
    expect(h.open.size).toBe(0);
    expect(status(h).workingOrders).toEqual([]);
    h.placeMode = 'ack';
    h.market(5_000);
    expect(h.open.size).toBeGreaterThan(0);

    // An order of ours the strategy does not know (e.g. placed just before a crash) is canceled.
    const prefix = [...h.open.keys()][0]!.slice(0, 8);
    h.open.set(`${prefix}zzzb`, { orderId: 'X999', side: 'BUY', price: '80.00', qty: new BN('0.05'), filled: new BN(0) });
    h.market(65_000);
    expect(h.open.has(`${prefix}zzzb`)).toBe(false);

    // Someone else trading this pair on the account: stop, cancel all, wait for a human.
    h.open.set('manual-1', { orderId: 'X1000', side: 'SELL', price: '99.00', qty: new BN('0.05'), filled: new BN(0) });
    h.market(65_000);
    expect(h.engine.venueHold).toBe('fatal:foreign_order');
  });
});

describe('LiveEngine: determinism and restart', () => {
  it('a recorded live session replays to exactly the same outputs', () => {
    const h = new Harness();
    h.start();
    h.fill('BUY');
    h.market(10_000);
    h.stream(false);
    h.stream(true);
    h.market(30_000);
    const replay = new LiveEngine(opts);
    const outs = h.inputs.flatMap((r) => replay.process(r));
    expect(crypto.createHash('sha256').update(JSON.stringify(outs)).digest('hex')).toBe(h.outputHash());
  });

  it('restore keeps the books, starts held, and resumes only after stream + sync', () => {
    const h = new Harness();
    h.start();
    h.fill('BUY');
    h.market(5_000);
    const snap = JSON.parse(JSON.stringify(h.engine.snapshot()));
    const restored = LiveEngine.restore(opts, snap);
    expect(restored.ledger.balance('cash:SOL', 'SOL').toFixed()).toBe(h.base.toFixed());
    expect(() => LiveEngine.restore({ ...opts, capitalQuote: 20 }, snap)).toThrow(/different configuration/);
    const h2 = new Harness(restored);
    Object.assign(h2, { quote: h.quote, base: h.base, ts: h.ts, seq: h.seq });
    for (const [k, v] of h.open) h2.open.set(k, v);
    h2.stream(false); // what the live process records first after a boot
    expect(restored.venueHold).toBe('stream_down');
    expect(h2.open.size).toBe(0); // cancel-all requested on the way down
    h2.market(2_000);
    h2.stream(true);
    h2.market(20_000);
    expect(restored.venueHold).toBeNull();
    expect(h2.outs.some((o) => o.kind === 'reconcile')).toBe(false);
  });
});
