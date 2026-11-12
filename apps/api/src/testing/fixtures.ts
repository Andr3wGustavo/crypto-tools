import type { BotView } from '@cortex/shared';

/** A valid BotView for tests (API and dashboard). */
export function sampleView(botId: string, ts: number, over: Partial<BotView> = {}): BotView {
  return {
    v: 1, botId, venue: 'mexc', mode: 'shadow', symbol: botId.split(':')[1]!, base: 'IO', quote: 'USDT', run: 'cfg-0123456789ab', version: 'test',
    startedAt: ts - 60_000, ts, status: 'running', quoting: true, haltRule: null, reduceOnly: false,
    market: { mid: 1.5, fair: 1.5001, refMid: 1.4999, bestBid: 1.49, bestAsk: 1.51, quoteBid: 1.495, quoteAsk: 1.505, halfSpreadBps: 33, toxic: false },
    balances: { quote: 10, base: 3 }, pnl: { equity: 14.5, startEquity: 15, peakEquity: 15.1, realized: 0.01, unrealized: -0.02 },
    risk: { sigmaBps: 12, adverseSelectionBps: 2.5, markoutsObserved: 40 },
    orders: [], edge: { n: 3, meanBps: 0.4, sdBps: 9, pGo: 0.2, pPositive: 0.55, verdict: 'CONTINUE' },
    counters: { records: 1000, fills: 5 }, feeds: { mexcAgeMs: 120, binanceAgeMs: 80 }, health: { errorsLastMin: 0, eventLoopLagMs: 3, clockSkewMs: -12 },
    ...over,
  };
}
