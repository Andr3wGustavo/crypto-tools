import { gaussian, mulberry32 } from '../math/rng';

/**
 * Deterministic two-venue market for tests and dry runs.
 * A latent "true" price follows GBM. The reference venue (Binance-like) sees it immediately with
 * a tight spread; the local venue (MEXC-like) sees it `localLagMs` later, rounded to its tick,
 * with a wider spread. Local trades are Poisson; informed flow leans toward the latent move.
 */
export interface SyntheticMarketParams {
  seed: number;
  startTs: number;
  durationMs: number;
  stepMs: number;
  startPrice: number;
  sigmaBpsPerSqrtS: number;
  driftBpsPerS: number;
  tick: number;
  spreadTicks: number;
  topQty: number;
  tradeRatePerSec: number;
  tradeQtyMean: number;
  localLagMs: number;
  /** Probability that an aggressor's side follows the latent move (0.5 = uninformed). */
  informedProb: number;
  /** Probability a trade sweeps 1–2 ticks through the touch. */
  sweepProb: number;
}

export const DEFAULT_SYNTHETIC: SyntheticMarketParams = {
  seed: 42,
  startTs: Date.UTC(2026, 0, 1),
  durationMs: 30 * 60_000,
  stepMs: 100,
  startPrice: 150,
  sigmaBpsPerSqrtS: 1.5,
  driftBpsPerS: 0,
  tick: 0.01,
  spreadTicks: 6,
  topQty: 40,
  tradeRatePerSec: 2,
  tradeQtyMean: 0.5,
  localLagMs: 200,
  informedProb: 0.55,
  sweepProb: 0.3,
};

export type SyntheticEvent =
  | { kind: 'ref'; ts: number; bid: number; bidQty: number; ask: number; askQty: number }
  | { kind: 'local'; ts: number; bid: number; bidQty: number; ask: number; askQty: number }
  | { kind: 'trade'; ts: number; price: number; qty: number; aggressor: 'buy' | 'sell' };

const roundTo = (x: number, tick: number) => Math.round(x / tick) * tick;
const fix = (x: number) => Number(x.toFixed(10));

export function* syntheticMarket(overrides: Partial<SyntheticMarketParams> = {}): Generator<SyntheticEvent> {
  const p = { ...DEFAULT_SYNTHETIC, ...overrides };
  const rand = mulberry32(p.seed);
  const dt = p.stepMs / 1000;
  const sig = p.sigmaBpsPerSqrtS / 1e4;
  const mu = p.driftBpsPerS / 1e4;
  let price = p.startPrice;
  const history: Array<{ ts: number; price: number }> = [];
  for (let ts = p.startTs; ts <= p.startTs + p.durationMs; ts += p.stepMs) {
    const prev = price;
    price = price * Math.exp((mu - 0.5 * sig * sig) * dt + sig * Math.sqrt(dt) * gaussian(rand));
    history.push({ ts, price });
    while (history.length > 1 && history[0]!.ts < ts - p.localLagMs) history.shift();
    const lagged = history[0]!.price;

    const refHalf = price * 0.5e-4;
    yield { kind: 'ref', ts, bid: price - refHalf, bidQty: 5, ask: price + refHalf, askQty: 5 };

    const center = roundTo(lagged, p.tick);
    const halfTicks = Math.floor(p.spreadTicks / 2);
    const bid = fix(center - halfTicks * p.tick);
    const ask = fix(center + (p.spreadTicks - halfTicks) * p.tick);
    yield { kind: 'local', ts, bid, bidQty: p.topQty, ask, askQty: p.topQty };

    if (rand() < p.tradeRatePerSec * dt) {
      const up = price >= prev;
      const followsMove = rand() < p.informedProb;
      const aggressor: 'buy' | 'sell' = up === followsMove ? 'buy' : 'sell';
      const sweep = rand() < p.sweepProb ? 1 + Math.floor(rand() * 2) : 0;
      const tradePrice = aggressor === 'buy' ? fix(ask + sweep * p.tick) : fix(bid - sweep * p.tick);
      const qty = Number((-Math.log(1 - rand()) * p.tradeQtyMean).toFixed(4)) + 0.0001;
      yield { kind: 'trade', ts, price: tradePrice, qty, aggressor };
    }
  }
}
