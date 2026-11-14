import crypto from 'node:crypto';
import {
  BN, DEFAULT_TREASURY, Ledger, MarketMakerStrategy, NigEstimator, TreasuryPolicy, WITHDRAWAL_TERMINAL, WithdrawalTransitionError,
  canonicalJson, captureState, nextWithdrawalStatus, restoreState, strategyTag, withdrawalId,
  type LedgerTransaction, type OrderStatus, type SimEvent, type StrategyConfig, type WithdrawalRecord,
} from '@cortex/core';
import type { ExecEvent } from '@cortex/exchange';
import { ENGINE_BEHAVIOR_VERSION, type EngineOutput, type EngineSnapshot, type InputRecord } from '../engine/shadow-engine';

/**
 * Live inputs = the shadow inputs (market, clock, health, commands) plus everything the exchange
 * told us, as data: execution events (user stream + REST replies), user-stream state, and
 * reconciliation snapshots. Recorded like every other input, so a live session replays exactly.
 */
export type LiveInputRecord =
  | InputRecord
  | { t: 'exec'; ts: number; e: ExecEvent }
  | { t: 'stream'; ts: number; up: boolean; reason?: string }
  /**
   * REST snapshot taken by the reconciler AFTER injecting recent fills: open orders + balances.
   * `epoch` echoes the request: a snapshot from before the latest stream change is stale.
   */
  | { t: 'sync'; ts: number; epoch: number; open: Array<{ clientOrderId: string; orderId: string }>; balances: Record<string, { free: string; locked: string }> }
  /** The withdrawer's answer about one withdrawal request (see withdraw/withdrawer.ts). */
  | { t: 'withdraw'; ts: number; id: string; status: 'SENT' | 'CONFIRMED' | 'FAILED'; amount?: string; fee?: string; exchangeId?: string; txId?: string; reason?: string };

/**
 * Ask the withdrawer about a withdrawal: `submit` it (only while every lock still passes),
 * report its `status`, or `abort` it (never submitted => refused forever and reported FAILED).
 * Re-sent periodically until the withdrawal is final: delivery is at-least-once, answers idempotent.
 */
export interface WithdrawRequest {
  kind: 'withdraw_request';
  ts: number;
  id: string;
  asset: string;
  amount: string;
  createdTs: number;
  mode: 'submit' | 'status' | 'abort';
}

export type LiveRequest =
  | { kind: 'request'; ts: number; op: 'query' | 'cancel'; clientOrderId: string; reason: string }
  | { kind: 'request'; ts: number; op: 'cancel_all' | 'trades'; reason: string }
  | { kind: 'request'; ts: number; op: 'sync'; epoch: number; reason: string };

export type LiveOutput =
  | EngineOutput
  | LiveRequest
  | { kind: 'sync'; ts: number; ok: boolean; reason: string; diffs: Array<{ asset: string; ledger: string; exchange: string }> }
  | { kind: 'exec_warning'; ts: number; message: string }
  /** A booked exchange fill, in the same shape as a simulated one (dashboard, alerts, fills page). */
  | { kind: 'exec_fill'; event: Omit<Extract<SimEvent, { kind: 'fill' }>, 'feeAsset'> & { feeAsset: 'quote' | 'base'; tradeId: string; isMaker: boolean } }
  /** An order status the exchange reported and the strategy was told (persistence, audit). */
  | { kind: 'order_status'; ts: number; clientOrderId: string; status: OrderStatus; reason?: string }
  | WithdrawRequest
  /** A withdrawal was created or changed status. */
  | { kind: 'withdrawal'; ts: number; w: WithdrawalRecord }
  /** Profit moved cash -> treasury. Amounts are exact decimals in the quote asset. */
  | { kind: 'treasury'; ts: number; skim: string; treasury: string; withdrawing: string; skimmed: string; withdrawn: string };

export interface LiveTreasuryOptions {
  /** Share of confirmed profit that stays in cash and compounds (the rest goes to the treasury). */
  reinvestRatio?: number;
  /** Smallest skim (quote units); skims are rounded down to this step. */
  skimStep?: number;
  /** Auto-withdrawal of the treasury. Absent => the treasury only accumulates. */
  withdraw?: {
    minAmount: number;
    dailyCap: number;
    cooldownMs?: number;
    /** Never withdraw while equity is more than this fraction below its peak. */
    maxDrawdown?: number;
    /** Network minimum + fee (the withdrawer re-checks the exchange's live values). */
    networkMin?: number;
    networkFee?: number;
    /** Re-ask the withdrawer about an unfinished withdrawal this often. */
    askEveryMs?: number;
  };
}

export interface LiveEngineOptions {
  config: StrategyConfig;
  /** Capital this bot may trade (D1: US$15). More quote than this ×1.1 on the account at opening ⇒ refuse. */
  capitalQuote: number;
  timerMs?: number;
  edgeWindowMs?: number;
  /** Re-query an UNKNOWN order at most this often. */
  queryEveryMs?: number;
  /** A SENT or CANCEL_REQ order with no outcome for this long becomes UNKNOWN (and is queried). */
  outcomeTimeoutMs?: number;
  /** Periodic reconciliation. */
  syncEveryMs?: number;
  /** While a sync is needed, re-request it this often (a lost request must not stall the bot). */
  resyncEveryMs?: number;
  /** Orders younger than this are not judged by a sync (their place may still be in flight). */
  syncGraceMs?: number;
  rateLimitHoldMs?: number;
  clockHoldMs?: number;
  /** Ledger vs exchange tolerance (absolute). Default: quote 0.001, base half a step. */
  balanceTol?: { quote: number; base: number };
  treasury?: LiveTreasuryOptions;
}

