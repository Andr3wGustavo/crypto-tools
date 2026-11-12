import crypto from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { BotIdSchema, EngineCommandSchema, RISKY_COMMANDS, type CommandEnvelope } from '@cortex/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditSink } from './audit';
import { base58Decode, solanaPublicKey } from './auth/encoding';
import { buildSiwsMessage, checkSiws, parseSiwsMessage, type SiwsFields } from './auth/siws';
import { verifyTotp } from './auth/totp';
import type { CommandBus } from './commands';
import type { ApiConfig } from './config';
import type { KvStore } from './store';

/**
 * Operator API. Security model:
 * - Identity = Sign-In With Solana by an allowlisted wallet → opaque session token in an
 *   httpOnly, SameSite=Strict cookie; only its SHA-256 is stored (a store leak yields no sessions).
 * - Cookie-authenticated writes must come from the dashboard origin (CSRF defence in depth).
 * - Commands that can increase risk need a fresh TOTP code (step-up), single-use even under
 *   concurrent requests. Pausing never does: stopping must always be easy.
 * - Service tokens (Discord bot) are hashed in config and scoped (read, pause).
 * - Every auth decision and command is audited before it takes effect; rejections tell the
 *   client nothing beyond "rejected" (the reason goes to the audit log).
 * - The API never touches trading state or exchange keys: commands go to the worker's stream.
 */
export interface AppDeps {
  config: ApiConfig;
  store: KvStore;
  audit: AuditSink;
  bus: CommandBus;
  now?: () => number;
  logger?: boolean;
  /** Auth endpoints per IP per minute (tests lower it). */
  authRatePerMin?: number;
}

export const SESSION_COOKIE = 'cortex_session';
export const SIWS_STATEMENT = 'Sign in to the Cortex Farm operator console.';
const NONCE_TTL_MS = 5 * 60_000;
const TOTP_REPLAY_TTL_MS = 10 * 60_000;

type Principal = { kind: 'wallet'; actor: string; scopes: ReadonlySet<string> } | { kind: 'service'; actor: string; scopes: ReadonlySet<string> };

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const ALL_SCOPES: ReadonlySet<string> = new Set(['read', 'pause', 'command']);

const NonceBody = z.object({ address: z.string().min(32).max(44) }).strict();
const VerifyBody = z.object({ message: z.string().min(1).max(2_000), signature: z.string().min(64).max(128) }).strict();
const CommandBody = z.object({ command: EngineCommandSchema, totp: z.string().regex(/^\d{6}$/).optional() }).strict();

