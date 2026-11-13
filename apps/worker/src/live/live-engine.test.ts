import crypto from 'node:crypto';
import { BN } from '@cortex/core';
import type { ExecEvent } from '@cortex/exchange';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../testing/synthetic-inputs';
import { LiveEngine, type LiveEngineOptions, type LiveInputRecord, type LiveOutput, type WithdrawRequest } from './live-engine';

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
  /** The withdrawer side (E9): sees every withdraw request; answers by calling `withdrawAnswer`. */
  onWithdrawRequest: ((r: WithdrawRequest) => void) | undefined;
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

// ---------------------------------------------------------------- E9: treasury + withdrawals

const wOpts: LiveEngineOptions = { ...opts, treasury: { withdraw: { minAmount: 0.03, dailyCap: 1 } } };
const wdStatus = (outs: LiveOutput[]) => outs.flatMap((o) => (o.kind === 'withdrawal' ? [o.w.status] : []));
const bal = (h: Harness, acct: string) => h.engine.ledger.balance(`${acct}:USDT`, 'USDT').toFixed();
const syncTrouble = (outs: LiveOutput[]) => outs.some((o) => (o.kind === 'sync' && !o.ok) || o.kind === 'reconcile');

/** Buys at 88, the market rallies, sells higher: a realized, equity-confirmed profit of ~0.087. */
function profitable(h: Harness): void {
  h.start();
  h.fill('BUY');
  h.market(4_000, 92, 92.1);
  h.fill('SELL');
  h.market(65_000, 92, 92.1); // skim timer + a periodic sync
}

/** A withdrawer that holds every request for the test to answer. */
function capture(h: Harness): WithdrawRequest[] {
  const seen: WithdrawRequest[] = [];
  h.onWithdrawRequest = (r) => seen.push(r);
  return seen;
}

describe('LiveEngine: treasury skim (E9)', () => {
  it('half of the realized, equity-confirmed profit leaves cash for the treasury; it is not a loss', () => {
    const h = new Harness();
    profitable(h);
    const s = status(h);
    expect(s.realizedPnl).toBeCloseTo(0.0874, 9);
    expect(bal(h, 'treasury')).toBe('0.04'); // 50% of 0.0874, rounded DOWN to the cent
    expect(h.outs.filter((o) => o.kind === 'treasury')).toHaveLength(1);
    // The strategy no longer trades it, and its risk references moved with it (no fake drawdown).
    expect(s.quoteTotal).toBeCloseTo(15.0874 - 0.04, 9);
    expect(s.startEquity).toBeCloseTo(15 - 0.04, 9);
    expect(s.status).toBe('running');
    // On the exchange it is one balance: cash + treasury = exchange quote, and syncs agree.
    expect(new BN(bal(h, 'cash')).plus(bal(h, 'treasury')).toFixed()).toBe(h.quote.toFixed());
    h.market(130_000, 92, 92.1);
    expect(syncTrouble(h.outs)).toBe(false);
    expect(bal(h, 'treasury')).toBe('0.04'); // nothing skimmed twice
  });

  it('a loss, or unrealized gains only ⇒ nothing is skimmed', () => {
    const loss = new Harness();
    loss.start();
    loss.fill('BUY');
    loss.market(4_000, 85, 85.1);
    loss.fill('SELL');
    loss.market(65_000, 85, 85.1);
    expect(status(loss).realizedPnl).toBeLessThan(0);
    expect(bal(loss, 'treasury')).toBe('0');

    const paper = new Harness();
    paper.start();
    paper.fill('BUY');
    paper.market(65_000, 95, 95.1); // up a lot, but nothing realized
    expect(bal(paper, 'treasury')).toBe('0');
  });
});

