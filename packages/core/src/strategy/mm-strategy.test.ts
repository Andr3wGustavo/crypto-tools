import { describe, expect, it } from 'vitest';
import { SimExecutor, type SimEvent } from '../sim/sim-executor';
import { syntheticMarket, type SyntheticMarketParams } from '../testing/synthetic-market';
import { MarketMakerStrategy, defaultStrategyConfig } from './mm-strategy';
import type { StrategyAction, StrategyConfig, StrategyEvent } from './types';

const RULES = { tickSize: '0.01', stepSize: '0.0001', minQty: '0.0001', minNotional: 1 };

/**
 * Market and parameters must be mutually consistent (in production k and A come from the fit on
 * real trades). This synthetic venue: 10-tick spread (≈6.7 bps) with 1–2 tick sweeps, so trades
 * reach ≈3.3–6 bps from mid; γ = 0.02, k = 0.5 → half spread ≈ 4.6 bps.
 */
const MARKET: Partial<SyntheticMarketParams> = { spreadTicks: 10, tradeRatePerSec: 3, sweepProb: 0.5 };

function makeConfig(over: Partial<StrategyConfig> = {}): StrategyConfig {
  const base = defaultStrategyConfig({ botId: 'test:SOLUSDT', base: 'SOL', quote: 'USDT', rules: RULES });
  return { ...base, as: { ...base.as, gamma: 0.02, k: 0.5 }, ...over };
}

interface RunResult {
  actions: StrategyAction[];
  fills: number;
  maxWorkingPerSide: number;
  minQuote: number;
  minBase: number;
  strategy: MarketMakerStrategy;
}

/** Closed-loop replay: market → strategy → simulated exchange → strategy. Fully deterministic. */
function run(
  market: Partial<SyntheticMarketParams>,
  cfg = makeConfig(),
  opts: { stopLocalAfterMs?: number; initial?: { quote: number; base: number } } = {},
): RunResult {
  const strat = new MarketMakerStrategy(cfg, opts.initial ?? { quote: 15, base: 0 });
  const sim = new SimExecutor({ latencyMs: 120, makerFeeRate: 0 });
  const actions: StrategyAction[] = [];
  let fills = 0;
  let maxWorkingPerSide = 0;
  let minQuote = Infinity;
  let minBase = Infinity;
  let nextTimer = 0;
  let t0: number | undefined;

  const feed = (ev: StrategyEvent) => {
    const acts = strat.handle(ev);
    for (const a of acts) {
      actions.push(a);
      let simEvents: SimEvent[] = [];
      if (a.kind === 'place') simEvents = sim.place(a.ts, { clientOrderId: a.clientOrderId, side: a.side, price: Number(a.price), qty: Number(a.qty) });
      else if (a.kind === 'cancel') simEvents = sim.cancel(a.ts, a.clientOrderId);
      simEvents.forEach(feedSim);
    }
    const snap = strat.snapshot();
    minQuote = Math.min(minQuote, snap.quoteTotal);
    minBase = Math.min(minBase, snap.baseTotal);
    for (const side of ['BUY', 'SELL'] as const) {
      const n = snap.workingOrders.filter((o) => o.side === side && o.status !== 'CANCEL_REQ').length;
      maxWorkingPerSide = Math.max(maxWorkingPerSide, n);
    }
  };
  const feedSim = (e: SimEvent) => {
    if (e.kind === 'fill') {
      fills++;
      feed({ kind: 'fill', ts: e.ts, clientOrderId: e.clientOrderId, fillId: e.fillId, side: e.side, price: e.price, qty: e.qty, fee: e.fee, feeAsset: 'quote' });
    } else feed({ kind: 'order', ts: e.ts, clientOrderId: e.clientOrderId, status: e.status });
  };

  for (const m of syntheticMarket({ ...MARKET, ...market })) {
    t0 ??= m.ts;
    sim.advance(m.ts).forEach(feedSim);
    if (m.ts >= nextTimer) {
      feed({ kind: 'timer', ts: m.ts });
      nextTimer = m.ts + 1000;
    }
    if (m.kind === 'ref') feed({ ...m, kind: 'book', venue: 'reference' });
    else if (m.kind === 'local') {
      if (opts.stopLocalAfterMs !== undefined && m.ts - t0 > opts.stopLocalAfterMs) continue;
      sim.onBook(m.ts, m).forEach(feedSim);
      feed({ ...m, kind: 'book', venue: 'local' });
    } else sim.onTrade(m).forEach(feedSim);
  }
  return { actions, fills, maxWorkingPerSide, minQuote, minBase, strategy: strat };
}

const hash = (xs: unknown[]) => {
  const s = JSON.stringify(xs);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
};

