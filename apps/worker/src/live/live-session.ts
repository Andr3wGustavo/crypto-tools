import { LiveExecutor, mexcMyTradeToExec, type ExecEvent, type MexcMyTrade, type MexcOrderRaw, type OrderApi, type UserStreamState } from '@cortex/exchange';
import type { LiveEngine, LiveInputRecord, LiveOutput } from './live-engine';

/** REST endpoints the live session needs (MexcRest implements them). */
export interface LiveRestApi extends OrderApi {
  openOrders(symbol: string): Promise<MexcOrderRaw[]>;
  account(): Promise<{ balances: Array<{ asset: string; free: string; locked: string }> }>;
  myTrades(symbol: string, startTime?: number, limit?: number): Promise<MexcMyTrade[]>;
}

export interface LiveSessionOptions {
  engine: LiveEngine;
  rest: LiveRestApi;
  symbol: string;
  /** Called with every input, before the engine sees it (the recorder: replay = live). */
  record: (r: LiveInputRecord) => void;
  /** Called with every input and the engine's outputs (sinks: Redis view, Postgres, logs). */
  onOutputs?: (r: LiveInputRecord, outs: LiveOutput[]) => void;
  /** The trading loop failed: the caller shuts down fail-closed (cancel all) and exits. */
  onFatal: (err: unknown) => void;
  log?: (o: Record<string, unknown>) => void;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  executor?: { ratePerSec?: number; burst?: number; maxConcurrent?: number };
  /** Own trades fetched on every sync, looking back this far (deduplicated by the ledger). */
  tradesLookbackMs?: number;
  cancelAllAttempts?: number;
}

/**
 * The live I/O layer around the pure LiveEngine. It owns nothing the engine decides: it turns
 * engine outputs into exchange requests and every answer back into recorded input records,
 * strictly one at a time (inputs are processed in exactly the order they are recorded).
 *
 *   boot:      cancel every open order on the symbol (must succeed) → user stream → engine waits
 *              for stream up + opening sync before it quotes
 *   sync:      own trades (recent) → open orders → balances → one `sync` record
 *   shutdown:  `stream down` input (engine stops quoting, asks cancel-all) → cancel-all → idle
 */
export class LiveSession {
  readonly executor: LiveExecutor;
  private readonly queue: LiveInputRecord[] = [];
  private draining = false;
  private syncing: Promise<void> | null = null;
  private syncAgain: number | null = null;
  private cancelAllRunning: Promise<void> | null = null;
  private stopped = false;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (o: Record<string, unknown>) => void;

  constructor(private readonly o: LiveSessionOptions) {
    this.clock = o.clock ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = o.log ?? ((x) => console.log(JSON.stringify(x)));
    this.executor = new LiveExecutor({
      api: o.rest, symbol: o.symbol, clock: this.clock, sleep: this.sleep, ...o.executor,
      emit: (evs) => this.exec(evs),
      onFatal: (err) => o.onFatal(err),
    });
  }

