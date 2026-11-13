import WebSocket from 'ws';
import type { Clock } from '../types';
import { systemClock } from '../types';

/**
 * WebSocket with the production behaviours every venue needs:
 *  - exponential backoff reconnect with jitter (deterministic jitter source injectable),
 *  - application-level keepalive ping,
 *  - staleness watchdog (no data for `staleMs` → force reconnect),
 *  - proactive rotation before the venue's max connection lifetime (MEXC: 24 h).
 */
export interface ResilientWsOptions {
  name: string;
  /** Fixed URL, or resolved before every (re)connect (e.g. a user stream's listenKey). */
  url: string | (() => Promise<string>);
  onOpen: (ws: WebSocket) => void;
  onMessage: (data: WebSocket.RawData, isBinary: boolean) => void;
  onState?: (state: 'connecting' | 'open' | 'closed' | 'stale' | 'error', detail?: string) => void;
  pingIntervalMs?: number;
  pingPayload?: () => string | undefined;
  staleMs?: number;
  maxLifetimeMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /**
   * 'open' (default): a successful handshake resets the backoff. 'manual': only `markHealthy()`
   * does (e.g. once a subscription is confirmed), so a server that accepts and then rejects us
   * is not hammered every 500 ms.
   */
  resetBackoffOn?: 'open' | 'manual';
  /** Watchdog period (default 1 s; shorter only in tests). */
  tickMs?: number;
  clock?: Clock;
}

export class ResilientWs {
  private ws: WebSocket | undefined;
  private running = false;
  private attempt = 0;
  private lastData = Number.NEGATIVE_INFINITY;
  private openedAt = 0;
  private timers: NodeJS.Timeout[] = [];
  /** Bumped by every stop/forced reconnect: an async connect that resolves late is discarded. */
  private gen = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly clock: Clock;

  constructor(private readonly o: ResilientWsOptions) {
    this.clock = o.clock ?? systemClock;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
    this.timers.push(setInterval(() => this.watchdog(), this.o.tickMs ?? 1_000));
  }

  stop(): void {
    this.running = false;
    this.gen++;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    discard(this.ws);
    this.ws = undefined;
  }

  /** The connection is fully usable: the next failure starts the backoff from scratch. */
  markHealthy(): void {
    this.attempt = 0;
  }

  send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  lastMessageAgeMs(now = this.clock()): number {
    return now - this.lastData;
  }

  /** Drops the current connection (if any) and reconnects with backoff. */
  restart(detail: string): void {
    if (!this.running) return;
    this.forceReconnect('error', detail);
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const gen = ++this.gen;
    this.o.onState?.('connecting');
    let url: string;
    try {
      url = typeof this.o.url === 'string' ? this.o.url : await this.o.url();
    } catch (err) {
      if (gen !== this.gen || !this.running) return;
      this.o.onState?.('error', `resolve url: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    if (gen !== this.gen || !this.running) return;
    // Never two sockets: whatever is left of a previous connection goes first.
    discard(this.ws);
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on('open', () => {
      if ((this.o.resetBackoffOn ?? 'open') === 'open') this.attempt = 0;
      this.openedAt = this.clock();
      this.lastData = this.clock();
      this.o.onState?.('open');
      this.o.onOpen(ws);
    });
    ws.on('message', (data, isBinary) => {
      this.lastData = this.clock();
      this.o.onMessage(data, isBinary);
    });
    ws.on('error', (err) => this.o.onState?.('error', err.message));
    ws.on('close', (code) => {
      this.o.onState?.('closed', `code ${code}`);
      if (this.ws === ws) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const base = this.o.backoffBaseMs ?? 500;
    const max = this.o.backoffMaxMs ?? 30_000;
    const delay = Math.min(max, base * 2 ** this.attempt++) * (0.75 + 0.5 * Math.random());
    // A single pending reconnect: a close racing with a forced restart must not connect twice.
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private forceReconnect(reason: 'stale' | 'error', detail: string): void {
    this.o.onState?.(reason, detail);
    this.gen++;
    discard(this.ws);
    this.ws = undefined;
    this.scheduleReconnect();
  }

  private pingTick = 0;

  private watchdog(): void {
    if (!this.running || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const now = this.clock();
    const staleMs = this.o.staleMs ?? 30_000;
    if (now - this.lastData > staleMs) return this.forceReconnect('stale', `no data for ${now - this.lastData}ms`);
    if (this.o.maxLifetimeMs && now - this.openedAt > this.o.maxLifetimeMs) return this.forceReconnect('stale', 'max lifetime rotation');
    const every = Math.max(1, Math.round((this.o.pingIntervalMs ?? 20_000) / (this.o.tickMs ?? 1_000)));
    if (++this.pingTick % every === 0) {
      const payload = this.o.pingPayload?.();
      if (payload) this.ws.send(payload);
      else this.ws.ping();
    }
  }
}

/**
 * Drops a socket for good. `terminate()` on a socket that is still connecting emits 'error'
 * asynchronously: without a listener that would be an uncaught exception, so one stays attached.
 */
function discard(ws: WebSocket | undefined): void {
  if (!ws) return;
  ws.removeAllListeners();
  ws.on('error', () => undefined);
  ws.terminate();
}
