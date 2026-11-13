import { describe, expect, it } from 'vitest';
import { decodeMexcPush, encodeMexcPush, type MexcPush } from './codec';
import { mexcMyTradeToExec, mexcPrivateChannels, mexcPrivateToExec, mexcRestOrderToExec, type MexcPrivatePush } from './private';

/** Round trip through the real protobuf schema: what the user stream will actually receive. */
const wire = (p: MexcPrivatePush): MexcPrivatePush => decodeMexcPush(encodeMexcPush(p as unknown as MexcPush)) as unknown as MexcPrivatePush;
const T = 1_794_571_200_000;

describe('MEXC private push → execution events', () => {
  it('order updates: status codes, side, exact decimal strings', () => {
    const p = wire({
      channel: mexcPrivateChannels.orders, symbol: 'IOUSDT', sendTime: T,
      privateOrders: { id: 'C02__1', clientId: 'cx-io-b-000042', price: '0.512300', quantity: '4.00', tradeType: 1, status: 3, cumulativeQuantity: '1.50', remainQuantity: '2.50', orderType: 2, isMaker: true, createTime: T },
    });
    expect(mexcPrivateToExec(p, T + 5)).toEqual([{
      kind: 'order', ts: T + 5, symbol: 'IOUSDT', clientOrderId: 'cx-io-b-000042', orderId: 'C02__1', side: 'BUY',
      status: 'PARTIALLY_FILLED', statusCode: 3, price: '0.512300', qty: '4.00', cumQty: '1.50', remainQty: '2.50',
    }]);
    const codes = [1, 2, 4, 5, 9].map((status) => (mexcPrivateToExec(wire({ channel: 'x', symbol: 'IOUSDT', privateOrders: { id: 'o', clientId: 'c', status, tradeType: 2 } }), T)[0] as { status: string }).status);
    expect(codes).toEqual(['NEW', 'FILLED', 'CANCELED', 'PARTIALLY_CANCELED', 'UNKNOWN']);
  });

  it('deals become fills keyed by tradeId, with fee and maker flag', () => {
    const p = wire({
      channel: mexcPrivateChannels.deals, symbol: 'IOUSDT',
      privateDeals: { price: '0.5123', quantity: '1.5', amount: '0.76845', tradeType: 2, isMaker: true, isSelfTrade: false, tradeId: 't-9', clientOrderId: 'cx-io-s-000043', orderId: 'C02__2', feeAmount: '0', feeCurrency: 'usdt', time: T },
    });
    expect(mexcPrivateToExec(p, T)).toEqual([{
      kind: 'fill', ts: T, symbol: 'IOUSDT', clientOrderId: 'cx-io-s-000043', orderId: 'C02__2', tradeId: 't-9', side: 'SELL',
      price: '0.5123', qty: '1.5', fee: '0', feeAsset: 'USDT', isMaker: true, selfTrade: false,
    }]);
  });

  it('account pushes become balances', () => {
    const p = wire({ channel: mexcPrivateChannels.account, privateAccount: { vcoinName: 'usdt', balanceAmount: '14.9', frozenAmount: '2.05', type: 'ENTRUST', time: T } });
    expect(mexcPrivateToExec(p, T)).toEqual([{ kind: 'balance', ts: T, asset: 'USDT', free: '14.9', locked: '2.05' }]);
  });

  it('malformed pushes throw (fail-closed upstream), they are never guessed', () => {
    expect(() => mexcPrivateToExec({ channel: 'x', privateDeals: { tradeType: 1, price: '1', quantity: '1' } }, T)).toThrow(/tradeId/);
    expect(() => mexcPrivateToExec({ channel: 'x', privateDeals: { tradeId: 't', tradeType: 3 } }, T)).toThrow(/side/);
    expect(() => mexcPrivateToExec({ channel: 'x', privateOrders: { id: 'o', price: '1e-5' } }, T)).toThrow(/decimal/);
    expect(() => mexcPrivateToExec({ channel: 'x', privateOrders: {} }, T)).toThrow(/ids/);
    expect(mexcPrivateToExec({ channel: 'x' }, T)).toEqual([]);
  });

  it('REST replies map to the same events as the stream (exact decimals, unknown status never guessed)', () => {
    const raw = { symbol: 'iousdt', orderId: '123', clientOrderId: 'c', price: '0.5123', origQty: '4.10', executedQty: '1.35', status: 'PARTIALLY_FILLED', side: 'SELL' as const };
    expect(mexcRestOrderToExec(raw, T)).toEqual({
      kind: 'order', ts: T, symbol: 'IOUSDT', clientOrderId: 'c', orderId: '123', side: 'SELL', status: 'PARTIALLY_FILLED', statusCode: null,
      price: '0.5123', qty: '4.10', cumQty: '1.35', remainQty: '2.75', source: 'rest',
    });
    expect(mexcRestOrderToExec({ ...raw, status: 'WEIRD' }, T).status).toBe('UNKNOWN');
    expect(() => mexcRestOrderToExec({ ...raw, executedQty: 'NaN' }, T)).toThrow(/decimal/);
    expect(mexcMyTradeToExec({ symbol: 'IOUSDT', id: '77', orderId: '123', price: '0.5', qty: '2', commission: '0', commissionAsset: 'usdt', time: T, isBuyer: true, isMaker: true }, T)).toEqual({
      kind: 'fill', ts: T, symbol: 'IOUSDT', clientOrderId: '', orderId: '123', tradeId: '77', side: 'BUY', price: '0.5', qty: '2', fee: '0', feeAsset: 'USDT', isMaker: true, selfTrade: false,
    });
  });
});
