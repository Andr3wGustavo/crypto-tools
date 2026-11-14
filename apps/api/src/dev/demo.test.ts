import { describe, expect, it } from 'vitest';
import { ShadowEngine } from '../../../worker/src/engine/shadow-engine';
import { DEMO_PAIRS, demoInputs, demoOptions } from './demo';

/**
 * The demo pairs are volatile small caps with coarse steps: they exposed four AFK bugs the calm
 * SOL fixture never hit (cancel/reject race, cap overshoot, a fixed toxic threshold, dropped
 * quotes at the edge floor). Each must keep quoting, without engine errors, for the whole run.
 */
describe('demo pairs stay live (AFK)', () => {
  it.each(DEMO_PAIRS.map((d) => [d.base, d] as const))('%s: no error, no risk flapping, never > 30 s without an order', async (_name, d) => {
    const recs = demoInputs(d, 45);
    const e = new ShadowEngine(demoOptions(d));
    let last = recs[0]!.ts;
    let gap = 0;
    const errors: string[] = [];
    let reduceOnly = 0;
    for (const [i, r] of recs.entries()) {
      if (i % 20_000 === 0) await new Promise((res) => setImmediate(res));
      for (const o of e.process(r)) {
        if (o.kind !== 'action') continue;
        if (o.action.kind === 'place') {
          gap = Math.max(gap, o.action.ts - last);
          last = o.action.ts;
        } else if (o.action.kind === 'error') errors.push(o.action.message);
        else if (o.action.kind === 'risk' && o.action.action === 'reduce_only') reduceOnly++;
      }
    }
    expect(errors).toEqual([]);
    expect(reduceOnly).toBeLessThanOrEqual(2);
    expect(Math.max(gap, recs.at(-1)!.ts - last)).toBeLessThanOrEqual(30_000);
    expect(e.strategy.snapshot().status).toBe('running');
  }, 60_000);
});
