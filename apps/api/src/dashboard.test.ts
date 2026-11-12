import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WS_CLOSE_SLOW, WS_CLOSE_UNAUTHORIZED, type BotEvent, type BotView, type WsServerMessage } from '@cortex/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { buildApp, SESSION_COOKIE } from './app';
import { MemoryAudit } from './audit';
import { base32Encode } from './auth/encoding';
import { MemoryBus } from './commands';
import { loadApiConfig } from './config';
import { MemoryBotData } from './data';
import { LiveHub, type HubSocket } from './hub';
import { MemoryStore } from './store';
import { sampleView } from './testing/fixtures';
import { testWallet } from './testing/wallet';

const ORIGIN = 'https://cortex-tokyo.example.ts.net';
const BOT = 'mexc:IOUSDT:shadow';
const BOT2 = 'mexc:KAITOUSDT:shadow';
const readToken = 'prometheus-token-for-tests-only-0123456789';
const pauseToken = 'pause-only-token-for-tests-only-0123456789';
const h = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const fill = (ts: number, id = 'f'): BotEvent => ({ k: 'fill', ts, fillId: id, clientOrderId: `c-${id}`, side: 'BUY', price: 1.49, qty: 4, fee: 0, feeAsset: 'quote' });
const order = (ts: number): BotEvent => ({ k: 'order', ts, op: 'cancel', clientOrderId: 'x', reason: 'ttl' });

const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function setup(opts: { webDir?: string; withData?: boolean } = {}) {
  const owner = testWallet();
  let t = Date.UTC(2026, 10, 12, 12, 0, 0);
  const now = () => t;
  const config = loadApiConfig({
    API_ORIGIN: ORIGIN, API_ALLOWED_WALLETS: owner.address, API_TOTP_SECRET: base32Encode(crypto.randomBytes(20)),
    API_SERVICE_TOKENS: `prometheus:${h(readToken)}:read,pager:${h(pauseToken)}:pause`,
  });
  const store = new MemoryStore(now);
  const audit = new MemoryAudit(now);
  const data = new MemoryBotData(now);
  const app = await buildApp({ config, store, audit, bus: new MemoryBus(), data: opts.withData === false ? undefined : data, now, webDir: opts.webDir, hub: { tickMs: 1_000_000, revalidateMs: 1_000_000 } }); // ticks driven by the tests
  apps.push(app);
  await app.ready();
  const { message } = (await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: owner.address } })).json() as { message: string };
  const login = await app.inject({ method: 'POST', url: '/auth/verify', payload: { message, signature: Buffer.from(owner.sign(message)).toString('base64') } });
  const session = login.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const asOwner = { cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN };
  const get = (url: string, headers: Record<string, string> = asOwner) => app.inject({ method: 'GET', url, headers });
  /** Opens the feed with the collector attached before the first frame (hello is sent at once). */
  const connect = async (headers: Record<string, string> = asOwner) => {
    let c!: ReturnType<typeof collector>;
    const ws = await app.injectWS('/ws', { headers }, { onInit: (w: WebSocket) => void (c = collector(w)) });
    return { ws, ...c };
  };
  return { app, data, audit, store, owner, asOwner, session, get, connect, now, advance: (ms: number) => (t += ms) };
}

