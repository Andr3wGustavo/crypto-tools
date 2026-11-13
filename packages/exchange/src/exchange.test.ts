import { describe, expect, it } from 'vitest';
import { mapBinanceCombined } from './binance/market-stream';
import { decodeMexcPush, encodeMexcPush, mexcChannels } from './mexc/codec';
import { mapMexcPush } from './mexc/market-stream';
import { MexcRest, MexcRestError, classifyMexcError, isUnknownOrder, mexcSymbolInfo, mexcWithdrawOutcome, signMexc } from './mexc/rest';
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

describe('MEXC REST failure semantics (what a failed order request means)', () => {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
  const fail = async (f: typeof fetch) => new MexcRest({ apiKey: 'k', apiSecret: 's', fetchImpl: f }).placeLimitMaker('IOUSDT', 'BUY', '1', '0.5', 'c1').then(() => undefined, (e: unknown) => e);

  it('classifies refusals (not executed) vs unknown outcomes (must be queried)', async () => {
    expect(classifyMexcError(await fail(reply(400, { code: 10101, msg: 'Insufficient balance' })))).toBe('rejected');
    expect(classifyMexcError(await fail(reply(400, { code: 700003, msg: 'Timestamp outside recvWindow' })))).toBe('clock');
    expect(classifyMexcError(await fail(reply(400, { code: 700002, msg: 'Signature not valid' })))).toBe('auth');
    const limited = await fail(reply(429, { code: 429, msg: 'Too Many Requests' }, { 'retry-after': '3' }));
    expect(classifyMexcError(limited)).toBe('rate_limited');
    expect((limited as MexcRestError).retryAfterMs).toBe(3_000);
    expect(classifyMexcError(await fail(reply(500, 'oops')))).toBe('unknown');
    expect(classifyMexcError(await fail(reply(502, '<html>bad gateway</html>')))).toBe('unknown');
    expect(classifyMexcError(await fail(reply(400, 'no json body')))).toBe('unknown');
    expect(classifyMexcError(await fail((async () => { throw new DOMException('timed out', 'TimeoutError'); }) as unknown as typeof fetch))).toBe('unknown');
    expect(classifyMexcError(await new MexcRest({ fetchImpl: reply(200, {}) }).account().then(() => undefined, (e: unknown) => e))).toBe('auth');
    expect(isUnknownOrder(await fail(reply(400, { code: -2011, msg: 'Unknown order sent' })))).toBe(true);
    expect(isUnknownOrder(await fail(reply(400, { code: 10101, msg: 'x' })))).toBe(false);
  });

  it('listenKey lifecycle: POST create, PUT keepalive, DELETE close, all signed', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const f = (async (url: string, init: { method: string }) => {
      calls.push({ method: init.method, url });
      return new Response(JSON.stringify({ listenKey: 'pqia91ma19a5s61cv6a81va65sdf19v8a65a1a5s61cv6a81va65sdf19v8a65a1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const rest = new MexcRest({ apiKey: 'k', apiSecret: 's', fetchImpl: f });
    const key = await rest.createListenKey();
    await rest.keepAliveListenKey(key);
    await rest.deleteListenKey(key);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'DELETE']);
    expect(calls.every((c) => c.url.startsWith('https://api.mexc.com/api/v3/userDataStream?') && /signature=[0-9a-f]{64}$/.test(c.url))).toBe(true);
    expect(calls[1]!.url).toContain(`listenKey=${key}`);
    await expect(new MexcRest({ apiKey: 'k', apiSecret: 's', fetchImpl: reply(200, {}) }).createListenKey()).rejects.toThrow(/no valid listenKey/);
  });

  it('wallet: withdraw is signed with our idempotency id (also as remark); history and address book parse', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const bodies: Record<string, unknown> = {
      '/api/v3/capital/withdraw': { id: 7781 },
      '/api/v3/capital/withdraw/history': [{ id: 7781, withdrawOrderId: null, remark: 'wdab12cd-1', address: 'Addr', amount: '20', applyTime: 5, coin: 'USDT', status: '6', transactionFee: '1' }],
      '/api/v3/capital/withdraw/address': { data: [{ coin: 'USDT', network: 'Solana(SOL)', address: 'Addr' }], totalPageNum: 1 },
    };
    const f = (async (url: string, init: { method: string }) => {
      calls.push({ method: init.method, url });
      const path = new URL(url).pathname;
      return new Response(JSON.stringify(bodies[path] ?? {}), { status: 200 });
    }) as unknown as typeof fetch;
    const rest = new MexcRest({ apiKey: 'k', apiSecret: 's', fetchImpl: f });
    expect(await rest.withdraw({ coin: 'USDT', netWork: 'SOL', address: 'Addr', amount: '20', withdrawOrderId: 'wdab12cd-1' })).toEqual({ id: '7781' });
    const w = new URL(calls[0]!.url);
    expect(calls[0]!.method).toBe('POST');
    expect(Object.fromEntries(['coin', 'netWork', 'address', 'amount', 'withdrawOrderId', 'remark'].map((k) => [k, w.searchParams.get(k)])))
      .toEqual({ coin: 'USDT', netWork: 'SOL', address: 'Addr', amount: '20', withdrawOrderId: 'wdab12cd-1', remark: 'wdab12cd-1' });
    expect(w.searchParams.get('signature')).toMatch(/^[0-9a-f]{64}$/);
    const h = await rest.withdrawHistory('USDT', 1, 2);
    expect(h[0]).toMatchObject({ id: '7781', status: 6, remark: 'wdab12cd-1' });
    expect((await rest.withdrawAddresses('USDT')).map((a) => a.address)).toEqual(['Addr']);
    await expect(new MexcRest({ apiKey: 'k', apiSecret: 's', fetchImpl: reply(200, {}) }).withdraw({ coin: 'USDT', netWork: 'SOL', address: 'A', amount: '1', withdrawOrderId: 'x' })).rejects.toThrow(/no id/);
    // Only SUCCESS / FAILED / CANCEL are final; anything else (even an unknown code) is in progress.
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 42].map(mexcWithdrawOutcome)).toEqual([
      'in_progress', 'in_progress', 'in_progress', 'in_progress', 'in_progress', 'in_progress', 'success', 'failed', 'failed', 'in_progress', 'in_progress',
    ]);
  });
});