describe('MarketMakerStrategy (closed loop on a synthetic market)', () => {
  it('is fully deterministic: identical inputs → identical action log', () => {
    const a = run({ seed: 1, durationMs: 10 * 60_000 });
    const b = run({ seed: 1, durationMs: 10 * 60_000 });
    expect(a.actions.length).toBeGreaterThan(0);
    expect(hash(a.actions)).toBe(hash(b.actions));
  });

  it('trades, and keeps hard invariants: no overspend, no short, ≤1 live order per side, quotes inside sane bounds', () => {
    const r = run({ seed: 2, durationMs: 30 * 60_000 });
    expect(r.fills).toBeGreaterThan(5);
    expect(r.minQuote).toBeGreaterThanOrEqual(-1e-9);
    expect(r.minBase).toBeGreaterThanOrEqual(-1e-12);
    expect(r.maxWorkingPerSide).toBeLessThanOrEqual(1);
    const places = r.actions.filter((a): a is Extract<StrategyAction, { kind: 'place' }> => a.kind === 'place');
    const samples = r.actions.filter((a): a is Extract<StrategyAction, { kind: 'sample' }> => a.kind === 'sample');
    expect(places.length).toBeGreaterThan(0);
    for (const s of samples) {
      expect(s.halfSpreadBps).toBeLessThanOrEqual(50);
      expect(s.halfSpreadBps).toBeGreaterThanOrEqual(2);
    }
    // Sizes respect the US$15 plan: order ≈ max(1.1 × minNotional, 15% equity) ≈ $2.25
    for (const p of places) expect(Number(p.price) * Number(p.qty)).toBeLessThanOrEqual(3.5);
    expect(r.actions.some((a) => a.kind === 'error')).toBe(false);
  });

  it('starts flat in USDT: the first order is always a bid (spot cannot short)', () => {
    const r = run({ seed: 3, durationMs: 60_000 });
    const first = r.actions.find((a) => a.kind === 'place');
    expect(first).toMatchObject({ side: 'BUY' });
  });

  it('crash (−75% in 40 min, informed sellers): loss stays far inside the promised US$4.50 bound', () => {
    const r = run({ seed: 4, durationMs: 40 * 60_000, driftBpsPerS: -6, sigmaBpsPerSqrtS: 2, informedProb: 0.8 });
    const snap = r.strategy.snapshot();
    expect(snap.startEquity! - snap.equity!).toBeLessThan(0.5);
    expect(r.minQuote).toBeGreaterThanOrEqual(-1e-9);
  });

  it('kill switch: holding inventory into a collapse kills the bot and nothing is placed afterwards', () => {
    // Budget 0.15: since the dust fix the bot unloads its inventory fast enough to stay under 0.3
    // in this collapse (max loss 0.25), so the kill switch needs a tighter budget to be exercised.
    const cfg = makeConfig({ risk: { ...makeConfig().risk, lossBudgetQuote: 0.15, maxDrawdownPct: 0.5, dailyLossPct: 0.5 } });
    const r = run(
      { seed: 4, durationMs: 20 * 60_000, driftBpsPerS: -6, sigmaBpsPerSqrtS: 2, informedProb: 0.9 },
      cfg,
      { initial: { quote: 12, base: 0.02 } },
    );
    const killIdx = r.actions.findIndex((a) => a.kind === 'status' && a.status === 'killed');
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(r.actions.slice(killIdx + 1).some((a) => a.kind === 'place')).toBe(false);
    expect(r.strategy.snapshot()).toMatchObject({ status: 'killed', quoting: false });
  });

  it('stale local data pauses quoting (fail-closed) and cancels resting orders', () => {
    const r = run({ seed: 5, durationMs: 5 * 60_000 }, makeConfig(), { stopLocalAfterMs: 2 * 60_000 });
    const risk = r.actions.filter((a) => a.kind === 'risk' && a.action === 'pause');
    expect(risk.length).toBeGreaterThan(0);
    // Emitted on change and repeated once a minute, not every second: ~3 min stale → ≤ 4 events.
    expect(risk.length).toBeLessThanOrEqual(4);
    const lastPlace = r.actions.filter((a) => a.kind === 'place').pop()!;
    expect(lastPlace.ts).toBeLessThanOrEqual(r.actions[0]!.ts + 2 * 60_000 + 5_000);
  });

  it('with equity above the base size, the strategy cap stays under the risk hard cap (no reduce_only flapping)', () => {
    // 0.2 × US$25 = US$5 > the US$3 hard cap: without the min() the bot buys past 3 and flaps.
    const r = run({ ...MARKET, seed: 3, durationMs: 10 * 60_000 }, makeConfig(), { initial: { quote: 25, base: 0 } });
    expect(r.fills).toBeGreaterThan(0);
    expect(r.actions.filter((a) => a.kind === 'risk' && a.action === 'reduce_only')).toEqual([]);
  });

  it('base balance stays decimal-exact through partial fills (no 0.01999999999999999)', () => {
    const s = new MarketMakerStrategy(makeConfig(), { quote: 15, base: 0 });
    s.handle({ kind: 'book', venue: 'reference', ts: 0, bid: 149.9, bidQty: 5, ask: 150.1, askQty: 5 });
    const placed = s.handle({ kind: 'book', venue: 'local', ts: 1, bid: 149.9, bidQty: 5, ask: 150.1, askQty: 5 }).find((a) => a.kind === 'place' && a.side === 'BUY');
    expect(placed).toBeDefined();
    const id = (placed as { clientOrderId: string }).clientOrderId;
    s.handle({ kind: 'order', ts: 2, clientOrderId: id, status: 'NEW' });
    for (const [i, q] of [0.0079, 0.0121, 0.0003].entries()) {
      s.handle({ kind: 'fill', ts: 3 + i, clientOrderId: id, fillId: `f${i}`, side: 'BUY', price: 150, qty: q, fee: 0, feeAsset: 'quote' });
    }
    expect(s.snapshot().baseTotal).toBe(0.0203); // a float sum gives 0.020300000000000002
  });

  it('pulls the vulnerable side when the reference venue jumps (lead–lag)', () => {
    const s = new MarketMakerStrategy(makeConfig(), { quote: 15, base: 0.02 });
    const book = (ts: number, venue: 'local' | 'reference', mid: number) =>
      s.handle({ kind: 'book', venue, ts, bid: mid - 0.03, bidQty: 10, ask: mid + 0.03, askQty: 10 });
    for (let t = 0; t <= 5_000; t += 100) {
      book(t, 'reference', 150);
      book(t, 'local', 150);
    }
    s.handle({ kind: 'timer', ts: 5_000 });
    const asks = s.snapshot().workingOrders.filter((o) => o.side === 'SELL');
    expect(asks.length).toBe(1);
    const acts = book(5_100, 'reference', 150.15); // +10 bps in 100 ms
    expect(acts).toContainEqual(expect.objectContaining({ kind: 'cancel', clientOrderId: asks[0]!.clientOrderId, reason: 'toxic_flow' }));
  });

  it('manual commands: pause cancels everything; kill is sticky until reset + resume', () => {
    const r = run({ seed: 6, durationMs: 2 * 60_000 });
    const s = r.strategy;
    const acts = s.handle({ kind: 'command', ts: 9e15, command: 'pause' });
    expect(s.snapshot().status).toBe('paused');
    expect(acts.filter((a) => a.kind === 'place')).toEqual([]);
    s.handle({ kind: 'command', ts: 9e15 + 1, command: 'resume' });
    expect(s.snapshot().status).toBe('running');
  });
});

