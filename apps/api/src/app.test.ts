import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp, SESSION_COOKIE } from './app';
import { MemoryAudit } from './audit';
import { base32Encode } from './auth/encoding';
import { hotp, totpCounter } from './auth/totp';
import { MemoryBus } from './commands';
import { loadApiConfig } from './config';
import { MemoryStore } from './store';
import { testWallet } from './testing/wallet';

const ORIGIN = 'https://cortex-tokyo.example.ts.net';
const BOT = 'mexc:IOUSDT:shadow';
const totpKey = crypto.randomBytes(20);
const serviceToken = 'discord-token-for-tests-only-0123456789';

async function setup(opts: { authRatePerMin?: number } = {}) {
  const owner = testWallet();
  let t = Date.UTC(2026, 10, 12, 12, 0, 0);
  const now = () => t;
  const config = loadApiConfig({
    API_ORIGIN: ORIGIN,
    API_ALLOWED_WALLETS: owner.address,
    API_TOTP_SECRET: base32Encode(totpKey),
    API_SERVICE_TOKENS: `discord:${crypto.createHash('sha256').update(serviceToken).digest('hex')}:read+pause`,
    API_COOKIE_SECURE: 'true',
  });
  const store = new MemoryStore(now);
  const audit = new MemoryAudit();
  const bus = new MemoryBus();
  const app = await buildApp({ config, store, audit, bus, now, ...opts });

  const nonce = (address: string) => app.inject({ method: 'POST', url: '/auth/nonce', payload: { address } });
  const verify = (message: string, signature: string) => app.inject({ method: 'POST', url: '/auth/verify', payload: { message, signature } });
  const login = async (w = owner) => {
    const { message } = (await nonce(w.address)).json() as { message: string };
    return verify(message, Buffer.from(w.sign(message)).toString('base64'));
  };
  const cookieOf = (res: Awaited<ReturnType<typeof verify>>) => res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  const command = (body: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/bots/${encodeURIComponent(BOT)}/commands`, payload: body, headers });
  const asOwner = (session: string) => ({ cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN });
  const code = (offsetSteps = 0) => hotp(totpKey, totpCounter(t) + offsetSteps);
  return { app, owner, audit, bus, store, config, nonce, verify, login, cookieOf, command, asOwner, code, advance: (ms: number) => (t += ms) };
}

const reasons = (a: MemoryAudit, action: string) => a.events.filter((e) => e.action === action).map((e) => e.data?.reason);

describe('API auth: Sign-In With Solana + allowlist', () => {
  it('the owner signs in: session cookie is httpOnly, Secure, SameSite=Strict; only its hash is stored', async () => {
    const s = await setup();
    const res = await s.login();
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === SESSION_COOKIE)!;
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(await s.store.get(`session:${c.value}`)).toBeUndefined(); // raw token is not a key
    const me = await s.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `${SESSION_COOKIE}=${c.value}` } });
    expect(me.json()).toMatchObject({ kind: 'wallet', actor: s.owner.address });
    expect(s.audit.events.map((e) => e.action)).toEqual(['auth.login']);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('a wallet outside the allowlist is refused, and learns nothing about why', async () => {
    const s = await setup();
    const stranger = testWallet();
    const n = await s.nonce(stranger.address);
    expect(n.statusCode).toBe(200); // nonces are issued to anyone: no allowlist oracle
    const res = await s.login(stranger);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'sign-in rejected' });
    expect(s.cookieOf(res)).toBeUndefined();
    expect(reasons(s.audit, 'auth.rejected')).toEqual(['not_allowed']);
  });

  it('nonces are single-use and expire; a signature by another key or over another text fails', async () => {
    const s = await setup();
    const { message } = (await s.nonce(s.owner.address)).json() as { message: string };
    const sig = Buffer.from(s.owner.sign(message)).toString('base64');
    expect((await s.verify(message, sig)).statusCode).toBe(200);
    expect((await s.verify(message, sig)).statusCode).toBe(401); // replay

    const m2 = ((await s.nonce(s.owner.address)).json() as { message: string }).message;
    const forged = Buffer.from(testWallet().sign(m2)).toString('base64');
    expect((await s.verify(m2, forged)).statusCode).toBe(401);
    expect((await s.verify(m2, Buffer.from(s.owner.sign(m2)).toString('base64'))).statusCode).toBe(401); // the failed try burned the nonce

    const m3 = ((await s.nonce(s.owner.address)).json() as { message: string }).message;
    const evil = m3.replace(/^[^ ]+ wants/, 'evil.example wants'); // same nonce, phishing domain
    expect((await s.verify(evil, Buffer.from(s.owner.sign(evil)).toString('base64'))).statusCode).toBe(401);

    const m4 = ((await s.nonce(s.owner.address)).json() as { message: string }).message;
    s.advance(5 * 60_000 + 1);
    expect((await s.verify(m4, Buffer.from(s.owner.sign(m4)).toString('base64'))).statusCode).toBe(401);
    expect(reasons(s.audit, 'auth.rejected')).toEqual(['nonce', 'signature', 'nonce', 'message', 'nonce']);
  });

  it('removing a wallet from the allowlist revokes its live sessions; logout kills the session', async () => {
    const s = await setup();
    const session = s.cookieOf(await s.login())!;
    const me = () => s.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `${SESSION_COOKIE}=${session}` } });
    expect((await me()).statusCode).toBe(200);
    const out = await s.app.inject({ method: 'POST', url: '/auth/logout', headers: s.asOwner(session) });
    expect(out.statusCode).toBe(200);
    expect((await me()).statusCode).toBe(401);

    const again = s.cookieOf(await s.login())!;
    s.config.allowlist.delete(s.owner.address);
    expect((await s.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `${SESSION_COOKIE}=${again}` } })).statusCode).toBe(401);
  });

  it('sessions expire after the configured TTL', async () => {
    const s = await setup();
    const session = s.cookieOf(await s.login())!;
    s.advance(s.config.sessionTtlMs);
    expect((await s.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `${SESSION_COOKIE}=${session}` } })).statusCode).toBe(401);
  });

  it('auth endpoints are rate limited per IP', async () => {
    const s = await setup({ authRatePerMin: 3 });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await s.nonce(s.owner.address)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it('malformed input gets a generic 400, never internals', async () => {
    const s = await setup();
    for (const payload of [{}, { address: 'x'.repeat(40) }, { address: s.owner.address, extra: 1 }]) {
      const r = await s.app.inject({ method: 'POST', url: '/auth/nonce', payload });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'bad request' });
    }
    const r = await s.app.inject({ method: 'POST', url: '/auth/nonce', payload: '{not json', headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'bad request' });
  });
});

describe('API commands: session + origin + TOTP step-up → worker stream', () => {
  it('a command without authentication is refused and nothing reaches the worker', async () => {
    const s = await setup();
    expect((await s.command({ command: 'pause' })).statusCode).toBe(401);
    expect((await s.command({ command: 'pause' }, { cookie: `${SESSION_COOKIE}=forged`, origin: ORIGIN })).statusCode).toBe(401);
    expect((await s.command({ command: 'pause' }, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
    expect(s.bus.sent).toEqual([]);
  });

  it('a cookie-authenticated command from another origin is refused (CSRF)', async () => {
    const s = await setup();
    const session = s.cookieOf(await s.login())!;
    for (const origin of ['https://evil.example', undefined]) {
      const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${session}` };
      if (origin) headers.origin = origin;
      expect((await s.command({ command: 'pause' }, headers)).statusCode).toBe(403);
    }
    expect(s.bus.sent).toEqual([]);
    expect(reasons(s.audit, 'command.rejected')).toEqual(['origin', 'origin']);
  });

  it('pause needs only the session; it is audited and enqueued for the worker', async () => {
    const s = await setup();
    const session = s.cookieOf(await s.login())!;
    const r = await s.command({ command: 'pause' }, s.asOwner(session));
    expect(r.statusCode).toBe(202);
    expect(s.bus.sent).toEqual([{ id: (r.json() as { id: string }).id, botId: BOT, command: 'pause', actor: s.owner.address, requestedAt: Date.UTC(2026, 10, 12, 12, 0, 0) }]);
    expect(s.audit.events.at(-1)).toMatchObject({ action: 'command.requested', target: `${BOT}:pause`, actor: s.owner.address });
  });

  it('risky commands need a fresh TOTP code, which is single-use', async () => {
    const s = await setup();
    const h = s.asOwner(s.cookieOf(await s.login())!);
    expect((await s.command({ command: 'resume' }, h)).statusCode).toBe(403);
    expect((await s.command({ command: 'resume', totp: '000000' === s.code() ? '111111' : '000000' }, h)).statusCode).toBe(403);
    const code = s.code();
    expect((await s.command({ command: 'resume', totp: code }, h)).statusCode).toBe(202);
    expect((await s.command({ command: 'reset_halt', totp: code }, h)).statusCode).toBe(403); // replay
    expect((await s.command({ command: 'reset_halt', totp: s.code(-1) }, h)).statusCode).toBe(403); // older step
    s.advance(30_000);
    expect((await s.command({ command: 'reset_halt', totp: s.code() }, h)).statusCode).toBe(202);
    expect(s.bus.sent.map((c) => c.command)).toEqual(['resume', 'reset_halt']);
    expect(reasons(s.audit, 'command.rejected')).toEqual(['totp_missing', 'totp_invalid', 'totp_invalid', 'totp_invalid']);
  });

  it('two concurrent requests with the same TOTP code: exactly one wins', async () => {
    const s = await setup();
    const h = s.asOwner(s.cookieOf(await s.login())!);
    const code = s.code();
    const [a, b] = await Promise.all([s.command({ command: 'resume', totp: code }, h), s.command({ command: 'reset_kill', totp: code }, h)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 403]);
    expect(s.bus.sent).toHaveLength(1);
  });

  it('service tokens (Discord) are scoped: they can pause, never resume', async () => {
    const s = await setup();
    const bearer = { authorization: `Bearer ${serviceToken}` };
    expect((await s.command({ command: 'pause' }, bearer)).statusCode).toBe(202);
    expect((await s.command({ command: 'resume', totp: s.code() }, bearer)).statusCode).toBe(403);
    expect(s.bus.sent.map((c) => [c.command, c.actor])).toEqual([['pause', 'service:discord']]);
    const me = await s.app.inject({ method: 'GET', url: '/auth/me', headers: bearer });
    expect(me.json()).toEqual({ kind: 'service', actor: 'service:discord', scopes: ['pause', 'read'] });
  });

  it('invalid bot ids and commands are rejected before anything is enqueued', async () => {
    const s = await setup();
    const h = s.asOwner(s.cookieOf(await s.login())!);
    const bad = await s.app.inject({ method: 'POST', url: `/bots/${encodeURIComponent('mexc:io:shadow')}/commands`, payload: { command: 'pause' }, headers: h });
    expect(bad.statusCode).toBe(400);
    expect((await s.command({ command: 'withdraw' }, h)).statusCode).toBe(400);
    expect((await s.command({ command: 'pause', extra: true }, h)).statusCode).toBe(400);
    expect(s.bus.sent).toEqual([]);
  });

  it('a bus failure is reported (503) and audited, never silently dropped', async () => {
    const s = await setup();
    s.bus.send = async () => {
      throw new Error('redis down');
    };
    const r = await s.command({ command: 'pause' }, s.asOwner(s.cookieOf(await s.login())!));
    expect(r.statusCode).toBe(503);
    expect(s.audit.events.at(-1)).toMatchObject({ action: 'command.failed', data: { err: 'redis down' } });
  });

  it('health endpoints', async () => {
    const s = await setup();
    expect((await s.app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true });
    expect((await s.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    s.store.ping = async () => false;
    expect((await s.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
  });
});

describe('API config', () => {
  it('refuses unsafe or malformed configuration at boot', () => {
    const ok = { API_ORIGIN: ORIGIN, API_ALLOWED_WALLETS: testWallet().address, API_TOTP_SECRET: base32Encode(totpKey) };
    expect(() => loadApiConfig(ok)).not.toThrow();
    expect(() => loadApiConfig({ ...ok, API_ORIGIN: `${ORIGIN}/path` })).toThrow(/bare origin/);
    expect(() => loadApiConfig({ ...ok, API_ALLOWED_WALLETS: 'not-a-wallet-address-at-all-xxxxxxxx' })).toThrow(/invalid Solana address/);
    expect(() => loadApiConfig({ ...ok, API_TOTP_SECRET: base32Encode(crypto.randomBytes(8)) })).toThrow(/≥ 16 bytes/);
    expect(() => loadApiConfig({ ...ok, API_SERVICE_TOKENS: 'discord:abc:admin' })).toThrow(/API_SERVICE_TOKENS/);
    expect(loadApiConfig(ok)).toMatchObject({ host: '127.0.0.1', domain: 'cortex-tokyo.example.ts.net', cookieSecure: true });
  });
});
