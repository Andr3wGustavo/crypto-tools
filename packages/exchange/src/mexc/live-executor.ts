import { systemClock, type Clock } from '../types';
import { mexcRestOrderToExec, type ExecEvent } from './private';
import { classifyMexcError, isUnknownOrder, MexcRestError, type MexcOrderRaw } from './rest';

/** The order endpoints the executor needs (MexcRest implements them). */
export interface OrderApi {
  placeLimitMaker(symbol: string, side: 'BUY' | 'SELL', quantity: string, price: string, newClientOrderId: string): Promise<{ orderId: string }>;
  cancelOrder(symbol: string, origClientOrderId: string): Promise<MexcOrderRaw>;
  cancelAll(symbol: string): Promise<MexcOrderRaw[]>;
  queryOrder(symbol: string, origClientOrderId: string): Promise<MexcOrderRaw>;
}

export interface LiveExecutorOptions {
  api: OrderApi;
  symbol: string;
  /** Every outcome, as data, in completion order. The caller records it and feeds the engine. */
  emit: (events: ExecEvent[]) => void;
  /** An `emit` that throws is the trading loop failing: handed here (fail-closed upstream). */
  onFatal: (err: unknown) => void;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  /** Sustained request rate and burst (token bucket). MEXC allows 500 / 10 s per endpoint and IP. */
  ratePerSec?: number;
  burst?: number;
  maxConcurrent?: number;
  /** A cancel that gets no answer is retried (cancels are idempotent) before it is reported unknown. */
  cancelAttempts?: number;
  /** Pause after a 429 without Retry-After. */
  rateLimitPauseMs?: number;
}

const PLACED_MEMORY = 10_000;

type Op = { kind: 'place'; clientOrderId: string; side: 'BUY' | 'SELL'; price: string; qty: string } | { kind: 'cancel'; clientOrderId: string } | { kind: 'query'; clientOrderId: string };

/**
 * Turns strategy actions into MEXC REST calls and every reply into execution events.
 *
 * - Requests for the same clientOrderId run strictly in order (a cancel never overtakes its own
 *   place); different orders run concurrently up to `maxConcurrent`.
 * - A token bucket keeps us far inside the venue limits; a 429 blocks every request until
 *   Retry-After and is reported as a `venue` event.
 * - Never guesses: refused ⇒ `reject` (not executed); no answer ⇒ `unknown` (the engine queries).
 *   A duplicate place for the same clientOrderId is dropped (idempotent by construction).
 */
export class LiveExecutor {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly placed = new Set<string>();
  private readonly cancelling = new Set<string>();
  private running = 0;
  private readonly waiters: Array<() => void> = [];
  private tokens: number;
  private refillTs: number;
  private blockedUntil = 0;
  private pending = 0;
  private readonly idleWaiters: Array<() => void> = [];
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rate: number;
  private readonly burst: number;

  constructor(private readonly o: LiveExecutorOptions) {
    this.clock = o.clock ?? systemClock;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rate = o.ratePerSec ?? 5;
    this.burst = o.burst ?? 5;
    this.tokens = this.burst;
    this.refillTs = this.clock();
  }

  place(p: { clientOrderId: string; side: 'BUY' | 'SELL'; price: string; qty: string }): void {
    if (this.placed.has(p.clientOrderId)) return;
    this.placed.add(p.clientOrderId);
    // Bounded memory over weeks of live: a duplicate can only come from a retry right after the
    // original; clientOrderIds are never reused (monotonic sequence), so old ones can go.
    if (this.placed.size > PLACED_MEMORY) this.placed.delete(this.placed.values().next().value as string);
    this.enqueue({ kind: 'place', ...p });
  }

  cancel(clientOrderId: string): void {
    if (this.cancelling.has(clientOrderId)) return; // one cancel in flight is enough
    this.cancelling.add(clientOrderId);
    this.enqueue({ kind: 'cancel', clientOrderId });
  }

  query(clientOrderId: string): void {
    this.enqueue({ kind: 'query', clientOrderId });
  }

  /**
   * Cancels every open order on the symbol (boot, shutdown, fail-closed). Bypasses the queue
   * but not the rate limit; throws when it cannot confirm, so the caller never assumes it worked.
   * Returns the canceled orders as events (also emitted).
   */
  async cancelAll(): Promise<ExecEvent[]> {
    await this.token();
    try {
      const rows = await this.o.api.cancelAll(this.o.symbol);
      const evs = (Array.isArray(rows) ? rows : []).map((r) => mexcRestOrderToExec(r, this.clock()));
      this.deliver(evs);
      return evs;
    } catch (err) {
      this.onVenueError(err);
      throw err;
    }
  }

  /** Resolves when every queued request has completed. */
  idle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  get inFlight(): number {
    return this.pending;
  }

  // ------------------------------------------------------------------ internals

