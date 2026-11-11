import {
  Ledger, MarketMakerStrategy, NigEstimator, SimExecutor,
  type SimEvent, type StrategyAction, type StrategyConfig,
} from '@cortex/core';

/**
 * Everything the engine consumes is an input record. Time is data too (`clock` records), so a
 * recording replayed through this engine reproduces every decision bit-for-bit.
 */
export type InputRecord =
  | { t: 'book'; venue: 'local' | 'reference'; ts: number; bid: number; bidQty: number; ask: number; askQty: number }
  | { t: 'trade'; ts: number; price: number; qty: number; aggressor: 'buy' | 'sell' }
  | { t: 'clock'; ts: number };

export type EngineOutput =
  | { kind: 'action'; action: StrategyAction }
  | { kind: 'sim'; event: SimEvent }
  | { kind: 'ledger'; txId: string }
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
 * Shadow mode: real public market data → strategy → conservative simulated exchange → strategy.
 * Also keeps the exact double-entry ledger and the hourly-MTM Bayesian edge estimate.
 */
export class ShadowEngine {
  readonly strategy: MarketMakerStrategy;
  readonly sim: SimExecutor;
  readonly ledger = new Ledger();
  readonly edge = new NigEstimator();
  private nextTimer = Number.NEGATIVE_INFINITY;
  private windowStart: { ts: number; equity: number } | undefined;
  private fills = 0;
  private readonly timerMs: number;
  private readonly edgeWindowMs: number;

  constructor(private readonly o: ShadowEngineOptions) {
    this.strategy = new MarketMakerStrategy(o.config, { quote: o.startQuote, base: 0 });
    this.sim = new SimExecutor({ latencyMs: o.latencyMs, makerFeeRate: o.makerFeeRate });
    this.timerMs = o.timerMs ?? 1_000;
    this.edgeWindowMs = o.edgeWindowMs ?? 3_600_000;
    this.ledger.post(Ledger.deposit('deposit-0', 0, o.config.quote, o.startQuote));
  }

  get fillCount(): number {
    return this.fills;
  }

  process(r: InputRecord): EngineOutput[] {
    const out: EngineOutput[] = [];
    this.sim.advance(r.ts).forEach((e) => this.onSim(e, out));
    if (r.ts >= this.nextTimer) {
      this.nextTimer = r.ts + this.timerMs;
      this.feed({ kind: 'timer', ts: r.ts }, out);
      this.edgeTick(r.ts, out);
    }
    if (r.t === 'book') {
      if (r.venue === 'local') {
        const book = { bid: r.bid, bidQty: r.bidQty, ask: r.ask, askQty: r.askQty };
        this.sim.onBook(r.ts, book).forEach((e) => this.onSim(e, out));
      }
      this.feed({ kind: 'book', venue: r.venue, ts: r.ts, bid: r.bid, bidQty: r.bidQty, ask: r.ask, askQty: r.askQty }, out);
    } else if (r.t === 'trade') {
      this.sim.onTrade({ ts: r.ts, price: r.price, qty: r.qty, aggressor: r.aggressor }).forEach((e) => this.onSim(e, out));
    }
    return out;
  }

  command(ts: number, command: 'pause' | 'resume' | 'reset_halt' | 'reset_kill'): EngineOutput[] {
    const out: EngineOutput[] = [];
    this.feed({ kind: 'command', ts, command }, out);
    return out;
  }

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

  private onSim(e: SimEvent, out: EngineOutput[]): void {
    out.push({ kind: 'sim', event: e });
    if (e.kind === 'fill') {
      this.fills++;
      const { base, quote } = this.o.config;
      const txId = `fill-${e.fillId}`;
      this.ledger.post(Ledger.fill(txId, e.ts, { side: e.side, base, quote, price: e.price, qty: e.qty, fee: e.fee, feeAsset: quote }, e.clientOrderId));
      out.push({ kind: 'ledger', txId });
      this.feed({ kind: 'fill', ts: e.ts, clientOrderId: e.clientOrderId, fillId: e.fillId, side: e.side, price: e.price, qty: e.qty, fee: e.fee, feeAsset: 'quote' }, out);
    } else {
      this.feed({ kind: 'order', ts: e.ts, clientOrderId: e.clientOrderId, status: e.status }, out);
    }
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
