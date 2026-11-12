import {
  BOTS_SET_KEY, BotEventSchema, BotViewSchema, LIVE_PATTERN, SERIES_MAX_POINTS, SeriesPointSchema, botKeys,
  type BotEventKind, type BotView, type LiveMessage, type SeriesPoint, type StoredEvent,
} from '@cortex/shared';
import type Redis from 'ioredis';

/**
 * Read side of the dashboard. The worker is the only writer (apps/worker/src/sinks/redis-sink.ts);
 * the API only reads and relays. Anything that fails its schema is dropped, never served: one
 * bad record must not break a page.
 */
export interface EventQuery {
  /** Exclusive stream-id cursor (newest-first pagination); omitted = from the newest. */
  before?: string;
  limit: number;
  kinds?: ReadonlySet<BotEventKind>;
  stream?: 'events' | 'fills';
}

export interface BotData {
  listBots(): Promise<string[]>;
  views(botIds: string[]): Promise<Array<BotView | undefined>>;
  /** Newest first. */
  events(botId: string, q: EventQuery): Promise<StoredEvent[]>;
  /** Oldest first, from `sinceMs`. */
  series(botId: string, sinceMs: number): Promise<SeriesPoint[]>;
  /** Live messages of every bot; returns the unsubscribe function. */
  subscribe(fn: (m: LiveMessage) => void): Promise<() => Promise<void>>;
}

export const STREAM_ID_RE = /^\d{1,15}-\d{1,10}$/;
/** Upper bound of entries read to fill one filtered page (a rare kind cannot cost a full scan). */
const MAX_SCAN = 5_000;

