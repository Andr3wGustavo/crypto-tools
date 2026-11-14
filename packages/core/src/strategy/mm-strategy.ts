import { AverageCostPosition } from '../accounting/position';
import { DEFAULT_AS_PARAMS, computeAsQuote } from '../quoting/avellaneda';
import { QuoteSanityError, buildQuoteOrders, sellableQty, type BookTop, type OrderTarget, type Side } from '../quoting/quote-builder';
import { snapQty } from '../quoting/tick';
import { DEFAULT_RISK_LIMITS, evaluateRisk, type RiskAction, type RiskViolation } from '../risk/risk-manager';
import { DEFAULT_LEAD_LAG, LeadLagModel } from '../signals/lead-lag';
import { DEFAULT_MARKOUTS, MarkoutTracker } from '../signals/markouts';
import { DEFAULT_VOL_PARAMS, VolEstimator } from '../stats/vol';
import { makeClientOrderId, strategyTag, nextStatus, type OrderStatus } from '../orders/fsm';
import type { BookEvent, BotStatus, StrategyAction, StrategyConfig, StrategyEvent } from './types';

interface WorkingOrder {
  clientOrderId: string;
  side: Side;
  price: number;
  priceStr: string;
  qty: number;
  filled: number;
  status: OrderStatus;
  createdTs: number;
}

const DAY_MS = 86_400_000;
/** A risk state that persists is repeated at most this often (it is evaluated every second). */
export const RISK_REPEAT_MS = 60_000;
/** The strategy's inventory cap as a fraction of the risk manager's hard cap. */
export const INVENTORY_CAP_MARGIN = 0.9;
const EPS = 1e-12;

export function defaultStrategyConfig(overrides: Partial<StrategyConfig> & Pick<StrategyConfig, 'botId' | 'base' | 'quote' | 'rules'>): StrategyConfig {
  return {
    as: DEFAULT_AS_PARAMS,
    makerFeeBps: 0,
    orderFraction: 0.15,
    minOrderMultiple: 1.1,
    maxInventoryFraction: 0.2,
    requote: { minIntervalMs: 250, thresholdBps: 1.5, maxAgeMs: 30_000 },
    inventoryDecay: { startMs: 60_000, fullMs: 15 * 60_000, minEdgeBpsAtFull: -5 },
    pennyMinSpreadTicks: 3,
    maxDeviationBps: 300,
    cashBufferPct: 0.01,
    sampleIntervalMs: 1_000,
    vol: DEFAULT_VOL_PARAMS,
    leadLag: DEFAULT_LEAD_LAG,
    markouts: DEFAULT_MARKOUTS,
    risk: DEFAULT_RISK_LIMITS,
    ...overrides,
  };
}

/**
 * Market-making strategy as a deterministic state machine: handle(event) → actions.
 * No clock reads, no randomness, no I/O. Replay, shadow and live run this exact code;
 * only the executor that consumes the actions differs.
 */
export class MarketMakerStrategy {
  private readonly tag: string;
  private seq = 0;
  private status: BotStatus = 'running';
  private haltRule: string | undefined;
  private riskPaused = false;
  private reduceOnly = false;
  /** Last risk state emitted (action + rules) and when: risk events are emitted on change. */
  private riskSig = 'ok';
  private riskSigTs = Number.NEGATIVE_INFINITY;
  /** Live only (see StrategyEvent 'venue'); always null in shadow. */
  private venueHold: string | null = null;

  private localBook: (BookTop & { ts: number }) | undefined;
  private lastFair = 0;
  private lastMid = 0;

  private quoteTotal: number;
  private baseTotal: number;
  private readonly position = new AverageCostPosition();
  private inventorySince: number | undefined;

  private readonly orders = new Map<string, WorkingOrder>();
  private lastQuoteTs = Number.NEGATIVE_INFINITY;
  private lastSampleTs = Number.NEGATIVE_INFINITY;

  private startEquity: number | undefined;
  private peakEquity = 0;
  private dayStartEquity = 0;
  private dayKey = -1;
  private health = { errorsLastMin: 0, eventLoopLagMs: 0, clockSkewMs: 0, reconcileDiverged: false };

