import { WS_CLOSE_SLOW, WS_CLOSE_UNAUTHORIZED, WS_TICK_MS, type BotView, type LiveMessage, type SeriesPoint, type StoredEvent, type WsServerMessage } from '@cortex/shared';
import type { BotData } from './data';

/** The part of a WebSocket the hub uses (the `ws` socket in production, a fake in tests). */
export interface HubSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface HubClient {
  socket: HubSocket;
  actor: string;
  /** Re-checks the session (expiry, allowlist removal). False → the client is closed with 4401. */
  stillAuthorized(): Promise<boolean>;
}

export interface HubOptions {
  tickMs?: number;
  /** A client with more than this many bytes queued is too slow: it is closed, never buffered for. */
  maxBufferedBytes?: number;
  /** Events relayed per tick; the overflow is dropped and the client told to refetch. */
  maxEventsPerTick?: number;
  revalidateMs?: number;
  now?: () => number;
}

/**
 * Fan-out of the workers' live messages to the dashboards: one Redis subscription for all
 * clients, coalesced into a tick about 4 times a second.
 * - Snapshot first: every connection, including each reconnect, starts with `hello`, which
 *   carries every bot's latest view. The client never has to replay deltas to be correct.
 * - Deltas: only the views that changed since the last tick, plus that tick's chart points
 *   and events.
 * - Backpressure: a slow client is closed (4408) instead of growing server memory; it
 *   reconnects and gets a fresh snapshot.
 * - Sessions are re-validated periodically. An expired or revoked session is closed with 4401.
 */
export class LiveHub {
  private readonly clients = new Set<HubClient>();
  private readonly latest = new Map<string, BotView>();
  private changed = new Map<string, BotView>();
  private points: Array<{ botId: string; p: SeriesPoint }> = [];
  private events: StoredEvent[] = [];
  private eventsDropped = 0;
  private timer: NodeJS.Timeout | undefined;
  private revalidator: NodeJS.Timeout | undefined;
  private unsubscribe: (() => Promise<void>) | undefined;
  private readonly o: Required<HubOptions>;
  relayed = 0;
  slowClosed = 0;

  constructor(private readonly data: BotData, o: HubOptions = {}) {
    this.o = { tickMs: WS_TICK_MS, maxBufferedBytes: 1 << 20, maxEventsPerTick: 500, revalidateMs: 30_000, now: Date.now, ...o };
  }

  get size(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    this.unsubscribe = await this.data.subscribe((m) => this.onMessage(m));
    const ids = await this.data.listBots();
    (await this.data.views(ids)).forEach((v) => v && this.latest.set(v.botId, v));
    this.timer = setInterval(() => this.tick(), this.o.tickMs);
    this.revalidator = setInterval(() => void this.revalidate(), this.o.revalidateMs);
    this.timer.unref();
    this.revalidator.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    clearInterval(this.revalidator);
    for (const c of this.clients) this.bye(c, 'shutdown', 1001);
    this.clients.clear();
    await this.unsubscribe?.();
  }

  onMessage(m: LiveMessage): void {
    if (m.t === 'view') {
      this.latest.set(m.view.botId, m.view);
      this.changed.set(m.view.botId, m.view);
    } else if (m.t === 'point') {
      this.points.push({ botId: m.botId, p: m.p });
      if (this.points.length > 1_000) this.points.splice(0, this.points.length - 1_000);
    } else if (m.t === 'event') {
      if (this.events.length < this.o.maxEventsPerTick) this.events.push({ id: m.id, botId: m.botId, e: m.e });
      else this.eventsDropped++;
    }
  }

  /** Registers a client and sends it the snapshot. */
  add(c: HubClient): void {
    this.clients.add(c);
    const hello: WsServerMessage = { t: 'hello', serverTime: this.o.now(), actor: c.actor, views: [...this.latest.values()] };
    this.send(c, JSON.stringify(hello));
  }

  remove(c: HubClient): void {
    this.clients.delete(c);
  }

  tick(): void {
    if (this.changed.size === 0 && this.points.length === 0 && this.events.length === 0) return;
    const msg: WsServerMessage = {
      t: 'tick', serverTime: this.o.now(), views: [...this.changed.values()], points: this.points, events: this.events,
      ...(this.eventsDropped ? { eventsDropped: this.eventsDropped } : {}),
    };
    this.changed = new Map();
    this.points = [];
    this.events = [];
    this.eventsDropped = 0;
    const json = JSON.stringify(msg); // serialised once for every client
    for (const c of this.clients) this.send(c, json);
    this.relayed++;
  }

  private send(c: HubClient, json: string): void {
    if (c.socket.bufferedAmount > this.o.maxBufferedBytes) {
      this.slowClosed++;
      this.bye(c, 'slow_consumer', WS_CLOSE_SLOW);
      this.clients.delete(c);
      return;
    }
    try {
      c.socket.send(json);
    } catch {
      this.clients.delete(c);
    }
  }

  private bye(c: HubClient, reason: Extract<WsServerMessage, { t: 'bye' }>['reason'], code: number): void {
    try {
      c.socket.send(JSON.stringify({ t: 'bye', reason } satisfies WsServerMessage));
      c.socket.close(code, reason);
    } catch {
      /* already gone */
    }
  }

  async revalidate(): Promise<void> {
    for (const c of [...this.clients]) {
      let ok = false;
      try {
        ok = await c.stillAuthorized();
      } catch {
        ok = false; // fail closed: when in doubt, the client re-authenticates
      }
      if (!ok) {
        this.bye(c, 'session_expired', WS_CLOSE_UNAUTHORIZED);
        this.clients.delete(c);
      }
    }
  }
}
