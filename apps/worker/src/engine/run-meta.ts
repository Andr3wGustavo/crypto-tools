import type { StrategyConfig } from '@cortex/core';
import { engineConfigHash, type ShadowEngineOptions } from './shadow-engine';

/** meta.json of a run directory: the pre-registered experiment the recordings belong to. */
export interface ReplayMeta {
  config: StrategyConfig;
  startQuote: number;
  latencyMs: number;
  info: { makerFeeRate: number };
  timerMs?: number;
  edgeWindowMs?: number;
  /** Written by the worker since E3; checked when present. */
  configHash?: string;
}

/** Engine options of a recorded run; refuses a meta.json whose configHash this engine would not reproduce. */
export function metaToOptions(meta: ReplayMeta): ShadowEngineOptions {
  const o: ShadowEngineOptions = {
    config: meta.config, startQuote: meta.startQuote, latencyMs: meta.latencyMs, makerFeeRate: meta.info.makerFeeRate,
    ...(meta.timerMs !== undefined ? { timerMs: meta.timerMs } : {}),
    ...(meta.edgeWindowMs !== undefined ? { edgeWindowMs: meta.edgeWindowMs } : {}),
  };
  const hash = engineConfigHash(o);
  if (meta.configHash && meta.configHash !== hash) {
    throw new Error(`meta.json configHash ${meta.configHash.slice(0, 12)} ≠ engine ${hash.slice(0, 12)} (engine version or config changed)`);
  }
  return o;
}
