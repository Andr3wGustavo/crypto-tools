import type WebSocket from 'ws';
import { ResilientWs } from '../ws/resilient-ws';
import { systemClock, type Clock } from '../types';
import { decodeMexcPush } from './codec';
import { MEXC_WS_URL } from './market-stream';
import { mexcPrivateChannels, mexcPrivateToExec, type ExecEvent, type MexcPrivatePush } from './private';

/** The three REST calls of the listenKey lifecycle (MexcRest implements them). */
export interface ListenKeyApi {
  createListenKey(): Promise<string>;
  keepAliveListenKey(listenKey: string): Promise<void>;
  deleteListenKey(listenKey: string): Promise<void>;
}

/**
 * - `up`: connected and subscribed to every private channel. Events may have been missed
 *   before this point, so the consumer reconciles over REST before it trusts its state again.
 *   `session` counts the times the stream came up (1 = first).
 * - `down`: not (or no longer) reliable: events can be missed from now on. The consumer stops
 *   quoting until the next `up` + reconcile (fail-closed).
 */
export type UserStreamState = { state: 'up'; session: number } | { state: 'down'; reason: string };

export interface UserStreamHandlers {
  /** Decoded execution events, in arrival order. A throw propagates (the trading loop fails closed). */
  onExec: (events: ExecEvent[]) => void;
  onState: (s: UserStreamState) => void;
  /** Diagnostics (key rotation, keepalive failures); never contains the listenKey. */
  onLog?: (o: Record<string, unknown>) => void;
}

export interface UserStreamOptions {
  rest: ListenKeyApi;
  url?: string;
  clock?: Clock;
  /** listenKey keepalive period (MEXC: key valid 60 min, keepalive recommended every 30). */
  keepAliveMs?: number;
  pingIntervalMs?: number;
  /** No frame (data or PONG) for this long ⇒ down + reconnect. */
  staleMs?: number;
  /** All channels must be confirmed within this long after the handshake. */
  subscribeTimeoutMs?: number;
  /** Proactive rotation before MEXC's 24 h connection limit. */
  maxLifetimeMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  tickMs?: number;
}

const CHANNELS = [mexcPrivateChannels.orders, mexcPrivateChannels.deals, mexcPrivateChannels.account];

/**
 * MEXC user data stream: listenKey lifecycle + private WebSocket → execution events.
 *
 * - The key is validated (keepalive) before every reconnect and re-created when that fails; the
 *   replaced key is deleted best-effort, so keys never pile up towards the 60-per-account limit.
 * - A keepalive every 30 min; a failed keepalive ⇒ down + new key + reconnect.
 * - Each channel is subscribed separately and must be acknowledged (`{code:0,msg:<channel>}`)
 *   before the stream reports `up`. A non-zero code or a missing ack ⇒ reconnect.
 * - A frame that cannot be decoded may have been a fill: never skipped, it forces down + reconnect
 *   so the consumer reconciles over REST.
 */
