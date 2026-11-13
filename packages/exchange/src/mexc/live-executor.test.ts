import { describe, expect, it } from 'vitest';
import { LiveExecutor, type OrderApi } from './live-executor';
import type { ExecEvent } from './private';
import { MexcRestError, type MexcOrderRaw } from './rest';

/**
 * Scripted exchange: each call takes the next scripted reply for its endpoint (default: success)
 * and can be held open to model latency, so ordering and concurrency are observable.
 */
type Reply = { ok: unknown } | { err: unknown } | { hold: true };
class FakeExchange implements OrderApi {
  readonly log: string[] = [];
  readonly script: Record<string, Reply[]> = {};
  private held: Array<() => void> = [];
  inFlight = 0;
  maxInFlight = 0;

  private async call<T>(name: string, dflt: () => T): Promise<T> {
    this.log.push(name);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const r = this.script[name.split(':')[0]!]?.shift();
      if (r && 'hold' in r) await new Promise<void>((res) => this.held.push(res));
      if (r && 'err' in r) throw r.err;
      if (r && 'ok' in r) return r.ok as T;
      return dflt();
    } finally {
      this.inFlight--;
    }
  }

  release(): void {
    this.held.splice(0).forEach((r) => r());
  }

  placeLimitMaker(_s: string, side: 'BUY' | 'SELL', q: string, p: string, cid: string) {
    return this.call(`place:${cid}`, () => ({ orderId: `X-${cid}`, side, q, p }));
  }
  cancelOrder(_s: string, cid: string) {
    return this.call(`cancel:${cid}`, () => order(cid, 'CANCELED'));
  }
  cancelAll() {
    return this.call('cancelAll', () => [order('a', 'CANCELED'), order('b', 'CANCELED', '0.5')]);
  }
  queryOrder(_s: string, cid: string) {
    return this.call(`query:${cid}`, () => order(cid, 'PARTIALLY_FILLED', '0.25'));
  }
}

const order = (cid: string, status: string, executedQty = '0'): MexcOrderRaw => ({
  symbol: 'IOUSDT', orderId: `X-${cid}`, clientOrderId: cid, price: '0.5000', origQty: '2.00', executedQty, status, side: 'BUY',
});
const rest = (status: number, code?: number, retryAfterMs?: number) => new MexcRestError(`http ${status}`, status, code, retryAfterMs);

function setup(over: Partial<ConstructorParameters<typeof LiveExecutor>[0]> = {}) {
  const api = new FakeExchange();
  const events: ExecEvent[] = [];
  const fatal: unknown[] = [];
  let now = 1_000_000;
  const slept: number[] = [];
  const ex = new LiveExecutor({
    api, symbol: 'IOUSDT', emit: (e) => events.push(...e), onFatal: (e) => fatal.push(e),
    clock: () => now, sleep: async (ms) => { slept.push(ms); now += ms; }, ...over,
  });
  return { api, ex, events, fatal, slept, advance: (ms: number) => (now += ms) };
}

