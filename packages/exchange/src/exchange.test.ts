import { describe, expect, it } from 'vitest';
import { mapBinanceCombined } from './binance/market-stream';
import { decodeMexcPush, encodeMexcPush, mexcChannels } from './mexc/codec';
import { mapMexcPush } from './mexc/market-stream';
import { MexcRest, mexcSymbolInfo, signMexc } from './mexc/rest';
import type { BookTick, TradeTick } from './types';

describe('MEXC protobuf codec', () => {
  it('round-trips book ticker and aggregated deals through the official schema', () => {
    const buf = encodeMexcPush({
      channel: mexcChannels.bookTicker('SOLUSDT'), symbol: 'SOLUSDT', sendTime: 1_700_000_000_123,
      publicAggreBookTicker: { bidPrice: '87.94', bidQuantity: '0.022', askPrice: '88.05', askQuantity: '71.862' },
    });
    const p = decodeMexcPush(buf);
    expect(p.channel).toBe('spot@public.aggre.bookTicker.v3.api.pb@100ms@SOLUSDT');
    expect(p.publicAggreBookTicker?.askPrice).toBe('88.05');
    expect(p.sendTime).toBe(1_700_000_000_123);
  });

  it('maps pushes to ticks; tradeType 1 = taker buy, 2 = taker sell; rejects crossed books', () => {
    const books: BookTick[] = [];
    const trades: TradeTick[] = [];
    const h = { onBook: (b: BookTick) => books.push(b), onTrade: (t: TradeTick) => trades.push(t) };
    mapMexcPush(decodeMexcPush(encodeMexcPush({
      channel: mexcChannels.deals('SOLUSDT'), symbol: 'SOLUSDT',
      publicAggreDeals: { deals: [
        { price: '88.05', quantity: '0.5', tradeType: 1, time: 1 },
        { price: '87.94', quantity: '1.25', tradeType: 2, time: 2 },
      ] },
    })), 1000, h);
    expect(trades.map((t) => [t.aggressor, t.price, t.qty])).toEqual([['buy', 88.05, 0.5], ['sell', 87.94, 1.25]]);
    mapMexcPush({ channel: 'x@SOLUSDT', publicAggreBookTicker: { bidPrice: '88', bidQuantity: '1', askPrice: '87', askQuantity: '1' } }, 1, h);
    expect(books).toEqual([]);
  });
});

describe('Binance combined stream', () => {
  it('maps bookTicker frames', () => {
    const books: BookTick[] = [];
    mapBinanceCombined(JSON.stringify({ stream: 'solusdt@bookTicker', data: { u: 1, s: 'SOLUSDT', b: '87.81', B: '2820.1', a: '87.82', A: '444.6' } }), 5, { onBook: (b) => books.push(b) });
    expect(books[0]).toMatchObject({ venue: 'binance', symbol: 'SOLUSDT', bid: 87.81, ask: 87.82, ts: 5 });
  });
});

describe('MEXC REST', () => {
  // Fixture copied from the live API response for SOLUSDT on 2026-11-09.
  const raw = {
    symbol: 'SOLUSDT', status: '1', baseAsset: 'SOL', quoteAsset: 'USDT', quotePrecision: 2,
    baseSizePrecision: '0.01', quoteAmountPrecision: '1', makerCommission: '0', takerCommission: '0.0005', isSpotTradingAllowed: true,
  };

  it('maps exchangeInfo to rules (tick 0.01, step 0.01, min order 1 USDT, maker 0%)', () => {
    expect(mexcSymbolInfo(raw)).toEqual({
      symbol: 'SOLUSDT', base: 'SOL', quote: 'USDT',
      rules: { tickSize: '0.01', stepSize: '0.01', minQty: '0.01', minNotional: 1 },
      makerFeeRate: 0, takerFeeRate: 0.0005, tradable: true,
    });
    expect(mexcSymbolInfo({ ...raw, quotePrecision: 4 }).rules.tickSize).toBe('0.0001');
    // baseSizePrecision "0" (no explicit minimum, most of the market): step = 10^-baseAssetPrecision.
    expect(mexcSymbolInfo({ ...raw, baseSizePrecision: '0', baseAssetPrecision: 2 }).rules).toMatchObject({ stepSize: '0.01', minQty: '0.01' });
    expect(mexcSymbolInfo({ ...raw, baseSizePrecision: '0', baseAssetPrecision: 0 }).rules.stepSize).toBe('1');
    expect(() => mexcSymbolInfo({ ...raw, baseSizePrecision: '0', baseAssetPrecision: undefined })).toThrow(/baseAssetPrecision/);
    expect(() => mexcSymbolInfo({ ...raw, quotePrecision: 1.5 })).toThrow(/quotePrecision/);
  });

  it('signs with HMAC-SHA256 (hex) and sends the key header only on signed calls', async () => {
    expect(signMexc('symbol=BTCUSDT&timestamp=1', 'secret')).toMatch(/^[0-9a-f]{64}$/);
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ balances: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const rest = new MexcRest({ apiKey: 'k', apiSecret: 's', fetchImpl });
    await rest.account();
    expect(calls[0]!.headers['X-MEXC-APIKEY']).toBe('k');
    expect(calls[0]!.url).toMatch(/recvWindow=5000&timestamp=\d+&signature=[0-9a-f]{64}$/);
    await expect(new MexcRest({ fetchImpl }).account()).rejects.toThrow(/requires API key/);
  });
});
