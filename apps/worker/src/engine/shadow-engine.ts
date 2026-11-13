import crypto from 'node:crypto';
import {
  Ledger, MarketMakerStrategy, NigEstimator, SimExecutor, canonicalJson, captureState, restoreState,
  type LedgerTransaction, type SimEvent, type StrategyAction, type StrategyConfig,
} from '@cortex/core';

export type EngineCommand = 'pause' | 'resume' | 'reset_halt' | 'reset_kill';

/**
 * Everything the engine consumes is an input record. Time, process health and operator commands
 * are data too, so a recording replayed through this engine reproduces every decision bit-for-bit.
 */
export type InputRecord =
  | { t: 'book'; venue: 'local' | 'reference'; ts: number; bid: number; bidQty: number; ask: number; askQty: number }
  | { t: 'trade'; ts: number; price: number; qty: number; aggressor: 'buy' | 'sell' }
  | { t: 'clock'; ts: number }
  | { t: 'health'; ts: number; errorsLastMin: number; eventLoopLagMs: number; clockSkewMs: number }
  | { t: 'command'; ts: number; command: EngineCommand };

export type EngineOutput =
  | { kind: 'action'; action: StrategyAction }
  | { kind: 'sim'; event: SimEvent }
  | { kind: 'ledger'; txId: string }
  | { kind: 'reconcile'; ts: number; ok: boolean; diffs: Array<{ asset: string; ledger: string; strategy: number }> }
  | { kind: 'edge'; ts: number; hourStartEquity: number; hourEndEquity: number; returnBps: number; n: number; pGo: number; pPositive: number; verdict: string };

export interface ShadowEngineOptions {
  config: StrategyConfig;
  startQuote: number;
  latencyMs: number;
  makerFeeRate: number;
  timerMs?: number;
  edgeWindowMs?: number;
}

/**
 * Two different versions, on purpose:
 *  - BEHAVIOR: part of the experiment identity (config hash). Bump only when the decisions the
 *    engine makes from the same inputs change. Bumping it orphans every recording's run dir.
 *  - STATE: snapshot shape. Bump when the captured state changes; old snapshots are then ignored
 *    at boot (genesis replay), recordings stay valid.
 * v2 state (E8): the strategy gained `venueHold` (live only, always null in shadow). Shadow
 * outputs are unchanged: the E3 recording still replays to output hash febef904….
 */
export const ENGINE_BEHAVIOR_VERSION = 1;
export const ENGINE_STATE_VERSION = 2;

/** Everything needed to resume the engine exactly where it stopped. */
export interface EngineSnapshot {
  v: number;
  configHash: string;
  lastTs: number;
  records: number;
  state: Record<string, unknown>;
  ledger: LedgerTransaction[];
}

/** Identity of an experiment: same hash ⇔ same pre-registered parameters and simulator. */
export function engineConfigHash(o: ShadowEngineOptions): string {
  const id = {
    v: ENGINE_BEHAVIOR_VERSION, config: o.config, startQuote: o.startQuote, latencyMs: o.latencyMs,
    makerFeeRate: o.makerFeeRate, timerMs: o.timerMs ?? 1_000, edgeWindowMs: o.edgeWindowMs ?? 3_600_000,
  };
  return crypto.createHash('sha256').update(canonicalJson(id)).digest('hex');
}

/** Stable digest of a full engine state: two runs are in the same state iff digests are equal. */
export function stateDigest(s: EngineSnapshot): string {
  return crypto.createHash('sha256').update(canonicalJson(s)).digest('hex');
}

const RECONCILE_TOL = 1e-9;
const SKIP = ['o', 'book', 'configHash'] as const;

/**
 * Shadow mode: real public market data → strategy → conservative simulated exchange → strategy.
 * Also keeps the exact double-entry ledger, reconciles it against the strategy's balances after
 * every fill (divergence ⇒ risk halt), and the hourly-MTM Bayesian edge estimate.
 */