describe('LiveEngine: withdrawals (E9)', () => {
  it('happy path: reserve → submit → SENT (debited) → CONFIRMED; books match the exchange throughout', () => {
    const h = new Harness(new LiveEngine(wOpts));
    const reqs = capture(h);
    profitable(h);
    h.market(2_000, 92, 92.1);
    expect(wdStatus(h.outs)).toEqual(['PENDING']);
    expect(reqs).toHaveLength(1);
    const r = reqs[0]!;
    expect(r).toMatchObject({ mode: 'submit', amount: '0.04', asset: 'USDT' });
    expect(r.id).toMatch(/^wd[0-9a-z]+-1$/);
    // Reserved BEFORE anything is sent.
    expect(bal(h, 'treasury')).toBe('0');
    expect(bal(h, 'withdrawing')).toBe('0.04');

    // The exchange debits the account as it accepts the withdrawal; the sync accepts both states.
    h.quote = h.quote.minus('0.04');
    h.withdrawAnswer({ id: r.id, status: 'SENT', exchangeId: 'E1' });
    h.market(70_000, 92, 92.1);
    expect(syncTrouble(h.outs)).toBe(false);
    expect(reqs.length).toBeGreaterThan(1);
    expect(reqs.slice(1).every((x) => x.mode === 'status')).toBe(true); // re-asked, never re-submitted

    h.withdrawAnswer({ id: r.id, status: 'CONFIRMED', amount: '0.04', fee: '0.01', txId: '5xSig' });
    h.market(70_000, 92, 92.1);
    expect(wdStatus(h.outs)).toEqual(['PENDING', 'SENT', 'CONFIRMED']);
    expect(bal(h, 'withdrawing')).toBe('0');
    expect(bal(h, 'external')).toBe('0.03'); // the owner receives amount − fee
    expect(h.engine.ledger.balance('expense:fees:USDT', 'USDT').toFixed()).toBe('0.01');
    expect(h.engine.treasuryView().withdrawals[0]).toMatchObject({ status: 'CONFIRMED', exchangeId: 'E1', txId: '5xSig', fee: '0.01' });
    expect(syncTrouble(h.outs)).toBe(false);
    expect(status(h).status).toBe('running');
  });

  it('a definitive failure restores the reserve; the next attempt waits for the cooldown', () => {
    const h = new Harness(new LiveEngine(wOpts));
    const reqs = capture(h);
    profitable(h);
    h.market(2_000, 92, 92.1);
    h.withdrawAnswer({ id: reqs[0]!.id, status: 'FAILED', reason: 'refused: address not whitelisted' });
    h.market(2_000, 92, 92.1);
    expect(bal(h, 'treasury')).toBe('0.04');
    expect(bal(h, 'withdrawing')).toBe('0');
    h.market(3_600_000, 92, 92.1);
    expect(wdStatus(h.outs)).toEqual(['PENDING', 'FAILED']); // no retry loop
    expect(syncTrouble(h.outs)).toBe(false);
  });

  it('locks: never while paused, unreconciled, below the minimum, or with equity under the principal', () => {
    const paused = new Harness(new LiveEngine(wOpts));
    capture(paused);
    paused.start();
    paused.fill('BUY');
    paused.market(4_000, 92, 92.1);
    paused.fill('SELL');
    paused.feed({ t: 'command', ts: paused.ts + 1, command: 'pause' });
    paused.market(65_000, 92, 92.1);
    expect(wdStatus(paused.outs)).toEqual([]);

    // Unreconciled: a PENDING withdrawal whose books are no longer confirmed is aborted, not sent.
    const unsynced = new Harness(new LiveEngine(wOpts));
    const ur = capture(unsynced);
    profitable(unsynced);
    unsynced.market(2_000, 92, 92.1);
    expect(ur[0]).toMatchObject({ mode: 'submit' });
    unsynced.autoSync = false; // syncs stop answering
    unsynced.stream(false);
    unsynced.stream(true);
    unsynced.market(61_000, 92, 92.1);
    expect(unsynced.engine.venueHold).toBe('syncing');
    expect(ur.at(-1)).toMatchObject({ id: ur[0]!.id, mode: 'abort' });

    const small = new Harness(new LiveEngine({ ...opts, treasury: { withdraw: { minAmount: 20, dailyCap: 100 } } }));
    capture(small);
    profitable(small);
    small.market(5_000, 92, 92.1);
    expect(bal(small, 'treasury')).toBe('0.04');
    expect(wdStatus(small.outs)).toEqual([]);

    const under = new Harness(new LiveEngine(wOpts));
    capture(under);
    under.start();
    under.fill('BUY');
    under.market(4_000, 92, 92.1);
    under.fill('SELL');
    under.market(1_000, 92, 92.1);
    under.fill('BUY');
    under.market(65_000, 80, 80.1); // inventory under water: equity < principal
    expect(wdStatus(under.outs)).toEqual([]);
  });

  it('a PENDING withdrawal is aborted (never submitted) when a lock closes before it was sent', () => {
    const h = new Harness(new LiveEngine(wOpts));
    const reqs = capture(h);
    profitable(h);
    h.market(2_000, 92, 92.1);
    expect(reqs).toHaveLength(1);
    h.feed({ t: 'command', ts: h.ts + 1, command: 'pause' });
    h.market(61_000, 92, 92.1);
    expect(reqs.at(-1)).toMatchObject({ id: reqs[0]!.id, mode: 'abort' });
    h.withdrawAnswer({ id: reqs[0]!.id, status: 'FAILED', reason: 'aborted' });
    h.market(1_000, 92, 92.1);
    expect(bal(h, 'treasury')).toBe('0.04');
  });

  it('impossible reports stop everything: CONFIRMED then FAILED, or a different amount', () => {
    const conflict = new Harness(new LiveEngine(wOpts));
    const reqs = capture(conflict);
    profitable(conflict);
    conflict.market(2_000, 92, 92.1);
    const id = reqs[0]!.id;
    conflict.quote = conflict.quote.minus('0.04');
    conflict.withdrawAnswer({ id, status: 'CONFIRMED', amount: '0.04', fee: '0' });
    conflict.market(500, 92, 92.1);
    conflict.withdrawAnswer({ id, status: 'FAILED', reason: 'late' });
    conflict.market(1_000, 92, 92.1);
    expect(conflict.engine.venueHold).toBe('fatal:withdraw_conflict');
    expect(bal(conflict, 'treasury')).toBe('0'); // never "restored" after the money left
    expect(bal(conflict, 'external')).toBe('0.04');

    const amount = new Harness(new LiveEngine(wOpts));
    const r2 = capture(amount);
    profitable(amount);
    amount.market(2_000, 92, 92.1);
    amount.withdrawAnswer({ id: r2[0]!.id, status: 'CONFIRMED', amount: '4', fee: '0' });
    amount.market(1_000, 92, 92.1);
    expect(amount.engine.venueHold).toBe('fatal:withdraw_amount');
    expect(bal(amount, 'withdrawing')).toBe('0.04'); // left for a human

    const unknown = new Harness(new LiveEngine(wOpts));
    profitable(unknown);
    unknown.withdrawAnswer({ id: 'wdffffff-9', status: 'CONFIRMED' });
    unknown.market(500, 92, 92.1);
    expect(unknown.outs.some((o) => o.kind === 'exec_warning' && o.message.includes('unknown withdrawal'))).toBe(true);
  });

  it('daily cap and cooldown; the treasury view lists the buckets', () => {
    const h = new Harness(new LiveEngine({ ...opts, treasury: { withdraw: { minAmount: 0.01, dailyCap: 0.02 } } }));
    const reqs = capture(h);
    profitable(h);
    h.market(2_000, 92, 92.1);
    expect(reqs[0]).toMatchObject({ amount: '0.02' }); // capped by the daily cap
    expect(bal(h, 'treasury')).toBe('0.02');
    h.quote = h.quote.minus('0.02');
    h.withdrawAnswer({ id: reqs[0]!.id, status: 'CONFIRMED', amount: '0.02', fee: '0' });
    h.market(3_600_000, 92, 92.1);
    expect(wdStatus(h.outs).filter((x) => x === 'PENDING')).toHaveLength(1); // 1 per day
    expect(h.engine.treasuryView()).toMatchObject({ treasury: '0.02', withdrawn: '0.02', skimmed: '0.04', withdrawing: '0' });
  });

  it('replay and restore are exact through a withdrawal in flight', () => {
    const h = new Harness(new LiveEngine(wOpts));
    const reqs = capture(h);
    profitable(h);
    h.market(2_000, 92, 92.1);
    h.quote = h.quote.minus('0.04');
    h.withdrawAnswer({ id: reqs[0]!.id, status: 'SENT', exchangeId: 'E1' });
    h.market(5_000, 92, 92.1);
    const snap = JSON.parse(JSON.stringify(h.engine.snapshot()));
    const restored = LiveEngine.restore(wOpts, snap);
    expect(restored.treasuryView()).toEqual(h.engine.treasuryView());
    expect(() => LiveEngine.restore(opts, snap)).toThrow(/different configuration/);
    h.withdrawAnswer({ id: reqs[0]!.id, status: 'CONFIRMED', amount: '0.04', fee: '0.01' });
    h.market(65_000, 92, 92.1);
    const replay = new LiveEngine(wOpts);
    const outs = h.inputs.flatMap((r) => replay.process(r));
    expect(crypto.createHash('sha256').update(JSON.stringify(outs)).digest('hex')).toBe(h.outputHash());
    expect(replay.treasuryView()).toEqual(h.engine.treasuryView());
  });
});