  private readonly vol: VolEstimator;
  private readonly leadLag: LeadLagModel;
  private readonly markouts: MarkoutTracker;

  constructor(
    readonly cfg: StrategyConfig,
    initial: { quote: number; base: number },
  ) {
    this.tag = strategyTag(cfg);
    this.quoteTotal = initial.quote;
    this.baseTotal = initial.base;
    this.vol = new VolEstimator(cfg.vol);
    this.leadLag = new LeadLagModel(cfg.leadLag);
    this.markouts = new MarkoutTracker(cfg.markouts);
  }

  handle(e: StrategyEvent): StrategyAction[] {
    const out: StrategyAction[] = [];
    switch (e.kind) {
      case 'book':
        this.onBook(e, out);
        break;
      case 'order':
        this.onOrder(e, out);
        this.quote(e.ts, out, false);
        break;
      case 'fill':
        this.onFill(e, out);
        this.checkRisk(e.ts, out);
        this.quote(e.ts, out, true);
        break;
      case 'timer':
        this.checkRisk(e.ts, out);
        this.quote(e.ts, out, false);
        break;
      case 'health':
        this.health = { errorsLastMin: e.errorsLastMin, eventLoopLagMs: e.eventLoopLagMs, clockSkewMs: e.clockSkewMs, reconcileDiverged: e.reconcileDiverged };
        this.checkRisk(e.ts, out);
        break;
      case 'balances':
        // Authoritative totals from the exchange (live reconciliation).
        this.quoteTotal = e.quote;
        this.baseTotal = e.base;
        break;
      case 'command':
        this.onCommand(e.ts, e.command, out);
        break;
      case 'venue':
        this.onVenue(e.ts, e.hold, out);
        break;
      case 'transfer':
        this.onTransfer(e, out);
        break;
    }
    return out;
  }

  // ------------------------------------------------------------------ events

  private onBook(e: BookEvent, out: StrategyAction[]): void {
    const mid = (e.bid + e.ask) / 2;
    if (!(mid > 0) || e.bid >= e.ask) return; // crossed/invalid book: ignore
    if (e.venue === 'reference') {
      this.leadLag.onReference(e.ts, mid, this.vol.sigmaBps());
      const tox = this.leadLag.toxicity(e.ts);
      if (tox.toxic) {
        // Pull the side that would be picked off, immediately (bypasses the re-quote throttle).
        const vulnerable: Side = tox.direction === 'up' ? 'SELL' : 'BUY';
        for (const o of this.orders.values()) {
          if (o.side === vulnerable && o.status !== 'CANCEL_REQ') this.cancel(e.ts, o, 'toxic_flow', out);
        }
      }
      return;
    }
    this.localBook = { bid: e.bid, bidQty: e.bidQty, ask: e.ask, askQty: e.askQty, ts: e.ts };
    this.lastMid = mid;
    this.vol.onPrice(e.ts, mid);
    this.leadLag.onLocal(e.ts, mid);
    this.lastFair = this.leadLag.fair(e.ts, mid).fair;
    for (const m of this.markouts.onMid(e.ts, this.lastFair)) out.push({ kind: 'markout', ...m });
    this.quote(e.ts, out, false);
  }

  private onOrder(e: Extract<StrategyEvent, { kind: 'order' }>, out: StrategyAction[]): void {
    const o = this.orders.get(e.clientOrderId);
    if (!o) return;
    const ev = e.status === 'NEW' ? 'ack' : e.status === 'CANCELED' ? 'canceled' : e.status === 'REJECTED' ? 'rejected' : e.status === 'UNKNOWN' ? 'timeout' : 'expired';
    try {
      o.status = nextStatus(o.status, ev);
    } catch (err) {
      out.push({ kind: 'error', ts: e.ts, message: (err as Error).message });
      // The exchange is the source of truth: an order it reports as gone IS gone. Keeping it as
      // a phantom in CANCEL_REQ would freeze that side forever (no new quote while a cancel is in
      // flight). Any other surprising report keeps the order, which stays fail-closed.
      if (ev === 'canceled' || ev === 'rejected' || ev === 'expired') this.orders.delete(o.clientOrderId);
      return;
    }
    if (o.status === 'CANCELED' || o.status === 'REJECTED' || o.status === 'EXPIRED') this.orders.delete(o.clientOrderId);
  }

