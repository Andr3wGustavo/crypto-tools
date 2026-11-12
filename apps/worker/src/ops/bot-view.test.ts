import { BotEventSchema, BotViewSchema, SERIES_STEP_MS, SeriesPointSchema, botKeys, type BotEvent, type LiveMessage } from '@cortex/shared';
import { describe, expect, it } from 'vitest';
import { ShadowEngine, stateDigest } from '../engine/shadow-engine';
import { RedisSink, type LiveRedis, type RedisCmd } from '../sinks/redis-sink';
import { syntheticInputs, testEngineOptions } from '../testing/synthetic-inputs';
import { BotViewBuilder, toWireEvents } from './bot-view';

const BOT = 'mexc:SOLUSDT:shadow';
const id = { botId: BOT, mode: 'shadow' as const, symbol: 'SOLUSDT', base: 'SOL', quote: 'USDT', run: 'cfg-0123456789ab', version: 'test', startedAt: 1 };
const records = syntheticInputs(20, 7);

/** Records every command; XADD returns increasing ids like Redis does. */
class FakeRedis implements LiveRedis {
  cmds: RedisCmd[] = [];
  up = true;
  failNext = false;
  private seq = 0;
  ready() {
    return this.up;
  }
  async exec(cmds: RedisCmd[]) {
    await new Promise((r) => setImmediate(r)); // really asynchronous, like the network
    if (this.failNext) {
      this.failNext = false;
      throw new Error('boom');
    }
    this.cmds.push(...cmds);
    return cmds.map((c) => (c[0] === 'XADD' ? `${++this.seq}-0` : 'OK'));
  }
  live(): LiveMessage[] {
    return this.cmds.filter((c) => c[0] === 'PUBLISH').map((c) => JSON.parse(c[2]!) as LiveMessage);
  }
}

describe('dashboard view (engine → @cortex/shared contracts)', () => {
  it('every view, point and event the engine produces satisfies the wire schemas', () => {
    const engine = new ShadowEngine(testEngineOptions);
    const b = new BotViewBuilder(id);
    let views = 0;
    let points = 0;
    const kinds = new Set<string>();
    for (const r of records) {
      const outs = engine.process(r);
      b.observe(r, outs);
      for (const e of toWireEvents(outs)) {
        BotEventSchema.parse(e);
        kinds.add(e.k);
      }
      if (r.t === 'clock' || r.t === 'book') {
        const v = BotViewSchema.parse(b.view(engine, { mexcAgeMs: 12, binanceAgeMs: Infinity }));
        views++;
        const p = b.point(v);
        if (p) {
          SeriesPointSchema.parse(p);
          points++;
        }
      }
    }
    expect(views).toBeGreaterThan(100);
    // One point per 5 s step at most: a 20-min market gives about 240.
    expect(points).toBeGreaterThan(200);
    expect(points).toBeLessThanOrEqual((20 * 60_000) / SERIES_STEP_MS + 1);
    expect(kinds).toContain('order');
    expect(kinds).toContain('fill');
    const last = b.view(engine, { mexcAgeMs: null, binanceAgeMs: Infinity });
    expect(last.feeds.binanceAgeMs).toBeNull(); // Infinity is not JSON: null on the wire
    expect(last.counters).toEqual({ records: records.length, fills: engine.fillCount });
    expect(last.market.refMid).toBeGreaterThan(0);
    if (last.market.quoteBid !== null && last.market.quoteAsk !== null) expect(last.market.quoteBid).toBeLessThan(last.market.quoteAsk);
  });

  it('observing never changes the engine (replay digest identical with and without the view)', () => {
    const plain = new ShadowEngine(testEngineOptions);
    for (const r of records) plain.process(r);
    const viewed = new ShadowEngine(testEngineOptions);
    const b = new BotViewBuilder(id);
    for (const r of records) {
      const outs = viewed.process(r);
      b.observe(r, outs);
      b.point(b.view(viewed, { mexcAgeMs: 0, binanceAgeMs: 0 }));
    }
    expect(stateDigest(viewed.snapshot())).toBe(stateDigest(plain.snapshot()));
  });
});

describe('Redis live publisher', () => {
  const fill: BotEvent = { k: 'fill', ts: 1, fillId: 'f1', clientOrderId: 'c1', side: 'BUY', price: 100, qty: 1, fee: 0, feeAsset: 'quote' };
  const order: BotEvent = { k: 'order', ts: 2, op: 'cancel', clientOrderId: 'c2', reason: 'ttl' };
  const engine = new ShadowEngine(testEngineOptions);
  const viewOf = (b: BotViewBuilder) => () => b.view(engine, { mexcAgeMs: 0, binanceAgeMs: 0 });

  it('keeps the engine order, tags each live event with its events-stream id, throttles the view', async () => {
    const r = new FakeRedis();
    const sink = new RedisSink(r, BOT, { warn: () => undefined });
    await sink.init();
    const b = new BotViewBuilder(id);
    sink.push([fill, order], 1_000, viewOf(b), () => undefined);
    sink.push([order], 1_500, viewOf(b), () => undefined); // < 1 s: no new view
    sink.push([], 1_600, viewOf(b), () => undefined); // nothing to send
    sink.push([], 2_000, viewOf(b), () => undefined);
    await sink.flush();
    const k = botKeys(BOT);
    expect(r.cmds[0]).toEqual(['SADD', 'bots', BOT]);
    expect(r.cmds.filter((c) => c[0] === 'XADD').map((c) => c[1])).toEqual([k.events, k.fills, k.events, k.events]);
    expect(r.cmds.filter((c) => c[0] === 'SET').length).toBe(2);
    const live = r.live();
    expect(live.map((m) => m.t)).toEqual(['event', 'event', 'view', 'event', 'view']);
    // ids are the events-stream replies (the fills XADD reply is skipped)
    expect(live.filter((m) => m.t === 'event').map((m) => (m as { id: string }).id)).toEqual(['1-0', '3-0', '4-0']);
    expect(sink.errors).toBe(0);
  });

  it('a Redis failure is counted, never thrown, and later writes still go out; nothing is sent while down', async () => {
    const r = new FakeRedis();
    const sink = new RedisSink(r, BOT, { warn: () => undefined });
    const b = new BotViewBuilder(id);
    r.failNext = true;
    sink.push([fill], 1_000, viewOf(b), () => undefined);
    sink.push([order], 3_000, viewOf(b), () => undefined);
    await sink.flush();
    expect(sink.errors).toBe(1);
    expect(r.live().map((m) => m.t)).toEqual(['event', 'view']);
    r.up = false;
    sink.push([fill], 5_000, viewOf(b), () => undefined);
    await sink.flush();
    expect(r.live().length).toBe(2);
  });

  it('bounds the backlog: beyond maxInFlight it drops and counts instead of growing memory', async () => {
    const r = new FakeRedis();
    const sink = new RedisSink(r, BOT, { warn: () => undefined }, 1_000, 3);
    const b = new BotViewBuilder(id);
    for (let i = 0; i < 10; i++) sink.push([order], i, viewOf(b), () => undefined);
    await sink.flush();
    expect(sink.errors).toBe(7);
    expect(r.live().filter((m) => m.t === 'event').length).toBe(3);
  });
});
