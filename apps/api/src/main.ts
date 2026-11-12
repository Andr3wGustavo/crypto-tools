import 'dotenv/config';
import { prisma } from '@cortex/db';
import Redis from 'ioredis';
import { buildApp } from './app';
import { PrismaAudit } from './audit';
import { RedisStreamBus } from './commands';
import { loadApiConfig } from './config';
import { RedisBotData } from './data';
import { RedisStore } from './store';

/**
 * Operator API server. Binds to loopback by default: the dashboard reaches it through the
 * Tailscale proxy (HTTPS on the tailnet), never from the public internet.
 */
async function main(): Promise<void> {
  const cfg = loadApiConfig();
  const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 2 });
  // Pub/sub needs its own connection (a subscribed connection can run no other command).
  const data = new RedisBotData(redis, () => new Redis(cfg.redisUrl, { maxRetriesPerRequest: null }));
  const app = await buildApp({
    config: cfg, store: new RedisStore(redis), audit: new PrismaAudit(prisma), bus: new RedisStreamBus(redis), data, webDir: cfg.webDir, logger: true, defaultMetrics: true,
  });
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const hard = setTimeout(() => process.exit(1), 10_000);
    hard.unref();
    await app.close();
    redis.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info({ origin: cfg.origin, wallets: cfg.allowlist.size, services: cfg.services.map((s) => s.name), dashboard: Boolean(cfg.webDir) }, 'api ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