  private onFill(e: Extract<StrategyEvent, { kind: 'fill' }>, out: StrategyAction[]): void {
    const feeQuote = e.feeAsset === 'quote' ? e.fee : 0;
    const feeBase = e.feeAsset === 'base' ? e.fee : 0;
    const notional = e.price * e.qty;
    // Base quantities are exchange decimals: keep the running total decimal-exact (12 places),
    // as the ledger is. A float residue (0.01999999999999999 for 0.02) made the 0.02 unsellable
    // while the dust check still saw 0.02: the bot froze (AFK review 2026-11-13).
    if (e.side === 'BUY') {
      this.quoteTotal -= notional + feeQuote;
      this.baseTotal = snapQty(this.baseTotal + e.qty - feeBase);
      if (this.inventorySince === undefined) this.inventorySince = e.ts;
    } else {
      this.quoteTotal += notional - feeQuote;
      this.baseTotal = snapQty(this.baseTotal - e.qty - feeBase);
    }
    if (this.baseTotal < EPS) {
      this.baseTotal = Math.max(0, this.baseTotal);
      this.inventorySince = undefined;
    }
    try {
      this.position.onFill({ side: e.side, price: e.price, qty: e.qty, fee: e.fee, feeIn: e.feeAsset });
    } catch (err) {
      out.push({ kind: 'error', ts: e.ts, message: (err as Error).message });
    }
    this.markouts.addFill({ id: e.fillId, side: e.side, price: e.price, ts: e.ts, mid: this.lastFair });
    const o = this.orders.get(e.clientOrderId);
    if (o) {
      o.filled += e.qty;
      const done = o.filled >= o.qty - EPS;
      o.status = nextStatus(o.status, done ? 'fill' : 'partial_fill');
      if (o.status === 'FILLED') this.orders.delete(o.clientOrderId);
    }
  }

  private onCommand(ts: number, cmd: 'pause' | 'resume' | 'reset_halt' | 'reset_kill', out: StrategyAction[]): void {
    if (cmd === 'pause' && this.status === 'running') this.setStatus(ts, 'paused', 'manual_pause', out);
    else if (cmd === 'resume' && this.status === 'paused') this.setStatus(ts, 'running', 'manual_resume', out);
    else if (cmd === 'reset_halt' && this.status === 'halted') {
      this.peakEquity = this.equity();
      this.haltRule = undefined;
      this.setStatus(ts, 'running', 'manual_reset_halt', out);
    } else if (cmd === 'reset_kill' && this.status === 'killed') {
      // Never straight back to running: a human must also issue `resume`.
      this.startEquity = this.equity();
      this.peakEquity = this.startEquity;
      this.setStatus(ts, 'paused', 'manual_reset_kill', out);
    }
    this.quote(ts, out, true);
  }

  private onVenue(ts: number, hold: string | null, out: StrategyAction[]): void {
    if (hold === this.venueHold) return;
    this.venueHold = hold;
    out.push({ kind: 'status', ts, status: this.status, quoting: this.canQuote(), reason: hold === null ? 'venue_ok' : `venue_hold:${hold}` });
    this.quote(ts, out, true);
  }

  private onTransfer(e: Extract<StrategyEvent, { kind: 'transfer' }>, out: StrategyAction[]): void {
    if (!Number.isFinite(e.quote) || this.quoteTotal + e.quote < -EPS) {
      out.push({ kind: 'error', ts: e.ts, message: `transfer ${e.quote} refused (quote ${this.quoteTotal})` });
      return;
    }
    this.quoteTotal = Math.max(0, this.quoteTotal + e.quote);
    // Moving money is not a gain or a loss: shift every equity reference by the same amount.
    if (this.startEquity !== undefined) this.startEquity += e.quote;
    this.peakEquity += e.quote;
    this.dayStartEquity += e.quote;
    this.quote(e.ts, out, true);
  }