export function parseView(raw: string | null | undefined): BotView | undefined {
  if (!raw) return undefined;
  try {
    const r = BotViewSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

export function parseStored(botId: string, id: string, raw: string | undefined): StoredEvent | undefined {
  if (!raw) return undefined;
  try {
    const r = BotEventSchema.safeParse(JSON.parse(raw));
    return r.success ? { id, botId, e: r.data } : undefined;
  } catch {
    return undefined;
  }
}

/** Compares Redis stream ids numerically (`ms-seq`). */
export function compareStreamIds(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number) as [number, number];
  const [bm, bs] = b.split('-').map(Number) as [number, number];
  return am !== bm ? am - bm : as - bs;
}

type XEntry = [string, string[]];
const field = (kv: string[], name: string) => {
  for (let i = 0; i + 1 < kv.length; i += 2) if (kv[i] === name) return kv[i + 1];
  return undefined;
};

export class RedisBotData implements BotData {
  /** `r` serves commands; `subscriber` is a dedicated connection (subscriber mode blocks others). */
  constructor(private readonly r: Redis, private readonly subscriber: () => Redis) {}

  async listBots(): Promise<string[]> {
    return (await this.r.smembers(BOTS_SET_KEY)).sort();
  }

  async views(botIds: string[]): Promise<Array<BotView | undefined>> {
    if (botIds.length === 0) return [];
    const raws = await this.r.mget(...botIds.map((b) => botKeys(b).view));
    return raws.map((raw) => parseView(raw));
  }

  async events(botId: string, q: EventQuery): Promise<StoredEvent[]> {
    const key = q.stream === 'fills' ? botKeys(botId).fills : botKeys(botId).events;
    const out: StoredEvent[] = [];
    let end = q.before ? `(${q.before}` : '+';
    let scanned = 0;
    while (out.length < q.limit && scanned < MAX_SCAN) {
      const batch = q.kinds ? Math.min(500, MAX_SCAN - scanned) : q.limit - out.length;
      const rows = (await this.r.call('XREVRANGE', key, end, '-', 'COUNT', String(batch))) as XEntry[];
      if (rows.length === 0) break;
      scanned += rows.length;
      for (const [id, kv] of rows) {
        const s = parseStored(botId, id, field(kv, 'e'));
        if (s && (!q.kinds || q.kinds.has(s.e.k)) && out.length < q.limit) out.push(s);
      }
      end = `(${rows[rows.length - 1]![0]}`;
      if (rows.length < batch) break;
    }
    return out;
  }

  async series(botId: string, sinceMs: number): Promise<SeriesPoint[]> {
    const rows = (await this.r.call('XRANGE', botKeys(botId).series, String(Math.max(0, Math.floor(sinceMs))), '+', 'COUNT', String(SERIES_MAX_POINTS))) as XEntry[];
    const out: SeriesPoint[] = [];
    for (const [, kv] of rows) {
      try {
        const r = SeriesPointSchema.safeParse(JSON.parse(field(kv, 'p') ?? ''));
        if (r.success) out.push(r.data);
      } catch {
        /* dropped */
      }
    }
    return out;
  }

  async subscribe(fn: (m: LiveMessage) => void): Promise<() => Promise<void>> {
    const sub = this.subscriber();
    sub.on('pmessage', (_p: string, _ch: string, msg: string) => {
      try {
        fn(JSON.parse(msg) as LiveMessage);
      } catch {
        /* a malformed message is dropped */
      }
    });
    await sub.psubscribe(LIVE_PATTERN);
    return async () => {
      await sub.punsubscribe(LIVE_PATTERN).catch(() => undefined);
      sub.disconnect();
    };
  }
}

/** In-memory implementation: tests and the local dev server (replayed recording). */
export class MemoryBotData implements BotData {
  private readonly viewsById = new Map<string, BotView>();
  private readonly ev = new Map<string, StoredEvent[]>();
  private readonly fl = new Map<string, StoredEvent[]>();
  private readonly pts = new Map<string, SeriesPoint[]>();
  private readonly subs = new Set<(m: LiveMessage) => void>();
  private lastMs = 0;
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private nextId(): string {
    const ms = Math.max(this.now(), this.lastMs);
    this.seq = ms === this.lastMs ? this.seq + 1 : 0;
    this.lastMs = ms;
    return `${ms}-${this.seq}`;
  }

  private emit(m: LiveMessage) {
    for (const s of this.subs) s(m);
  }

  /** What the worker's RedisSink does, in memory. */
  publishView(v: BotView): void {
    this.viewsById.set(v.botId, v);
    this.emit({ t: 'view', view: v });
  }

  publishPoint(botId: string, p: SeriesPoint): void {
    const a = this.pts.get(botId) ?? [];
    a.push(p);
    if (a.length > SERIES_MAX_POINTS) a.splice(0, a.length - SERIES_MAX_POINTS);
    this.pts.set(botId, a);
    this.emit({ t: 'point', botId, p });
  }

  publishEvent(botId: string, e: StoredEvent['e']): string {
    const id = this.nextId();
    const s: StoredEvent = { id, botId, e };
    for (const [m, keep] of [[this.ev, 10_000], ...(e.k === 'fill' ? [[this.fl, 50_000] as const] : [])] as const) {
      const a = m.get(botId) ?? [];
      a.push(s);
      if (a.length > keep) a.splice(0, a.length - keep);
      m.set(botId, a);
    }
    this.emit({ t: 'event', botId, id, e });
    return id;
  }

  async listBots() {
    return [...this.viewsById.keys()].sort();
  }

  async views(botIds: string[]) {
    return botIds.map((b) => this.viewsById.get(b));
  }

  async events(botId: string, q: EventQuery) {
    const all = (q.stream === 'fills' ? this.fl : this.ev).get(botId) ?? [];
    const out: StoredEvent[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < q.limit; i--) {
      const s = all[i]!;
      if (q.before && compareStreamIds(s.id, q.before) >= 0) continue;
      if (!q.kinds || q.kinds.has(s.e.k)) out.push(s);
    }
    return out;
  }

  async series(botId: string, sinceMs: number) {
    return (this.pts.get(botId) ?? []).filter((p) => p.ts >= sinceMs);
  }

  async subscribe(fn: (m: LiveMessage) => void) {
    this.subs.add(fn);
    return async () => {
      this.subs.delete(fn);
    };
  }
}
