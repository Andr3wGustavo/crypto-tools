import { DEFAULT_RISK_LIMITS, defaultStrategyConfig, type StrategyConfig } from '@cortex/core';
import type { VenueSymbolInfo } from '@cortex/exchange';

/**
 * Pre-registered parameters for the D0 shadow window. Changing anything here creates a new
 * BotConfig version (see PostgresSink.init) and starts a new evaluation window.
 *
 * Rationale for the MEXC SOLUSDT starting point (snapshot 2026-11-09: spread ≈ 12.5 bps, maker 0%):
 *   γ = 0.02 /bp, k = 0.4 /bp → liquidity term ≈ 2.4 bps; AS prior 2 bps → half spread ≈ 4.5–6 bps,
 *   i.e. inside the observed spread. k and A are re-estimated from recorded trades in the Edge Lab (E7).
 */
export function shadowStrategyConfig(botId: string, info: VenueSymbolInfo, startQuote: number): StrategyConfig {
  const base = defaultStrategyConfig({ botId, base: info.base, quote: info.quote, rules: info.rules });
  return {
    ...base,
    makerFeeBps: info.makerFeeRate * 1e4,
    as: { ...base.as, gamma: 0.02, k: 0.4, minHalfSpreadBps: 2, maxHalfSpreadBps: 40, maxSkewBps: 10 },
    risk: {
      ...DEFAULT_RISK_LIMITS,
      // Same ratios as the live plan, scaled to the virtual capital: budget 20%, inventory cap 20%.
      lossBudgetQuote: 0.2 * startQuote,
      maxInventoryNotional: Math.max(0.2 * startQuote, info.rules.minNotional * 3),
    },
  };
}

/**
 * Salt the run's generated ids with its own configuration hash (computed without the salt, so it
 * is stable across restarts). A new run of the same bot — new parameters, or the next capital
 * stage — then never reuses an order or withdrawal id of an older run.
 */
export function withRunSalt<O extends { config: StrategyConfig }>(opts: O, configHash: (o: O) => string): O {
  const { idSalt: _old, ...config } = opts.config;
  const unsalted = { ...opts, config } as O;
  return { ...unsalted, config: { ...config, idSalt: configHash(unsalted).slice(0, 12) } };
}