function decodeSignature(s: string): Uint8Array | undefined {
  try {
    const b58 = base58Decode(s);
    if (b58.length === 64) return b58;
  } catch {
    /* not base58 */
  }
  const b64 = Buffer.from(s, 'base64');
  return b64.length === 64 ? b64 : undefined;
}

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const { config: cfg, store, audit, bus } = d;
  const now = d.now ?? Date.now;
  const app = Fastify({ logger: d.logger ?? false, trustProxy: cfg.trustProxy, bodyLimit: 16 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const authLimit = { config: { rateLimit: { max: d.authRatePerMin ?? 10, timeWindow: 60_000 } } };

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    return payload;
  });
  // Never leak internals: validation and unexpected errors get a generic body.
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    void reply.status(status).send({ error: status === 429 ? 'too many requests' : status >= 500 ? 'internal error' : 'bad request' });
  });

  const servicesByHash = cfg.services.map((s) => ({ ...s, hashBuf: Buffer.from(s.hash, 'hex') }));
  async function principal(req: FastifyRequest): Promise<Principal | undefined> {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const h = Buffer.from(sha256(auth.slice(7)), 'hex');
      const s = servicesByHash.find((x) => crypto.timingSafeEqual(x.hashBuf, h));
      return s ? { kind: 'service', actor: `service:${s.name}`, scopes: s.scopes } : undefined;
    }
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return undefined;
    const raw = await store.get(`session:${sha256(token)}`);
    if (!raw) return undefined;
    const s = JSON.parse(raw) as { address: string; exp: number };
    // Removing a wallet from the allowlist revokes its sessions on the next request.
    if (!(s.exp > now()) || !cfg.allowlist.has(s.address)) return undefined;
    return { kind: 'wallet', actor: s.address, scopes: ALL_SCOPES };
  }

  /** Cookie-authenticated writes must come from the dashboard's own origin. */
  const sameOrigin = (req: FastifyRequest) => req.headers.origin === cfg.origin;
  const deny = (reply: FastifyReply, status: number, error: string) => reply.status(status).send({ error });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => ((await store.ping()) ? { ok: true } : reply.status(503).send({ ok: false })));

  app.post('/auth/nonce', authLimit, async (req, reply) => {
    const body = NonceBody.safeParse(req.body);
    if (!body.success) return deny(reply, 400, 'bad request');
    try {
      solanaPublicKey(body.data.address);
    } catch {
      return deny(reply, 400, 'bad request');
    }
    // Issued to any valid address: the response must not reveal who is on the allowlist.
    const nonce = crypto.randomBytes(16).toString('hex');
    const t = now();
    const fields: SiwsFields = {
      domain: cfg.domain, address: body.data.address, statement: SIWS_STATEMENT, uri: cfg.origin, version: '1', chainId: 'mainnet',
      nonce, issuedAt: new Date(t).toISOString(), expirationTime: new Date(t + NONCE_TTL_MS).toISOString(),
    };
    const message = buildSiwsMessage(fields);
    await store.set(`siws:${nonce}`, JSON.stringify({ fields, message }), NONCE_TTL_MS);
    return { message, input: fields };
  });

  app.post('/auth/verify', authLimit, async (req, reply) => {
    const body = VerifyBody.safeParse(req.body);
    const reject = async (reason: string, actor = 'unknown') => {
      await audit.record({ actor, action: 'auth.rejected', data: { reason }, ip: req.ip });
      return deny(reply, 401, 'sign-in rejected');
    };
    if (!body.success) return reject('malformed');
    let nonce: string | undefined;
    let address = 'unknown';
    try {
      const f = parseSiwsMessage(body.data.message);
      nonce = f.nonce;
      address = f.address;
    } catch {
      return reject('malformed');
    }
    // Single use: consumed before any other check, so a failed attempt cannot be retried.
    const pendingRaw = nonce ? await store.getDel(`siws:${nonce}`) : undefined;
    if (!pendingRaw) return reject('nonce', address);
    const pending = JSON.parse(pendingRaw) as { fields: Required<Pick<SiwsFields, 'domain' | 'uri' | 'nonce' | 'issuedAt' | 'expirationTime' | 'address' | 'statement'>>; message: string };
    if (body.data.message !== pending.message) return reject('message', address);
    const sig = decodeSignature(body.data.signature);
    if (!sig) return reject('signature', address);
    const r = checkSiws(body.data.message, sig, pending.fields, cfg.allowlist, now());
    if (!r.ok) return reject(r.reason, address);

    const token = crypto.randomBytes(32).toString('base64url');
    const exp = now() + cfg.sessionTtlMs;
    await store.set(`session:${sha256(token)}`, JSON.stringify({ address: r.address, exp }), cfg.sessionTtlMs);
    await audit.record({ actor: r.address, action: 'auth.login', ip: req.ip });
    void reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, secure: cfg.cookieSecure, sameSite: 'strict', path: '/', maxAge: Math.floor(cfg.sessionTtlMs / 1000),
    });
    return { address: r.address, expiresAt: new Date(exp).toISOString() };
  });

  app.get('/auth/me', async (req, reply) => {
    const p = await principal(req);
    if (!p) return deny(reply, 401, 'unauthenticated');
    return { kind: p.kind, actor: p.actor, scopes: [...p.scopes].sort() };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token && !sameOrigin(req)) return deny(reply, 403, 'forbidden');
    if (token) {
      const p = await principal(req);
      await store.del(`session:${sha256(token)}`);
      if (p) await audit.record({ actor: p.actor, action: 'auth.logout', ip: req.ip });
    }
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post<{ Params: { botId: string } }>('/bots/:botId/commands', { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (req, reply) => {
    const p = await principal(req);
    if (!p) return deny(reply, 401, 'unauthenticated');
    if (p.kind === 'wallet' && !sameOrigin(req)) {
      await audit.record({ actor: p.actor, action: 'command.rejected', data: { reason: 'origin', origin: req.headers.origin ?? null }, ip: req.ip });
      return deny(reply, 403, 'forbidden');
    }
    const botId = BotIdSchema.safeParse(req.params.botId);
    const body = CommandBody.safeParse(req.body);
    if (!botId.success || !body.success) return deny(reply, 400, 'bad request');
    const { command, totp } = body.data;
    const target = `${botId.data}:${command}`;

    if (p.kind === 'service' && !(command === 'pause' && p.scopes.has('pause'))) {
      await audit.record({ actor: p.actor, action: 'command.rejected', target, data: { reason: 'scope' }, ip: req.ip });
      return deny(reply, 403, 'forbidden');
    }
    if (RISKY_COMMANDS.has(command)) {
      const last = Number((await store.get('totp:last')) ?? -1);
      const counter = totp === undefined ? undefined : verifyTotp(cfg.totpKey, totp, now(), last);
      // setNx makes the step single-use even for two concurrent requests with the same code.
      if (counter === undefined || !(await store.setNx(`totp:used:${counter}`, '1', TOTP_REPLAY_TTL_MS))) {
        await audit.record({ actor: p.actor, action: 'command.rejected', target, data: { reason: totp === undefined ? 'totp_missing' : 'totp_invalid' }, ip: req.ip });
        return deny(reply, 403, 'totp required');
      }
      await store.set('totp:last', String(Math.max(counter, last)), 24 * 3_600_000);
    }

    const envelope: CommandEnvelope = { id: crypto.randomUUID(), botId: botId.data, command, actor: p.actor, requestedAt: now() };
    await audit.record({ actor: p.actor, action: 'command.requested', target, data: { id: envelope.id, stepUp: RISKY_COMMANDS.has(command) }, ip: req.ip });
    try {
      const streamId = await bus.send(envelope);
      return reply.status(202).send({ id: envelope.id, streamId });
    } catch (err) {
      await audit.record({ actor: p.actor, action: 'command.failed', target, data: { id: envelope.id, err: (err as Error).message }, ip: req.ip });
      return deny(reply, 503, 'command bus unavailable');
    }
  });

  return app;
}
