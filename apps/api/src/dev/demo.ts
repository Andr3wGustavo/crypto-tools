import { defaultStrategyConfig, syntheticMarket, type SymbolRules } from '@cortex/core';
import type { InputRecord, ShadowEngineOptions } from '../../../worker/src/engine/shadow-engine';

/**
 * DEV ONLY: a multi-pair demo on seeded synthetic markets, for README screenshots and videos.
 * The pairs are named after the real pre-registration scan's top picks, but every price, trade
 * and fill here is synthetic (the bots report run "demo-synthetic"). Nothing here is a result.
 */
export interface DemoPair {
  base: string;
  price: number;
  rules: SymbolRules;
  spreadTicks: number;
  seed: number;
  /** Volatility in bps/√s. */
  sigma: number;
  /** Probability that an aggressor trades with the latent move (0.5 = uninformed). */
  informed: number;
  /** How late MEXC sees the latent price, in ms (the lead-lag the bot exploits). */
  lagMs?: number;
}

export const DEMO_PAIRS: DemoPair[] = [
  { base: 'SOL', price: 88, rules: { tickSize: '0.01', stepSize: '0.01', minQty: '0.01', minNotional: 1 }, spreadTicks: 6, seed: 11, sigma: 3.3, informed: 0.68, lagMs: 60 },
  { base: 'IO', price: 0.6214, rules: { tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', minNotional: 1 }, spreadTicks: 6, seed: 5, sigma: 4.8, informed: 0.68, lagMs: 60 },
  { base: 'KAITO', price: 1.243, rules: { tickSize: '0.001', stepSize: '0.01', minQty: '0.01', minNotional: 1 }, spreadTicks: 2, seed: 8, sigma: 4.4, informed: 0.7, lagMs: 60 },
  { base: 'ZRO', price: 2.118, rules: { tickSize: '0.001', stepSize: '0.01', minQty: '0.01', minNotional: 1 }, spreadTicks: 3, seed: 13, sigma: 4, informed: 0.68, lagMs: 60 },
];

export function demoOptions(d: DemoPair): ShadowEngineOptions {
  const base = defaultStrategyConfig({ botId: `mexc:${d.base}USDT:shadow`, base: d.base, quote: 'USDT', rules: d.rules });
  return { config: { ...base, as: { ...base.as, gamma: 0.02, k: 0.5 } }, startQuote: 15, latencyMs: 150, makerFeeRate: 0, edgeWindowMs: 10 * 60_000 };
}

export function demoInputs(d: DemoPair, minutes: number): InputRecord[] {
  const out: InputRecord[] = [];
  let nextClock = 0;
  const units = 44 / d.price; // base units worth ~US$44, the SOL default trade (0.5 SOL)
  for (const m of syntheticMarket({
    seed: d.seed, durationMs: minutes * 60_000, startPrice: d.price, tick: Number(d.rules.tickSize), spreadTicks: d.spreadTicks,
    tradeRatePerSec: 0.5, sweepProb: 0.15, tradeQtyMean: units, topQty: 80 * units,
    sigmaBpsPerSqrtS: d.sigma, informedProb: d.informed, localLagMs: d.lagMs ?? 200,
  })) {
    if (m.ts >= nextClock) {
      out.push({ t: 'clock', ts: m.ts });
      nextClock = m.ts + 1000;
    }
    if (m.kind === 'trade') out.push({ t: 'trade', ts: m.ts, price: m.price, qty: m.qty, aggressor: m.aggressor });
    else out.push({ t: 'book', venue: m.kind === 'ref' ? 'reference' : 'local', ts: m.ts, bid: m.bid, bidQty: m.bidQty, ask: m.ask, askQty: m.askQty });
  }
  return out;
}
