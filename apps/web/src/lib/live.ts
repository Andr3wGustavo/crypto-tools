import type { BotView, SeriesPoint, StoredEvent, WsServerMessage } from '@cortex/shared';

/**
 * Live state of the dashboard: one WebSocket to /ws (snapshot + deltas).
 * - Every (re)connect starts from the server's `hello` snapshot, so a missed delta can never
 *   leave the screen wrong for longer than a reconnect.
 * - Reconnects with capped exponential backoff and jitter; a 4401 close means the session is
 *   gone and stops reconnecting (the app shows the sign-in screen).
 * - Series points and events are merged with what the pages fetched over REST, deduplicated by
 *   timestamp (points) and stream id (events), and bounded in memory.
 * Values (not types) from @cortex/shared are mirrored here to keep zod out of the bundle; a
 * unit test pins them to the shared ones.
 */
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const MAX_POINTS_PER_BOT = 17_280;
export const MAX_EVENTS = 3_000;
export const MAX_FILLS = 5_000;
export const MAX_NOISY = 2_000;
/** High-rate kinds (several per second per bot): kept apart so they never evict the rare ones. */
export const NOISY_KINDS: ReadonlySet<string> = new Set(['order', 'markout']);

export type ConnState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'unauthorized';

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number): void;
}

export interface LiveOptions {
  url: () => string;
  socket?: (url: string) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
  random?: () => number;
}

export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(15_000, 500 * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.5 + random() * 0.5));
}

/** Inserts points keeping ts order and uniqueness; returns a new array (bounded). */
export function mergePoints(cur: readonly SeriesPoint[], add: readonly SeriesPoint[], max = MAX_POINTS_PER_BOT): SeriesPoint[] {
  if (add.length === 0) return cur as SeriesPoint[];
  const byTs = new Map<number, SeriesPoint>();
  for (const p of cur) byTs.set(p.ts, p);
  for (const p of add) byTs.set(p.ts, p);
  const out = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  return out.length > max ? out.slice(out.length - max) : out;
}

const idKey = (id: string): [number, number] => {
  const [a, b] = id.split('-');
  return [Number(a), Number(b)];
};
/** Newer stream id first. */
export function compareIdsDesc(a: string, b: string): number {
  const [am, as] = idKey(a);
  const [bm, bs] = idKey(b);
  return bm !== am ? bm - am : bs - as;
}

export class LiveStore {
  views = new Map<string, BotView>();
  points = new Map<string, SeriesPoint[]>();
  /** Newest first, unique by bot+id. Rare kinds only (status, risk, edge, fills, commands…). */
  events: StoredEvent[] = [];
  /** Orders and markouts, newest first (separate bound: their churn must not evict the rest). */
  noisy: StoredEvent[] = [];
  /** Fills only, newest first (separate bound). */
  fills: StoredEvent[] = [];
  state: ConnState = 'idle';
  actor: string | null = null;
  /** serverTime − local clock, from the last message (the server is the time authority). */
  clockOffsetMs = 0;
  lastMessageAt = 0;
  eventsDropped = 0;
  /** Incremented on every snapshot (hello): REST-seeded data keyed by it refetches after a gap. */
  epoch = 0;
  version = 0;

  private ws: SocketLike | null = null;
  private attempt = 0;
  private timer: unknown = null;
  private readonly listeners = new Set<() => void>();
  private readonly seen = new Set<string>();
  private readonly seenFills = new Set<string>();
  private readonly seenNoisy = new Set<string>();
  private readonly o: Required<LiveOptions>;

  constructor(o: LiveOptions) {
    this.o = {
      socket: (u) => new WebSocket(u) as unknown as SocketLike,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
      random: Math.random,
      ...o,
    };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  /** Server-aligned "now" for ages. */
  serverNow(): number {
    return this.o.now() + this.clockOffsetMs;
  }

  private changed(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  connect(): void {
    if (this.ws || this.state === 'live') return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = this.o.socket(this.o.url());
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        this.handle(JSON.parse(ev.data) as WsServerMessage);
      } catch {
        /* ignore a malformed frame */
      }
    };
    ws.onclose = (ev) => {
      this.ws = null;
      if (ev.code === WS_CLOSE_UNAUTHORIZED) {
        this.setState('unauthorized');
        return;
      }
      if (this.state === 'idle') return; // closed on purpose
      this.setState('reconnecting');
      const delay = backoffMs(this.attempt++, this.o.random);
      this.timer = this.o.setTimer(() => {
        this.timer = null;
        this.connect();
      }, delay);
    };
    ws.onerror = () => undefined; // onclose follows and handles it
  }