const P = (id: string) => ({ clientOrderId: id, side: 'BUY' as const, price: '0.5000', qty: '2.00' });
const kinds = (e: ExecEvent[]) => e.map((x) => `${x.kind}${'clientOrderId' in x ? `:${x.clientOrderId}` : ''}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LiveExecutor', () => {
  it('place → ack with the exchange orderId; duplicate places are dropped (idempotent)', async () => {
    const { api, ex, events } = setup();
    ex.place(P('c1'));
    ex.place(P('c1'));
    await ex.idle();
    expect(api.log).toEqual(['place:c1']);
    expect(events).toEqual([{ kind: 'ack', ts: 1_000_000, clientOrderId: 'c1', orderId: 'X-c1' }]);
  });

  it('a cancel never overtakes its own place, while other orders proceed concurrently', async () => {
    const { api, ex, events } = setup();
    api.script.place = [{ hold: true }];
    ex.place(P('c1'));
    ex.cancel('c1');
    ex.place(P('c2'));
    await tick();
    expect(api.log).toEqual(['place:c1', 'place:c2']); // c2 is not stuck behind c1
    api.release();
    await ex.idle();
    expect(api.log).toEqual(['place:c1', 'place:c2', 'cancel:c1']);
    expect(kinds(events)).toEqual(['ack:c2', 'ack:c1', 'order:c1']);
    expect(events[2]).toMatchObject({ kind: 'order', status: 'CANCELED', source: 'rest', remainQty: '2' });
  });

  it('refused ⇒ reject (not executed); no answer ⇒ unknown (must be queried)', async () => {
    const { api, ex, events } = setup();
    api.script.place = [{ err: rest(400, 10101) }, { err: new DOMException('timed out', 'TimeoutError') }, { err: rest(503) }];
    ex.place(P('a'));
    ex.place(P('b'));
    ex.place(P('c'));
    await ex.idle();
    expect(events).toEqual([
      expect.objectContaining({ kind: 'reject', clientOrderId: 'a', op: 'place', code: 10101 }),
      expect.objectContaining({ kind: 'unknown', clientOrderId: 'b', op: 'place' }),
      expect.objectContaining({ kind: 'unknown', clientOrderId: 'c', op: 'place' }),
    ]);
  });

  it('429 blocks every request until Retry-After and is reported as a venue event', async () => {
    const { api, ex, events, slept } = setup();
    api.script.place = [{ err: rest(429, 429, 3_000) }];
    ex.place(P('a'));
    await ex.idle();
    ex.place(P('b'));
    await ex.idle();
    expect(kinds(events)).toEqual(['venue', 'reject:a', 'ack:b']);
    expect(events[0]).toMatchObject({ state: 'rate_limited' });
    expect(events[1]).toMatchObject({ reason: 'rate_limited' });
    expect(slept).toContain(3_000);
  });

  it('auth and clock failures are venue events (the engine halts / pauses on them)', async () => {
    const { api, ex, events } = setup();
    api.script.place = [{ err: rest(400, 700002) }, { err: rest(400, 700003) }];
    ex.place(P('a'));
    ex.place(P('b'));
    await ex.idle();
    expect(events.filter((e) => e.kind === 'venue').map((e) => (e as { state: string }).state)).toEqual(['auth', 'clock']);
    expect(events.filter((e) => e.kind === 'reject').map((e) => (e as { reason: string }).reason)).toEqual(['auth', 'clock']);
  });

  it('cancel: unknown order ⇒ unknown (query decides); no answer is retried, then unknown', async () => {
    const { api, ex, events } = setup({ cancelAttempts: 3 });
    api.script.cancel = [{ err: rest(400, -2011) }, { err: rest(502) }, { err: rest(502) }, { ok: order('y', 'CANCELED') }, { err: rest(502) }, { err: rest(502) }, { err: rest(502) }];
    ex.cancel('x');
    await ex.idle();
    ex.cancel('y');
    await ex.idle();
    ex.cancel('z');
    await ex.idle();
    expect(api.log).toEqual(['cancel:x', 'cancel:y', 'cancel:y', 'cancel:y', 'cancel:z', 'cancel:z', 'cancel:z']);
    expect(kinds(events)).toEqual(['unknown:x', 'order:y', 'unknown:z']);
  });

  it('concurrent cancels of the same order are coalesced', async () => {
    const { api, ex } = setup();
    api.script.cancel = [{ hold: true }];
    ex.cancel('x');
    ex.cancel('x');
    await tick();
    api.release();
    await ex.idle();
    expect(api.log).toEqual(['cancel:x']);
  });

  it('query: order snapshot, or missing when the exchange never saw it', async () => {
    const { api, ex, events } = setup();
    api.script.query = [{ ok: order('q1', 'PARTIALLY_FILLED', '0.75') }, { err: rest(400, -2013) }, { err: rest(500) }];
    ex.query('q1');
    ex.query('q2');
    ex.query('q3');
    await ex.idle();
    expect(events[0]).toMatchObject({ kind: 'order', status: 'PARTIALLY_FILLED', cumQty: '0.75', remainQty: '1.25' });
    expect(events[1]).toEqual({ kind: 'missing', ts: 1_000_000, clientOrderId: 'q2' });
    expect(events[2]).toMatchObject({ kind: 'unknown', clientOrderId: 'q3' });
  });

  it('token bucket: never more than the burst at once, then the sustained rate', async () => {
    const { api, ex, slept } = setup({ ratePerSec: 5, burst: 2 });
    for (let i = 0; i < 6; i++) ex.place(P(`o${i}`));
    await ex.idle();
    expect(api.log).toHaveLength(6);
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(800); // 4 extra tokens at 5/s
  });

  it('respects maxConcurrent', async () => {
    const { api, ex } = setup({ maxConcurrent: 2, burst: 10 });
    api.script.place = [{ hold: true }, { hold: true }, { hold: true }];
    ex.place(P('a'));
    ex.place(P('b'));
    ex.place(P('c'));
    await tick();
    expect(api.inFlight).toBe(2);
    while (ex.inFlight > 0) {
      api.release();
      await tick();
    }
    expect(api.maxInFlight).toBe(2);
  });

  it('cancelAll returns and emits every canceled order; failure throws (never assumed)', async () => {
    const { api, ex, events } = setup();
    const evs = await ex.cancelAll();
    expect(evs.map((e) => (e as { clientOrderId: string }).clientOrderId)).toEqual(['a', 'b']);
    expect(events).toHaveLength(2);
    api.script.cancelAll = [{ err: rest(502) }];
    await expect(ex.cancelAll()).rejects.toThrow(/502/);
  });

  it('an emit that throws is handed to onFatal, never swallowed', async () => {
    const fatal: unknown[] = [];
    const { ex } = setup({ emit: () => { throw new Error('engine failed'); }, onFatal: (e) => fatal.push(e) });
    ex.place(P('a'));
    await ex.idle();
    expect(fatal).toHaveLength(1);
    expect(String(fatal[0])).toMatch(/engine failed/);
  });
});
