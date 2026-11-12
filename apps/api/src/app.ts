import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import {
  BotEventSchema, BotIdSchema, EngineCommandSchema, RISKY_COMMANDS, WS_CLOSE_UNAUTHORIZED,
  type BotEventKind, type CommandEnvelope, type SystemInfo,
} from '@cortex/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditSink } from './audit';
import { base58Decode, solanaPublicKey } from './auth/encoding';
import { buildSiwsMessage, checkSiws, parseSiwsMessage, type SiwsFields } from './auth/siws';
import { verifyTotp } from './auth/totp';
import type { CommandBus } from './commands';
import type { ApiConfig } from './config';
import { STREAM_ID_RE, type BotData } from './data';
import { LiveHub, type HubOptions } from './hub';
import { createMetrics, type Metrics } from './metrics';
import type { KvStore } from './store';

/**
 * Operator API. Security model:
 * - Identity = Sign-In With Solana by an allowlisted wallet → opaque session token in an
 *   httpOnly, SameSite=Strict cookie; only its SHA-256 is stored (a store leak yields no sessions).
 * - Cookie-authenticated writes and WebSocket upgrades must come from the dashboard origin
 *   (CSRF and cross-site WebSocket hijacking defence).
 * - Commands that can increase risk need a fresh TOTP code (step-up), single-use even under
 *   concurrent requests. Pausing never does: stopping must always be easy.
 * - Service tokens (Discord bot, Prometheus) are hashed in config and scoped (read, pause).
 * - Every auth decision and command is audited before it takes effect; rejections tell the
 *   client nothing beyond "rejected" (the reason goes to the audit log).
 * - The API never touches trading state or exchange keys: commands go to the worker's stream,
 *   and the dashboard data is read from what the worker publishes.
 * - The dashboard is served from this same origin: no CORS at all, and a strict CSP.
 */
export interface AppDeps {
  config: ApiConfig;
  store: KvStore;
  audit: AuditSink;
  bus: CommandBus;
  /** Dashboard read side. Without it the read routes answer 503. */
  data?: BotData;
  hub?: HubOptions;
  /** Built dashboard (apps/web/dist). Served with an SPA fallback when set. */
  webDir?: string;
  version?: string;
  now?: () => number;
  logger?: boolean;
  /** Auth endpoints per IP per minute (tests lower it). */
  authRatePerMin?: number;
  /** Process metrics (tests turn them off). */
  defaultMetrics?: boolean;
}

export const SESSION_COOKIE = 'cortex_session';
export const SIWS_STATEMENT = 'Sign in to the Cortex Farm operator console.';
const NONCE_TTL_MS = 5 * 60_000;
const TOTP_REPLAY_TTL_MS = 10 * 60_000;

type Principal = { kind: 'wallet'; actor: string; scopes: ReadonlySet<string> } | { kind: 'service'; actor: string; scopes: ReadonlySet<string> };

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const ALL_SCOPES: ReadonlySet<string> = new Set(['read', 'pause', 'command']);
const EVENT_KINDS = new Set<string>(BotEventSchema.options.map((o) => o.shape.k.value));

const NonceBody = z.object({ address: z.string().min(32).max(44) }).strict();
const VerifyBody = z.object({ message: z.string().min(1).max(2_000), signature: z.string().min(64).max(128) }).strict();
const CommandBody = z.object({ command: EngineCommandSchema, totp: z.string().regex(/^\d{6}$/).optional() }).strict();
const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.string().regex(STREAM_ID_RE).optional(),
  kinds: z.string().max(200).optional()
    .transform((s, ctx) => {
      if (!s) return undefined;
      const ks = s.split(',');
      if (!ks.every((k) => EVENT_KINDS.has(k))) ctx.addIssue({ code: 'custom', message: 'unknown kind' });
      return new Set(ks as BotEventKind[]);
    }),
}).strict();
const SeriesQuery = z.object({ since: z.coerce.number().int().min(0).optional() }).strict();
const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().positive().optional() }).strict();

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

/** Strict CSP for the dashboard: same-origin everything, no inline scripts, no framing. */
export function contentSecurityPolicy(origin: string): string {
  const ws = origin.replace(/^http/, 'ws');
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
    `connect-src 'self' ${ws}`, "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
  ].join('; ');
}

