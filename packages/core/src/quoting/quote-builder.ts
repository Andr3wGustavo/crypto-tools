import type { AsQuote } from './avellaneda';
import { BN, addSteps, ceilToStep, decimalsOf, floorToStep, type BNValue } from './tick';

export type Side = 'BUY' | 'SELL';

export interface SymbolRules {
  tickSize: string;
  stepSize: string;
  minQty: string;
  /** Minimum order value in quote currency. */
  minNotional: number;
}

export interface BookTop {
  bid: number;
  bidQty: number;
  ask: number;
  askQty: number;
}

export interface FreeBalances {
  quoteFree: number;
  baseFree: number;
}

export interface BuildParams {
  orderNotional: number;
  /**
   * Target value of the bid when it differs from `orderNotional` (the room left under the
   * inventory cap, or the minimum order that makes stuck dust sellable). Defaults to orderNotional.
   */
  bidNotional?: number;
  /** Hard ceiling for the bid's value (the room under the inventory cap). Rounding up to the
   *  exchange minimum never goes past it. Default: no ceiling beyond the one-step rule. */
  bidNotionalMax?: number;
  costBps: number;
  /** Minimum edge (bps vs fair) on the inventory-reducing side; decays with inventory age. */
  reduceMinEdgeBps: number;
  /** Improve the best price by one tick when the spread is at least this many ticks. 0 = off. */
  pennyMinSpreadTicks: number;
  /** Any final price further than this from fair is a bug → throw (fail-closed). */
  maxDeviationBps: number;
  cashBufferPct: number;
}

export interface BuildFlags {
  pullBid?: boolean;
  pullAsk?: boolean;
  /** Inventory at/over cap or risk says reduce-only: no new bids. */
  noBid?: boolean;
}

export interface OrderTarget {
  side: Side;
  price: string;
  qty: string;
  edgeBps: number;
}

export type SkipReason =
  | 'toxic'
  | 'inventory_cap'
  | 'insufficient_edge'
  | 'below_min'
  | 'insufficient_cash'
  | 'no_inventory';

export interface BuildResult {
  bid?: OrderTarget;
  ask?: OrderTarget;
  skipped: Array<{ side: Side; reason: SkipReason }>;
}

export class QuoteSanityError extends Error {
  override name = 'QuoteSanityError';
}

/**
 * Largest step multiple we can sell out of `held`. floorToStep alone may snap UP by < 1e-9 step
 * (it absorbs binary-float noise), which must never make a sell exceed what we hold.
 */
export function sellableQty(held: BNValue, step: string): string {
  let q = floorToStep(held, step);
  while (new BN(q).gt(held) && new BN(q).gt(0)) q = addSteps(q, step, -1);
  return q;
}

const edgeBid = (price: number, fair: number) => ((fair - price) / fair) * 1e4;
const edgeAsk = (price: number, fair: number) => ((price - fair) / fair) * 1e4;

/**
 * Turns a model quote into exchange-valid post-only orders:
 * tick/step rounding (bid floors, ask ceils), post-only clamping, optional one-tick penny,
 * minimum-edge check, min qty / min notional, cash and inventory availability, sanity bounds.
 */
