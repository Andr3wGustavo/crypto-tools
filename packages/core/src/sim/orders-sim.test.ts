import { describe, expect, it } from 'vitest';
import { IllegalOrderTransition, botTag, makeClientOrderId, nextStatus } from '../orders/fsm';
import { SimExecutor } from './sim-executor';

describe('order FSM', () => {
  it('walks the happy path and the cancel race', () => {
    let s = nextStatus('INTENT', 'send');
    s = nextStatus(s, 'ack');
    s = nextStatus(s, 'partial_fill');
    expect(s).toBe('PARTIAL');
    s = nextStatus(s, 'cancel_request');
    s = nextStatus(s, 'partial_fill'); // late fill while cancelling
    expect(s).toBe('CANCEL_REQ');
    expect(nextStatus(s, 'canceled')).toBe('CANCELED');
  });

  it('resolves UNKNOWN through reconciliation and rejects illegal moves', () => {
    expect(nextStatus(nextStatus('SENT', 'timeout'), 'reconcile_filled')).toBe('FILLED');
    expect(() => nextStatus('FILLED', 'ack')).toThrow(IllegalOrderTransition);
    expect(() => nextStatus('CANCELED', 'fill')).toThrow(IllegalOrderTransition);
  });

  it('clientOrderId is deterministic, unique per (seq, side) and ≤ 32 chars', () => {
    const tag = botTag('mexc:SOLUSDT');
    expect(tag).toHaveLength(6);
    expect(makeClientOrderId(tag, 1234567, 'BUY')).toBe(makeClientOrderId(botTag('mexc:SOLUSDT'), 1234567, 'BUY'));
    expect(makeClientOrderId(tag, 1, 'BUY')).not.toBe(makeClientOrderId(tag, 1, 'SELL'));
    expect(makeClientOrderId(tag, Number.MAX_SAFE_INTEGER, 'SELL').length).toBeLessThanOrEqual(32);
  });
});

