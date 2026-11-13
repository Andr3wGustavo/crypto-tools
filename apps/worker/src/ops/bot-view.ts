import { SERIES_STEP_MS, type BotEvent, type BotView, type SeriesPoint, type TreasuryView } from '@cortex/shared';
import type { EngineOutput, InputRecord, ShadowEngine } from '../engine/shadow-engine';
import type { LiveEngine, LiveInputRecord, LiveOutput } from '../live/live-engine';

/** What the view reads from an engine (shadow and live expose the same read side; live adds the treasury). */
export type ViewableEngine = Pick<ShadowEngine, 'strategy' | 'edge' | 'recordCount' | 'fillCount'> & Partial<Pick<LiveEngine, 'treasuryView'>>;

/** Live treasury → wire view (exact decimals become display numbers; the last 20 withdrawals). */
export function treasuryWire(t: ReturnType<LiveEngine['treasuryView']>, wallet: string | null): TreasuryView {
  return {
    asset: t.asset, cash: Number(t.cash), treasury: Number(t.treasury), withdrawing: Number(t.withdrawing), withdrawn: Number(t.withdrawn),
    skimmed: Number(t.skimmed), principal: t.principal, wallet,
    withdrawals: t.withdrawals.slice(-20).reverse().map((w) => ({
      id: w.id, amount: Number(w.amount), status: w.status, createdTs: w.createdTs, updatedTs: w.updatedTs,
      fee: w.fee !== undefined ? Number(w.fee) : null, txId: w.txId ?? null, reason: w.reason ?? null,
    })),
  };
}

/**
 * Maps the engine's internal state and outputs to the dashboard wire contracts in
 * @cortex/shared. This is the only place that knows both sides. It reads the engine and never
 * feeds it, so nothing here can change a trading decision or the replay digest.
 */
export interface BotIdentity {
  botId: string;
  mode: 'shadow' | 'live';
  symbol: string;
  base: string;
  quote: string;
  run: string;
  version: string;
  startedAt: number;
  /** Live: public address of the on-chain treasury wallet (display only). */
  treasuryWallet?: string | null;
}

export interface FeedAges {
  mexcAgeMs: number | null;
  binanceAgeMs: number | null;
}

const finite = (x: number | undefined | null): number | null => (x !== undefined && x !== null && Number.isFinite(x) ? x : null);
const positive = (x: number | undefined | null): number | null => (finite(x) !== null && (x as number) > 0 ? (x as number) : null);

/** Engine output → wire event (undefined = not shown: samples and ledger ids). */
export function toWireEvent(o: EngineOutput | LiveOutput): BotEvent | undefined {
  if (o.kind === 'exec_fill') {
    const e = o.event;
    return { k: 'fill', ts: e.ts, fillId: e.fillId, clientOrderId: e.clientOrderId, side: e.side, price: e.price, qty: e.qty, fee: e.fee, feeAsset: e.feeAsset };
  }
  if (o.kind === 'exec_warning') return { k: 'error', ts: o.ts, message: o.message };
  if (o.kind === 'request' || o.kind === 'sync' || o.kind === 'withdraw_request') return undefined; // I/O plumbing, logged by the live process
  if (o.kind === 'treasury') return { k: 'treasury', ts: o.ts, skim: Number(o.skim), treasury: Number(o.treasury) };
  if (o.kind === 'withdrawal') {
    const w = o.w;
    return { k: 'withdrawal', ts: o.ts, id: w.id, status: w.status, amount: Number(w.amount), fee: w.fee !== undefined ? Number(w.fee) : null, txId: w.txId ?? null, reason: w.reason ?? null };
  }
  if (o.kind === 'sim') {
    const e = o.event;
    if (e.kind === 'fill') return { k: 'fill', ts: e.ts, fillId: e.fillId, clientOrderId: e.clientOrderId, side: e.side, price: e.price, qty: e.qty, fee: e.fee, feeAsset: e.feeAsset };
    return undefined; // order acks: the strategy's own place/cancel actions already describe them
  }
  if (o.kind === 'reconcile') return { k: 'reconcile', ts: o.ts, ok: o.ok, diffs: o.diffs.length };
  if (o.kind === 'edge') return { k: 'edge', ts: o.ts, returnBps: o.returnBps, n: o.n, pGo: o.pGo, pPositive: o.pPositive, verdict: o.verdict };
  if (o.kind !== 'action') return undefined;
  const a = o.action;
  switch (a.kind) {
    case 'place':
      return { k: 'order', ts: a.ts, op: 'place', clientOrderId: a.clientOrderId, side: a.side, price: a.price, qty: a.qty };
    case 'cancel':
      return { k: 'order', ts: a.ts, op: 'cancel', clientOrderId: a.clientOrderId, reason: a.reason };
    case 'status':
      return { k: 'status', ts: a.ts, status: a.status, quoting: a.quoting, reason: a.reason };
    case 'risk':
      return { k: 'risk', ts: a.ts, action: a.action, violations: a.violations.map((v) => `${v.rule}: ${v.message}`) };
    case 'error':
      return { k: 'error', ts: a.ts, message: a.message };
    case 'markout':
      return { k: 'markout', ts: a.ts, fillId: a.fillId, horizonMs: a.horizonMs, bps: a.bps };
    default:
      return undefined; // 'sample': summarised by the view and the chart series instead
  }
}

