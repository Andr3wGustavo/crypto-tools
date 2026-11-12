import type { BotView } from '@cortex/shared';

/** Derived numbers shown on the dashboard. Pure functions: unit-tested. */

/** A view older than this means the worker stopped publishing (or the feed died). */
export const STALE_MS = 30_000;
export const MEXC_STALE_MS = 60_000;
export const BINANCE_STALE_MS = 300_000;
/** Below this many hourly windows an annualised number is noise, so none is shown. */
export const MIN_EDGE_HOURS_FOR_APR = 24;

export type HealthLevel = 'ok' | 'warn' | 'down';
export interface BotHealth {
  level: HealthLevel;
  reasons: string[];
}

export function botHealth(v: BotView, serverNow: number): BotHealth {
  const reasons: string[] = [];
  let level: HealthLevel = 'ok';
  const worse = (l: HealthLevel, why: string) => {
    reasons.push(why);
    if (l === 'down' || (l === 'warn' && level === 'ok')) level = l;
  };
  const age = serverNow - v.ts;
  if (age > STALE_MS) worse('down', `sem atualização há ${Math.round(age / 1000)} s`);
  if (v.status === 'killed') worse('down', 'kill switch acionado');
  else if (v.status === 'halted') worse('down', `halt${v.haltRule ? `: ${v.haltRule}` : ''}`);
  else if (v.status === 'paused') worse('warn', 'pausado');
  if (v.feeds.mexcAgeMs === null || v.feeds.mexcAgeMs > MEXC_STALE_MS) worse('warn', 'feed MEXC parado');
  if (v.feeds.binanceAgeMs === null || v.feeds.binanceAgeMs > BINANCE_STALE_MS) worse('warn', 'feed Binance parado');
  if (v.health.errorsLastMin > 0) worse('warn', `${v.health.errorsLastMin} erro(s) no último minuto`);
  if (v.reduceOnly) worse('warn', 'reduce-only');
  return { level, reasons };
}

export interface Pnl {
  abs: number | null;
  /** Relative to the starting equity. */
  bps: number | null;
  /** Fraction below the peak (≥ 0). */
  drawdown: number | null;
}

export function pnlOf(v: BotView): Pnl {
  const { equity, startEquity, peakEquity } = v.pnl;
  if (equity === null || startEquity === null || !(startEquity > 0)) return { abs: null, bps: null, drawdown: null };
  const abs = equity - startEquity;
  return { abs, bps: (abs / startEquity) * 1e4, drawdown: peakEquity && peakEquity > 0 ? Math.max(0, (peakEquity - equity) / peakEquity) : null };
}

/**
 * Simple (non-compounded) APR from the live hourly edge estimate: mean bps/h × 8760.
 * Null until MIN_EDGE_HOURS_FOR_APR windows exist: annualising a few hours is misleading.
 */
export function aprOf(v: BotView): number | null {
  if (v.edge.n < MIN_EDGE_HOURS_FOR_APR) return null;
  return (v.edge.meanBps * 8760) / 1e4;
}

export interface Totals {
  bots: number;
  running: number;
  attention: number;
  equity: number | null;
  startEquity: number | null;
  pnl: number | null;
  pnlBps: number | null;
  fills: number;
  worstDrawdown: number | null;
}

export function totalsOf(views: BotView[], serverNow: number): Totals {
  let equity = 0;
  let start = 0;
  let priced = 0;
  let worst: number | null = null;
  let running = 0;
  let attention = 0;
  let fills = 0;
  for (const v of views) {
    if (v.status === 'running') running++;
    if (botHealth(v, serverNow).level !== 'ok') attention++;
    fills += v.counters.fills;
    if (v.pnl.equity !== null && v.pnl.startEquity !== null) {
      equity += v.pnl.equity;
      start += v.pnl.startEquity;
      priced++;
    }
    const dd = pnlOf(v).drawdown;
    if (dd !== null) worst = worst === null ? dd : Math.max(worst, dd);
  }
  const has = priced > 0;
  return {
    bots: views.length, running, attention, fills, worstDrawdown: worst,
    equity: has ? equity : null, startEquity: has ? start : null,
    pnl: has ? equity - start : null, pnlBps: has && start > 0 ? ((equity - start) / start) * 1e4 : null,
  };
}

export interface Band {
  /** Positions in [0, 100] (% of the bar width); null = not shown. */
  bestBid: number | null;
  bestAsk: number | null;
  quoteBid: number | null;
  quoteAsk: number | null;
  fair: number | null;
  /** Our band in bps of fair (ask − bid), or null if one side is missing. */
  widthBps: number | null;
}

/** Geometry of the quote-band bar ("in range" view): venue touch, our quotes, fair value. */
export function bandOf(v: BotView): Band {
  const m = v.market;
  const xs = [m.bestBid, m.bestAsk, m.quoteBid, m.quoteAsk, m.fair].filter((x): x is number => x !== null && x > 0);
  const none: Band = { bestBid: null, bestAsk: null, quoteBid: null, quoteAsk: null, fair: null, widthBps: null };
  if (xs.length < 2) return none;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const pad = (hi - lo) * 0.15 || hi * 1e-4;
  const at = (x: number | null) => (x === null || !(x > 0) ? null : ((x - (lo - pad)) / (hi + pad - (lo - pad))) * 100);
  return {
    bestBid: at(m.bestBid), bestAsk: at(m.bestAsk), quoteBid: at(m.quoteBid), quoteAsk: at(m.quoteAsk), fair: at(m.fair),
    widthBps: m.quoteBid !== null && m.quoteAsk !== null && m.fair ? ((m.quoteAsk - m.quoteBid) / m.fair) * 1e4 : null,
  };
}

/** Spread of the venue touch in bps of mid. */
export function touchSpreadBps(v: BotView): number | null {
  const { bestBid, bestAsk } = v.market;
  if (bestBid === null || bestAsk === null || !(bestAsk > bestBid)) return null;
  return ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 1e4;
}