  private enqueue(op: Op): void {
    this.pending++;
    const prev = this.chains.get(op.clientOrderId) ?? Promise.resolve();
    const next = prev
      .then(() => this.withSlot(() => this.run(op)))
      .catch((err: unknown) => this.o.onFatal(err))
      .finally(() => {
        if (this.chains.get(op.clientOrderId) === next) this.chains.delete(op.clientOrderId);
        if (op.kind === 'cancel') this.cancelling.delete(op.clientOrderId);
        if (--this.pending === 0) this.idleWaiters.splice(0).forEach((r) => r());
      });
    this.chains.set(op.clientOrderId, next);
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.o.maxConcurrent ?? 4;
    while (this.running >= max) await new Promise<void>((r) => this.waiters.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiters.shift()?.();
    }
  }

  /** Waits for a request token (and for any 429 block to end). */
  private async token(): Promise<void> {
    for (;;) {
      const now = this.clock();
      if (now < this.blockedUntil) {
        await this.sleep(this.blockedUntil - now);
        continue;
      }
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.refillTs) / 1_000) * this.rate);
      this.refillTs = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1_000));
    }
  }

  private async run(op: Op): Promise<void> {
    const { symbol } = this.o;
    const id = op.clientOrderId;
    if (op.kind === 'place') {
      await this.token();
      try {
        const r = await this.o.api.placeLimitMaker(symbol, op.side, op.qty, op.price, id);
        if (!r || r.orderId === undefined || r.orderId === null || String(r.orderId) === '') {
          // Accepted but unreadable: whether it rests is unknown.
          return this.deliver([{ kind: 'unknown', ts: this.clock(), clientOrderId: id, op: 'place', detail: 'place reply without orderId' }]);
        }
        return this.deliver([{ kind: 'ack', ts: this.clock(), clientOrderId: id, orderId: String(r.orderId) }]);
      } catch (err) {
        const f = classifyMexcError(err);
        this.onVenueError(err);
        if (f === 'unknown') return this.deliver([{ kind: 'unknown', ts: this.clock(), clientOrderId: id, op: 'place', detail: describe(err) }]);
        return this.deliver([{ kind: 'reject', ts: this.clock(), clientOrderId: id, op: 'place', reason: f === 'rejected' ? describe(err) : f, code: codeOf(err) }]);
      }
    }
    if (op.kind === 'cancel') {
      const attempts = Math.max(1, this.o.cancelAttempts ?? 3);
      for (let a = 1; a <= attempts; a++) {
        await this.token();
        try {
          const r = await this.o.api.cancelOrder(symbol, id);
          return this.deliver([mexcRestOrderToExec({ ...r, clientOrderId: r.clientOrderId || id }, this.clock())]);
        } catch (err) {
          if (isUnknownOrder(err)) {
            // Already filled, already canceled, or never placed: only a query can tell which.
            return this.deliver([{ kind: 'unknown', ts: this.clock(), clientOrderId: id, op: 'cancel', detail: describe(err) }]);
          }
          const f = classifyMexcError(err);
          this.onVenueError(err);
          if (f === 'auth' || f === 'clock' || f === 'rejected') {
            return this.deliver([{ kind: 'reject', ts: this.clock(), clientOrderId: id, op: 'cancel', reason: f === 'rejected' ? describe(err) : f, code: codeOf(err) }]);
          }
          // rate_limited (token() waits out the block) or no answer: a cancel is safe to repeat.
          if (a === attempts) return this.deliver([{ kind: 'unknown', ts: this.clock(), clientOrderId: id, op: 'cancel', detail: describe(err) }]);
        }
      }
      return;
    }
    // query
    await this.token();
    try {
      const r = await this.o.api.queryOrder(symbol, id);
      this.deliver([mexcRestOrderToExec({ ...r, clientOrderId: r.clientOrderId || id }, this.clock())]);
    } catch (err) {
      if (isUnknownOrder(err)) return this.deliver([{ kind: 'missing', ts: this.clock(), clientOrderId: id }]);
      this.onVenueError(err);
      // No answer: the order stays unknown; the reconciler asks again on its next pass.
      this.deliver([{ kind: 'unknown', ts: this.clock(), clientOrderId: id, op: 'cancel', detail: `query failed: ${describe(err)}` }]);
    }
  }

  /** Venue-wide failures: block on 429, and tell the engine (rate limit / auth / clock). */
  private onVenueError(err: unknown): void {
    const f = classifyMexcError(err);
    if (f === 'rate_limited') {
      const ms = (err instanceof MexcRestError && err.retryAfterMs) || (this.o.rateLimitPauseMs ?? 2_000);
      this.blockedUntil = Math.max(this.blockedUntil, this.clock() + ms);
    }
    if (f === 'rate_limited' || f === 'auth' || f === 'clock') {
      this.deliver([{ kind: 'venue', ts: this.clock(), state: f, detail: describe(err) }]);
    }
  }

  private deliver(evs: ExecEvent[]): void {
    if (evs.length > 0) this.o.emit(evs);
  }
}

const describe = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 200);
const codeOf = (err: unknown): number | null => (err instanceof MexcRestError && err.code !== undefined ? err.code : null);