  disconnect(): void {
    this.setState('idle');
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
  }

  /** After a fresh sign-in. */
  reset(): void {
    this.disconnect();
    this.attempt = 0;
    this.views.clear();
    this.points.clear();
    this.events = [];
    this.fills = [];
    this.noisy = [];
    this.seen.clear();
    this.seenFills.clear();
    this.seenNoisy.clear();
    this.actor = null;
    this.changed();
  }

  private setState(s: ConnState): void {
    if (this.state !== s) {
      this.state = s;
      this.changed();
    }
  }

  handle(m: WsServerMessage): void {
    this.lastMessageAt = this.o.now();
    if ('serverTime' in m) this.clockOffsetMs = m.serverTime - this.o.now();
    if (m.t === 'hello') {
      this.attempt = 0;
      this.epoch++;
      this.state = 'live';
      this.actor = m.actor;
      // The snapshot replaces the views wholesale: a bot that disappeared is gone.
      this.views = new Map(m.views.map((v) => [v.botId, v]));
    } else if (m.t === 'tick') {
      for (const v of m.views) this.views.set(v.botId, v);
      const byBot = new Map<string, SeriesPoint[]>();
      for (const { botId, p } of m.points) byBot.set(botId, [...(byBot.get(botId) ?? []), p]);
      for (const [b, ps] of byBot) this.points.set(b, mergePoints(this.points.get(b) ?? [], ps));
      this.addEvents(m.events);
      if (m.eventsDropped) this.eventsDropped += m.eventsDropped;
    } else if (m.t === 'bye') {
      if (m.reason === 'session_expired') this.state = 'unauthorized';
    }
    this.changed();
  }

  seedPoints(botId: string, pts: readonly SeriesPoint[]): void {
    this.points.set(botId, mergePoints(this.points.get(botId) ?? [], pts));
    this.changed();
  }

  seedEvents(evs: readonly StoredEvent[]): void {
    if (this.addEvents(evs)) this.changed();
  }

  private addEvents(evs: readonly StoredEvent[]): boolean {
    // Orders and markouts arrive several times a second per bot: in one shared buffer they pushed
    // out every risk, status and edge event within minutes. Each class has its own bound.
    const a = addUnique(this.events, this.seen, evs.filter((s) => !NOISY_KINDS.has(s.e.k)), MAX_EVENTS);
    const n = addUnique(this.noisy, this.seenNoisy, evs.filter((s) => NOISY_KINDS.has(s.e.k)), MAX_NOISY);
    // Fills also get their own buffer (the Fills page and the chart markers).
    const b = addUnique(this.fills, this.seenFills, evs.filter((s) => s.e.k === 'fill'), MAX_FILLS, byFillId, newestTsFirst);
    return a || n || b;
  }

  /** Events of the given kinds (all kinds when omitted), newest first. */
  eventsOf(kinds?: ReadonlySet<string>): StoredEvent[] {
    const wantNoisy = !kinds || [...kinds].some((k) => NOISY_KINDS.has(k));
    const wantRare = !kinds || [...kinds].some((k) => !NOISY_KINDS.has(k));
    if (!wantNoisy) return this.events;
    if (!wantRare) return this.noisy;
    return [...this.events, ...this.noisy].sort(newestIdFirst);
  }

}

const byId = (s: StoredEvent) => `${s.botId}|${s.id}`;
/** A fill has a different stream id in the events and fills streams: its fillId is its identity. */
const byFillId = (s: StoredEvent) => `${s.botId}|${s.e.k === 'fill' ? s.e.fillId : s.id}`;
const newestIdFirst = (x: StoredEvent, y: StoredEvent) => compareIdsDesc(x.id, y.id);
const newestTsFirst = (x: StoredEvent, y: StoredEvent) => y.e.ts - x.e.ts || compareIdsDesc(x.id, y.id);

/** Adds unseen events, keeps newest-first order, evicts the oldest beyond `max`. */
function addUnique(list: StoredEvent[], seen: Set<string>, evs: readonly StoredEvent[], max: number, key = byId, order = newestIdFirst): boolean {
  let added = false;
  for (const s of evs) {
    const k = key(s);
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(s);
    added = true;
  }
  if (added) {
    list.sort(order);
    if (list.length > max) for (const s of list.splice(max)) seen.delete(key(s));
  }
  return added;
}

export function wsUrl(loc: { protocol: string; host: string } = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}