export async function buildApp(d: AppDeps): Promise<FastifyInstance & { hub?: LiveHub; metrics: Metrics }> {
  const { config: cfg, store, audit, bus, data } = d;
  const now = d.now ?? Date.now;
  const startedAt = now();
  const version = d.version ?? process.env.APP_VERSION ?? 'dev';
  const metrics = createMetrics(d.defaultMetrics ?? false);
  const hub = data ? new LiveHub(data, { now, ...d.hub }) : undefined;
  const app = Fastify({ logger: d.logger ?? false, trustProxy: cfg.trustProxy, bodyLimit: 16 * 1024 }) as unknown as FastifyInstance & { hub?: LiveHub; metrics: Metrics };
  app.decorate('hub', hub);
  app.decorate('metrics', metrics);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 1_024 } }); // the client never sends data
  const authLimit = { config: { rateLimit: { max: d.authRatePerMin ?? 10, timeWindow: 60_000 } } };
  const csp = contentSecurityPolicy(cfg.origin);

  app.addHook('onSend', async (req, reply, payload) => {
    // Hashed build assets never change; everything else (API, index.html) is never cached.
    reply.header('cache-control', req.url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', csp);
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (cfg.cookieSecure) reply.header('strict-transport-security', 'max-age=31536000');
    return payload;
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    metrics.http.observe({ method: req.method, route, status: `${Math.floor(reply.statusCode / 100)}xx` }, reply.elapsedTime / 1_000);
  });
  // Never leak internals: validation and unexpected errors get a generic body.
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    void reply.status(status).send({ error: status === 429 ? 'too many requests' : status >= 500 ? 'internal error' : 'bad request' });
  });
  if (hub) {
    app.addHook('onReady', async () => hub.start());
    app.addHook('preClose', async () => hub.stop());
  }

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
  /** Read routes: a session or a service token with the `read` scope. */
  async function reader(req: FastifyRequest, reply: FastifyReply): Promise<Principal | undefined> {
    const p = await principal(req);
    if (!p) {
      void deny(reply, 401, 'unauthenticated');
      return undefined;
    }
    if (!p.scopes.has('read')) {
      void deny(reply, 403, 'forbidden');
      return undefined;
    }
    if (!data) {
      void deny(reply, 503, 'dashboard data unavailable');
      return undefined;
    }
    return p;
  }

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
      metrics.authRejected.inc({ reason });
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
      metrics.commands.inc({ command, result: 'scope' });
      await audit.record({ actor: p.actor, action: 'command.rejected', target, data: { reason: 'scope' }, ip: req.ip });
      return deny(reply, 403, 'forbidden');
    }
    if (RISKY_COMMANDS.has(command)) {
      const last = Number((await store.get('totp:last')) ?? -1);
      const counter = totp === undefined ? undefined : verifyTotp(cfg.totpKey, totp, now(), last);
      // setNx makes the step single-use even for two concurrent requests with the same code.
      if (counter === undefined || !(await store.setNx(`totp:used:${counter}`, '1', TOTP_REPLAY_TTL_MS))) {
        metrics.commands.inc({ command, result: 'totp' });
        await audit.record({ actor: p.actor, action: 'command.rejected', target, data: { reason: totp === undefined ? 'totp_missing' : 'totp_invalid' }, ip: req.ip });
        return deny(reply, 403, 'totp required');
      }
      await store.set('totp:last', String(Math.max(counter, last)), 24 * 3_600_000);
    }

    const envelope: CommandEnvelope = { id: crypto.randomUUID(), botId: botId.data, command, actor: p.actor, requestedAt: now() };
    await audit.record({ actor: p.actor, action: 'command.requested', target, data: { id: envelope.id, stepUp: RISKY_COMMANDS.has(command) }, ip: req.ip });
    try {
      const streamId = await bus.send(envelope);
      metrics.commands.inc({ command, result: 'accepted' });
      return reply.status(202).send({ id: envelope.id, streamId });
    } catch (err) {
      metrics.commands.inc({ command, result: 'bus_error' });
      await audit.record({ actor: p.actor, action: 'command.failed', target, data: { id: envelope.id, err: (err as Error).message }, ip: req.ip });
      return deny(reply, 503, 'command bus unavailable');
    }
  });

  // ---------------------------------------------------------------- dashboard read side

  app.get('/bots', async (req, reply) => {
    if (!(await reader(req, reply))) return reply;
    const ids = await data!.listBots();
    const views = await data!.views(ids);
    return { bots: views.filter((v) => v !== undefined), missing: ids.filter((_, i) => !views[i]) };
  });

  app.get<{ Params: { botId: string } }>('/bots/:botId', async (req, reply) => {
    if (!(await reader(req, reply))) return reply;
    const id = BotIdSchema.safeParse(req.params.botId);
    if (!id.success) return deny(reply, 400, 'bad request');
    const [v] = await data!.views([id.data]);
    return v ?? deny(reply, 404, 'not found');
  });

  const eventRoute = (stream: 'events' | 'fills') => async (req: FastifyRequest<{ Params: { botId: string } }>, reply: FastifyReply) => {
    if (!(await reader(req, reply))) return reply;
    const id = BotIdSchema.safeParse(req.params.botId);
    const q = PageQuery.safeParse(req.query);
    if (!id.success || !q.success) return deny(reply, 400, 'bad request');
    const events = await data!.events(id.data, { limit: q.data.limit, before: q.data.before, kinds: q.data.kinds, stream });
    // A full page may have more behind it; a short page is the end.
    return { events, next: events.length === q.data.limit ? events[events.length - 1]!.id : null };
  };
  app.get('/bots/:botId/events', eventRoute('events'));
  app.get('/bots/:botId/fills', eventRoute('fills'));

  app.get<{ Params: { botId: string } }>('/bots/:botId/series', async (req, reply) => {
    if (!(await reader(req, reply))) return reply;
    const id = BotIdSchema.safeParse(req.params.botId);
    const q = SeriesQuery.safeParse(req.query);
    if (!id.success || !q.success) return deny(reply, 400, 'bad request');
    return { points: await data!.series(id.data, q.data.since ?? now() - 6 * 3_600_000) };
  });

  app.get('/audit', async (req, reply) => {
    if (!(await reader(req, reply))) return reply;
    const q = AuditQuery.safeParse(req.query);
    if (!q.success) return deny(reply, 400, 'bad request');
    const entries = await audit.list(q.data.limit, q.data.before);
    return { entries, next: entries.length === q.data.limit ? entries[entries.length - 1]!.ts : null };
  });

  app.get('/system', async (req, reply) => {
    if (!(await reader(req, reply))) return reply;
    const t = now();
    const views = (await data!.views(await data!.listBots())).filter((v) => v !== undefined);
    const info: SystemInfo = {
      serverTime: t,
      api: { version, uptimeS: Math.round((t - startedAt) / 1000), wsClients: hub?.size ?? 0, redis: await store.ping(), rssMb: Math.round(process.memoryUsage().rss / 1_048_576) },
      bots: views.map((v) => ({ botId: v.botId, ageMs: Math.max(0, t - v.ts), status: v.status, version: v.version, run: v.run })),
    };
    return info;
  });

  app.get('/metrics', async (req, reply) => {
    const p = await principal(req);
    if (!p || !p.scopes.has('read')) return deny(reply, p ? 403 : 401, p ? 'forbidden' : 'unauthenticated');
    metrics.wsClients.set(hub?.size ?? 0);
    if (data) {
      const t = now();
      metrics.botViewAge.reset();
      for (const v of (await data.views(await data.listBots())).filter((x) => x !== undefined)) metrics.botViewAge.set({ bot: v.botId }, Math.max(0, (t - v.ts) / 1000));
    }
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  // Live feed. Authorised BEFORE the upgrade: no socket is ever opened for a refused client.
  const wsPrincipal = new WeakMap<FastifyRequest, Principal>();
  app.get('/ws', {
    websocket: true,
    preValidation: async (req, reply) => {
      const p = await principal(req);
      const reason = !p ? 'unauthenticated' : !p.scopes.has('read') ? 'scope' : p.kind === 'wallet' && !sameOrigin(req) ? 'origin' : !hub ? 'unavailable' : undefined;
      if (reason) {
        metrics.wsRejected.inc({ reason });
        if (reason === 'origin') await audit.record({ actor: p!.actor, action: 'ws.rejected', data: { reason, origin: req.headers.origin ?? null }, ip: req.ip });
        return deny(reply, reason === 'unauthenticated' ? 401 : reason === 'unavailable' ? 503 : 403, reason === 'unavailable' ? 'dashboard data unavailable' : 'forbidden');
      }
      wsPrincipal.set(req, p!);
    },
  }, (socket, req) => {
    const p = wsPrincipal.get(req);
    if (!p || !hub) {
      socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    const client = {
      socket,
      actor: p.actor,
      // Same check as every request: expiry, logout and allowlist removal all close the feed.
      stillAuthorized: async () => (await principal(req))?.actor === p.actor,
    };
    hub.add(client);
    socket.on('close', () => hub.remove(client));
    socket.on('message', () => socket.close(1003, 'read-only feed'));
  });

  // ---------------------------------------------------------------- dashboard (same origin)
  if (d.webDir) {
    const index = path.join(d.webDir, 'index.html');
    if (!fs.existsSync(index)) throw new Error(`API_WEB_DIR has no index.html: ${d.webDir}`);
    await app.register(fastifyStatic, { root: d.webDir, prefix: '/', wildcard: true, index: false });
    app.get('/', (_req, reply) => reply.sendFile('index.html'));
    // Client-side routes (/bot/..., /risk, ...) get the app shell; API misses stay JSON 404s.
    app.setNotFoundHandler((req, reply) => {
      const wantsHtml = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
      return wantsHtml ? reply.sendFile('index.html') : deny(reply, 404, 'not found');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => deny(reply, 404, 'not found'));
  }

  return app;
}