/** Treasury options with defaults filled in (part of the configuration hash). */
export function treasuryIdentity(t: LiveTreasuryOptions | undefined) {
  const w = t?.withdraw;
  return {
    reinvestRatio: t?.reinvestRatio ?? DEFAULT_TREASURY.reinvestRatio,
    skimStep: t?.skimStep ?? 0.01,
    withdraw: w ? {
      minAmount: w.minAmount, dailyCap: w.dailyCap, cooldownMs: w.cooldownMs ?? 24 * 3_600_000, maxDrawdown: w.maxDrawdown ?? 0.02,
      networkMin: w.networkMin ?? 0, networkFee: w.networkFee ?? 0, askEveryMs: w.askEveryMs ?? 60_000,
    } : null,
  };
}

/** 2: treasury skim + withdrawals (E9). */
export const LIVE_ENGINE_VERSION = 2;

export function liveConfigHash(o: LiveEngineOptions): string {
  const id = {
    mode: 'live', v: ENGINE_BEHAVIOR_VERSION, live: LIVE_ENGINE_VERSION, config: o.config, capitalQuote: o.capitalQuote,
    timerMs: o.timerMs ?? 1_000, edgeWindowMs: o.edgeWindowMs ?? 3_600_000, treasury: treasuryIdentity(o.treasury),
  };
  return crypto.createHash('sha256').update(canonicalJson(id)).digest('hex');
}

type Dec = InstanceType<typeof BN>;
const RECONCILE_TOL = 1e-9;
const EPS = 1e-12;
const ORDER_ID_MEMORY = 2_000;
const PRE_OPEN_TRADE_MEMORY = 1_000;
const SKIP = ['o', 'book', 'configHash', 'symbol', 'ourPrefix', 'policy', 'tcfg'] as const;
const SKIM_EVERY_MS = 60_000;
const KEEP_FINAL_WITHDRAWALS = 50;
type StrategyView = ReturnType<MarketMakerStrategy['snapshot']>;
const OPEN_ORDER: ReadonlySet<string> = new Set(['NEW', 'PARTIALLY_FILLED']);

/**
 * Live engine: the same deterministic strategy, ledger and edge estimate as shadow, with the
 * simulator replaced by the real exchange. It performs no I/O: it emits the strategy's place /
 * cancel actions plus `request` outputs (query, cancel, cancel-all, sync, trades) for the I/O
 * layer, and consumes the answers as input records.
 *
 * Fail-closed rules, in order of precedence (the first that applies is the venue hold):
 *   fatal (auth, foreign activity, unsupported fee asset, start inventory/capital) — sticky until
 *   a human resets the halt · not opened yet · user stream down · re-syncing · rate limited · clock.
 * Any hold ⇒ the strategy cancels everything and does not quote.
 *
 * The exchange is the source of truth: balances must match the ledger on two consecutive syncs,
 * otherwise the sticky reconciliation halt fires (same mechanism as shadow).
 *
 * Treasury (E9): confirmed profit is skimmed cash -> treasury (the strategy never trades it), and
 * the treasury is withdrawn to the owner's wallet through the withdrawal FSM, with the reserve
 * debited before the request and restored only on a definitive failure. On the exchange,
 * cash + treasury + withdrawing is one quote balance; while a withdrawal is in flight the sync
 * accepts that balance anywhere between "not yet debited" and "debited".
 */
export class LiveEngine {
  readonly strategy: MarketMakerStrategy;
  readonly edge = new NigEstimator();
  readonly configHash: string;
  private book = new Ledger();
  private readonly symbol: string;
  private readonly ourPrefix: string;
  private nextTimer = Number.NEGATIVE_INFINITY;
  private windowStart: { ts: number; equity: number } | undefined;
  private fills = 0;
  private lastTs = Number.NEGATIVE_INFINITY;
  private records = 0;
  private health = { errorsLastMin: 0, eventLoopLagMs: 0, clockSkewMs: 0 };
  private reconcileDiverged = false;
  private opened = false;
  /** Trades seen before opening: already inside the opening balances, never booked (bounded). */
  private preOpenTrades = new Set<string>();
  private streamUp = false;
  private syncPending = true;
  private rateHoldUntil = Number.NEGATIVE_INFINITY;
  private clockHoldUntil = Number.NEGATIVE_INFINITY;
  private fatal: string | null = null;
  private hold: string | null = null;
  private divergentSyncs = 0;
  private nextSync = Number.NEGATIVE_INFINITY;
  private lastMid = 0;
  private streamEpoch = 0;
  private lastSyncRequest = Number.NEGATIVE_INFINITY;
  private readonly orderIds = new Map<string, string>();
  private readonly lastQuery = new Map<string, number>();
  /** When we last asked the exchange to place / cancel each order (outcome timeout). */
  private readonly requestedAt = new Map<string, number>();
  // ---- treasury (E9)
  private readonly policy: TreasuryPolicy;
  private readonly tcfg: ReturnType<typeof treasuryIdentity>;
  /** Quote value deposited at opening: equity at or above it means every treasury unit is profit. */
  private principal: number | undefined;
  /** Exact total ever skimmed cash -> treasury (includes what was withdrawn since). */
  private skimmed = '0';
  private nextSkim = Number.NEGATIVE_INFINITY;
  private skims = 0;
  private wdSeq = 0;
  private withdrawals: WithdrawalRecord[] = [];
  private lastWithdrawAsk = Number.NEGATIVE_INFINITY;
  private lastSyncOkTs = Number.NEGATIVE_INFINITY;