/** Collects WebSocket messages; resolves when `pred` holds. */
function collector(ws: WebSocket) {
  const msgs: WsServerMessage[] = [];
  let closed: { code: number } | undefined;
  ws.on('message', (d) => msgs.push(JSON.parse(String(d)) as WsServerMessage));
  ws.on('close', (code) => (closed = { code }));
  const until = async (pred: () => boolean, ms = 2_000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timeout; got ${JSON.stringify(msgs.map((m) => m.t))}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { msgs, until, closed: () => closed };
}

describe('dashboard read API', () => {
  it('needs a session or a read-scoped token; without the data source it answers 503', async () => {
    const s = await setup();
    s.data.publishView(sampleView(BOT, s.now()));
    expect((await s.get('/bots', {})).statusCode).toBe(401);
    expect((await s.get('/bots', { authorization: `Bearer ${pauseToken}` })).statusCode).toBe(403);
    expect((await s.get('/bots', { authorization: 'Bearer nope' })).statusCode).toBe(401);
    const svc = await s.get('/bots', { authorization: `Bearer ${readToken}` });
    expect(svc.statusCode).toBe(200);
    expect((svc.json() as { bots: BotView[] }).bots.map((b) => b.botId)).toEqual([BOT]);
    const none = await setup({ withData: false });
    expect((await none.get('/bots')).statusCode).toBe(503);
  });

  it('lists views, serves one bot, 404 for an unknown bot, 400 for a malformed id', async () => {
    const s = await setup();
    s.data.publishView(sampleView(BOT2, s.now()));
    s.data.publishView(sampleView(BOT, s.now(), { status: 'paused', quoting: false }));
    const list = (await s.get('/bots')).json() as { bots: BotView[]; missing: string[] };
    expect(list.bots.map((b) => [b.botId, b.status])).toEqual([[BOT, 'paused'], [BOT2, 'running']]);
    expect(list.missing).toEqual([]);
    expect(((await s.get(`/bots/${encodeURIComponent(BOT)}`)).json() as BotView).status).toBe('paused');
    expect((await s.get(`/bots/${encodeURIComponent('mexc:NOPEUSDT:shadow')}`)).statusCode).toBe(404);
    expect((await s.get('/bots/not-a-bot')).statusCode).toBe(400);
  });

  it('events: newest first, exclusive cursor, kind filter; fills have their own stream', async () => {
    const s = await setup();
    for (let i = 0; i < 7; i++) {
      s.data.publishEvent(BOT, i % 3 === 0 ? fill(i, `f${i}`) : order(i));
      s.advance(1);
    }
    const page1 = (await s.get(`/bots/${encodeURIComponent(BOT)}/events?limit=4`)).json() as { events: Array<{ id: string; e: BotEvent }>; next: string };
    expect(page1.events.map((x) => x.e.ts)).toEqual([6, 5, 4, 3]);
    const page2 = (await s.get(`/bots/${encodeURIComponent(BOT)}/events?limit=4&before=${page1.next}`)).json() as { events: Array<{ e: BotEvent }>; next: string | null };
    expect(page2.events.map((x) => x.e.ts)).toEqual([2, 1, 0]);
    expect(page2.next).toBeNull();
    const fills = (await s.get(`/bots/${encodeURIComponent(BOT)}/events?kinds=fill`)).json() as { events: Array<{ e: BotEvent }> };
    expect(fills.events.map((x) => x.e.ts)).toEqual([6, 3, 0]);
    const fstream = (await s.get(`/bots/${encodeURIComponent(BOT)}/fills?limit=2`)).json() as { events: Array<{ e: BotEvent }> };
    expect(fstream.events.map((x) => x.e.k)).toEqual(['fill', 'fill']);
    expect((await s.get(`/bots/${encodeURIComponent(BOT)}/events?kinds=fill,bogus`)).statusCode).toBe(400);
    expect((await s.get(`/bots/${encodeURIComponent(BOT)}/events?before=123`)).statusCode).toBe(400);
    expect((await s.get(`/bots/${encodeURIComponent(BOT)}/events?limit=501`)).statusCode).toBe(400);
  });

  it('series: points since a time (default: the last 6 h)', async () => {
    const s = await setup();
    const t = s.now();
    for (const dt of [-7 * 3_600_000, -3_600_000, -5_000, 0]) s.data.publishPoint(BOT, { ts: t + dt, mid: 1, fair: 1, refMid: 1, quoteBid: null, quoteAsk: null, equity: 15, inventory: 0 });
    const def = (await s.get(`/bots/${encodeURIComponent(BOT)}/series`)).json() as { points: Array<{ ts: number }> };
    expect(def.points.length).toBe(3);
    const recent = (await s.get(`/bots/${encodeURIComponent(BOT)}/series?since=${t - 10_000}`)).json() as { points: unknown[] };
    expect(recent.points.length).toBe(2);
  });

  it('audit log is readable newest first with a time cursor; /system reports bot ages', async () => {
    const s = await setup();
    s.advance(1_000);
    await s.app.inject({ method: 'POST', url: `/bots/${encodeURIComponent(BOT)}/commands`, payload: { command: 'pause' }, headers: s.asOwner });
    const a = (await s.get('/audit?limit=1')).json() as { entries: Array<{ action: string; ts: number }>; next: number };
    expect(a.entries.map((e) => e.action)).toEqual(['command.requested']);
    const b = (await s.get(`/audit?before=${a.next}`)).json() as { entries: Array<{ action: string }> };
    expect(b.entries.map((e) => e.action)).toEqual(['auth.login']);
    s.data.publishView(sampleView(BOT, s.now() - 4_000));
    const sys = (await s.get('/system/info')).json() as { bots: Array<{ ageMs: number }>; api: { redis: boolean } };
    expect(sys.bots[0]!.ageMs).toBe(4_000);
    expect(sys.api.redis).toBe(true);
  });

  it('/metrics: Prometheus text for read-scoped callers only', async () => {
    const s = await setup();
    s.data.publishView(sampleView(BOT, s.now() - 2_000));
    expect((await s.get('/metrics', {})).statusCode).toBe(401);
    expect((await s.get('/metrics', { authorization: `Bearer ${pauseToken}` })).statusCode).toBe(403);
    const m = await s.get('/metrics', { authorization: `Bearer ${readToken}` });
    expect(m.statusCode).toBe(200);
    expect(m.body).toContain('cortex_api_ws_clients 0');
    expect(m.body).toContain(`cortex_api_bot_view_age_seconds{bot="${BOT}"} 2`);
    expect(m.body).toContain('cortex_api_http_request_duration_seconds_bucket');
  });
});

describe('live WebSocket (snapshot + deltas)', () => {
  it('refuses the upgrade without a session, from a foreign origin (audited), or without read scope', async () => {
    const s = await setup();
    await expect(s.app.injectWS('/ws', { headers: { origin: ORIGIN } })).rejects.toThrow(/401/);
    await expect(s.app.injectWS('/ws', { headers: { cookie: s.asOwner.cookie, origin: 'https://evil.example' } })).rejects.toThrow(/403/);
    expect(s.audit.events.at(-1)).toMatchObject({ action: 'ws.rejected', data: { reason: 'origin', origin: 'https://evil.example' } });
    await expect(s.app.injectWS('/ws', { headers: { authorization: `Bearer ${pauseToken}` } })).rejects.toThrow(/403/);
    expect(s.app.hub!.size).toBe(0);
  });

  it('hello carries every view; ticks coalesce views per bot and relay points and events with ids', async () => {
    const s = await setup();
    s.data.publishView(sampleView(BOT, s.now()));
    s.app.hub!.tick(); // flush that view to nobody: the snapshot below must still carry it
    const c = await s.connect();
    const ws = c.ws;
    await c.until(() => c.msgs.length >= 1);
    const hello = c.msgs[0]!;
    expect(hello).toMatchObject({ t: 'hello', actor: s.owner.address });
    expect((hello as { views: BotView[] }).views.map((v) => v.botId)).toEqual([BOT]);

    s.app.hub!.tick(); // nothing pending: nothing sent
    s.data.publishView(sampleView(BOT, s.now() + 1, { status: 'paused' }));
    s.data.publishView(sampleView(BOT, s.now() + 2, { status: 'halted' }));
    s.data.publishView(sampleView(BOT2, s.now() + 2));
    const id = s.data.publishEvent(BOT, fill(5));
    s.data.publishPoint(BOT, { ts: 5, mid: 1, fair: 1, refMid: null, quoteBid: null, quoteAsk: null, equity: 15, inventory: 0 });
    s.app.hub!.tick();
    await c.until(() => c.msgs.some((m) => m.t === 'tick'));
    const tick = c.msgs.find((m) => m.t === 'tick') as Extract<WsServerMessage, { t: 'tick' }>;
    expect(tick.views.map((v) => [v.botId, v.status])).toEqual([[BOT, 'halted'], [BOT2, 'running']]);
    expect(tick.events).toEqual([{ id, botId: BOT, e: fill(5) }]);
    expect(tick.points.length).toBe(1);
    expect(s.app.hub!.size).toBe(1);
    ws.terminate();
  });

  it('a logged-out session is closed with 4401 at the next revalidation', async () => {
    const s = await setup();
    const c = await s.connect();
    await c.until(() => c.msgs.length >= 1);
    await s.app.inject({ method: 'POST', url: '/auth/logout', headers: s.asOwner });
    await s.app.hub!.revalidate();
    await c.until(() => c.closed() !== undefined);
    expect(c.msgs.at(-1)).toEqual({ t: 'bye', reason: 'session_expired' });
    expect(c.closed()!.code).toBe(WS_CLOSE_UNAUTHORIZED);
    expect(s.app.hub!.size).toBe(0);
  });

  it('the client cannot talk: any message closes the feed (read-only)', async () => {
    const s = await setup();
    const c = await s.connect();
    const ws = c.ws;
    await c.until(() => c.msgs.length >= 1);
    ws.send('{"t":"command","command":"resume"}');
    await c.until(() => c.closed() !== undefined);
    expect(c.closed()!.code).toBe(1003);
  });
});

describe('hub backpressure', () => {
  it('closes a slow consumer (4408) instead of buffering for it; fast clients keep receiving', async () => {
    const data = new MemoryBotData();
    const hub = new LiveHub(data, { tickMs: 1_000_000, maxBufferedBytes: 100 });
    await hub.start();
    const mk = (buffered: number) => {
      const sent: string[] = [];
      const s: HubSocket & { sent: string[]; closedWith?: number } = {
        bufferedAmount: buffered, sent, send: (x: string) => sent.push(x), close: (code?: number) => void (s.closedWith = code),
      };
      return s;
    };
    const fast = mk(0);
    const slow = mk(10_000);
    hub.add({ socket: fast, actor: 'a', stillAuthorized: async () => true });
    hub.add({ socket: slow, actor: 'b', stillAuthorized: async () => true });
    expect(slow.closedWith).toBe(WS_CLOSE_SLOW);
    expect(JSON.parse(slow.sent[0]!)).toEqual({ t: 'bye', reason: 'slow_consumer' });
    data.publishEvent(BOT, fill(1));
    hub.tick();
    expect(fast.sent.map((x) => (JSON.parse(x) as WsServerMessage).t)).toEqual(['hello', 'tick']);
    expect(hub.size).toBe(1);
    await hub.stop();
  });

  it('caps events per tick and tells the client how many it dropped', async () => {
    const data = new MemoryBotData();
    const hub = new LiveHub(data, { tickMs: 1_000_000, maxEventsPerTick: 3 });
    await hub.start();
    const sent: string[] = [];
    hub.add({ socket: { bufferedAmount: 0, send: (x) => sent.push(x), close: () => undefined }, actor: 'a', stillAuthorized: async () => true });
    for (let i = 0; i < 5; i++) data.publishEvent(BOT, order(i));
    hub.tick();
    const tick = JSON.parse(sent[1]!) as Extract<WsServerMessage, { t: 'tick' }>;
    expect(tick.events.length).toBe(3);
    expect(tick.eventsDropped).toBe(2);
    await hub.stop();
  });
});

describe('dashboard served from the API origin', () => {
  const webDir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-web-'));
    fs.writeFileSync(path.join(d, 'index.html'), '<!doctype html><title>Cortex</title><div id="root"></div>');
    fs.mkdirSync(path.join(d, 'assets'));
    fs.writeFileSync(path.join(d, 'assets', 'app-abc123.js'), 'console.log(1)');
    return d;
  };

  it('serves the shell with a strict CSP, client routes fall back to it, API misses stay JSON 404', async () => {
    const s = await setup({ webDir: webDir() });
    const root = await s.get('/', {});
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<div id="root">');
    expect(root.headers['content-security-policy']).toContain("script-src 'self'");
    expect(root.headers['content-security-policy']).toContain(`connect-src 'self' ${ORIGIN.replace('https', 'wss')}`);
    expect(root.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(root.headers['cache-control']).toBe('no-store');
    expect(root.headers['strict-transport-security']).toBe('max-age=31536000');
    const deep = await s.get('/bot/mexc:IOUSDT:shadow', { accept: 'text/html' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<div id="root">');
    const asset = await s.get('/assets/app-abc123.js', {});
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const miss = await s.get('/nope', { accept: 'application/json' });
    expect(miss.statusCode).toBe(404);
    expect(miss.json()).toEqual({ error: 'not found' });
    // Every dashboard page path reloads into the shell, never into an API response.
    for (const p of ['/risk', '/fills', '/logs', '/treasury', '/system', '/settings']) {
      const r = await s.get(p, { accept: 'text/html' });
      expect([p, r.statusCode, r.body.includes('<div id="root">')]).toEqual([p, 200, true]);
    }
    // The data is still protected: the shell is public, the API behind it is not.
    expect((await s.get('/bots', { accept: 'text/html' })).statusCode).toBe(401);
  });
});

describe('startup does not depend on the data store', () => {
  it('a store that is down at boot: the hub starts at once, then loads the snapshot when it comes back', async () => {
    const data = new MemoryBotData();
    data.publishView(sampleView(BOT, 1));
    let down = true;
    const flaky = Object.assign(Object.create(data) as MemoryBotData, {
      listBots: async () => {
        if (down) throw new Error('ECONNREFUSED');
        return data.listBots();
      },
    });
    const hub = new LiveHub(flaky, { tickMs: 1_000_000 });
    await hub.start(); // must not wait for the store
    const sent: string[] = [];
    hub.add({ socket: { bufferedAmount: 0, send: (x) => sent.push(x), close: () => undefined }, actor: 'a', stillAuthorized: async () => true });
    expect((JSON.parse(sent[0]!) as { views: unknown[] }).views).toEqual([]);
    down = false;
    await hub.snapshotLoaded;
    hub.add({ socket: { bufferedAmount: 0, send: (x) => sent.push(x), close: () => undefined }, actor: 'b', stillAuthorized: async () => true });
    expect((JSON.parse(sent[1]!) as { views: Array<{ botId: string }> }).views.map((v) => v.botId)).toEqual([BOT]);
    await hub.stop();
  });
});
