import os from 'node:os';
import Redis from 'ioredis';
import { Alerter } from './alerts/alerter';
import { DiscordNotifier } from './alerts/discord';
import type { Alert } from './alerts/rules';

/**
 * Alerter process: the farm's voice while you are AFK. Reads every bot's events and views
 * from Redis and posts alerts to a Discord webhook (critical/warn/info/resolved + a daily
 * digest). Without a webhook the alerts only go to the log.
 *
 * It watches the bots; the dead-man (healthchecks.io) watches the machine, including this
 * process, through ALERTER_HEALTHCHECK_URL.
 *
 * Env: REDIS_URL (required), ALERT_DISCORD_WEBHOOK, ALERT_DAILY_UTC_HOUR (default 11 = 08:00
 *      in Brasília), ALERT_SOURCE (footer, default hostname), ALERTER_HEALTHCHECK_URL,
 *      ALERT_CHECK_EVERY_MS (15000).
 */
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
const env = (k: string) => process.env[k]?.trim() || undefined;

async function main() {
  const redisUrl = env('REDIS_URL');
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const webhook = env('ALERT_DISCORD_WEBHOOK');
  const hc = env('ALERTER_HEALTHCHECK_URL');
  const checkEvery = Number(env('ALERT_CHECK_EVERY_MS') ?? 15_000);
  const dailyHour = Number(env('ALERT_DAILY_UTC_HOUR') ?? 11);
  if (!(dailyHour >= 0 && dailyHour <= 23)) throw new Error('ALERT_DAILY_UTC_HOUR must be 0..23');

  const notifier = webhook ? new DiscordNotifier({ url: webhook, source: env('ALERT_SOURCE') ?? os.hostname(), log }) : undefined;
  const deliver = (alerts: Alert[]) => {
    for (const a of alerts) log({ msg: 'alert', severity: a.severity, bot: a.botId, title: a.title, text: a.text });
    notifier?.push(alerts);
  };
  if (!notifier) log({ msg: 'ALERT_DISCORD_WEBHOOK not set: alerts go to this log only' });

  // Dedicated connection: XREADGROUP BLOCK holds it.
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  redis.on('error', () => undefined); // counted below as failed steps
  const alerter = new Alerter({ redis: { call: (c, ...a) => redis.call(c, ...a) }, deliver, dailyUtcHour: dailyHour });

  let stopping = false;
  const stop = async () => {
    stopping = true;
    await notifier?.flush();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());

  deliver([{ severity: 'info', botId: null, ts: Date.now(), title: 'Alerter online', text: 'Monitorando a farm. Você recebe aqui halts, kills, divergências, feeds parados, drawdown e o resumo diário.' }]);

  let lastBots = 0;
  let lastViews = 0;
  let lastPing = 0;
  let failures = 0;
  while (!stopping) {
    const t = Date.now();
    try {
      if (t - lastBots >= 60_000) {
        await alerter.refreshBots();
        lastBots = t;
      }
      await alerter.readEvents();
      if (Date.now() - lastViews >= checkEvery) {
        await alerter.checkViews();
        lastViews = Date.now();
      }
      await alerter.maybeDaily();
      if (failures > 0) log({ msg: 'redis back', after: failures });
      failures = 0;
    } catch (err) {
      failures++;
      if (failures === 1 || failures % 20 === 0) log({ msg: 'alerter step failed', err: (err as Error).message, failures });
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5))));
    }
    if (hc && Date.now() - lastPing >= 60_000) {
      lastPing = Date.now();
      // Healthy = Redis readable. When this stops (process, Redis or VPS down) healthchecks.io alerts.
      void fetch(failures === 0 ? hc : `${hc}/fail`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    }
    if (alerter.botCount === 0) await new Promise((r) => setTimeout(r, 5_000)); // nothing to block on yet
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