  constructor(private readonly o: LiveEngineOptions) {
    this.strategy = new MarketMakerStrategy(o.config, { quote: o.capitalQuote, base: 0 });
    this.configHash = liveConfigHash(o);
    this.tcfg = treasuryIdentity(o.treasury);
    const w = this.tcfg.withdraw;
    this.policy = new TreasuryPolicy({
      ...DEFAULT_TREASURY,
      reinvestRatio: this.tcfg.reinvestRatio,
      promotion: { ...DEFAULT_TREASURY.promotion, enabled: false },
      withdrawal: w ? { minAmount: w.minAmount, cooldownMs: w.cooldownMs, dailyCap: w.dailyCap, floor: 0 } : DEFAULT_TREASURY.withdrawal,
    });
    this.symbol = `${o.config.base}${o.config.quote}`.toUpperCase();
    this.ourPrefix = `cf${strategyTag(o.config)}`;
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

  /** Current venue hold (null = quoting allowed by the venue layer). */
  get venueHold(): string | null {
    return this.hold;
  }

  get isOpened(): boolean {
    return this.opened;
  }

  /** Treasury buckets (exact decimals, quote asset) and the withdrawals still remembered. */
  treasuryView() {
    const q = this.o.config.quote;
    return {
      asset: q,
      cash: this.book.balance(`cash:${q}`, q).toFixed(),
      ...this.buckets(),
      principal: this.principal ?? null,
      withdrawals: this.withdrawals.map((w) => ({ ...w })),
    };
  }

  process(r: LiveInputRecord): LiveOutput[] {
    const out: LiveOutput[] = [];
    this.records++;
    this.lastTs = r.ts;
    if (this.opened && r.ts >= this.nextTimer) {
      this.nextTimer = r.ts + (this.o.timerMs ?? 1_000);
      this.feed({ kind: 'timer', ts: r.ts }, out);
      this.edgeTick(r.ts, out);
      this.periodic(r.ts, out);
      this.treasuryTick(r.ts, out);
    }
    switch (r.t) {
      case 'book':
        if (r.venue === 'local' && r.bid > 0 && r.ask > r.bid) this.lastMid = (r.bid + r.ask) / 2;
        // Before opening the strategy sees no prices: its start equity must be the real balance.
        if (this.opened) this.feed({ kind: 'book', venue: r.venue, ts: r.ts, bid: r.bid, bidQty: r.bidQty, ask: r.ask, askQty: r.askQty }, out);
        break;
      case 'trade':
      case 'clock':
        break;
      case 'health':
        this.health = { errorsLastMin: r.errorsLastMin, eventLoopLagMs: r.eventLoopLagMs, clockSkewMs: r.clockSkewMs };
        this.feedHealth(r.ts, out);
        break;
      case 'command':
        if (r.command === 'reset_halt' && this.fatal !== null) this.fatal = null;
        this.feed({ kind: 'command', ts: r.ts, command: r.command }, out);
        break;
      case 'stream':
        if (r.up !== this.streamUp) {
          this.streamEpoch++;
          this.streamUp = r.up;
          this.syncPending = true; // either way: nothing is trusted until a fresh sync
          if (!r.up) out.push({ kind: 'request', ts: r.ts, op: 'cancel_all', reason: `user stream down${r.reason ? `: ${r.reason}` : ''}` });
          else this.requestSync(r.ts, 'user stream up', out);
        }
        break;
      case 'exec':
        this.onExec(r.ts, r.e, out);
        break;
      case 'sync':
        this.onSync(r, out);
        break;
      case 'withdraw':
        this.onWithdraw(r, out);
        break;
    }
    if (this.syncPending && this.streamUp && r.ts - this.lastSyncRequest >= (this.o.resyncEveryMs ?? 15_000)) this.requestSync(r.ts, 'sync still needed', out);
    this.updateHold(r.ts, out);
    return out;
  }

  // ------------------------------------------------------------------ exchange events

  private onExec(ts: number, e: ExecEvent, out: LiveOutput[]): void {
    switch (e.kind) {
      case 'balance':
        return; // balances are judged only on syncs (stream pushes race with fills)
      case 'venue':
        if (e.state === 'rate_limited') this.rateHoldUntil = Math.max(this.rateHoldUntil, ts + (this.o.rateLimitHoldMs ?? 10_000));
        else if (e.state === 'clock') this.clockHoldUntil = Math.max(this.clockHoldUntil, ts + (this.o.clockHoldMs ?? 30_000));
        else this.setFatal('auth', ts, out);
        return;
      case 'ack': {
        this.learn(e.orderId, e.clientOrderId);
        const wo = this.strategy.workingOrder(e.clientOrderId);
        if (wo && wo.status !== 'PARTIAL') this.feed({ kind: 'order', ts, clientOrderId: e.clientOrderId, status: 'NEW' }, out);
        return;
      }
      case 'reject': {
        const wo = this.strategy.workingOrder(e.clientOrderId);
        if (!wo) return;
        if (e.op === 'place') {
          // Refused ⇒ never existed. If a cancel was already requested, it is simply moot.
          const status = wo.status === 'CANCEL_REQ' ? 'CANCELED' : 'REJECTED';
          if (wo.status === 'SENT' || wo.status === 'UNKNOWN' || wo.status === 'CANCEL_REQ') this.feed({ kind: 'order', ts, clientOrderId: e.clientOrderId, status, reason: e.reason }, out);
          return;
        }
        // A refused cancel leaves the order's state unknown: ask the exchange.
        this.unknown(ts, e.clientOrderId, `cancel refused: ${e.reason}`, out);
        return;
      }
      case 'unknown':
        if (this.strategy.workingOrder(e.clientOrderId)) this.unknown(ts, e.clientOrderId, `${e.op}: ${e.detail}`, out);
        return;
      case 'missing': {
        const wo = this.strategy.workingOrder(e.clientOrderId);
        if (!wo) return;
        if (wo.filled > EPS) {
          out.push({ kind: 'exec_warning', ts, message: `exchange has no record of ${e.clientOrderId} but it has fills: re-syncing` });
          this.resync(ts, 'missing order with fills', out);
        }
        this.feed({ kind: 'order', ts, clientOrderId: e.clientOrderId, status: 'CANCELED', reason: 'not_on_exchange' }, out);
        this.lastQuery.delete(e.clientOrderId);
        return;
      }
      case 'order':
        return this.onOrder(ts, e, out);
      case 'fill':
        return this.onFill(ts, e, out);
    }
  }

  private onOrder(ts: number, e: Extract<ExecEvent, { kind: 'order' }>, out: LiveOutput[]): void {
    if (e.symbol && e.symbol !== this.symbol) return; // another pair on the account
    const cid = e.clientOrderId || this.orderIds.get(e.orderId) || '';
    if (!this.isOurs(cid)) {
      if (OPEN_ORDER.has(e.status)) this.setFatal('foreign_order', ts, out, `order ${e.orderId} (${cid || 'no client id'}) on ${this.symbol}`);
      return;
    }
    this.learn(e.orderId, cid);
    const wo = this.strategy.workingOrder(cid);
    if (!wo) {
      // Ours but unknown to the strategy (e.g. placed just before a crash): never leave it resting.
      if (OPEN_ORDER.has(e.status)) out.push({ kind: 'request', ts, op: 'cancel', clientOrderId: cid, reason: 'orphan order' });
      return;
    }
    const filledOnExchange = Number(e.cumQty);
    if (e.source === 'rest' && filledOnExchange > wo.filled + EPS) out.push({ kind: 'request', ts, op: 'trades', reason: `fills missing for ${cid}` });
    switch (e.status) {
      case 'NEW':
      case 'PARTIALLY_FILLED':
      case 'FILLED':
        // Exists on the exchange. Quantities move only with fills (deduplicated by trade id).
        if (wo.status === 'SENT' || wo.status === 'UNKNOWN') this.feed({ kind: 'order', ts, clientOrderId: cid, status: 'NEW' }, out);
        if (wo.status === 'UNKNOWN' || e.source === 'rest') this.lastQuery.delete(cid);
        return;
      case 'CANCELED':
      case 'PARTIALLY_CANCELED':
        this.feed({ kind: 'order', ts, clientOrderId: cid, status: 'CANCELED' }, out);
        this.lastQuery.delete(cid);
        return;
      case 'UNKNOWN':
        this.unknown(ts, cid, `exchange status code ${e.statusCode ?? '?'}`, out);
        return;
    }
  }

  private onFill(ts: number, e: Extract<ExecEvent, { kind: 'fill' }>, out: LiveOutput[]): void {
    if (e.symbol && e.symbol !== this.symbol) return;
    // Before opening the strategy has no order (boot cancels all first), so a trade seen now is
    // older activity — e.g. the previous run's last fills, returned by the 15-minute trade
    // lookback — and the opening balances already contain it. It is never booked, now or later.
    if (!this.opened) {
      if (this.preOpenTrades.size < PRE_OPEN_TRADE_MEMORY) this.preOpenTrades.add(e.tradeId);
      return;
    }
    if (this.preOpenTrades.has(e.tradeId)) return;
    const cid = e.clientOrderId || this.orderIds.get(e.orderId) || '';
    if (cid && !this.isOurs(cid)) {
      this.setFatal('foreign_fill', ts, out, `trade ${e.tradeId} of ${cid} on ${this.symbol}`);
    } else if (!cid) {
      out.push({ kind: 'exec_warning', ts, message: `fill ${e.tradeId} of unknown order ${e.orderId}: booked, re-syncing` });
      this.resync(ts, 'fill of unknown order', out);
    }
    const { base, quote } = this.o.config;
    const fee = new BN(e.fee);
    let feeAsset: 'quote' | 'base' = 'quote';
    if (!fee.isZero()) {
      if (e.feeAsset === base.toUpperCase()) feeAsset = 'base';
      else if (e.feeAsset !== quote.toUpperCase()) {
        // A fee in a third asset (e.g. MX) is outside this ledger: stop and let a human decide.
        this.setFatal('fee_asset', ts, out, `fee ${e.fee} ${e.feeAsset}`);
      }
    }
    const feeKnown = fee.isZero() || feeAsset === 'base' || e.feeAsset === quote.toUpperCase();
    const txId = `fill-${e.tradeId}`;
    let posted: boolean;
    try {
      posted = this.book.post(Ledger.fill(txId, ts, { side: e.side, base, quote, price: e.price, qty: e.qty, fee: feeKnown ? e.fee : '0', feeAsset: feeAsset === 'base' ? base : quote }, cid || undefined));
    } catch (err) {
      // E.g. the fill would overdraw the ledger: the books no longer explain the exchange.
      out.push({ kind: 'exec_warning', ts, message: `fill ${e.tradeId} rejected by the ledger: ${(err as Error).message}` });
      this.diverge(ts, out, [quote, base]);
      return;
    }
    if (!posted) return; // same trade seen twice (stream + REST recovery)
    this.fills++;
    out.push({ kind: 'ledger', txId });
    out.push({
      kind: 'exec_fill',
      event: { kind: 'fill', ts, clientOrderId: cid, fillId: e.tradeId, tradeId: e.tradeId, side: e.side, price: Number(e.price), qty: Number(e.qty), fee: feeKnown ? fee.toNumber() : 0, feeAsset, isMaker: e.isMaker },
    });
    if (!e.isMaker) out.push({ kind: 'exec_warning', ts, message: `taker fill ${e.tradeId} on a post-only order` });
    this.feed({
      kind: 'fill', ts, clientOrderId: cid, fillId: e.tradeId, side: e.side, price: Number(e.price), qty: Number(e.qty),
      fee: feeKnown ? fee.toNumber() : 0, feeAsset,
    }, out);
    this.reconcile(ts, out);
  }

  private onSync(r: Extract<LiveInputRecord, { t: 'sync' }>, out: LiveOutput[]): void {
    const ts = r.ts;
    if (r.epoch !== this.streamEpoch) {
      // Taken before the stream last changed: events may be missing after it. Never trust it.
      out.push({ kind: 'sync', ts, ok: false, reason: `stale (epoch ${r.epoch} != ${this.streamEpoch})`, diffs: [] });
      return;
    }
    const { base, quote } = this.o.config;
    const total = (asset: string) => {
      const b = r.balances[asset.toUpperCase()] ?? r.balances[asset];
      return b ? new BN(b.free).plus(b.locked) : new BN(0);
    };

    // ---- orders
    const open = new Map(r.open.map((x) => [x.clientOrderId, x.orderId]));
    for (const [cid, orderId] of open) {
      if (!this.isOurs(cid)) {
        this.setFatal('foreign_order', ts, out, `open order ${orderId} (${cid || 'no client id'}) on ${this.symbol}`);
        continue;
      }
      this.learn(orderId, cid);
      if (!this.strategy.workingOrder(cid)) out.push({ kind: 'request', ts, op: 'cancel', clientOrderId: cid, reason: 'orphan order' });
    }
    const grace = this.o.syncGraceMs ?? 10_000;
    for (const wo of this.strategy.snapshot().workingOrders) {
      if (open.has(wo.clientOrderId) || wo.status === 'SENT' || ts - wo.createdTs < grace) continue;
      // Not open on the exchange: its fills (if any) were injected before this snapshot.
      this.feed({ kind: 'order', ts, clientOrderId: wo.clientOrderId, status: 'CANCELED', reason: 'not_open_on_exchange' }, out);
      this.lastQuery.delete(wo.clientOrderId);
    }

    // ---- balances
    const q = total(quote);
    const b = total(base);
    if (!this.opened) {
      if (!(this.lastMid > 0)) {
        out.push({ kind: 'sync', ts, ok: false, reason: 'no market price yet', diffs: [] });
        return; // re-requested by the resync timer
      }
      if (q.gt(this.o.capitalQuote * 1.1)) return this.setFatal('capital_exceeds', ts, out, `${q.toFixed()} ${quote} > configured capital ${this.o.capitalQuote}`);
      if (b.times(this.lastMid).gte(this.o.config.rules.minNotional)) return this.setFatal('inventory_at_start', ts, out, `${b.toFixed()} ${base} on the account`);
      this.book.post(Ledger.deposit('open-quote', ts, quote, q));
      if (!b.isZero()) this.book.post(Ledger.deposit('open-base', ts, base, b));
      this.feed({ kind: 'balances', ts, quote: q.toNumber(), base: b.toNumber() }, out);
      this.principal = q.plus(b.times(this.lastMid)).toNumber();
      this.lastSyncOkTs = ts;
      this.opened = true;
      this.syncPending = false;
      this.nextSync = ts + (this.o.syncEveryMs ?? 60_000);
      out.push({ kind: 'sync', ts, ok: true, reason: 'opened', diffs: [] });
      return;
    }
    const tol = this.o.balanceTol ?? { quote: 0.001, base: Number(this.o.config.rules.stepSize) / 2 };
    const diffs: Array<{ asset: string; ledger: string; exchange: string }> = [];
    for (const [asset, ex, t] of [[quote, q, tol.quote], [base, b, tol.base]] as const) {
      // On the exchange, cash + treasury + reserved withdrawals are one balance. A reserved
      // withdrawal may already be debited (or not yet): accept anything in between.
      const l = this.onExchange(asset);
      const inFlight = this.book.balance(`withdrawing:${asset}`, asset);
      const ok = ex.gte(l.minus(inFlight).minus(t)) && ex.lte(l.plus(t));
      if (!ok) diffs.push({ asset, ledger: inFlight.isZero() ? l.toFixed() : `${l.minus(inFlight).toFixed()}..${l.toFixed()}`, exchange: ex.toFixed() });
    }
    this.nextSync = ts + (this.o.syncEveryMs ?? 60_000);
    if (diffs.length === 0) {
      this.divergentSyncs = 0;
      this.syncPending = false;
      this.lastSyncOkTs = ts;
      out.push({ kind: 'sync', ts, ok: true, reason: 'balanced', diffs });
      return;
    }
    // A fill landing between the REST calls can make one snapshot disagree. Stop quoting, then
    // confirm on a quiet second snapshot; two in a row is a real divergence (sticky halt).
    this.divergentSyncs++;
    out.push({ kind: 'sync', ts, ok: false, reason: this.divergentSyncs >= 2 ? 'diverged' : 'mismatch, confirming', diffs });
    if (this.divergentSyncs >= 2) {
      this.diverge(ts, out, diffs.map((d) => d.asset));
    } else {
      this.resync(ts, 'balance mismatch', out);
    }
  }

  // ------------------------------------------------------------------ treasury (E9)

  private onExchange(asset: string): Dec {
    return this.book.balance(`cash:${asset}`, asset).plus(this.book.balance(`treasury:${asset}`, asset)).plus(this.book.balance(`withdrawing:${asset}`, asset));
  }

  /** Trading is healthy and the books were just confirmed by the exchange. */
  private quiet(ts: number): boolean {
    return this.opened && this.hold === null && this.fatal === null && !this.reconcileDiverged && !this.syncPending
      && ts - this.lastSyncOkTs <= 2.5 * (this.o.syncEveryMs ?? 60_000);
  }

  private treasuryTick(ts: number, out: LiveOutput[]): void {
    if (this.principal === undefined) return;
    const s = this.strategy.snapshot();
    if (ts >= this.nextSkim && this.quiet(ts) && s.status === 'running' && s.equity !== undefined) {
      this.nextSkim = ts + SKIM_EVERY_MS;
      this.skim(ts, s, out);
    }
    this.withdrawTick(ts, this.strategy.snapshot(), out);
  }

  private skim(ts: number, s: StrategyView, out: LiveOutput[]): void {
    const quote = this.o.config.quote;
    // Quote committed to resting buys must stay in cash (a fill would otherwise overdraw it).
    let committed = 0;
    for (const wo of s.workingOrders) if (wo.side === 'BUY') committed += (wo.qty - wo.filled) * wo.price;
    const skimmed = Number(this.skimmed);
    const due = this.policy.skimDue({
      realizedPnl: s.realizedPnl, profitToDate: s.equity! + skimmed - this.principal!, skimmed,
      spare: s.quoteTotal - committed, step: this.tcfg.skimStep,
    });
    if (!(due > 0)) return;
    const amount = new BN(due).decimalPlaces(8, BN.ROUND_DOWN);
    const id = `skim-${this.skims + 1}`;
    try {
      this.book.post(Ledger.transfer(id, ts, 'treasury_split', 'cash', 'treasury', quote, amount));
    } catch (err) {
      out.push({ kind: 'exec_warning', ts, message: `skim ${amount.toFixed()} refused by the ledger: ${(err as Error).message}` });
      return;
    }
    this.skims++;
    this.skimmed = new BN(this.skimmed).plus(amount).toFixed();
    out.push({ kind: 'ledger', txId: id });
    this.feed({ kind: 'transfer', ts, quote: -amount.toNumber(), reason: 'treasury_skim' }, out);
    // The edge measures trading returns: a transfer is not one.
    if (this.windowStart) this.windowStart = { ts: this.windowStart.ts, equity: this.windowStart.equity - amount.toNumber() };
    out.push({ kind: 'treasury', ts, skim: amount.toFixed(), ...this.buckets() });
    this.reconcile(ts, out);
  }

  private buckets() {
    const q = this.o.config.quote;
    return {
      treasury: this.book.balance(`treasury:${q}`, q).toFixed(), withdrawing: this.book.balance(`withdrawing:${q}`, q).toFixed(),
      skimmed: this.skimmed, withdrawn: this.book.balance(`external:${q}`, q).toFixed(),
    };
  }

  /** The five locks (+ one withdrawal in flight at a time); see TreasuryPolicy.withdrawalDecision. */
  private withdrawLocks(ts: number, s: StrategyView) {
    const w = this.tcfg.withdraw!;
    const quote = this.o.config.quote;
    // Cooldown counts every attempt (a failure is retried a day later, never in a loop); the daily
    // cap counts only money that may actually have left.
    const counted = this.withdrawals.filter((x) => x.status !== 'FAILED');
    const last = this.withdrawals.length > 0 ? Math.max(...this.withdrawals.map((x) => x.createdTs)) : undefined;
    const equity = s.equity;
    const drawdownOk = equity !== undefined && s.peakEquity > 0 && 1 - equity / s.peakEquity <= w.maxDrawdown;
    return this.policy.withdrawalDecision(this.book.balance(`treasury:${quote}`, quote).toNumber(), {
      mode: 'live',
      halted: this.fatal !== null || this.reconcileDiverged || s.status !== 'running' || this.hold !== null,
      inFlight: this.withdrawals.some((x) => !WITHDRAWAL_TERMINAL.has(x.status)),
      reconcileOk: this.quiet(ts),
      // Cash equity at or above the principal => everything in the treasury is net profit.
      equityConfirmed: drawdownOk && equity !== undefined && this.principal !== undefined && equity >= this.principal,
      now: ts,
      ...(last !== undefined ? { lastWithdrawalTs: last } : {}),
      withdrawnLast24h: counted.filter((x) => ts - x.createdTs < 24 * 3_600_000).reduce((a, x) => a + Number(x.amount), 0),
      networkMin: w.networkMin,
      networkFee: w.networkFee,
    });
  }

  private withdrawTick(ts: number, s: StrategyView, out: LiveOutput[]): void {
    const w = this.tcfg.withdraw;
    const open = this.withdrawals.find((x) => !WITHDRAWAL_TERMINAL.has(x.status));
    if (open) {
      if (ts - this.lastWithdrawAsk < (w?.askEveryMs ?? 60_000)) return;
      this.lastWithdrawAsk = ts;
      // A PENDING one is submitted only while the safety locks still pass; otherwise it is aborted.
      let mode: WithdrawRequest['mode'] = 'status';
      if (open.status === 'PENDING') {
        const safety = new Set(['halted', 'reconcile_pending', 'equity_unconfirmed', 'not_live']);
        const blocking = w ? this.withdrawLocks(ts, s).reasons.filter((r) => safety.has(r)) : ['disabled'];
        mode = blocking.length === 0 ? 'submit' : 'abort';
      }
      out.push({ kind: 'withdraw_request', ts, id: open.id, asset: open.asset, amount: open.amount, createdTs: open.createdTs, mode });
      return;
    }
    if (!w || this.principal === undefined) return;
    const d = this.withdrawLocks(ts, s);
    if (!d.allowed) return;
    const quote = this.o.config.quote;
    const amount = new BN(d.amount).decimalPlaces(2, BN.ROUND_DOWN);
    if (!amount.gt(0)) return;
    const id = withdrawalId(strategyTag(this.o.config), this.wdSeq + 1);
    try {
      this.book.post(Ledger.transfer(`${id}-reserve`, ts, 'withdrawal_reserve', 'treasury', 'withdrawing', quote, amount));
    } catch (err) {
      out.push({ kind: 'exec_warning', ts, message: `withdrawal reserve refused by the ledger: ${(err as Error).message}` });
      return;
    }
    this.wdSeq++;
    const rec: WithdrawalRecord = { id, asset: quote, amount: amount.toFixed(), status: 'PENDING', createdTs: ts, updatedTs: ts };
    this.withdrawals.push(rec);
    this.lastWithdrawAsk = ts;
    out.push({ kind: 'ledger', txId: `${id}-reserve` });
    out.push({ kind: 'withdrawal', ts, w: { ...rec } });
    out.push({ kind: 'withdraw_request', ts, id, asset: quote, amount: rec.amount, createdTs: ts, mode: 'submit' });
  }

  private onWithdraw(r: Extract<LiveInputRecord, { t: 'withdraw' }>, out: LiveOutput[]): void {
    const ts = r.ts;
    const rec = this.withdrawals.find((x) => x.id === r.id);
    if (!rec) {
      out.push({ kind: 'exec_warning', ts, message: `withdrawer reported unknown withdrawal ${r.id} (${r.status})` });
      return;
    }
    let next: ReturnType<typeof nextWithdrawalStatus>;
    try {
      next = nextWithdrawalStatus(rec.status, r.status);
    } catch (err) {
      if (!(err instanceof WithdrawalTransitionError)) throw err;
      return this.setFatal('withdraw_conflict', ts, out, `${r.id}: ${err.message}`);
    }
    if (r.exchangeId) rec.exchangeId = r.exchangeId;
    if (r.txId) rec.txId = r.txId;
    if (next === 'same') return;
    const asset = rec.asset;
    if (next === 'CONFIRMED') {
      if (r.amount !== undefined && !new BN(r.amount).eq(rec.amount)) {
        return this.setFatal('withdraw_amount', ts, out, `${r.id}: exchange reports ${r.amount}, reserved ${rec.amount}`);
      }
      const fee = r.fee ?? '0';
      try {
        this.book.post(Ledger.withdrawal(`${rec.id}-settle`, ts, asset, rec.amount, fee, 'withdrawing'));
      } catch (err) {
        return this.setFatal('withdraw_settle', ts, out, `${r.id}: ${(err as Error).message}`);
      }
      rec.fee = new BN(fee).toFixed();
      out.push({ kind: 'ledger', txId: `${rec.id}-settle` });
    } else if (next === 'FAILED') {
      this.book.post(Ledger.transfer(`${rec.id}-release`, ts, 'withdrawal_release', 'withdrawing', 'treasury', asset, rec.amount));
      out.push({ kind: 'ledger', txId: `${rec.id}-release` });
    }
    rec.status = next;
    rec.updatedTs = ts;
    if (r.reason) rec.reason = r.reason;
    out.push({ kind: 'withdrawal', ts, w: { ...rec } });
    if (WITHDRAWAL_TERMINAL.has(next)) {
      this.nextSync = Math.min(this.nextSync, ts); // money moved: confirm the books on the next tick
      const done = this.withdrawals.filter((x) => WITHDRAWAL_TERMINAL.has(x.status));
      if (done.length > KEEP_FINAL_WITHDRAWALS) this.withdrawals = this.withdrawals.filter((x) => x !== done[0]);
    }
  }

  // ------------------------------------------------------------------ helpers

  private periodic(ts: number, out: LiveOutput[]): void {
    const every = this.o.queryEveryMs ?? 5_000;
    const timeout = this.o.outcomeTimeoutMs ?? 30_000;
    for (const wo of this.strategy.snapshot().workingOrders) {
      const asked = this.requestedAt.get(wo.clientOrderId) ?? wo.createdTs;
      if ((wo.status === 'SENT' || wo.status === 'CANCEL_REQ') && ts - asked >= timeout) {
        // No outcome for a request we made: we no longer know whether it happened.
        this.unknown(ts, wo.clientOrderId, `no outcome after ${timeout} ms`, out);
      } else if (wo.status === 'UNKNOWN' && ts - (this.lastQuery.get(wo.clientOrderId) ?? Number.NEGATIVE_INFINITY) >= every) {
        this.lastQuery.set(wo.clientOrderId, ts);
        out.push({ kind: 'request', ts, op: 'query', clientOrderId: wo.clientOrderId, reason: 'unknown order' });
      }
    }
    for (const m of [this.lastQuery, this.requestedAt]) for (const cid of m.keys()) if (!this.strategy.workingOrder(cid)) m.delete(cid);
    if (ts >= this.nextSync && !this.syncPending) {
      this.nextSync = ts + (this.o.syncEveryMs ?? 60_000);
      this.requestSync(ts, 'periodic', out);
    }
  }

  private unknown(ts: number, cid: string, why: string, out: LiveOutput[]): void {
    const wo = this.strategy.workingOrder(cid);
    if (!wo) return;
    if (wo.status !== 'UNKNOWN') this.feed({ kind: 'order', ts, clientOrderId: cid, status: 'UNKNOWN', reason: why }, out);
    this.requestedAt.delete(cid);
    this.lastQuery.set(cid, ts);
    out.push({ kind: 'request', ts, op: 'query', clientOrderId: cid, reason: why });
  }

  private resync(ts: number, reason: string, out: LiveOutput[]): void {
    if (!this.syncPending) this.requestSync(ts, reason, out);
    this.syncPending = true;
  }

  private requestSync(ts: number, reason: string, out: LiveOutput[]): void {
    this.lastSyncRequest = ts;
    out.push({ kind: 'request', ts, op: 'sync', epoch: this.streamEpoch, reason });
  }

  private setFatal(why: string, ts: number, out: LiveOutput[], detail?: string): void {
    if (this.fatal === null) {
      this.fatal = why;
      out.push({ kind: 'exec_warning', ts, message: `venue fatal: ${why}${detail ? ` (${detail})` : ''}` });
      out.push({ kind: 'request', ts, op: 'cancel_all', reason: `fatal: ${why}` });
    }
  }

  private updateHold(ts: number, out: LiveOutput[]): void {
    const h = this.fatal !== null ? `fatal:${this.fatal}`
      : !this.opened ? 'opening'
      : !this.streamUp ? 'stream_down'
      : this.syncPending ? 'syncing'
      : ts < this.rateHoldUntil ? 'rate_limited'
      : ts < this.clockHoldUntil ? 'clock'
      : null;
    if (h === this.hold) return;
    this.hold = h;
    this.feed({ kind: 'venue', ts, hold: h }, out);
  }

  private isOurs(cid: string): boolean {
    return cid.startsWith(this.ourPrefix);
  }

  private learn(orderId: string, cid: string): void {
    if (!orderId || !cid || this.orderIds.get(orderId) === cid) return;
    this.orderIds.set(orderId, cid);
    if (this.orderIds.size > ORDER_ID_MEMORY) this.orderIds.delete(this.orderIds.keys().next().value as string);
  }

  private feed(ev: Parameters<MarketMakerStrategy['handle']>[0], out: LiveOutput[]): void {
    if (ev.kind === 'order') out.push({ kind: 'order_status', ts: ev.ts, clientOrderId: ev.clientOrderId, status: ev.status, ...(ev.reason ? { reason: ev.reason } : {}) });
    for (const a of this.strategy.handle(ev)) {
      out.push({ kind: 'action', action: a });
      if (a.kind === 'place' || a.kind === 'cancel') this.requestedAt.set(a.clientOrderId, a.ts);
    }
  }

  private feedHealth(ts: number, out: LiveOutput[]): void {
    this.feed({ kind: 'health', ts, ...this.health, reconcileDiverged: this.reconcileDiverged }, out);
  }

  /** Sticky reconciliation halt (same mechanism as shadow). Reports ledger vs strategy for `assets`. */
  private diverge(ts: number, out: LiveOutput[], assets: string[]): void {
    if (this.reconcileDiverged) return;
    this.reconcileDiverged = true;
    const s = this.strategy.snapshot();
    const diffs = assets.map((asset) => ({
      asset, ledger: this.book.balance(`cash:${asset}`, asset).toFixed(), strategy: asset === this.o.config.quote ? s.quoteTotal : s.baseTotal,
    }));
    out.push({ kind: 'reconcile', ts, ok: false, diffs });
    this.feedHealth(ts, out);
  }

  /** Strategy float balances must follow the exact ledger (as in shadow). */
  private reconcile(ts: number, out: LiveOutput[]): void {
    if (this.reconcileDiverged) return;
    const { base, quote } = this.o.config;
    const s = this.strategy.snapshot();
    const diffs: Array<{ asset: string; ledger: string; strategy: number }> = [];
    for (const [asset, mine] of [[quote, s.quoteTotal], [base, s.baseTotal]] as const) {
      const l = this.book.balance(`cash:${asset}`, asset);
      if (Math.abs(l.toNumber() - mine) > RECONCILE_TOL * Math.max(1, Math.abs(mine))) diffs.push({ asset, ledger: l.toFixed(), strategy: mine });
    }
    if (diffs.length > 0) this.diverge(ts, out, diffs.map((d) => d.asset));
  }

  private edgeTick(ts: number, out: LiveOutput[]): void {
    const eq = this.strategy.snapshot().equity;
    if (eq === undefined) return;
    if (!this.windowStart) {
      this.windowStart = { ts, equity: eq };
      return;
    }
    if (ts - this.windowStart.ts < (this.o.edgeWindowMs ?? 3_600_000)) return;
    const returnBps = (eq / this.windowStart.equity - 1) * 1e4;
    this.edge.update(returnBps);
    const v = this.edge.verdict();
    out.push({ kind: 'edge', ts, hourStartEquity: this.windowStart.equity, hourEndEquity: eq, returnBps, n: this.edge.n, pGo: v.pGo, pPositive: v.pPositive, verdict: v.verdict });
    this.windowStart = { ts, equity: eq };
  }

  // ------------------------------------------------------------------ snapshot / restore

  snapshot(): EngineSnapshot {
    return {
      v: LIVE_STATE_VERSION,
      configHash: this.configHash,
      lastTs: this.lastTs,
      records: this.records,
      state: captureState(this, SKIP),
      ledger: this.book.transactions.map((t) => ({ ...t, postings: t.postings.map((p) => ({ ...p })) })),
    };
  }

  /**
   * Rebuilds the engine from a snapshot of the same configuration. A restart is NOT applied here
   * (that would make a resumed run differ from a replay of its recording): the live process
   * records `{t:'stream', up:false, reason:'restart'}` as its first input after boot, which holds
   * the engine until the stream is up and a fresh sync arrives.
   */
  static restore(o: LiveEngineOptions, s: EngineSnapshot): LiveEngine {
    const e = new LiveEngine(o);
    if (s.v !== LIVE_STATE_VERSION) throw new Error(`live snapshot version ${s.v} ≠ ${LIVE_STATE_VERSION}`);
    if (s.configHash !== e.configHash) throw new Error('snapshot belongs to a different configuration');
    restoreState(e, s.state as Parameters<typeof restoreState>[1], SKIP);
    e.book = new Ledger();
    for (const tx of s.ledger as LedgerTransaction[]) e.book.post(tx);
    if (e.records !== s.records || e.lastTs !== s.lastTs) throw new Error('snapshot header does not match its state');
    return e;
  }
}

/** 2: treasury fields (E9). */
export const LIVE_STATE_VERSION = 4; // v3: strategy risk-emission state (2026-11-13); v4: pre-open trades (2026-11-14)