export class ShadowEngine {
  readonly strategy: MarketMakerStrategy;
  readonly sim: SimExecutor;
  readonly edge = new NigEstimator();
  readonly configHash: string;
  private book = new Ledger();
  private nextTimer = Number.NEGATIVE_INFINITY;
  private windowStart: { ts: number; equity: number } | undefined;
  private fills = 0;
  private lastTs = Number.NEGATIVE_INFINITY;
  private records = 0;
  private health = { errorsLastMin: 0, eventLoopLagMs: 0, clockSkewMs: 0 };
  private reconcileDiverged = false;
  private readonly timerMs: number;
  private readonly edgeWindowMs: number;

  constructor(private readonly o: ShadowEngineOptions) {
    this.strategy = new MarketMakerStrategy(o.config, { quote: o.startQuote, base: 0 });
    this.sim = new SimExecutor({ latencyMs: o.latencyMs, makerFeeRate: o.makerFeeRate });
    this.timerMs = o.timerMs ?? 1_000;
    this.edgeWindowMs = o.edgeWindowMs ?? 3_600_000;
    this.configHash = engineConfigHash(o);
    this.book.post(Ledger.deposit('deposit-0', 0, o.config.quote, o.startQuote));
  }

  get ledger(): Ledger {
    return this.book;
  }

  get fillCount(): number {
    return this.fills;
  }

  get recordCount(): number {
    return this.records;
  }

  /** Start of the current edge window (read-only view for the evaluator; not part of any output). */
  get edgeWindowStartTs(): number | undefined {
    return this.windowStart?.ts;
  }

  process(r: InputRecord): EngineOutput[] {
    const out: EngineOutput[] = [];
    this.records++;
    this.lastTs = r.ts;
    this.sim.advance(r.ts).forEach((e) => this.onSim(e, out));
    if (r.ts >= this.nextTimer) {
      this.nextTimer = r.ts + this.timerMs;
      this.feed({ kind: 'timer', ts: r.ts }, out);
      this.edgeTick(r.ts, out);
    }
    switch (r.t) {
      case 'book':
        if (r.venue === 'local') {
          const book = { bid: r.bid, bidQty: r.bidQty, ask: r.ask, askQty: r.askQty };
          this.sim.onBook(r.ts, book).forEach((e) => this.onSim(e, out));
        }
        this.feed({ kind: 'book', venue: r.venue, ts: r.ts, bid: r.bid, bidQty: r.bidQty, ask: r.ask, askQty: r.askQty }, out);
        break;
      case 'trade':
        this.sim.onTrade({ ts: r.ts, price: r.price, qty: r.qty, aggressor: r.aggressor }).forEach((e) => this.onSim(e, out));
        break;
      case 'health':
        this.health = { errorsLastMin: r.errorsLastMin, eventLoopLagMs: r.eventLoopLagMs, clockSkewMs: r.clockSkewMs };
        this.feedHealth(r.ts, out);
        break;
      case 'command':
        this.feed({ kind: 'command', ts: r.ts, command: r.command }, out);
        break;
      case 'clock':
        break;
    }
    return out;
  }

  // ------------------------------------------------------------------ snapshot / restore

  snapshot(): EngineSnapshot {
    return {
      v: ENGINE_STATE_VERSION,
      configHash: this.configHash,
      lastTs: this.lastTs,
      records: this.records,
      state: captureState(this, SKIP),
      ledger: this.book.transactions.map((t) => ({ ...t, postings: t.postings.map((p) => ({ ...p })) })),
    };
  }

  /**
   * Rebuilds an engine from a snapshot taken with the same options. Refuses a snapshot from a
   * different experiment (config hash) or engine version, and re-validates every ledger
   * transaction (balanced, no overdraft) while re-posting it.
   */
  static restore(o: ShadowEngineOptions, s: EngineSnapshot): ShadowEngine {
    const e = new ShadowEngine(o);
    if (s.v !== ENGINE_STATE_VERSION) throw new Error(`snapshot version ${s.v} ≠ engine ${ENGINE_STATE_VERSION}`);
    if (s.configHash !== e.configHash) throw new Error('snapshot belongs to a different configuration');
    restoreState(e, s.state as Parameters<typeof restoreState>[1], SKIP);
    e.book = new Ledger();
    for (const tx of s.ledger) e.book.post(tx);
    if (e.records !== s.records || e.lastTs !== s.lastTs) throw new Error('snapshot header does not match its state');
    // The ledger must explain the strategy's balances (unless a divergence was already recorded:
    // then the sticky halt is part of the state and the mismatch is expected).
    const diffs = e.ledgerDiffs();
    if (!e.reconcileDiverged && diffs.length > 0) {
      throw new Error(`snapshot ledger does not match the strategy balances (${diffs.map((d) => `${d.asset}: ${d.ledger} vs ${d.strategy}`).join(', ')})`);
    }
    return e;
  }

