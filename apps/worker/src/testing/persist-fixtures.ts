import { ShadowEngine } from '../engine/shadow-engine';
import { LiveEngine, type LiveEngineOptions } from '../live/live-engine';
import { LedgerTap, type PersistItem, type SinkContext } from '../sinks/postgres-sink';
import { Harness, opts as liveOpts } from './live-harness';
import { syntheticInputs, testEngineOptions } from './synthetic-inputs';

/** Engine runs captured record by record, as the workers hand them to persistence. */
export const SHADOW_CTX: SinkContext = { botId: 'mexc:SOLUSDT:shadow', run: 'cfg-test', mode: 'shadow', venue: 'mexc', symbol: 'SOLUSDT', base: 'SOL', quote: 'USDT' };
export const LIVE_CTX: SinkContext = { botId: 'mexc:SOLUSDT:live', run: 'live-test', mode: 'live', venue: 'mexc', symbol: 'SOLUSDT', base: 'SOL', quote: 'USDT', wallet: 'So11111111111111111111111111111111111111112' };

/** A shadow run over a seeded synthetic market, captured record by record. */
export function shadowRun(minutes = 20, seed = 9): { engine: ShadowEngine; items: PersistItem[] } {
  const engine = new ShadowEngine(testEngineOptions);
  const tap = new LedgerTap(engine);
  const items: PersistItem[] = [];
  for (const r of syntheticInputs(minutes, seed)) items.push(tap.item(engine.process(r)));
  return { engine, items };
}

/** A live session: profit, skim, then a withdrawal that is sent and confirmed. */
export function liveRun(): { h: Harness; items: PersistItem[] } {
  const o: LiveEngineOptions = { ...liveOpts, treasury: { withdraw: { minAmount: 0.03, dailyCap: 1 } } };
  const h = new Harness(new LiveEngine(o));
  const tap = new LedgerTap(h.engine);
  const items: PersistItem[] = [];
  h.onRecord = (outs) => items.push(tap.item(outs));
  const reqs: string[] = [];
  h.onWithdrawRequest = (r) => reqs.push(r.id);
  h.start();
  h.fill('BUY');
  h.market(4_000, 92, 92.1);
  h.stripClientIds = true; // one fill arrives without a client id (booked by order id)
  h.fill('SELL');
  h.stripClientIds = false;
  h.market(67_000, 92, 92.1);
  const id = reqs[0]!;
  h.quote = h.quote.minus('0.04');
  h.withdrawAnswer({ id, status: 'SENT', exchangeId: 'E1' });
  h.market(70_000, 92, 92.1);
  h.withdrawAnswer({ id, status: 'CONFIRMED', amount: '0.04', fee: '0.01', txId: '5xSig' });
  h.market(70_000, 92, 92.1);
  return { h, items };
}

