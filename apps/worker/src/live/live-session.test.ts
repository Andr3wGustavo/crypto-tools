import crypto from 'node:crypto';
import { BN } from '@cortex/core';
import { MexcRestError, type MexcMyTrade, type MexcOrderRaw } from '@cortex/exchange';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../testing/synthetic-inputs';
import { LiveEngine, type LiveInputRecord, type LiveOutput } from './live-engine';
import { LiveSession, paperPrice, type LiveRestApi } from './live-session';

type Dec = InstanceType<typeof BN>;
const SYM = 'SOLUSDT';

/** A stateful fake of the MEXC REST endpoints the live session uses. */
class FakeRest implements LiveRestApi {
  open = new Map<string, { orderId: string; side: 'BUY' | 'SELL'; price: string; qty: Dec; filled: Dec }>();
  trades: MexcMyTrade[] = [];
  quote = new BN(15);
  base = new BN(0);
  seq = 0;
  failCancelAll = 0;
  calls: string[] = [];

  private raw(cid: string, status: string): MexcOrderRaw {
    const o = this.open.get(cid)!;
    return { symbol: SYM, orderId: o.orderId, clientOrderId: cid, price: o.price, origQty: o.qty.toFixed(), executedQty: o.filled.toFixed(), status, side: o.side };
  }
  async placeLimitMaker(_s: string, side: 'BUY' | 'SELL', quantity: string, price: string, cid: string) {
    this.calls.push('place');
    const orderId = `X${++this.seq}`;
    this.open.set(cid, { orderId, side, price, qty: new BN(quantity), filled: new BN(0) });
    return { orderId };
  }
  async cancelOrder(_s: string, cid: string) {
    this.calls.push('cancel');
    if (!this.open.has(cid)) throw new MexcRestError('Unknown order sent', 400, -2011);
    const r = this.raw(cid, 'CANCELED');
    this.open.delete(cid);
    return r;
  }
  async cancelAll() {
    this.calls.push('cancelAll');
    if (this.failCancelAll-- > 0) throw new MexcRestError('bad gateway', 502);
    const rows = [...this.open.keys()].map((cid) => this.raw(cid, 'CANCELED'));
    this.open.clear();
    return rows;
  }
  async queryOrder(_s: string, cid: string) {
    if (!this.open.has(cid)) throw new MexcRestError('Order does not exist', 400, -2013);
    return this.raw(cid, 'NEW');
  }
  async openOrders() {
    return [...this.open.keys()].map((cid) => this.raw(cid, 'NEW'));
  }
  async account() {
    return { balances: [{ asset: 'USDT', free: this.quote.toFixed(), locked: '0' }, { asset: 'SOL', free: this.base.toFixed(), locked: '0' }] };
  }
  async myTrades() {
    return this.trades;
  }
  /** A taker hits our resting order of `side`; returns the trade as MEXC reports it. */
  fill(side: 'BUY' | 'SELL', time: number): MexcMyTrade {
    const [cid, o] = [...this.open].find(([, x]) => x.side === side)!;
    const q = o.qty;
    this.open.delete(cid);
    const n = q.times(o.price);
    if (side === 'BUY') { this.quote = this.quote.minus(n); this.base = this.base.plus(q); } else { this.quote = this.quote.plus(n); this.base = this.base.minus(q); }
    const t: MexcMyTrade = { symbol: SYM, id: `T${++this.seq}`, orderId: o.orderId, clientOrderId: cid, price: o.price, qty: q.toFixed(), commission: '0', commissionAsset: 'USDT', time, isBuyer: side === 'BUY', isMaker: true };
    this.trades.push(t);
    return t;
  }
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

function setup() {
  const rest = new FakeRest();
  const engine = new LiveEngine({ config: testConfig, capitalQuote: 15 });
  const recorded: LiveInputRecord[] = [];
  const outs: LiveOutput[] = [];
  const fatal: unknown[] = [];
  let now = 1_000_000;
  const session = new LiveSession({
    engine, rest, symbol: SYM, record: (r) => recorded.push(r), onOutputs: (_r, o) => outs.push(...o), onFatal: (e) => fatal.push(e),
    clock: () => now, sleep: async (ms) => { now += ms; }, log: () => undefined,
  });
  const market = async (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now += 250;
      session.input({ t: 'book', venue: 'local', ts: now, bid: 88, bidQty: 5, ask: 88.1, askQty: 5 });
      await settle();
    }
  };
  return { rest, engine, session, recorded, outs, fatal, market, at: () => now };
}