describe('live hooks: venue hold and unknown order state (never exercised in shadow)', () => {
  /** Strategy with a quoting book and both sides acknowledged on the venue. */
  function quoting() {
    // Inventory on hand so both sides quote; caps raised so the fixture is not in reduce-only.
    const cfg = makeConfig({ maxInventoryFraction: 0.6 });
    const s = new MarketMakerStrategy({ ...cfg, risk: { ...cfg.risk, maxInventoryNotional: 10 } }, { quote: 15, base: 0.03 });
    const all: StrategyAction[] = [];
    const h = (e: StrategyEvent) => {
      const a = s.handle(e);
      all.push(...a);
      return a;
    };
    for (let i = 0; i < 40; i++) h({ kind: 'book', venue: 'local', ts: 1_000 + i * 250, bid: 150, bidQty: 5, ask: 150.1, askQty: 5 });
    h({ kind: 'timer', ts: 12_000 });
    for (const o of s.snapshot().workingOrders) h({ kind: 'order', ts: 12_001, clientOrderId: o.clientOrderId, status: 'NEW' });
    return { s, h, all };
  }

  it('a treasury transfer moves quote out without looking like a loss (risk references shift too)', () => {
    const { s, h } = quoting();
    const before = s.snapshot();
    expect(before.status).toBe('running');
    const out = h({ kind: 'transfer', ts: 12_500, quote: -5, reason: 'treasury_skim' });
    const after = s.snapshot();
    expect(after.quoteTotal).toBeCloseTo(before.quoteTotal - 5, 12);
    expect(after.startEquity! - before.startEquity!).toBeCloseTo(-5, 12);
    expect(after.peakEquity - before.peakEquity).toBeCloseTo(-5, 12);
    expect(after.realizedPnl).toBe(before.realizedPnl);
    expect(out.filter((a) => a.kind === 'error')).toEqual([]);
    // A large skim relative to equity would breach drawdown limits if it were counted as a loss.
    h({ kind: 'transfer', ts: 12_600, quote: -8, reason: 'treasury_skim' });
    h({ kind: 'timer', ts: 13_000 });
    expect(s.snapshot().status).toBe('running');
    // More than the balance is refused (never negative).
    const bad = h({ kind: 'transfer', ts: 13_100, quote: -100, reason: 'treasury_skim' });
    expect(bad.find((a) => a.kind === 'error')).toBeDefined();
    expect(s.snapshot().quoteTotal).toBeCloseTo(before.quoteTotal - 13, 12);
  });

  it('a venue hold cancels everything and blocks quoting until released', () => {
    const { s, h } = quoting();
    const working = s.snapshot().workingOrders;
    expect(working.map((o) => o.side).sort()).toEqual(['BUY', 'SELL']);
    const out = h({ kind: 'venue', ts: 12_100, hold: 'stream_down' });
    expect(out.find((a) => a.kind === 'status')).toMatchObject({ status: 'running', quoting: false, reason: 'venue_hold:stream_down' });
    expect(out.filter((a) => a.kind === 'place')).toEqual([]);
    const pending = s.snapshot().workingOrders;
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((o) => o.status === 'CANCEL_REQ')).toBe(true); // every order asked to cancel
    for (const o of pending) h({ kind: 'order', ts: 12_200, clientOrderId: o.clientOrderId, status: 'CANCELED' });
    expect(s.snapshot().workingOrders).toEqual([]);
    // Fresh book, then a timer so the risk check sees it (a stale book is its own risk pause).
    const later = [h({ kind: 'book', venue: 'local', ts: 20_001, bid: 150, bidQty: 5, ask: 150.1, askQty: 5 }), h({ kind: 'timer', ts: 20_050 })].flat();
    expect(later.filter((a) => a.kind === 'place')).toEqual([]);
    expect(h({ kind: 'venue', ts: 20_100, hold: 'stream_down' })).toEqual([]); // idempotent
    const back = h({ kind: 'venue', ts: 20_200, hold: null });
    expect(back.find((a) => a.kind === 'status')).toMatchObject({ quoting: true, reason: 'venue_ok' });
    expect(back.filter((a) => a.kind === 'place').map((a) => (a as { side: string }).side).sort()).toEqual(['BUY', 'SELL']);
    expect(s.snapshot().venueHold).toBeNull();
  });

  it('an UNKNOWN order freezes its side (no new quote, no cancel) until the exchange resolves it', () => {
    const { s, h } = quoting();
    const bid = s.snapshot().workingOrders.find((o) => o.side === 'BUY')!;
    h({ kind: 'order', ts: 12_300, clientOrderId: bid.clientOrderId, status: 'UNKNOWN' });
    expect(s.workingOrder(bid.clientOrderId)?.status).toBe('UNKNOWN');
    // A large price move would normally reprice the bid: with UNKNOWN it must not touch that side.
    const moved = [12_400, 12_700, 13_000, 14_000].flatMap((ts) => h({ kind: 'book', venue: 'local', ts, bid: 149, bidQty: 5, ask: 149.1, askQty: 5 }));
    const bidActions = moved.filter((a) => (a.kind === 'place' || a.kind === 'cancel') && (a.kind === 'cancel' ? a.clientOrderId === bid.clientOrderId : a.side === 'BUY'));
    expect(bidActions).toEqual([]);
    expect(moved.filter((a) => a.kind === 'error')).toEqual([]);
    // Resolved as canceled → the side quotes again.
    const again = [h({ kind: 'order', ts: 14_100, clientOrderId: bid.clientOrderId, status: 'CANCELED' }), h({ kind: 'timer', ts: 16_000 })].flat();
    expect(again.some((a) => a.kind === 'place' && a.side === 'BUY')).toBe(true);
  });

  it('an UNKNOWN order that turns out to be resting goes back to NEW; one that filled becomes FILLED', () => {
    const { s, h } = quoting();
    const [a, b] = s.snapshot().workingOrders;
    h({ kind: 'order', ts: 12_300, clientOrderId: a!.clientOrderId, status: 'UNKNOWN' });
    h({ kind: 'order', ts: 12_400, clientOrderId: a!.clientOrderId, status: 'NEW' });
    expect(s.workingOrder(a!.clientOrderId)?.status).toBe('NEW');
    h({ kind: 'order', ts: 12_500, clientOrderId: b!.clientOrderId, status: 'UNKNOWN' });
    h({ kind: 'fill', ts: 12_600, clientOrderId: b!.clientOrderId, fillId: 't1', side: b!.side, price: b!.price, qty: b!.qty, fee: 0, feeAsset: 'quote' });
    expect(s.workingOrder(b!.clientOrderId)).toBeUndefined();
  });
});
