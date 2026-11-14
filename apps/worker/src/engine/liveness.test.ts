import { describe, expect, it } from 'vitest';
import { syntheticInputs, testEngineOptions } from '../testing/synthetic-inputs';
import { ShadowEngine } from './shadow-engine';

/**
 * AFK liveness: a farm that silently stops quoting earns nothing and alerts no one, because
 * every health check stays green. Found in the 2026-11-13 review: a partial fill left inventory
 * too small to sell (under the US$1 minimum after step rounding) and too close to the cap to
 * buy — the bot never quoted again (seed 11 stopped at minute 3). A float residue in partial
 * fills could also make a "sell everything" order exceed the exact ledger and crash the engine.
 *
 * Invariant: on a healthy market the bot always has a fresh order out, on any seed (checked for
 * 2 h × 7 seeds by hand; 30 min × 3 seeds here to keep CI fast).
 */
describe('AFK liveness (synthetic market)', () => {
  it.each([3, 11, 23])('seed %i: never goes more than 30 s without placing, and never crashes', async (seed) => {
    const recs = syntheticInputs(30, seed);
    const e = new ShadowEngine(testEngineOptions);
    let last = recs[0]!.ts;
    let maxGap = 0;
    let places = 0;
    for (const [i, r] of recs.entries()) {
      if (i % 20_000 === 0) await new Promise((res) => setImmediate(res)); // keep the test worker responsive
      for (const o of e.process(r)) {
        if (o.kind === 'action' && o.action.kind === 'place') {
          maxGap = Math.max(maxGap, o.action.ts - last);
          last = o.action.ts;
          places++;
        }
      }
    }
    maxGap = Math.max(maxGap, recs.at(-1)!.ts - last);
    expect(places).toBeGreaterThan(500);
    expect(maxGap).toBeLessThanOrEqual(30_000);
  }, 60_000);
});