  /** Feeds one input (market data, clock, health, commands, exchange events). */
  input(r: LiveInputRecord): void {
    this.queue.push(r);
    if (this.draining) return; // re-entrant call from a handler: processed in order below
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const x = this.queue.shift()!;
        this.o.record(x);
        const outs = this.o.engine.process(x);
        this.o.onOutputs?.(x, outs);
        for (const out of outs) this.dispatch(out);
      }
    } catch (err) {
      this.queue.length = 0;
      this.o.onFatal(err);
    } finally {
      this.draining = false;
    }
  }

  /** User stream callbacks (wire MexcUserStream handlers here). */
  readonly stream = {
    onExec: (events: ExecEvent[]) => this.exec(events),
    onState: (s: UserStreamState) => this.input({ t: 'stream', ts: this.clock(), up: s.state === 'up', ...(s.state === 'down' ? { reason: s.reason } : {}) }),
  };

  /**
   * Before anything else: no order of ours may rest from a previous run. Retries, and throws if
   * it cannot confirm (the caller must not start quoting).
   */
  async boot(): Promise<void> {
    await this.cancelAll('boot', true);
  }

  /** Stop quoting, cancel everything, wait for in-flight requests (bounded by the caller). */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.input({ t: 'stream', ts: this.clock(), up: false, reason: 'shutdown' });
    this.stopped = true;
    await this.cancelAllRunning;
    await this.cancelAll('shutdown', false).catch(() => undefined);
    await this.executor.idle();
    await this.syncing;
  }

  // ------------------------------------------------------------------ internals

  private exec(events: ExecEvent[]): void {
    for (const e of events) this.input({ t: 'exec', ts: e.ts, e });
  }

  private dispatch(o: LiveOutput): void {
    if (o.kind === 'action') {
      const a = o.action;
      if (this.stopped) return;
      if (a.kind === 'place') this.executor.place({ clientOrderId: a.clientOrderId, side: a.side, price: a.price, qty: a.qty });
      else if (a.kind === 'cancel') this.executor.cancel(a.clientOrderId);
      return;
    }
    if (o.kind !== 'request') return;
    switch (o.op) {
      case 'query':
        this.executor.query(o.clientOrderId);
        return;
      case 'cancel':
        this.executor.cancel(o.clientOrderId);
        return;
      case 'cancel_all':
        if (!this.cancelAllRunning) {
          this.cancelAllRunning = this.cancelAll(o.reason, false)
            .catch((err: unknown) => this.log({ msg: 'live: cancel-all failed after retries', level: 'error', err: String(err) }))
            .finally(() => (this.cancelAllRunning = null));
        }
        return;
      case 'trades':
        void this.fetchTrades().catch((err: unknown) => this.log({ msg: 'live: trade recovery failed', level: 'warn', err: String(err) }));
        return;
      case 'sync':
        this.requestSync(o.epoch);
        return;
    }
  }

  private async cancelAll(reason: string, mustSucceed: boolean): Promise<void> {
    const attempts = Math.max(1, this.o.cancelAllAttempts ?? 5);
    for (let a = 1; ; a++) {
      try {
        const evs = await this.executor.cancelAll();
        this.log({ msg: 'live: cancel-all done', reason, canceled: evs.length });
        return;
      } catch (err) {
        this.log({ msg: 'live: cancel-all failed', level: 'error', reason, attempt: a, err: String(err) });
        if (a >= attempts) {
          if (mustSucceed) throw new Error(`cancel-all (${reason}) not confirmed after ${a} attempts: ${String(err)}`);
          throw err;
        }
        await this.sleep(Math.min(30_000, 1_000 * 2 ** (a - 1)));
      }
    }
  }

  /** At most one sync in flight; a request arriving meanwhile runs once more afterwards. */
  private requestSync(epoch: number): void {
    if (this.stopped) return;
    if (this.syncing) {
      this.syncAgain = epoch;
      return;
    }
    this.syncing = this.sync(epoch)
      .catch((err: unknown) => this.log({ msg: 'live: sync failed (the engine asks again)', level: 'warn', err: String(err) }))
      .finally(() => {
        this.syncing = null;
        const again = this.syncAgain;
        this.syncAgain = null;
        if (again !== null) this.requestSync(again);
      });
  }

  private async sync(epoch: number): Promise<void> {
    await this.fetchTrades();
    const open = await this.o.rest.openOrders(this.o.symbol);
    const acct = await this.o.rest.account();
    const balances: Record<string, { free: string; locked: string }> = {};
    for (const b of acct.balances ?? []) balances[b.asset.toUpperCase()] = { free: b.free, locked: b.locked };
    this.input({
      t: 'sync', ts: this.clock(), epoch,
      open: (Array.isArray(open) ? open : []).filter((x) => x.symbol === undefined || x.symbol.toUpperCase() === this.o.symbol).map((x) => ({ clientOrderId: x.clientOrderId ?? '', orderId: String(x.orderId ?? '') })),
      balances,
    });
  }

  /** Own recent trades → fill records (the ledger books each trade id once). */
  private async fetchTrades(): Promise<void> {
    const since = this.clock() - (this.o.tradesLookbackMs ?? 15 * 60_000);
    const trades = await this.o.rest.myTrades(this.o.symbol, since, 100);
    if (trades.length >= 100) this.log({ msg: 'live: myTrades page full; older fills rely on the stream and the balance check', level: 'warn' });
    const evs = [...trades].sort((a, b) => a.time - b.time || String(a.id).localeCompare(String(b.id))).map((t) => mexcMyTradeToExec(t, this.clock()));
    this.exec(evs);
  }
}
