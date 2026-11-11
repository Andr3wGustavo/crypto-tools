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
  url: string;
  onOpen: (ws: WebSocket) => void;
  onMessage: (data: WebSocket.RawData, isBinary: boolean) => void;
  onState?: (state: 'connecting' | 'open' | 'closed' | 'stale' | 'error', detail?: string) => void;
  pingIntervalMs?: number;
  pingPayload?: () => string | undefined;
  staleMs?: number;
  maxLifetimeMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  clock?: Clock;
}

export class ResilientWs {
  private ws: WebSocket | undefined;
  private running = false;
  private attempt = 0;
  private lastData = Number.NEGATIVE_INFINITY;
  private openedAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private readonly clock: Clock;

  constructor(private readonly o: ResilientWsOptions) {
    this.clock = o.clock ?? systemClock;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.timers.push(setInterval(() => this.watchdog(), 1_000));
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = undefined;
  }

  send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  lastMessageAgeMs(now = this.clock()): number {
    return now - this.lastData;
  }

  private connect(): void {
    if (!this.running) return;
    this.o.onState?.('connecting');
    const ws = new WebSocket(this.o.url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
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
    const t = setTimeout(() => this.connect(), delay);
    this.timers.push(t);
  }

  private forceReconnect(reason: 'stale' | 'error', detail: string): void {
    this.o.onState?.(reason, detail);
    const old = this.ws;
    this.ws = undefined;
    old?.removeAllListeners();
    old?.terminate();
    this.scheduleReconnect();
  }

  private pingTick = 0;

  private watchdog(): void {
    if (!this.running || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const now = this.clock();
    const staleMs = this.o.staleMs ?? 30_000;
    if (now - this.lastData > staleMs) return this.forceReconnect('stale', `no data for ${now - this.lastData}ms`);
    if (this.o.maxLifetimeMs && now - this.openedAt > this.o.maxLifetimeMs) return this.forceReconnect('stale', 'max lifetime rotation');
    const every = Math.max(1, Math.round((this.o.pingIntervalMs ?? 20_000) / 1_000));
    if (++this.pingTick % every === 0) {
      const payload = this.o.pingPayload?.();
      if (payload) this.ws.send(payload);
      else this.ws.ping();
    }
  }
}