describe('SimExecutor (conservative shadow fills)', () => {
  const book = { bid: 99.9, bidQty: 5, ask: 100.1, askQty: 5 };

  it('queue ahead is capped by the displayed size at our level, and never grows', () => {
    const s = new SimExecutor({ latencyMs: 0, makerFeeRate: 0 });
    s.onBook(0, { bid: 99.9, bidQty: 100, ask: 100.1, askQty: 5 });
    s.place(0, { clientOrderId: 'q', side: 'BUY', price: 99.9, qty: 2 }); // joins behind 100
    s.onBook(1, { bid: 99.9, bidQty: 3, ask: 100.1, askQty: 5 }); // 97 cancelled ahead → ≤ 3 ahead
    s.onBook(2, { bid: 99.9, bidQty: 50, ask: 100.1, askQty: 5 }); // newcomers queue BEHIND us
    const fills = s.onTrade({ ts: 3, price: 99.9, qty: 4, aggressor: 'sell' });
    expect(fills).toMatchObject([{ kind: 'fill', clientOrderId: 'q', qty: 1, price: 99.9 }]);
  });

  it('an order placed below the best gets a finite queue once the market comes down to it', () => {
    const s = new SimExecutor({ latencyMs: 0, makerFeeRate: 0 });
    s.onBook(0, book);
    s.place(0, { clientOrderId: 'd', side: 'BUY', price: 99.8, qty: 1 }); // below best: infinite queue
    expect(s.onTrade({ ts: 1, price: 99.8, qty: 10, aggressor: 'sell' }).filter((e) => e.kind === 'fill')).toEqual([]);
    s.onBook(2, { bid: 99.8, bidQty: 2, ask: 99.9, askQty: 5 });
    const fills = s.onTrade({ ts: 3, price: 99.8, qty: 3, aggressor: 'sell' });
    expect(fills).toMatchObject([{ kind: 'fill', clientOrderId: 'd', qty: 1 }]);
  });

  it('partial fills are decimal: no binary-float residue reaches the ledger', () => {
    const s = new SimExecutor({ latencyMs: 0, makerFeeRate: 0 });
    s.onBook(0, book);
    s.place(0, { clientOrderId: 'p', side: 'BUY', price: 100, qty: 0.02 });
    const f1 = s.onTrade({ ts: 1, price: 100, qty: 0.0079, aggressor: 'sell' });
    const f2 = s.onTrade({ ts: 2, price: 100, qty: 1, aggressor: 'sell' });
    expect(f1).toMatchObject([{ qty: 0.0079 }]);
    expect(f2).toMatchObject([{ qty: 0.0121 }]); // raw float: 0.012100000000000001
    expect(s.onTrade({ ts: 3, price: 100, qty: 1, aggressor: 'sell' })).toEqual([]); // fully filled, removed
  });

  it('activates after latency and rejects orders that would cross', () => {
    const s = new SimExecutor({ latencyMs: 100, makerFeeRate: 0 });
    s.onBook(0, book);
    expect(s.place(0, { clientOrderId: 'a', side: 'BUY', price: 100, qty: 1 })).toEqual([]);
    expect(s.advance(99)).toEqual([]);
    expect(s.advance(100)).toEqual([{ kind: 'order', ts: 100, clientOrderId: 'a', status: 'NEW' }]);
    s.place(100, { clientOrderId: 'x', side: 'BUY', price: 100.1, qty: 1 });
    expect(s.advance(200)[0]).toMatchObject({ clientOrderId: 'x', status: 'REJECTED' });
  });

  it('front of queue when improving the best; fills on a trade at or through our price', () => {
    const s = new SimExecutor({ latencyMs: 0, makerFeeRate: 0.001 });
    s.onBook(0, book);
    s.place(0, { clientOrderId: 'b', side: 'BUY', price: 100, qty: 1 }); // inside spread → 0 ahead
    const f = s.onTrade({ ts: 1, price: 100, qty: 0.4, aggressor: 'sell' });
    expect(f).toEqual([{ kind: 'fill', ts: 1, clientOrderId: 'b', fillId: 'b-f1', side: 'BUY', price: 100, qty: 0.4, fee: 0.04, feeAsset: 'quote' }]);
    expect(s.onTrade({ ts: 2, price: 100.1, qty: 5, aggressor: 'buy' })).toEqual([]); // wrong side
  });

  it('joining the best waits for the displayed queue; behind the best needs a trade-through', () => {
    const s = new SimExecutor({ latencyMs: 0, makerFeeRate: 0 });
    s.onBook(0, book);
    s.place(0, { clientOrderId: 'j', side: 'BUY', price: 99.9, qty: 1 }); // 5 ahead
    expect(s.onTrade({ ts: 1, price: 99.9, qty: 4, aggressor: 'sell' })).toEqual([]);
    expect(s.onTrade({ ts: 2, price: 99.9, qty: 1.5, aggressor: 'sell' })[0]).toMatchObject({ qty: 0.5 });
    s.place(3, { clientOrderId: 'w', side: 'BUY', price: 99.8, qty: 1 }); // behind best
    expect(s.onTrade({ ts: 4, price: 99.8, qty: 100, aggressor: 'sell' }).filter((e) => e.clientOrderId === 'w')).toEqual([]);
    expect(s.onTrade({ ts: 5, price: 99.7, qty: 100, aggressor: 'sell' }).find((e) => e.clientOrderId === 'w')).toMatchObject({ qty: 1 });
  });

  it('an order can still fill while its cancel is in flight', () => {
    const s = new SimExecutor({ latencyMs: 50, makerFeeRate: 0 });
    s.onBook(0, book);
    s.place(0, { clientOrderId: 'c', side: 'SELL', price: 100, qty: 1 });
    s.advance(50);
    s.cancel(60, 'c');
    expect(s.onTrade({ ts: 100, price: 100.05, qty: 1, aggressor: 'buy' })[0]).toMatchObject({ kind: 'fill', qty: 1 });
    s.place(200, { clientOrderId: 'd', side: 'SELL', price: 100, qty: 1 });
    s.advance(250);
    s.cancel(260, 'd');
    expect(s.onTrade({ ts: 311, price: 100.05, qty: 1, aggressor: 'buy' }).map((e) => e.kind)).toEqual(['order']); // canceled first
  });
});
