import type { Alert, Severity } from './rules';

/**
 * Discord webhook delivery.
 * - Batches up to 10 alerts per message (Discord's embed limit), at most one message per
 *   `minIntervalMs`, so a burst of alerts fits well inside the webhook rate limit.
 * - Retries 429 (honouring `retry_after`) and 5xx/network errors with backoff; gives up on 4xx.
 * - Bounded queue: under a storm it keeps the newest alerts plus the most severe, and says how
 *   many it dropped (never unbounded memory, never silently).
 * - The webhook URL is a secret (anyone with it can post): it is never logged.
 */
export const WEBHOOK_RE = /^https:\/\/(?:discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

const COLOR: Record<Severity, number> = { critical: 0xef4444, warn: 0xf59e0b, info: 0xffd60a, resolved: 0x22c55e };
const ICON: Record<Severity, string> = { critical: '🔴', warn: '🟠', info: '🟡', resolved: '🟢' };
const RANK: Record<Severity, number> = { critical: 3, warn: 2, resolved: 1, info: 0 };

export interface DiscordOptions {
  url: string;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  maxQueue?: number;
  maxAttempts?: number;
  log?: (o: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Shown in the footer (e.g. the host), so you know which farm is talking. */
  source?: string;
}

export function toEmbed(a: Alert, source?: string) {
  return {
    title: `${ICON[a.severity]} ${a.title}`.slice(0, 256),
    description: a.text.slice(0, 4_000),
    color: COLOR[a.severity],
    timestamp: new Date(a.ts).toISOString(),
    ...(source ? { footer: { text: source.slice(0, 100) } } : {}),
  };
}

export class DiscordNotifier {
  private queue: Alert[] = [];
  private dropped = 0;
  private sending: Promise<void> | null = null;
  private lastSent = Number.NEGATIVE_INFINITY;
  sent = 0;
  failed = 0;
  private readonly o: Required<Omit<DiscordOptions, 'source'>> & { source?: string };

  constructor(o: DiscordOptions) {
    if (!WEBHOOK_RE.test(o.url)) throw new Error('ALERT_DISCORD_WEBHOOK is not a Discord webhook URL');
    this.o = {
      fetchImpl: (...a) => fetch(...a), minIntervalMs: 2_000, maxQueue: 100, maxAttempts: 5,
      log: (x) => console.log(JSON.stringify(x)), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ...o,
    };
  }

  push(alerts: Alert[]): void {
    if (alerts.length === 0) return;
    this.queue.push(...alerts);
    if (this.queue.length > this.o.maxQueue) {
      // Keep the most severe, then the newest.
      const keep = [...this.queue].map((a, i) => ({ a, i })).sort((x, y) => RANK[y.a.severity] - RANK[x.a.severity] || y.i - x.i).slice(0, this.o.maxQueue);
      this.dropped += this.queue.length - keep.length;
      this.queue = keep.sort((x, y) => x.i - y.i).map((x) => x.a);
    }
    if (!this.sending) this.sending = this.drain().finally(() => (this.sending = null));
  }

  /** Resolves when everything queued so far was sent (or given up on). */
  async flush(): Promise<void> {
    while (this.sending) await this.sending;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const wait = this.lastSent + this.o.minIntervalMs - Date.now();
      if (wait > 0) await this.o.sleep(wait);
      const batch = this.queue.splice(0, 10);
      const embeds = batch.map((a) => toEmbed(a, this.o.source));
      // The drop count travels with this batch; drops that happen while it is in flight are
      // counted for the next one (resetting after the send would lose them).
      const droppedNow = this.dropped;
      this.dropped = 0;
      const content = droppedNow > 0 ? `⚠️ ${droppedNow} alerta(s) descartados numa rajada (fila cheia). Veja os logs.` : undefined;
      const ok = await this.post({ username: 'Cortex Farm', embeds, ...(content ? { content } : {}) });
      this.lastSent = Date.now();
      if (ok) {
        this.sent += batch.length;
      } else {
        this.failed += batch.length;
        this.dropped += droppedNow; // the notice did not go out: report it with the next batch
      }
    }
  }

  private async post(body: unknown): Promise<boolean> {
    for (let attempt = 1; attempt <= this.o.maxAttempts; attempt++) {
      let status = 0;
      let retryAfterMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      try {
        const res = await this.o.fetchImpl(`${this.o.url}?wait=true`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        if (res.ok) return true;
        if (status === 429) {
          const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
          if (typeof j.retry_after === 'number') retryAfterMs = Math.ceil(j.retry_after * 1_000) + 100;
        } else if (status < 500) {
          this.o.log({ msg: 'discord webhook rejected the alert (not retried)', status });
          return false;
        }
      } catch (err) {
        this.o.log({ msg: 'discord webhook unreachable', err: (err as Error).name, attempt });
      }
      if (attempt < this.o.maxAttempts) await this.o.sleep(retryAfterMs);
    }
    this.o.log({ msg: 'discord webhook: alert batch given up after retries' });
    return false;
  }
}
