import { defaultStrategyConfig, syntheticMarket } from '@cortex/core';
import type { InputRecord, ShadowEngineOptions } from '../engine/shadow-engine';

const rules = { tickSize: '0.01', stepSize: '0.01', minQty: '0.01', minNotional: 1 };
const base = defaultStrategyConfig({ botId: 'mexc:SOLUSDT:shadow', base: 'SOL', quote: 'USDT', rules });
export const testConfig = { ...base, as: { ...base.as, gamma: 0.02, k: 0.5 } };
export const testEngineOptions: ShadowEngineOptions = { config: testConfig, startQuote: 15, latencyMs: 150, makerFeeRate: 0, edgeWindowMs: 10 * 60_000 };

/**
 * Deterministic two-venue market as engine input records, with a clock record every second.
 * Activity is moderate on purpose (one trade every ~2 s, few sweeps): busier settings only
 * slow the tests down and make the demo look better than any real market.
 */
export function syntheticInputs(minutes: number, seed = 9): InputRecord[] {
  const out: InputRecord[] = [];
  let nextClock = 0;
  for (const m of syntheticMarket({ seed, durationMs: minutes * 60_000, startPrice: 88, spreadTicks: 10, tradeRatePerSec: 0.5, sweepProb: 0.15 })) {
    if (m.ts >= nextClock) {
      out.push({ t: 'clock', ts: m.ts });
      nextClock = m.ts + 1000;
    }
    if (m.kind === 'trade') out.push({ t: 'trade', ts: m.ts, price: m.price, qty: m.qty, aggressor: m.aggressor });
    else out.push({ t: 'book', venue: m.kind === 'ref' ? 'reference' : 'local', ts: m.ts, bid: m.bid, bidQty: m.bidQty, ask: m.ask, askQty: m.askQty });
  }
  return out;
}
