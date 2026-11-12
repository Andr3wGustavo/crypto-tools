import crypto from 'node:crypto';
import { commandStreamKey } from '@cortex/shared';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, SESSION_COOKIE } from '../../../api/src/app';
import { MemoryAudit } from '../../../api/src/audit';
import { base32Encode } from '../../../api/src/auth/encoding';
import { hotp, totpCounter } from '../../../api/src/auth/totp';
import { RedisStreamBus } from '../../../api/src/commands';
import { loadApiConfig } from '../../../api/src/config';
import { RedisStore } from '../../../api/src/store';
import { testWallet } from '../../../api/src/testing/wallet';
import { COMMAND_GROUP, CommandSource } from './command-source';
import { IoRedisStreamClient } from './redis-stream-client';

/**
 * End to end against a REAL Redis (CI service; locally: REDIS_TEST_URL=redis://127.0.0.1:6379):
 * wallet sign-in → API → Redis stream → worker command source → engine input, with the real
 * ioredis adapters (GETDEL nonces, XADD, XREADGROUP/XACK parsing).
 */
const url = process.env.REDIS_TEST_URL;

describe.skipIf(!url)('operator command, end to end over real Redis', () => {
  const conns: Redis[] = [];
  const conn = () => {
    const r = new Redis(url!, { maxRetriesPerRequest: 1 });
    conns.push(r);
    return r;
  };
  afterAll(() => conns.forEach((c) => c.disconnect()));

  it('sign-in → pause + TOTP resume → applied by the worker in order, acked, outcomes published', async () => {
    const BOT = `mexc:E2E${crypto.randomBytes(3).toString('hex').toUpperCase()}:shadow`;
    const ORIGIN = 'https://cortex-e2e.example.ts.net';
    const owner = testWallet();
    const totpKey = crypto.randomBytes(20);
    const redis = conn();
    const app = await buildApp({
      config: loadApiConfig({ API_ORIGIN: ORIGIN, API_ALLOWED_WALLETS: owner.address, API_TOTP_SECRET: base32Encode(totpKey) }),
      store: new RedisStore(redis), audit: new MemoryAudit(), bus: new RedisStreamBus(redis),
    });

    const client = new IoRedisStreamClient(conn());
    await client.ensureGroup(commandStreamKey(BOT), COMMAND_GROUP); // the worker is up before commands arrive
    const applied: string[] = [];
    const src = new CommandSource({ botId: BOT, client, apply: (c) => applied.push(c.command), blockMs: 200 });
    src.start();

    const { message } = (await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: owner.address } })).json() as { message: string };
    const signature = Buffer.from(owner.sign(message)).toString('base64');
    const login = await app.inject({ method: 'POST', url: '/auth/verify', payload: { message, signature } });
    expect(login.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/verify', payload: { message, signature } })).statusCode).toBe(401); // GETDEL: single use
    const session = login.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const headers = { cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN };
    const send = (payload: object) => app.inject({ method: 'POST', url: `/bots/${encodeURIComponent(BOT)}/commands`, payload, headers });

    expect((await send({ command: 'pause' })).statusCode).toBe(202);
    expect((await send({ command: 'resume', totp: hotp(totpKey, totpCounter(Date.now())) })).statusCode).toBe(202);

    const t0 = Date.now();
    while (applied.length < 2 && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    await src.stop();
    expect(applied).toEqual(['pause', 'resume']);

    const pending = (await redis.call('XPENDING', commandStreamKey(BOT), COMMAND_GROUP)) as [number, ...unknown[]];
    expect(Number(pending[0])).toBe(0);
    const events = (await redis.call('XRANGE', `bot:${BOT}:events`, '-', '+')) as Array<[string, string[]]>;
    expect(events.map(([, kv]) => JSON.parse(kv[1]!) as { command: string; applied: boolean }).map((e) => [e.command, e.applied])).toEqual([['pause', true], ['resume', true]]);

    await redis.del(commandStreamKey(BOT), `bot:${BOT}:events`);
    await app.close();
  });
});