describe('LiveSession (I/O around the live engine)', () => {
  it('paper mode sends prices far from the market, rounded away from it, and never fills', () => {
    expect(paperPrice('BUY', '88.00', 500, '0.01')).toBe('83.6');
    expect(paperPrice('SELL', '88.10', 500, '0.01')).toBe('92.51'); // 92.505 → up, never toward the book
    expect(paperPrice('BUY', '0.51237', 300, '0.00001')).toBe('0.49699'); // 0.4969989 → floor
    expect(() => paperPrice('BUY', '0.01', 10_000, '0.01')).toThrow(/not positive/);
  });

  it('boot cancels leftovers; opens after stream + sync; fills reach the ledger; shutdown leaves nothing resting', async () => {
    const { rest, engine, session, market, recorded, outs, fatal, at } = setup();
    rest.open.set('cfleftover1b', { orderId: 'OLD', side: 'BUY', price: '80', qty: new BN('0.1'), filled: new BN(0) });
    await session.boot();
    expect(rest.open.size).toBe(0);

    await market(3_000);
    expect(rest.calls.filter((c) => c === 'place')).toEqual([]); // nothing before stream + sync
    session.stream.onState({ state: 'up', session: 1 });
    await market(12_000);
    expect(engine.isOpened).toBe(true);
    expect(engine.venueHold).toBeNull();
    expect(rest.open.size).toBeGreaterThan(0);

    // A fill pushed by the user stream (no client id, as MEXC may send it) is booked by orderId.
    const t = rest.fill('BUY', at());
    session.stream.onExec([{ kind: 'fill', ts: at(), symbol: SYM, clientOrderId: '', orderId: t.orderId, tradeId: t.id, side: 'BUY', price: t.price, qty: t.qty, fee: '0', feeAsset: 'USDT', isMaker: true, selfTrade: false }]);
    await market(70_000); // includes a periodic sync that sees the same trade again via REST
    expect(engine.fillCount).toBe(1);
    expect(engine.ledger.balance('cash:SOL', 'SOL').toFixed()).toBe(rest.base.toFixed());
    expect(engine.ledger.balance('cash:USDT', 'USDT').toFixed()).toBe(rest.quote.toFixed());
    expect(outs.some((o) => o.kind === 'reconcile')).toBe(false);

    await session.shutdown();
    expect(rest.open.size).toBe(0);
    expect(fatal).toEqual([]);

    // Everything the session fed the engine was recorded: replaying it gives the same outputs.
    const replay = new LiveEngine({ config: testConfig, capitalQuote: 15 });
    const h = (x: LiveOutput[]) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
    expect(h(recorded.flatMap((r) => replay.process(r)))).toBe(h(outs));
  });

  it('a stream drop cancels everything over REST and resumes only after a fresh sync', async () => {
    const { rest, engine, session, market } = setup();
    await session.boot();
    await market(3_000);
    session.stream.onState({ state: 'up', session: 1 });
    await market(12_000);
    expect(rest.open.size).toBeGreaterThan(0);
    session.stream.onState({ state: 'down', reason: 'stale' });
    await market(2_000);
    expect(rest.open.size).toBe(0);
    expect(engine.venueHold).toBe('stream_down');
    session.stream.onState({ state: 'up', session: 2 });
    await market(5_000);
    expect(engine.venueHold).toBeNull();
    expect(rest.open.size).toBeGreaterThan(0);
  });

  it('boot refuses to continue when cancel-all cannot be confirmed; transient failures are retried', async () => {
    const a = setup();
    a.rest.failCancelAll = 2;
    await a.session.boot();
    expect(a.rest.calls.filter((c) => c === 'cancelAll')).toHaveLength(3);
    const b = setup();
    b.rest.failCancelAll = 99;
    await expect(b.session.boot()).rejects.toThrow(/not confirmed after 5 attempts/);
  });
});
