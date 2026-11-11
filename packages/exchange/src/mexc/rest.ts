import crypto from 'node:crypto';
import type { SymbolRules } from '@cortex/core';
import type { VenueSymbolInfo } from '../types';

export const MEXC_REST_BASE = 'https://api.mexc.com';

/** Raw subset of GET /api/v3/exchangeInfo symbol entries we rely on (verified against the live API, 2026-11-09). */
export interface MexcSymbolRaw {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  quotePrecision: number;
  baseSizePrecision: string;
  quoteAmountPrecision: string;
  makerCommission: string;
  takerCommission: string;
  isSpotTradingAllowed: boolean;
}

/**
 * MEXC rules → exchange-agnostic SymbolRules.
 *   tick          = 10^(−quotePrecision)
 *   step / minQty = baseSizePrecision        (e.g. "0.01")
 *   minNotional   = quoteAmountPrecision     (minimum order value in quote, e.g. "1" USDT)
 */
export function mexcSymbolInfo(raw: MexcSymbolRaw): VenueSymbolInfo {
  if (!Number.isInteger(raw.quotePrecision) || raw.quotePrecision < 0 || raw.quotePrecision > 18) {
    throw new RangeError(`unexpected quotePrecision ${raw.quotePrecision}`);
  }
  const tickSize = raw.quotePrecision === 0 ? '1' : `0.${'0'.repeat(raw.quotePrecision - 1)}1`;
  const step = raw.baseSizePrecision;
  const minNotional = Number(raw.quoteAmountPrecision);
  if (!(Number(step) > 0) || !(minNotional > 0)) throw new RangeError(`invalid rules for ${raw.symbol}`);
  const rules: SymbolRules = { tickSize, stepSize: step, minQty: step, minNotional };
  return {
    symbol: raw.symbol,
    base: raw.baseAsset,
    quote: raw.quoteAsset,
    rules,
    makerFeeRate: Number(raw.makerCommission),
    takerFeeRate: Number(raw.takerCommission),
    tradable: raw.status === '1' && raw.isSpotTradingAllowed,
  };
}

export class MexcRestError extends Error {
  override name = 'MexcRestError';
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
  }
}

/**
 * Minimal MEXC spot REST client. Public endpoints work without keys.
 * Signed endpoints (live trading, phase E8) sign the query string with HMAC-SHA256
 * and send the key in X-MEXC-APIKEY. Server-time offset is applied to every signed call.
 */
export class MexcRest {
  private timeOffsetMs = 0;

  constructor(
    private readonly opts: { base?: string; apiKey?: string; apiSecret?: string; recvWindow?: number; fetchImpl?: typeof fetch } = {},
  ) {}

  private get base() {
    return this.opts.base ?? MEXC_REST_BASE;
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number> = {}, signed = false): Promise<T> {
    const q = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (signed) {
      if (!this.opts.apiKey || !this.opts.apiSecret) throw new MexcRestError('signed endpoint requires API key/secret', 0);
      q.set('recvWindow', String(this.opts.recvWindow ?? 5_000));
      q.set('timestamp', String(Date.now() + this.timeOffsetMs));
      q.set('signature', signMexc(q.toString(), this.opts.apiSecret));
      headers['X-MEXC-APIKEY'] = this.opts.apiKey;
    }
    const url = `${this.base}${path}${q.size ? `?${q.toString()}` : ''}`;
    const res = await (this.opts.fetchImpl ?? fetch)(url, { method, headers, signal: AbortSignal.timeout(8_000) });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) {
      const b = body as { msg?: string; code?: number };
      throw new MexcRestError(`MEXC ${method} ${path} → ${res.status}: ${b?.msg ?? text.slice(0, 200)}`, res.status, b?.code);
    }
    return body as T;
  }

  /**
   * Measures and stores the server-time offset (server − local). NTP-style: takes `samples`
   * round trips and keeps the one with the smallest RTT, whose offset error is bounded by ±RTT/2
   * (the first request also pays the TLS handshake, so a single sample is badly biased).
   */
  async syncTime(samples = 5): Promise<{ offsetMs: number; rttMs: number; samples: number }> {
    let best: { offsetMs: number; rttMs: number } | undefined;
    for (let i = 0; i < Math.max(1, samples); i++) {
      const t0 = Date.now();
      const { serverTime } = await this.request<{ serverTime: number }>('GET', '/api/v3/time');
      const rttMs = Date.now() - t0;
      if (!best || rttMs < best.rttMs) best = { offsetMs: Math.round(serverTime - (t0 + rttMs / 2)), rttMs };
    }
    this.timeOffsetMs = best!.offsetMs;
    return { ...best!, samples: Math.max(1, samples) };
  }

  async symbolInfo(symbol: string): Promise<VenueSymbolInfo> {
    const r = await this.request<{ symbols: MexcSymbolRaw[] }>('GET', '/api/v3/exchangeInfo', { symbol: symbol.toUpperCase() });
    const raw = r.symbols?.[0];
    if (!raw) throw new MexcRestError(`symbol ${symbol} not found`, 404);
    return mexcSymbolInfo(raw);
  }

  async bookTicker(symbol: string): Promise<{ bidPrice: string; bidQty: string; askPrice: string; askQty: string }> {
    return this.request('GET', '/api/v3/ticker/bookTicker', { symbol: symbol.toUpperCase() });
  }

  // ---------------- signed (live, phase E8) ----------------

  placeLimitMaker(symbol: string, side: 'BUY' | 'SELL', quantity: string, price: string, newClientOrderId: string) {
    return this.request<{ orderId: string }>('POST', '/api/v3/order', { symbol, side, type: 'LIMIT_MAKER', quantity, price, newClientOrderId }, true);
  }

  cancelOrder(symbol: string, origClientOrderId: string) {
    return this.request('DELETE', '/api/v3/order', { symbol, origClientOrderId }, true);
  }

  cancelAll(symbol: string) {
    return this.request('DELETE', '/api/v3/openOrders', { symbol }, true);
  }

  queryOrder(symbol: string, origClientOrderId: string) {
    return this.request<{ status: string; executedQty: string; origQty: string }>('GET', '/api/v3/order', { symbol, origClientOrderId }, true);
  }

  openOrders(symbol: string) {
    return this.request<Array<{ clientOrderId: string; status: string }>>('GET', '/api/v3/openOrders', { symbol }, true);
  }

  account() {
    return this.request<{ balances: Array<{ asset: string; free: string; locked: string }> }>('GET', '/api/v3/account', {}, true);
  }
}

export function signMexc(query: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}
