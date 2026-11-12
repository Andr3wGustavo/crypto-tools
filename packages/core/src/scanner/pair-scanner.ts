/**
 * Pair scanner — pure metrics, gates and ranking (no I/O; the CLI feeds it venue data).
 *
 * Purpose: choose, BEFORE the shadow window starts, the pairs the shadow will measure. The
 * selection is written with the hash of these parameters, so it is pre-registered: the shadow
 * then evaluates the chosen pairs on data the scanner never saw (no look-ahead, no cherry-pick).
 *
 * Economics of a 0%-maker market maker, in the units used here (bps of the mid):
 *   capturable half spread  hsBps  = ((spread_ticks − 2) · tick_bps) / 2
 *       (quoting one tick inside each side leaves spread − 2 ticks; we earn ~half per fill)
 *   price risk              σ60Bps = realised volatility of the mid over 1 minute
 *   flow                    trades per minute (no flow ⇒ no fills ⇒ no edge measurement)
 *   score = min(1, flow / flowSaturation) · hsBps / max(σ60Bps, σFloor)
 * The score is a *heuristic ranking*, not an edge estimate: whether a pair is profitable is
 * decided only by the shadow (hourly MTM + NIG posterior), never by this number.
 */

export interface ScannerParams {
  quote: string;
  /** Virtual capital per pair (the shadow's start quote). */
  capitalQuote: number;
  /** Same sizing rules as the strategy: order = max(minNotional·minOrderMultiple, …) must fit the inventory cap. */
  minOrderMultiple: number;
  maxInventoryFraction: number;
  minQuoteVolume24h: number;
  /** Below this the book has no room to quote inside the spread (= strategy pennyMinSpreadTicks). */
  minSpreadTicks: number;
  minHalfSpreadBps: number;
  /** Wider than this is an illiquid / broken book, not an opportunity. */
  maxSpreadBps: number;
  minTradesPerMin: number;
  /** Fraction of book samples that must be valid (two-sided, not crossed). */
  minValidBookFrac: number;
  /** Require a Binance USDT listing of the same base (lead-lag reference + anti-rug). */
  requireReference: boolean;
  /** |ln(mexcMid / binanceMid)| above this ⇒ probably a different token with the same ticker. */
  maxReferenceBasisBps: number;
  flowSaturationPerMin: number;
  sigmaFloorBps: number;
  topN: number;
}

export const DEFAULT_SCANNER_PARAMS: ScannerParams = {
  quote: 'USDT',
  capitalQuote: 15,
  minOrderMultiple: 1.1,
  maxInventoryFraction: 0.2,
  minQuoteVolume24h: 100_000,
  minSpreadTicks: 3,
  minHalfSpreadBps: 2,
  maxSpreadBps: 150,
  minTradesPerMin: 2,
  minValidBookFrac: 0.95,
  requireReference: true,
  maxReferenceBasisBps: 100,
  flowSaturationPerMin: 10,
  sigmaFloorBps: 0.5,
  topN: 8,
};

// ------------------------------------------------------------------ stage 1: universe

export interface UniverseRow {
  symbol: string;
  base: string;
  quote: string;
  tradable: boolean;
  /** Venue risk flag (MEXC "ST" = special treatment / delisting watch). */
  flagged: boolean;
  makerFeeRate: number;
  minNotional: number;
  tickSize: number;
  quoteVolume24h: number;
  hasReference: boolean;
}

export interface Rejection {
  symbol: string;
  reasons: string[];
}

const LEVERAGED = /\d+[LS]$/;

