import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { encodeMexcPush, type MexcPush } from './codec';
import { mexcPrivateChannels, type ExecEvent } from './private';
import { MexcUserStream, type ListenKeyApi, type UserStreamState } from './user-stream';

/** A local stand-in for wbs-api.mexc.com speaking the same JSON control + protobuf data frames. */
class FakeMexc {
  readonly wss = new WebSocketServer({ port: 0 });
  readonly conns: Array<{ ws: WebSocket; url: string; subs: string[] }> = [];
  ack: 'ok' | 'refuse' | 'silent' = 'ok';
  pong = true;

  constructor() {
    this.wss.on('connection', (ws, req) => {
      const c = { ws, url: req.url ?? '', subs: [] as string[] };
      this.conns.push(c);
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as { method: string; params?: string[] };
        if (m.method === 'PING' && this.pong) ws.send(JSON.stringify({ id: 0, code: 0, msg: 'PONG' }));
        if (m.method === 'SUBSCRIPTION') {
          const ch = m.params![0]!;
          c.subs.push(ch);
          if (this.ack === 'ok') ws.send(JSON.stringify({ id: 0, code: 0, msg: ch }));
          if (this.ack === 'refuse') ws.send(JSON.stringify({ id: 0, code: 1, msg: 'Blocked!' }));
        }
      });
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}/ws`;
  }

  get last() {
    return this.conns[this.conns.length - 1]!;
  }

  push(p: MexcPush | Uint8Array): void {
    this.last.ws.send(p instanceof Uint8Array ? p : encodeMexcPush(p), { binary: true });
  }

  close(): Promise<void> {
    for (const c of this.conns) c.ws.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

class FakeKeys implements ListenKeyApi {
  created = 0;
  keepAlives: string[] = [];
  deleted: string[] = [];
  keepAliveFails = false;
  async createListenKey() {
    return `key${++this.created}`;
  }
  async keepAliveListenKey(k: string) {
    this.keepAlives.push(k);
    if (this.keepAliveFails) throw new Error('listenKey expired');
  }
  async deleteListenKey(k: string) {
    this.deleted.push(k);
  }
}

async function until(cond: () => boolean, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const fast = { pingIntervalMs: 40, staleMs: 400, tickMs: 20, backoffBaseMs: 10, backoffMaxMs: 40, subscribeTimeoutMs: 300 };

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

function setup(over: Partial<ConstructorParameters<typeof MexcUserStream>[1]> = {}) {
  const ex = new FakeMexc();
  const keys = new FakeKeys();
  const states: UserStreamState[] = [];
  const execs: ExecEvent[] = [];
  const s = new MexcUserStream({ onExec: (e) => execs.push(...e), onState: (x) => states.push(x) }, { rest: keys, url: ex.url, ...fast, ...over });
  cleanup.push(async () => {
    await s.stop();
    await ex.close();
  });
  return { ex, keys, states, execs, s };
}

const ups = (st: UserStreamState[]) => st.filter((x) => x.state === 'up').length;

describe('MexcUserStream', () => {
  it('connects with a fresh listenKey, confirms all three channels, then decodes private frames', async () => {
    const { ex, keys, states, execs, s } = setup();
    s.start();
    await until(() => s.up);
    expect(keys.created).toBe(1);
    expect(ex.last.url).toBe('/ws?listenKey=key1');
    expect(ex.last.subs.sort()).toEqual(Object.values(mexcPrivateChannels).sort());
    expect(states).toEqual([{ state: 'up', session: 1 }]);
    ex.push({ channel: mexcPrivateChannels.deals, symbol: 'IOUSDT', privateDeals: { price: '0.5', quantity: '2', tradeType: 1, tradeId: 't1', orderId: 'o1', clientOrderId: 'c1', feeAmount: '0', feeCurrency: 'USDT', isMaker: true, time: 1 } } as unknown as MexcPush);
    await until(() => execs.length === 1);
    expect(execs[0]).toMatchObject({ kind: 'fill', tradeId: 't1', side: 'BUY', qty: '2', clientOrderId: 'c1' });
  });

  it('a dropped connection reports down, then reuses the still-valid key after a keepalive', async () => {
    const { ex, keys, states, s } = setup();
    s.start();
    await until(() => s.up);
    ex.last.ws.terminate();
    await until(() => ups(states) === 2);
    expect(states.map((x) => x.state)).toEqual(['up', 'down', 'up']);
    expect(states[2]).toEqual({ state: 'up', session: 2 });
    expect(keys.created).toBe(1);
    expect(keys.keepAlives).toContain('key1');
    expect(ex.last.url).toBe('/ws?listenKey=key1');
  });

  it('an expired key (keepalive fails) is replaced and the old one deleted', async () => {
    const { ex, keys, states, s } = setup();
    s.start();
    await until(() => s.up);
    keys.keepAliveFails = true;
    ex.last.ws.terminate();
    await until(() => ups(states) === 2);
    expect(keys.created).toBe(2);
    expect(keys.deleted).toContain('key1');
    expect(ex.last.url).toBe('/ws?listenKey=key2');
  });

  it('the periodic keepalive failing rotates the key and forces a gap', async () => {
    const { ex, keys, states, s } = setup({ keepAliveMs: 150 });
    s.start();
    await until(() => s.up);
    keys.keepAliveFails = true;
    await until(() => states.some((x) => x.state === 'down'));
    keys.keepAliveFails = false;
    await until(() => ups(states) === 2);
    expect(ex.last.url).toBe('/ws?listenKey=key2');
    expect(keys.deleted).toContain('key1');
  });

  it('a refused or unconfirmed subscription never reports up', async () => {
    const { ex, states, s } = setup();
    ex.ack = 'refuse';
    s.start();
    await until(() => ex.conns.length >= 2);
    ex.ack = 'silent';
    await until(() => ex.conns.length >= 4); // subscribe timeout → reconnect
    expect(states).toEqual([]);
    ex.ack = 'ok';
    await until(() => s.up);
  });

  it('silence (no PONG, no data) is detected as stale: down + reconnect', async () => {
    const { ex, states, s } = setup();
    s.start();
    await until(() => s.up);
    ex.pong = false;
    await until(() => states.some((x) => x.state === 'down'));
    expect((states[1] as { reason: string }).reason).toMatch(/^stale/);
    ex.pong = true;
    await until(() => ups(states) === 2);
  });

  it('an undecodable private frame forces a gap instead of being skipped', async () => {
    const { ex, states, execs, s } = setup();
    s.start();
    await until(() => s.up);
    ex.push(new Uint8Array([0xff, 0xff, 0xff, 0x0f]));
    await until(() => states.some((x) => x.state === 'down'));
    expect((states[1] as { reason: string }).reason).toMatch(/undecodable/);
    expect(execs).toEqual([]);
    await until(() => ups(states) === 2);
  });

  it('stop reports down and deletes the key', async () => {
    const { keys, states, s } = setup();
    s.start();
    await until(() => s.up);
    await s.stop();
    expect(states.map((x) => x.state)).toEqual(['up', 'down']);
    expect(keys.deleted).toEqual(['key1']);
  });
});
