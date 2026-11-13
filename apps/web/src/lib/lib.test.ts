import crypto from 'node:crypto';
import * as shared from '@cortex/shared';
import type { BotView, SeriesPoint, StoredEvent, WsServerMessage } from '@cortex/shared';
import { describe, expect, it } from 'vitest';
import { sampleView } from '../../../api/src/testing/fixtures';
import { aprOf, bandOf, botHealth, pnlOf, totalsOf, touchSpreadBps } from './derive';
import { fmtAge, fmtBps, fmtPrice, fmtUsd, pairLabel, shortAddr, toCsv } from './format';
import { LiveStore, MAX_EVENTS, WS_CLOSE_UNAUTHORIZED, backoffMs, mergePoints, wsUrl, type SocketLike } from './live';
import { hrefOf, parseRoute } from './router';
import { parseTokenBalance, solscanTx, usdtBalance } from './solana';
import { findPhantom, signInError, signInWithPhantom, toBase64, type SolanaProvider } from './wallet';

describe('solana treasury wallet (read only)', () => {
  it('sums parsed token accounts; anything malformed is null; links are encoded', async () => {
    const acct = (ui: string) => ({ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: ui } } } } } });
    expect(parseTokenBalance({ result: { value: [acct('20.5'), acct('4.5')] } })).toBe(25);
    expect(parseTokenBalance({ result: { value: [] } })).toBe(0);
    expect(parseTokenBalance({ error: { code: -32602 } })).toBeNull();
    expect(parseTokenBalance({ result: { value: [{ account: {} }] } })).toBeNull();
    expect(solscanTx('a/b')).toBe('https://solscan.io/tx/a%2Fb');
    const calls: string[] = [];
    const f = (async (url: string, init: { body: string }) => {
      calls.push(url, init.body);
      return new Response(JSON.stringify({ result: { value: [acct('7')] } }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await usdtBalance('Owner1', f)).toBe(7);
    expect(calls[0]).toBe(shared.SOLANA_RPC_URL);
    expect(JSON.parse(calls[1]!)).toMatchObject({ method: 'getTokenAccountsByOwner', params: ['Owner1', { mint: shared.USDT_SOLANA_MINT }, { encoding: 'jsonParsed' }] });
    expect(await usdtBalance('Owner1', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
  });
});

const BOT = 'mexc:IOUSDT:shadow';
const T = Date.UTC(2026, 10, 12, 12);

describe('format (pt-BR)', () => {
  it('money, bps, prices, ages, labels', () => {
    expect(fmtUsd(15)).toBe('US$ 15,00');
    expect(fmtUsd(-0.0123)).toBe('−US$ 0,0123');
    expect(fmtUsd(1234.5, true)).toBe('+US$ 1.234,50');
    expect(fmtUsd(null)).toBe('—');
    expect(fmtUsd(Number.NaN)).toBe('—');
    expect(fmtBps(-3.25, 1)).toBe('−3,3 bps');
    expect(fmtBps(2, 1, true)).toBe('+2,0 bps');
    expect(fmtPrice(0.00001234)).toBe('0,00001234');
    expect(fmtPrice(1.5)).toBe('1,5000');
    expect(fmtAge(500)).toBe('agora');
    expect(fmtAge(42_000)).toBe('42 s');
    expect(fmtAge(3 * 3_600_000)).toBe('3 h');
    expect(pairLabel('KAITOUSDT')).toBe('KAITO/USDT');
    expect(shortAddr('GqVo5G4xG8HBYzBrdgvTGyeHEGeuob5q7ZKWY3AUtDwH')).toBe('GqVo…tDwH');
  });

  it('CSV escapes quotes, commas and newlines (RFC 4180)', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"'], [1, null]])).toBe('a,b\r\n"x,y","say ""hi"""\r\n1,\r\n');
  });
});

describe('derived metrics', () => {
  it('health: stale, halted, paused, dead feeds, errors', () => {
    expect(botHealth(sampleView(BOT, T), T + 1_000)).toEqual({ level: 'ok', reasons: [] });
    expect(botHealth(sampleView(BOT, T), T + 31_000).level).toBe('down');
    expect(botHealth(sampleView(BOT, T, { status: 'halted', haltRule: 'max_drawdown' }), T).reasons).toContain('halt: max_drawdown');
    expect(botHealth(sampleView(BOT, T, { status: 'paused' }), T).level).toBe('warn');
    const dead = sampleView(BOT, T, { feeds: { mexcAgeMs: null, binanceAgeMs: 10 } });
    expect(botHealth(dead, T)).toEqual({ level: 'warn', reasons: ['feed MEXC parado'] });
  });

  it('PnL, drawdown, and no APR before 24 hourly windows', () => {
    const v = sampleView(BOT, T); // equity 14.5, start 15, peak 15.1
    const p = pnlOf(v);
    expect(p.abs).toBeCloseTo(-0.5, 12);
    expect(p.bps).toBeCloseTo(-333.333, 2);
    expect(p.drawdown).toBeCloseTo(0.6 / 15.1, 12);
    expect(aprOf(v)).toBeNull();
    expect(aprOf(sampleView(BOT, T, { edge: { ...v.edge, n: 24, meanBps: 1 } }))).toBeCloseTo(0.876, 12);
    expect(pnlOf(sampleView(BOT, T, { pnl: { ...v.pnl, equity: null } })).abs).toBeNull();
  });

  it('totals across bots ignore unpriced bots but count them', () => {
    const a = sampleView(BOT, T);
    const b = sampleView('mexc:ZROUSDT:shadow', T, { status: 'paused', pnl: { equity: 16, startEquity: 15, peakEquity: 16, realized: 1, unrealized: 0 } });
    const c = sampleView('mexc:WUSDT:shadow', T, { pnl: { equity: null, startEquity: null, peakEquity: null, realized: 0, unrealized: 0 } });
    const t = totalsOf([a, b, c], T);
    expect(t).toMatchObject({ bots: 3, running: 2, attention: 1, equity: 30.5, startEquity: 30, fills: 15 });
    expect(t.pnlBps).toBeCloseTo((0.5 / 30) * 1e4, 9);
    expect(totalsOf([], T).equity).toBeNull();
  });

  it('band geometry orders venue touch, our quotes and fair inside [0,100]', () => {
    const b = bandOf(sampleView(BOT, T));
    for (const x of [b.bestBid, b.quoteBid, b.fair, b.quoteAsk, b.bestAsk]) expect(x).toBeGreaterThanOrEqual(0);
    expect(b.bestBid!).toBeLessThan(b.quoteBid!);
    expect(b.quoteBid!).toBeLessThan(b.fair!);
    expect(b.fair!).toBeLessThan(b.quoteAsk!);
    expect(b.quoteAsk!).toBeLessThan(b.bestAsk!);
    expect(b.bestAsk!).toBeLessThanOrEqual(100);
    expect(b.widthBps).toBeCloseTo((0.01 / 1.5001) * 1e4, 9);
    expect(touchSpreadBps(sampleView(BOT, T))).toBeCloseTo((0.02 / 1.5) * 1e4, 9);
  });
});

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed?: number;
  constructor(readonly url: string) {}
  close(code?: number) {
    this.closed = code;
  }
  recv(m: WsServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

function liveHarness() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let now = T;
  const store = new LiveStore({
    url: () => 'wss://x/ws',
    socket: (u) => {
      const s = new FakeSocket(u);
      sockets.push(s);
      return s;
    },
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
    now: () => now,
    random: () => 1,
  });
  return { store, sockets, timers, tick: (ms: number) => (now += ms) };
}

const point = (ts: number): SeriesPoint => ({ ts, mid: 1, fair: 1, refMid: 1, quoteBid: null, quoteAsk: null, equity: 15, inventory: 0 });
const ev = (id: string, ts = 1): StoredEvent => ({ id, botId: BOT, e: { k: 'error', ts, message: id } });

describe('live store (WebSocket snapshot + deltas)', () => {
  it('constants mirror @cortex/shared (kept local so zod stays out of the bundle)', () => {
    expect(WS_CLOSE_UNAUTHORIZED).toBe(shared.WS_CLOSE_UNAUTHORIZED);
  });

  it('hello replaces the views; ticks update, merge points by ts, dedupe events by id', () => {
    const { store, sockets } = liveHarness();
    store.connect();
    expect(store.state).toBe('connecting');
    const s = sockets[0]!;
    s.recv({ t: 'tick', serverTime: T, views: [sampleView('mexc:OLDUSDT:shadow', T)], points: [], events: [] });
    s.recv({ t: 'hello', serverTime: T + 500, actor: 'me', views: [sampleView(BOT, T)] });
    expect(store.state).toBe('live');
    expect([...store.views.keys()]).toEqual([BOT]); // the snapshot wins
    expect(store.clockOffsetMs).toBe(500);
    s.recv({ t: 'tick', serverTime: T, views: [sampleView(BOT, T + 1, { status: 'paused' })], points: [{ botId: BOT, p: point(10) }, { botId: BOT, p: point(5) }], events: [ev('1-0'), ev('2-0')] });
    store.seedPoints(BOT, [point(5), point(1)]);
    store.seedEvents([ev('2-0'), ev('1-5'), ev('0-9')]);
    expect(store.views.get(BOT)!.status).toBe('paused');
    expect(store.points.get(BOT)!.map((p) => p.ts)).toEqual([1, 5, 10]);
    expect(store.events.map((e) => e.id)).toEqual(['2-0', '1-5', '1-0', '0-9']);
  });

  it('reconnects with capped exponential backoff and resets it on hello', () => {
    const { store, sockets, timers } = liveHarness();
    store.connect();
    for (let i = 0; i < 3; i++) {
      sockets.at(-1)!.onclose?.({ code: 1006 });
      expect(store.state).toBe('reconnecting');
      timers.at(-1)!.fn();
    }
    expect(timers.map((t) => t.ms)).toEqual([500, 1000, 2000]);
    expect(backoffMs(20, () => 1)).toBe(15_000);
    expect(backoffMs(0, () => 0)).toBe(250);
    sockets.at(-1)!.recv({ t: 'hello', serverTime: T, actor: 'me', views: [] });
    sockets.at(-1)!.onclose?.({ code: 1006 });
    expect(timers.at(-1)!.ms).toBe(500);
  });

  it('4401 stops reconnecting (session gone); disconnect() is quiet', () => {
    const { store, sockets, timers } = liveHarness();
    store.connect();
    sockets[0]!.onclose?.({ code: WS_CLOSE_UNAUTHORIZED });
    expect(store.state).toBe('unauthorized');
    expect(timers.length).toBe(0);
    const h = liveHarness();
    h.store.connect();
    h.store.disconnect();
    h.sockets[0]!.onclose?.({ code: 1000 });
    expect(h.store.state).toBe('idle');
    expect(h.timers.length).toBe(0);
  });

  it('a fill seen in both streams (different stream ids) is kept once, ordered by time', () => {
    const { store } = liveHarness();
    const f = (id: string, fillId: string, ts: number): StoredEvent => ({ id, botId: BOT, e: { k: 'fill', ts, fillId, clientOrderId: 'c', side: 'BUY', price: 1, qty: 1, fee: 0, feeAsset: 'quote' } });
    store.seedEvents([f('100-0', 'a', 100), f('200-0', 'b', 200)]); // live, events-stream ids
    store.seedEvents([f('100-1', 'a', 100), f('200-3', 'b', 200), f('50-0', 'z', 50)]); // REST, fills-stream ids
    expect(store.fills.map((x) => (x.e as { fillId: string }).fillId)).toEqual(['b', 'a', 'z']);
  });

  it('memory stays bounded', () => {
    const { store } = liveHarness();
    store.seedEvents(Array.from({ length: MAX_EVENTS + 50 }, (_, i) => ev(`${i}-0`)));
    expect(store.events.length).toBe(MAX_EVENTS);
    expect(store.events[0]!.id).toBe(`${MAX_EVENTS + 49}-0`); // the newest are kept
    expect(mergePoints([], Array.from({ length: 10 }, (_, i) => point(i)), 4).map((p) => p.ts)).toEqual([6, 7, 8, 9]);
  });

  it('ws url follows the page scheme', () => {
    expect(wsUrl({ protocol: 'https:', host: 'cortex.ts.net' })).toBe('wss://cortex.ts.net/ws');
    expect(wsUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws');
  });
});

describe('router', () => {
  it('parses and builds every page; bot ids round-trip', () => {
    expect(parseRoute('/')).toEqual({ page: 'overview' });
    expect(parseRoute('/risk/')).toEqual({ page: 'risk' });
    const r = parseRoute(hrefOf({ page: 'bot', botId: BOT }));
    expect(r).toEqual({ page: 'bot', botId: BOT });
    expect(parseRoute('/bot/%E0%A4%A')).toEqual({ page: 'notfound' });
    expect(parseRoute('/nope')).toEqual({ page: 'notfound' });
  });
});

describe('Phantom sign-in', () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const address = 'GqVo5G4xG8HBYzBrdgvTGyeHEGeuob5q7ZKWY3AUtDwH';
  const provider = (signed: string[]): SolanaProvider => ({
    isPhantom: true,
    connect: async () => ({ publicKey: { toString: () => address } }),
    disconnect: async () => undefined,
    signMessage: async (m) => {
      signed.push(new TextDecoder().decode(m));
      return { signature: new Uint8Array(crypto.sign(null, Buffer.from(m), keys.privateKey)) };
    },
  });

  it('signs exactly the server message and sends the signature in base64', async () => {
    const signed: string[] = [];
    const message = `cortex.ts.net wants you to sign in with your Solana account:\n${address}\n\nSign in.`;
    let sent: [string, string] | undefined;
    const steps: string[] = [];
    const r = await signInWithPhantom(provider(signed), {
      nonce: async () => ({ message }),
      verify: async (m, s) => {
        sent = [m, s];
        return { address };
      },
    }, 'cortex.ts.net', (s) => steps.push(s));
    expect(r).toBe(address);
    expect(signed).toEqual([message]);
    expect(sent![0]).toBe(message);
    expect(crypto.verify(null, Buffer.from(message), keys.publicKey, Buffer.from(sent![1], 'base64'))).toBe(true);
    expect(steps).toEqual(['connect', 'challenge', 'sign', 'verify']);
  });

  it('refuses to sign a message for another domain or another address', async () => {
    for (const message of [
      `evil.example wants you to sign in with your Solana account:\n${address}\n\nSign in.`,
      'cortex.ts.net wants you to sign in with your Solana account:\nSomeoneElse1111111111111111111111111111111\n\nx',
      'Transfer 100 SOL',
    ]) {
      const signed: string[] = [];
      await expect(signInWithPhantom(provider(signed), { nonce: async () => ({ message }), verify: async () => ({ address }) }, 'cortex.ts.net')).rejects.toThrow(/inesperada/);
      expect(signed).toEqual([]);
    }
  });

  it('provider detection, base64, error messages', () => {
    const p = { isPhantom: true } as SolanaProvider;
    expect(findPhantom({ phantom: { solana: p } })).toBe(p);
    expect(findPhantom({ solana: { ...p, isPhantom: false } })).toBeUndefined();
    expect(toBase64(new Uint8Array([0, 255, 1]))).toBe(Buffer.from([0, 255, 1]).toString('base64'));
    expect(signInError({ code: 4001 })).toMatch(/cancelada/);
    expect(signInError({ status: 401 })).toMatch(/allowlist/);
  });
});

// Keeps the BotView fixture honest: it must satisfy the shared schema.
it('fixture satisfies BotViewSchema', () => {
  expect(shared.BotViewSchema.parse(sampleView(BOT, T)) as BotView).toBeTruthy();
});