export function toWireEvents(outs: ReadonlyArray<EngineOutput | LiveOutput>): BotEvent[] {
  const r: BotEvent[] = [];
  for (const o of outs) {
    const e = toWireEvent(o);
    if (e) r.push(e);
  }
  return r;
}

/**
 * Observes the inputs and outputs next to the engine, to show what the engine does not expose:
 * the reference mid, the venue's best bid/ask, the last quote sample and the process health.
 */
export class BotViewBuilder {
  private refMid: number | null = null;
  private bestBid: number | null = null;
  private bestAsk: number | null = null;
  private halfSpreadBps: number | null = null;
  private toxic = false;
  private health = { errorsLastMin: 0, eventLoopLagMs: 0, clockSkewMs: 0 };
  private lastTs = 0;
  private lastStep = Number.NEGATIVE_INFINITY;

  constructor(readonly id: BotIdentity, private readonly stepMs = SERIES_STEP_MS) {}

  observe(r: InputRecord | LiveInputRecord, outs: ReadonlyArray<EngineOutput | LiveOutput>): void {
    this.lastTs = r.ts;
    if (r.t === 'book') {
      if (r.venue === 'reference') this.refMid = positive((r.bid + r.ask) / 2);
      else {
        this.bestBid = positive(r.bid);
        this.bestAsk = positive(r.ask);
      }
    } else if (r.t === 'health') {
      this.health = { errorsLastMin: r.errorsLastMin, eventLoopLagMs: r.eventLoopLagMs, clockSkewMs: r.clockSkewMs };
    }
    for (const o of outs) {
      if (o.kind === 'action' && o.action.kind === 'sample') {
        this.halfSpreadBps = finite(o.action.halfSpreadBps);
        this.toxic = o.action.toxic;
      }
    }
  }

  view(engine: ViewableEngine, feeds: FeedAges): BotView {
    const s = engine.strategy.snapshot();
    const edge = engine.edge.state;
    const v = engine.edge.verdict();
    let quoteBid: number | null = null;
    let quoteAsk: number | null = null;
    for (const o of s.workingOrders) {
      if (o.side === 'BUY') quoteBid = quoteBid === null ? o.price : Math.max(quoteBid, o.price);
      else quoteAsk = quoteAsk === null ? o.price : Math.min(quoteAsk, o.price);
    }
    return {
      v: 1,
      botId: this.id.botId,
      venue: 'mexc',
      mode: this.id.mode,
      symbol: this.id.symbol,
      base: this.id.base,
      quote: this.id.quote,
      run: this.id.run,
      version: this.id.version,
      startedAt: this.id.startedAt,
      ts: this.lastTs,
      status: s.status,
      quoting: s.quoting,
      haltRule: s.haltRule ?? null,
      reduceOnly: s.reduceOnly,
      market: {
        mid: positive(s.mid), fair: positive(s.fair), refMid: this.refMid, bestBid: this.bestBid, bestAsk: this.bestAsk,
        quoteBid, quoteAsk, halfSpreadBps: this.halfSpreadBps, toxic: this.toxic,
      },
      balances: { quote: s.quoteTotal, base: s.baseTotal },
      pnl: { equity: finite(s.equity), startEquity: finite(s.startEquity), peakEquity: finite(s.peakEquity), realized: s.realizedPnl, unrealized: s.unrealizedPnl },
      risk: { sigmaBps: s.sigmaBps, adverseSelectionBps: s.adverseSelectionBps, markoutsObserved: s.markoutsObserved },
      orders: s.workingOrders.map((o) => ({ clientOrderId: o.clientOrderId, side: o.side, price: o.priceStr, qty: o.qty, filled: o.filled, status: o.status, createdTs: o.createdTs })),
      edge: { n: edge.n, meanBps: edge.mean, sdBps: edge.n > 1 ? Math.sqrt(edge.m2 / (edge.n - 1)) : 0, pGo: v.pGo, pPositive: v.pPositive, verdict: v.verdict },
      counters: { records: engine.recordCount, fills: engine.fillCount },
      feeds: { mexcAgeMs: finite(feeds.mexcAgeMs), binanceAgeMs: finite(feeds.binanceAgeMs) },
      health: { ...this.health },
      ...(engine.treasuryView ? { treasury: treasuryWire(engine.treasuryView(), this.id.treasuryWallet ?? null) } : {}),
    };
  }

  /** A chart point when the engine clock enters a new step (at most one per step), else undefined. */
  point(view: BotView): SeriesPoint | undefined {
    const step = Math.floor(view.ts / this.stepMs);
    if (!(view.ts > 0) || step <= this.lastStep) return undefined;
    this.lastStep = step;
    return {
      ts: view.ts, mid: view.market.mid, fair: view.market.fair, refMid: view.market.refMid,
      quoteBid: view.market.quoteBid, quoteAsk: view.market.quoteAsk, equity: view.pnl.equity, inventory: view.balances.base,
    };
  }
}