export class MexcUserStream {
  private readonly ws: ResilientWs;
  private readonly clock: Clock;
  private key: string | undefined;
  private pending = new Set<string>();
  private isUp = false;
  private sessions = 0;
  private running = false;
  private subscribeTimer: NodeJS.Timeout | undefined;
  private keepAliveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly h: UserStreamHandlers, private readonly o: UserStreamOptions) {
    this.clock = o.clock ?? systemClock;
    const base = o.url ?? MEXC_WS_URL;
    this.ws = new ResilientWs({
      name: 'mexc-user',
      url: async () => `${base}?listenKey=${encodeURIComponent(await this.validKey())}`,
      clock: this.clock,
      pingIntervalMs: o.pingIntervalMs ?? 10_000,
      pingPayload: () => JSON.stringify({ method: 'PING' }),
      staleMs: o.staleMs ?? 30_000,
      maxLifetimeMs: o.maxLifetimeMs ?? 23 * 3600_000,
      resetBackoffOn: 'manual',
      ...(o.backoffBaseMs !== undefined ? { backoffBaseMs: o.backoffBaseMs } : {}),
      ...(o.backoffMaxMs !== undefined ? { backoffMaxMs: o.backoffMaxMs } : {}),
      ...(o.tickMs !== undefined ? { tickMs: o.tickMs } : {}),
      onState: (state, detail) => {
        if (state === 'closed' || state === 'stale' || state === 'error') this.down(`${state}${detail ? `: ${detail}` : ''}`);
      },
      onOpen: (ws) => this.subscribe(ws),
      onMessage: (data, isBinary) => this.onMessage(data, isBinary),
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.ws.start();
    this.keepAliveTimer = setInterval(() => void this.keepAlive(), this.o.keepAliveMs ?? 30 * 60_000);
  }

  /** Stops the stream and deletes the key (best-effort). Reports `down` if it was up. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.keepAliveTimer);
    clearTimeout(this.subscribeTimer);
    this.ws.stop();
    this.down('stopped');
    const k = this.key;
    this.key = undefined;
    if (k) await this.o.rest.deleteListenKey(k).catch(() => undefined);
  }

  get up(): boolean {
    return this.isUp;
  }

  lastMessageAgeMs(now?: number): number {
    return this.ws.lastMessageAgeMs(now);
  }

  // ------------------------------------------------------------------ internals

  /** Key to connect with: the current one if a keepalive proves it valid, else a fresh one. */
  private async validKey(): Promise<string> {
    if (this.key) {
      try {
        await this.o.rest.keepAliveListenKey(this.key);
        return this.key;
      } catch (err) {
        this.log({ msg: 'listenKey keepalive failed before reconnect: creating a new key', err: (err as Error).message });
        this.dropKey();
      }
    }
    this.key = await this.o.rest.createListenKey();
    this.log({ msg: 'listenKey created' });
    return this.key;
  }

  private dropKey(): void {
    const old = this.key;
    this.key = undefined;
    if (old) void this.o.rest.deleteListenKey(old).catch(() => undefined);
  }

  private async keepAlive(): Promise<void> {
    const k = this.key;
    if (!this.running || !k) return;
    try {
      await this.o.rest.keepAliveListenKey(k);
    } catch (err) {
      if (this.key !== k || !this.running) return;
      this.log({ msg: 'listenKey keepalive failed: rotating key', err: (err as Error).message });
      this.dropKey();
      this.ws.restart('listenKey keepalive failed');
    }
  }

  private subscribe(ws: WebSocket): void {
    this.pending = new Set(CHANNELS);
    for (const c of CHANNELS) ws.send(JSON.stringify({ method: 'SUBSCRIPTION', params: [c] }));
    clearTimeout(this.subscribeTimer);
    this.subscribeTimer = setTimeout(() => {
      if (this.pending.size > 0) this.ws.restart(`subscription not confirmed: ${[...this.pending].join(',')}`);
    }, this.o.subscribeTimeoutMs ?? 10_000);
  }

  private onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (!isBinary) return this.onControl(String(data));
    let push: MexcPrivatePush;
    let events: ExecEvent[];
    try {
      push = decodeMexcPush(data as Buffer) as unknown as MexcPrivatePush;
      events = mexcPrivateToExec(push, this.clock());
    } catch (err) {
      // Could have been a fill: force a gap so the consumer reconciles. Never skip silently.
      this.ws.restart(`undecodable private frame: ${(err as Error).message}`);
      return;
    }
    // Outside the try: a handler exception is the trading loop's and must propagate.
    if (events.length > 0) this.h.onExec(events);
  }

  private onControl(text: string): void {
    let m: { code?: unknown; msg?: unknown };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    if (m.msg === 'PONG') return;
    const msg = typeof m.msg === 'string' ? m.msg : '';
    if (m.code !== 0) {
      // Any refusal (blocked, bad listenKey, unknown channel) leaves us blind: reconnect.
      this.ws.restart(`subscription refused (code ${String(m.code)}): ${msg.slice(0, 120)}`);
      return;
    }
    for (const c of msg.split(',')) this.pending.delete(c.trim());
    if (this.pending.size === 0 && !this.isUp && this.running) {
      clearTimeout(this.subscribeTimer);
      this.isUp = true;
      this.ws.markHealthy();
      this.h.onState({ state: 'up', session: ++this.sessions });
    }
  }

  private down(reason: string): void {
    clearTimeout(this.subscribeTimer);
    this.pending = new Set(CHANNELS);
    if (!this.isUp) return;
    this.isUp = false;
    this.h.onState({ state: 'down', reason });
  }

  private log(o: Record<string, unknown>): void {
    this.h.onLog?.(o);
  }
}
