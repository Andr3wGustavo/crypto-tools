import { BOTS_SET_KEY, BotEventSchema, BotViewSchema, SeriesPointSchema, botKeys, type BotView } from '@cortex/shared';
import { AlertRules, dailySummary, type Alert, type DailyRow } from './rules';

/** The Redis surface the alerter needs (`ioredis.call` in production). */
export interface RedisCall {
  call(cmd: string, ...args: string[]): Promise<unknown>;
}

export const ALERT_GROUP = 'alerter';
const CONSUMER = 'alerter-1';
type XStreams = Array<[string, Array<[string, string[] | null]>]> | null;
type XEntries = Array<[string, string[]]>;
const field = (kv: string[] | null, name: string) => {
  for (let i = 0; kv && i + 1 < kv.length; i += 2) if (kv[i] === name) return kv[i + 1];
  return undefined;
};
const parseView = (raw: unknown): BotView | undefined => {
  try {
    const r = BotViewSchema.safeParse(JSON.parse(String(raw)));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
};

export interface AlerterOptions {
  redis: RedisCall;
  deliver: (alerts: Alert[]) => void;
  rules?: AlertRules;
  now?: () => number;
  blockMs?: number;
  dailyUtcHour?: number;
}

/**
 * Reads every bot's event stream through a consumer group (so a restart resumes where it left
 * off: at-least-once; a duplicated alert is harmless, a lost one is not) and checks the
 * latest views. Pure plumbing around AlertRules: one `step()` = one read + one check.
 */
export class Alerter {
  private readonly rules: AlertRules;
  private readonly now: () => number;
  private groups = new Set<string>();
  private bots: string[] = [];
  private lastDaily = '';
  private pendingDone = false;

  constructor(private readonly o: AlerterOptions) {
    this.rules = o.rules ?? new AlertRules();
    this.now = o.now ?? Date.now;
  }

  get botCount(): number {
    return this.bots.length;
  }

  async refreshBots(): Promise<string[]> {
    this.bots = ((await this.o.redis.call('SMEMBERS', BOTS_SET_KEY)) as string[]).sort();
    for (const b of this.bots) {
      const k = botKeys(b).events;
      if (this.groups.has(k)) continue;
      try {
        // '$': a new alerter does not replay a bot's whole history as alerts.
        await this.o.redis.call('XGROUP', 'CREATE', k, ALERT_GROUP, '$', 'MKSTREAM');
      } catch (err) {
        if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
      }
      this.groups.add(k);
    }
    return this.bots;
  }

  /** Reads and processes one batch of events (pending ones first, after a restart). */
  async readEvents(): Promise<number> {
    if (this.bots.length === 0) return 0;
    const keys = this.bots.map((b) => botKeys(b).events);
    const id = this.pendingDone ? '>' : '0';
    const block = id === '>' && (this.o.blockMs ?? 5_000) > 0 ? ['BLOCK', String(this.o.blockMs ?? 5_000)] : [];
    const res = (await this.o.redis.call('XREADGROUP', 'GROUP', ALERT_GROUP, CONSUMER, 'COUNT', '200', ...block, 'STREAMS', ...keys, ...keys.map(() => id))) as XStreams;
    let n = 0;
    const alerts: Alert[] = [];
    for (const [key, entries] of res ?? []) {
      const botId = this.bots.find((b) => botKeys(b).events === key);
      for (const [entryId, kv] of entries) {
        n++;
        const raw = field(kv, 'e');
        if (botId && raw) {
          try {
            const e = BotEventSchema.safeParse(JSON.parse(raw));
            if (e.success) alerts.push(...this.rules.onEvent(botId, e.data, this.now()));
          } catch {
            /* malformed: acked and skipped */
          }
        }
        await this.o.redis.call('XACK', key, ALERT_GROUP, entryId);
      }
    }
    if (id === '0' && n === 0) this.pendingDone = true;
    this.o.deliver(alerts);
    return n;
  }

  async checkViews(): Promise<void> {
    if (this.bots.length === 0) return;
    const raws = (await this.o.redis.call('MGET', ...this.bots.map((b) => botKeys(b).view))) as Array<string | null>;
    this.o.deliver(this.rules.onViews(this.bots.map((botId, i) => ({ botId, view: parseView(raws[i]) })), this.now()));
  }

  /** Sends the digest once a day at `dailyUtcHour` (returns true when it did). */
  async maybeDaily(): Promise<boolean> {
    const now = new Date(this.now());
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== (this.o.dailyUtcHour ?? 11) || this.lastDaily === day || this.bots.length === 0) return false;
    this.lastDaily = day;
    this.o.deliver([dailySummary(await this.dailyRows(), this.now())]);
    return true;
  }

  async dailyRows(): Promise<DailyRow[]> {
    const since = String(this.now() - 86_400_000);
    const raws = (await this.o.redis.call('MGET', ...this.bots.map((b) => botKeys(b).view))) as Array<string | null>;
    const rows: DailyRow[] = [];
    for (const [i, botId] of this.bots.entries()) {
      const v = parseView(raws[i]);
      const first = (await this.o.redis.call('XRANGE', botKeys(botId).series, since, '+', 'COUNT', '1')) as XEntries;
      let equity24hAgo: number | null = null;
      try {
        const p = SeriesPointSchema.safeParse(JSON.parse(field(first[0]?.[1] ?? null, 'p') ?? ''));
        // Only a point from (about) 24 h ago is a 24 h baseline; a younger bot has none.
        if (p.success && p.data.ts <= this.now() - 23 * 3_600_000) equity24hAgo = p.data.equity;
      } catch {
        /* no history */
      }
      const fills = (await this.o.redis.call('XRANGE', botKeys(botId).fills, since, '+', 'COUNT', '10000')) as XEntries;
      rows.push({
        botId, status: v?.status ?? 'sem dados', equity: v?.pnl.equity ?? null, equity24hAgo,
        fills24h: fills.length, edgeN: v?.edge.n ?? 0, edgeMeanBps: v?.edge.meanBps ?? 0,
      });
    }
    return rows;
  }
}