  // ------------------------------------------------------------------ risk

  private equity(): number {
    return this.quoteTotal + this.baseTotal * (this.lastFair || this.lastMid);
  }

  private checkRisk(ts: number, out: StrategyAction[]): void {
    if (!this.localBook || !(this.lastFair > 0)) return;
    const equity = this.equity();
    if (this.startEquity === undefined) {
      this.startEquity = equity;
      this.peakEquity = equity;
    }
    const day = Math.floor(ts / DAY_MS);
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.dayStartEquity = equity;
      if (this.status === 'halted' && this.haltRule === 'daily_loss') {
        this.haltRule = undefined;
        this.setStatus(ts, 'running', 'new_utc_day', out);
      }
    }
    if (equity > this.peakEquity) this.peakEquity = equity;
    const d = evaluateRisk(this.cfg.risk, {
      equity,
      peakEquity: this.peakEquity,
      dayStartEquity: this.dayStartEquity,
      startEquity: this.startEquity,
      inventoryNotional: this.baseTotal * this.lastFair,
      tickerAgeMs: ts - this.localBook.ts,
      ...this.health,
    });
    this.applyRisk(ts, d.action, d.violations, out);
  }

  private applyRisk(ts: number, action: RiskAction, violations: RiskViolation[], out: StrategyAction[]): void {
    // Emit on change (including the return to ok), and repeat a persisting state once a minute:
    // evaluated every second, an hour-long pause would otherwise flood the event log with 3 600
    // identical events and push the useful history out of the capped stream.
    const sig = action === 'ok' ? 'ok' : `${action}:${violations.map((v) => v.rule).sort().join(',')}`;
    if (sig !== this.riskSig || (action !== 'ok' && ts - this.riskSigTs >= RISK_REPEAT_MS)) {
      out.push({ kind: 'risk', ts, action, violations });
      this.riskSig = sig;
      this.riskSigTs = ts;
    }
    this.reduceOnly = action === 'reduce_only';
    if (action === 'kill' && this.status !== 'killed') {
      this.setStatus(ts, 'killed', violations.map((v) => v.rule).join(','), out);
    } else if (action === 'halt' && (this.status === 'running' || this.status === 'paused')) {
      this.haltRule = violations.find((v) => v.severity === 'halt')?.rule;
      this.setStatus(ts, 'halted', this.haltRule ?? 'halt', out);
    }
    const wasPaused = this.riskPaused;
    this.riskPaused = action === 'pause';
    if (this.riskPaused && !wasPaused) this.cancelAll(ts, 'risk_pause', out);
  }

  private setStatus(ts: number, s: BotStatus, reason: string, out: StrategyAction[]): void {
    if (this.status === s) return;
    this.status = s;
    out.push({ kind: 'status', ts, status: s, quoting: this.canQuote(), reason });
    if (!this.canQuote()) this.cancelAll(ts, reason, out);
  }

  private canQuote(): boolean {
    return this.status === 'running' && !this.riskPaused && this.venueHold === null;
  }

  // ------------------------------------------------------------------ quoting

  private quote(ts: number, out: StrategyAction[], force: boolean): void {
    if (!this.canQuote()) {
      this.cancelAll(ts, 'not_quoting', out);
      return;
    }
    const book = this.localBook;
    if (!book || !(this.lastFair > 0)) return;
    if (ts - book.ts > this.cfg.risk.maxTickerAgeMs) {
      this.cancelAll(ts, 'stale_book', out);
      return;
    }
    if (!force && ts - this.lastQuoteTs < this.cfg.requote.minIntervalMs) return;
    this.lastQuoteTs = ts;

    const fair = this.lastFair;
    const equity = this.equity();
    const orderNotional = Math.max(this.cfg.rules.minNotional * this.cfg.minOrderMultiple, this.cfg.orderFraction * equity);
    // The strategy's own cap stays 10% under the risk manager's hard cap: otherwise, once equity
    // grows, the bot buys up to 20% of equity, trips reduce_only at the fixed limit and flaps as
    // the price wiggles around it. The margin absorbs a 10% mark-to-market rise of a full position.
    const maxInv = Math.min(Math.max(orderNotional, this.cfg.maxInventoryFraction * equity), INVENTORY_CAP_MARGIN * this.cfg.risk.maxInventoryNotional);
    const invNotional = this.baseTotal * fair;
    const q = Math.min(1, Math.max(0, invNotional / maxInv));
    const sigmaBps = this.vol.sigmaBps();
    const asBps = this.markouts.adverseSelectionBps();
    const costBps = this.cfg.makerFeeBps + asBps;
    const tox = this.leadLag.toxicity(ts);

    const asq = computeAsQuote(this.cfg.as, { fair, sigmaBps, q, costBps });

    // Balances available to the *replacement* orders: exclude locks of orders still pending cancel.
    let quoteLocked = 0;
    let baseLocked = 0;
    for (const o of this.orders.values()) {
      // Pending cancel, or unknown (live): may still rest on the book, so its funds are not free.
      if (o.status !== 'CANCEL_REQ' && o.status !== 'UNKNOWN') continue;
      const rem = o.qty - o.filled;
      if (o.side === 'BUY') quoteLocked += rem * o.price;
      else baseLocked += rem;
    }
    const age = this.inventorySince === undefined ? 0 : ts - this.inventorySince;
    const d = this.cfg.inventoryDecay;
    const w = Math.min(1, Math.max(0, (age - d.startMs) / Math.max(1, d.fullMs - d.startMs)));
    const reduceMinEdgeBps = costBps + w * (d.minEdgeBpsAtFull - costBps);

    // Bid size: the room left under the inventory cap, so the cap is hard and a partial fill never
    // blocks the bid entirely. Dead zone (AFK deadlock, found in the 2026-11-13 review): inventory
    // too small to sell (under the exchange minimum after step rounding) AND too close to the cap to
    // buy a full order — the bot would never quote again. Then one minimum order is allowed so the
    // position becomes sellable; the cap is exceeded by at most one minimum order (+ one step).
    const minOrderValue = this.cfg.rules.minNotional * this.cfg.minOrderMultiple;
    const baseFree = Math.max(0, this.baseTotal - baseLocked);
    const sellable = Number(sellableQty(baseFree, this.cfg.rules.stepSize)) * fair >= this.cfg.rules.minNotional;
    const dust = this.baseTotal > EPS && !sellable;
    let bidNotional = Math.min(orderNotional, maxInv - invNotional);
    let capBlocksBid = bidNotional < minOrderValue - EPS;
    if (capBlocksBid && dust) {
      bidNotional = minOrderValue;
      capBlocksBid = false;
    }

    let build;
    try {
      build = buildQuoteOrders(
        asq,
        book,
        this.cfg.rules,
        { quoteFree: Math.max(0, this.quoteTotal - quoteLocked), baseFree },
        {
          orderNotional,
          bidNotional,
          // Normal mode: the cap is hard, rounding up to the minimum may not cross it. Dust mode
          // may cross it by the one minimum order that makes the position sellable.
          ...(dust ? {} : { bidNotionalMax: maxInv - invNotional }),
          costBps,
          reduceMinEdgeBps,
          pennyMinSpreadTicks: this.cfg.pennyMinSpreadTicks,
          maxDeviationBps: this.cfg.maxDeviationBps,
          cashBufferPct: this.cfg.cashBufferPct,
        },
        {
          pullBid: tox.toxic && tox.direction === 'down',
          pullAsk: tox.toxic && tox.direction === 'up',
          noBid: this.reduceOnly || capBlocksBid,
        },
      );
    } catch (err) {
      if (err instanceof QuoteSanityError) {
        // Fail-closed: a sanity failure means a bug or corrupted input. Stop and wait for a human.
        out.push({ kind: 'error', ts, message: err.message });
        this.haltRule = 'quote_sanity';
        this.setStatus(ts, 'halted', 'quote_sanity', out);
        return;
      }
      throw err;
    }

    this.reconcileSide(ts, 'BUY', build.bid, out);
    this.reconcileSide(ts, 'SELL', build.ask, out);

    if (ts - this.lastSampleTs >= this.cfg.sampleIntervalMs) {
      this.lastSampleTs = ts;
      out.push({
        kind: 'sample', ts, fair, mid: this.lastMid,
        ...(build.bid ? { bid: Number(build.bid.price) } : {}),
        ...(build.ask ? { ask: Number(build.ask.price) } : {}),
        halfSpreadBps: asq.halfSpreadBps, skewBps: asq.skewBps, sigmaBps, asBps, q, toxic: tox.toxic,
        equity, inventoryQty: this.baseTotal, quoteBalance: this.quoteTotal,
        realizedPnl: this.position.realizedPnl, unrealizedPnl: this.position.unrealizedPnl(fair),
      });
    }
  }

  /** Keep, replace (cancel now, re-place after the cancel is confirmed) or place the order on one side. */
  private reconcileSide(ts: number, side: Side, target: OrderTarget | undefined, out: StrategyAction[]): void {
    const onSide = [...this.orders.values()].filter((o) => o.side === side);
    // Never double-expose while a cancel is in flight, or while an order's state is unknown (live).
    if (onSide.some((o) => o.status === 'CANCEL_REQ' || o.status === 'UNKNOWN')) return;
    const current = onSide[0];
    if (!target) {
      if (current) this.cancel(ts, current, 'no_target', out);
      return;
    }
    if (current) {
      const diffBps = (Math.abs(current.price - Number(target.price)) / this.lastFair) * 1e4;
      const stale = ts - current.createdTs >= this.cfg.requote.maxAgeMs;
      if ((current.priceStr !== target.price && diffBps >= this.cfg.requote.thresholdBps) || stale) {
        this.cancel(ts, current, stale ? 'max_age' : 'reprice', out);
      }
      return;
    }
    const clientOrderId = makeClientOrderId(this.tag, this.seq++, side);
    this.orders.set(clientOrderId, {
      clientOrderId, side, price: Number(target.price), priceStr: target.price,
      qty: Number(target.qty), filled: 0, status: nextStatus('INTENT', 'send'), createdTs: ts,
    });
    out.push({ kind: 'place', ts, clientOrderId, side, price: target.price, qty: target.qty });
  }

  private cancel(ts: number, o: WorkingOrder, reason: string, out: StrategyAction[]): void {
    // UNKNOWN (live): there is no order we know of to cancel; the live engine queries it and the
    // venue-level cancel-all / reconciler removes it if it does rest.
    if (o.status === 'CANCEL_REQ' || o.status === 'UNKNOWN') return;
    o.status = nextStatus(o.status, 'cancel_request');
    out.push({ kind: 'cancel', ts, clientOrderId: o.clientOrderId, reason });
  }

  private cancelAll(ts: number, reason: string, out: StrategyAction[]): void {
    for (const o of this.orders.values()) this.cancel(ts, o, reason, out);
  }

  // ------------------------------------------------------------------ introspection

  /** One working order (copy), for the live engine's mapping of exchange events. */
  workingOrder(clientOrderId: string): Readonly<WorkingOrder> | undefined {
    const o = this.orders.get(clientOrderId);
    return o ? { ...o } : undefined;
  }

  snapshot() {
    return {
      status: this.status,
      quoting: this.canQuote(),
      haltRule: this.haltRule,
      reduceOnly: this.reduceOnly,
      venueHold: this.venueHold,
      fair: this.lastFair,
      mid: this.lastMid,
      quoteTotal: this.quoteTotal,
      baseTotal: this.baseTotal,
      equity: this.lastFair > 0 ? this.equity() : undefined,
      startEquity: this.startEquity,
      peakEquity: this.peakEquity,
      realizedPnl: this.position.realizedPnl,
      unrealizedPnl: this.lastFair > 0 ? this.position.unrealizedPnl(this.lastFair) : 0,
      sigmaBps: this.vol.sigmaBps(),
      adverseSelectionBps: this.markouts.adverseSelectionBps(),
      markoutsObserved: this.markouts.observed,
      workingOrders: [...this.orders.values()].map((o) => ({ ...o })),
      seq: this.seq,
    };
  }
}