/** Static gates that need no sampling. Returns survivors and every rejection with its reasons. */
export function screenUniverse(rows: readonly UniverseRow[], p: ScannerParams): { pass: UniverseRow[]; rejected: Rejection[] } {
  const pass: UniverseRow[] = [];
  const rejected: Rejection[] = [];
  const maxMinNotional = (p.maxInventoryFraction * p.capitalQuote) / p.minOrderMultiple;
  for (const r of rows) {
    const reasons: string[] = [];
    if (r.quote !== p.quote) reasons.push(`quote ${r.quote}`);
    if (!r.tradable) reasons.push('not tradable');
    if (r.flagged) reasons.push('venue risk flag');
    if (LEVERAGED.test(r.base)) reasons.push('leveraged token');
    if (r.makerFeeRate > 0) reasons.push(`maker fee ${r.makerFeeRate}`);
    if (!(r.tickSize > 0)) reasons.push('no tick size');
    if (r.minNotional > maxMinNotional) reasons.push(`min notional ${r.minNotional} > ${maxMinNotional.toFixed(2)} (inventory cap)`);
    if (!(r.quoteVolume24h >= p.minQuoteVolume24h)) reasons.push(`24h volume ${Math.round(r.quoteVolume24h)} < ${p.minQuoteVolume24h}`);
    if (p.requireReference && !r.hasReference) reasons.push('no reference listing');
    if (reasons.length) rejected.push({ symbol: r.symbol, reasons });
    else pass.push(r);
  }
  return { pass, rejected };
}

// ------------------------------------------------------------------ stage 2: measurements

export interface BookSample {
  ts: number;
  bid: number;
  ask: number;
}

export interface BookStats {
  samples: number;
  validFrac: number;
  midP50: number;
  tickBps: number;
  spreadTicksP10: number;
  spreadTicksP50: number;
  spreadBpsP50: number;
  /** Realised 1-minute volatility of the mid, in bps (irregular sampling handled: Σr² / Σdt). */
  sigma60Bps: number;
  /** Fraction of consecutive valid samples where the mid moved. */
  midMoveFrac: number;
}

/** Nearest-rank quantile of an ascending array (q ∈ [0, 1]). */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

export function bookStats(samples: readonly BookSample[], tickSize: number): BookStats {
  const valid = samples.filter((s) => s.bid > 0 && s.ask > s.bid);
  const mids = valid.map((s) => (s.bid + s.ask) / 2);
  const ticks = valid.map((s) => Math.round((s.ask - s.bid) / tickSize)).sort((a, b) => a - b);
  const bps = valid.map((s, i) => ((s.ask - s.bid) / mids[i]!) * 1e4).sort((a, b) => a - b);
  let sumR2 = 0;
  let sumDt = 0;
  let moves = 0;
  for (let i = 1; i < valid.length; i++) {
    const dt = valid[i]!.ts - valid[i - 1]!.ts;
    if (!(dt > 0)) continue;
    const r = Math.log(mids[i]! / mids[i - 1]!);
    sumR2 += r * r;
    sumDt += dt;
    if (r !== 0) moves++;
  }
  const midP50 = quantile([...mids].sort((a, b) => a - b), 0.5);
  return {
    samples: samples.length,
    validFrac: samples.length ? valid.length / samples.length : 0,
    midP50,
    tickBps: (tickSize / midP50) * 1e4,
    spreadTicksP10: quantile(ticks, 0.1),
    spreadTicksP50: quantile(ticks, 0.5),
    spreadBpsP50: quantile(bps, 0.5),
    sigma60Bps: sumDt > 0 ? Math.sqrt((sumR2 / sumDt) * 60_000) * 1e4 : 0,
    midMoveFrac: valid.length > 1 ? moves / (valid.length - 1) : 0,
  };
}

export interface PublicTrade {
  time: number;
  price: number;
  qty: number;
  /** true ⇒ the seller was the aggressor. */
  isBuyerMaker: boolean;
}

export interface TradeStats {
  n: number;
  spanMin: number;
  perMin: number;
  notionalPerMin: number;
  medianNotional: number;
  buyShare: number;
}