  // ------------------------------------------------------------------ internals

  private feed(ev: Parameters<MarketMakerStrategy['handle']>[0], out: EngineOutput[]): void {
    for (const a of this.strategy.handle(ev)) {
      out.push({ kind: 'action', action: a });
      if (a.kind === 'place') {
        this.sim.place(a.ts, { clientOrderId: a.clientOrderId, side: a.side, price: Number(a.price), qty: Number(a.qty) }).forEach((e) => this.onSim(e, out));
      } else if (a.kind === 'cancel') {
        this.sim.cancel(a.ts, a.clientOrderId).forEach((e) => this.onSim(e, out));
      }
    }
  }

  private feedHealth(ts: number, out: EngineOutput[]): void {
    this.feed({ kind: 'health', ts, ...this.health, reconcileDiverged: this.reconcileDiverged }, out);
  }

  private onSim(e: SimEvent, out: EngineOutput[]): void {
    out.push({ kind: 'sim', event: e });
    if (e.kind === 'fill') {
      this.fills++;
      const { base, quote } = this.o.config;
      const txId = `fill-${e.fillId}`;
      this.book.post(Ledger.fill(txId, e.ts, { side: e.side, base, quote, price: e.price, qty: e.qty, fee: e.fee, feeAsset: quote }, e.clientOrderId));
      out.push({ kind: 'ledger', txId });
      this.feed({ kind: 'fill', ts: e.ts, clientOrderId: e.clientOrderId, fillId: e.fillId, side: e.side, price: e.price, qty: e.qty, fee: e.fee, feeAsset: 'quote' }, out);
      this.reconcile(e.ts, out);
    } else {
      this.feed({ kind: 'order', ts: e.ts, clientOrderId: e.clientOrderId, status: e.status }, out);
    }
  }

  /**
   * Shadow reconciliation: the exact ledger (decimal) is the source of truth; the strategy keeps
   * float balances. Any divergence beyond float noise means a bookkeeping bug → risk halt
   * (sticky until a human resets it). Emits output only on divergence.
   */
  private reconcile(ts: number, out: EngineOutput[]): void {
    if (this.reconcileDiverged) return;
    const diffs = this.ledgerDiffs();
    if (diffs.length === 0) return;
    this.reconcileDiverged = true;
    out.push({ kind: 'reconcile', ts, ok: false, diffs });
    this.feedHealth(ts, out);
  }

  private ledgerDiffs(): Array<{ asset: string; ledger: string; strategy: number }> {
    const { base, quote } = this.o.config;
    const s = this.strategy.snapshot();
    const diffs: Array<{ asset: string; ledger: string; strategy: number }> = [];
    for (const [asset, mine] of [[quote, s.quoteTotal], [base, s.baseTotal]] as const) {
      const l = this.book.balance(`cash:${asset}`, asset);
      if (Math.abs(l.toNumber() - mine) > RECONCILE_TOL * Math.max(1, Math.abs(mine))) diffs.push({ asset, ledger: l.toFixed(), strategy: mine });
    }
    return diffs;
  }

  /** One observation per window: MTM equity return in bps (includes inventory — no survivorship bias). */
  private edgeTick(ts: number, out: EngineOutput[]): void {
    const eq = this.strategy.snapshot().equity;
    if (eq === undefined) return;
    if (!this.windowStart) {
      this.windowStart = { ts, equity: eq };
      return;
    }
    if (ts - this.windowStart.ts < this.edgeWindowMs) return;
    const returnBps = (eq / this.windowStart.equity - 1) * 1e4;
    this.edge.update(returnBps);
    const v = this.edge.verdict();
    out.push({ kind: 'edge', ts, hourStartEquity: this.windowStart.equity, hourEndEquity: eq, returnBps, n: this.edge.n, pGo: v.pGo, pPositive: v.pPositive, verdict: v.verdict });
    this.windowStart = { ts, equity: eq };
  }
}