export function buildQuoteOrders(
  quote: AsQuote,
  book: BookTop,
  rules: SymbolRules,
  bal: FreeBalances,
  params: BuildParams,
  flags: BuildFlags = {},
): BuildResult {
  const fair = quote.fair;
  const tick = rules.tickSize;
  const tickN = Number(tick);
  const res: BuildResult = { skipped: [] };
  const spreadTicks = Math.round((book.ask - book.bid) / tickN);

  // ---------- BID (opening side for a long-only spot inventory) ----------
  if (flags.pullBid) res.skipped.push({ side: 'BUY', reason: 'toxic' });
  else if (flags.noBid) res.skipped.push({ side: 'BUY', reason: 'inventory_cap' });
  else {
    // The model's price, but never richer than the edge floor (fair − cost): a too-tight model
    // quote is moved back to the floor and placed, not dropped (dropping left the bot with no
    // order at all for minutes when the other side was blocked too).
    let price = floorToStep(BN.min(new BN(quote.bid), new BN(fair).times(1 - params.costBps / 1e4)), tick);
    if (Number(price) >= book.ask) price = addSteps(book.ask, tick, -1);
    if (params.pennyMinSpreadTicks > 0 && spreadTicks >= params.pennyMinSpreadTicks && Number(price) === book.bid) {
      const improved = addSteps(book.bid, tick, 1);
      if (edgeBid(Number(improved), fair) >= params.costBps) price = improved;
    }
    const p = Number(price);
    const edge = edgeBid(p, fair);
    const target = params.bidNotional ?? params.orderNotional;
    let qty = p > 0 ? floorToStep(new BN(target).div(price), rules.stepSize) : '0';
    // Flooring to the step can drop a valid-sized target under the exchange minimum (a coarse step,
    // e.g. 0.01 SOL ≈ US$0.9 against a US$1 minimum). Round up to the smallest valid size instead,
    // but never by more than one step above the target.
    if (p > 0 && (new BN(qty).lt(rules.minQty) || Number(qty) * p < rules.minNotional)) {
      const minValid = BN.max(new BN(ceilToStep(new BN(rules.minNotional).div(price), rules.stepSize)), new BN(rules.minQty));
      const v = minValid.times(price);
      const ceiling = BN.min(new BN(target).plus(new BN(rules.stepSize).times(price)), params.bidNotionalMax ?? Number.POSITIVE_INFINITY);
      if (v.gte(rules.minNotional) && v.lte(ceiling)) qty = minValid.toFixed(decimalsOf(rules.stepSize));
    }
    const value = Number(qty) * p;
    if (edge < params.costBps) res.skipped.push({ side: 'BUY', reason: 'insufficient_edge' });
    else if (new BN(qty).lt(rules.minQty) || value < rules.minNotional) res.skipped.push({ side: 'BUY', reason: 'below_min' });
    else if (value * (1 + params.cashBufferPct) > bal.quoteFree) res.skipped.push({ side: 'BUY', reason: 'insufficient_cash' });
    else res.bid = { side: 'BUY', price, qty, edgeBps: edge };
  }

  // ---------- ASK (reducing side: only sells inventory we actually hold) ----------
  if (flags.pullAsk) res.skipped.push({ side: 'SELL', reason: 'toxic' });
  else {
    // Same on the reducing side: an inventory skew that asks below the allowed edge is clamped up
    // to fair · (1 + reduceMinEdge) and placed there.
    let price = ceilToStep(BN.max(new BN(quote.ask), new BN(fair).times(1 + params.reduceMinEdgeBps / 1e4)), tick);
    if (Number(price) <= book.bid) price = addSteps(book.bid, tick, 1);
    if (params.pennyMinSpreadTicks > 0 && spreadTicks >= params.pennyMinSpreadTicks && Number(price) === book.ask) {
      const improved = addSteps(book.ask, tick, -1);
      if (edgeAsk(Number(improved), fair) >= params.reduceMinEdgeBps) price = improved;
    }
    const p = Number(price);
    const edge = edgeAsk(p, fair);
    const wanted = new BN(params.orderNotional).div(price);
    const held = new BN(bal.baseFree);
    const all = sellableQty(held, rules.stepSize);
    let qty = floorToStep(BN.min(wanted, all), rules.stepSize);
    // Never leave unsellable dust behind: if what would remain after this sell is below the
    // exchange minimum, sell everything we hold in this order instead.
    if (new BN(qty).lt(all) && held.minus(qty).times(p).lt(rules.minNotional)) qty = all;
    const value = Number(qty) * p;
    if (held.times(p).lt(rules.minNotional) || new BN(qty).lt(rules.minQty) || value < rules.minNotional) {
      res.skipped.push({ side: 'SELL', reason: held.gt(0) && held.times(p).gte(rules.minNotional) ? 'below_min' : 'no_inventory' });
    } else if (edge < params.reduceMinEdgeBps) res.skipped.push({ side: 'SELL', reason: 'insufficient_edge' });
    else res.ask = { side: 'SELL', price, qty, edgeBps: edge };
  }

  // ---------- Sanity (fail-closed) ----------
  for (const o of [res.bid, res.ask]) {
    if (!o) continue;
    const p = Number(o.price);
    if (!(p > 0)) throw new QuoteSanityError(`non-positive price ${o.price}`);
    const dev = Math.abs(p / fair - 1) * 1e4;
    if (dev > params.maxDeviationBps) throw new QuoteSanityError(`${o.side} ${o.price} is ${dev.toFixed(1)} bps from fair ${fair}`);
  }
  if (res.bid && res.ask && Number(res.bid.price) >= Number(res.ask.price)) {
    throw new QuoteSanityError(`crossed quotes bid=${res.bid.price} ask=${res.ask.price}`);
  }
  if (res.bid && Number(res.bid.price) >= book.ask) throw new QuoteSanityError('bid would take liquidity');
  if (res.ask && Number(res.ask.price) <= book.bid) throw new QuoteSanityError('ask would take liquidity');
  return res;
}