/** Rate from the most recent public trades: (n − 1) intervals over the time they span (≥ 1 s). */
export function tradeStats(trades: readonly PublicTrade[]): TradeStats {
  const n = trades.length;
  if (n < 2) return { n, spanMin: 0, perMin: 0, notionalPerMin: 0, medianNotional: n ? trades[0]!.price * trades[0]!.qty : 0, buyShare: 0 };
  let lo = Infinity;
  let hi = -Infinity;
  let notional = 0;
  let buys = 0;
  const each: number[] = [];
  for (const t of trades) {
    lo = Math.min(lo, t.time);
    hi = Math.max(hi, t.time);
    const v = t.price * t.qty;
    notional += v;
    each.push(v);
    if (!t.isBuyerMaker) buys++;
  }
  const spanMin = Math.max(hi - lo, 1_000) / 60_000;
  return {
    n,
    spanMin,
    perMin: (n - 1) / spanMin,
    notionalPerMin: notional / spanMin,
    medianNotional: quantile(each.sort((a, b) => a - b), 0.5),
    buyShare: buys / n,
  };
}

// ------------------------------------------------------------------ scoring and ranking

export interface PairMeasurement {
  row: UniverseRow;
  book: BookStats;
  trades?: TradeStats;
  /** ln(venueMid / referenceMid) in bps, when the reference was sampled. */
  referenceBasisBps?: number;
}

export interface PairScore {
  symbol: string;
  base: string;
  eligible: boolean;
  reasons: string[];
  hsBps: number;
  score: number;
}

/** Capturable half spread after quoting one tick inside both sides, in bps. */
export const capturableHalfSpreadBps = (spreadTicks: number, tickBps: number): number => (Math.max(0, spreadTicks - 2) * tickBps) / 2;

/** Book-only gates: decide who is worth fetching trades for. */
export function bookGateReasons(b: BookStats, p: ScannerParams): string[] {
  const reasons: string[] = [];
  if (b.validFrac < p.minValidBookFrac) reasons.push(`valid book ${(b.validFrac * 100).toFixed(0)}% < ${p.minValidBookFrac * 100}%`);
  if (!(b.spreadTicksP50 >= p.minSpreadTicks)) reasons.push(`spread ${b.spreadTicksP50} ticks < ${p.minSpreadTicks}`);
  if (!(b.spreadBpsP50 <= p.maxSpreadBps)) reasons.push(`spread ${b.spreadBpsP50.toFixed(1)} bps > ${p.maxSpreadBps}`);
  const hs = capturableHalfSpreadBps(b.spreadTicksP50, b.tickBps);
  if (!(hs >= p.minHalfSpreadBps)) reasons.push(`capturable half spread ${hs.toFixed(2)} bps < ${p.minHalfSpreadBps}`);
  return reasons;
}

export function scorePair(m: PairMeasurement, p: ScannerParams): PairScore {
  const reasons = bookGateReasons(m.book, p);
  const hsBps = capturableHalfSpreadBps(m.book.spreadTicksP50, m.book.tickBps);
  const perMin = m.trades?.perMin ?? 0;
  if (!m.trades) reasons.push('trades not measured');
  else if (perMin < p.minTradesPerMin) reasons.push(`${perMin.toFixed(2)} trades/min < ${p.minTradesPerMin}`);
  if (p.requireReference) {
    if (m.referenceBasisBps === undefined) reasons.push('reference not sampled');
    else if (Math.abs(m.referenceBasisBps) > p.maxReferenceBasisBps) reasons.push(`reference basis ${m.referenceBasisBps.toFixed(0)} bps (different token?)`);
  }
  const flow = Math.min(1, perMin / p.flowSaturationPerMin);
  const score = (flow * hsBps) / Math.max(m.book.sigma60Bps, p.sigmaFloorBps);
  return { symbol: m.row.symbol, base: m.row.base, eligible: reasons.length === 0, reasons, hsBps, score: Number.isFinite(score) ? score : 0 };
}

/** Eligible pairs first by score (desc), ties by symbol; `selected` = top N eligible. */
export function rankPairs(ms: readonly PairMeasurement[], p: ScannerParams): { ranked: PairScore[]; selected: PairScore[] } {
  const ranked = ms.map((m) => scorePair(m, p)).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.symbol.localeCompare(b.symbol));
  return { ranked, selected: ranked.filter((s) => s.eligible).slice(0, p.topN) };
}
