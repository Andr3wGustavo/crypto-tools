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
  /** Decimals allowed in the base quantity. */
  baseAssetPrecision?: number;
  /** Minimum quantity / step; "0" on ~80% of symbols (no explicit minimum → use baseAssetPrecision). */
  baseSizePrecision: string;
  quoteAmountPrecision: string;
  makerCommission: string;
  takerCommission: string;
  isSpotTradingAllowed: boolean;
  /** "ST" = special treatment (risk warning / delisting watch). */
  st?: boolean;
}

export interface MexcTicker24h {
  symbol: string;
  bidPrice: string;
  askPrice: string;
  lastPrice: string;
  quoteVolume: string;
}

export interface MexcBookTicker {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
}

export interface MexcPublicTrade {
  price: string;
  qty: string;
  time: number;
  isBuyerMaker: boolean;
}

/**
 * MEXC rules → exchange-agnostic SymbolRules.
 *   tick          = 10^(−quotePrecision)
 *   step / minQty = baseSizePrecision (e.g. "0.01"); when it is "0" (no explicit minimum, ~80% of
 *                   the market), 10^(−baseAssetPrecision) — the finest quantity the venue accepts
 *   minNotional   = quoteAmountPrecision     (minimum order value in quote, e.g. "1" USDT)
 */
export function mexcSymbolInfo(raw: MexcSymbolRaw): VenueSymbolInfo {
  const tickSize = decimalUnit(raw.quotePrecision, 'quotePrecision');
  const step = Number(raw.baseSizePrecision) > 0 ? raw.baseSizePrecision : decimalUnit(raw.baseAssetPrecision, 'baseAssetPrecision');
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

/** 10^(−decimals) as an exact decimal string ("1", "0.1", "0.001", …). */
function decimalUnit(decimals: number | undefined, field: string): string {
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new RangeError(`unexpected ${field} ${decimals}`);
  return decimals === 0 ? '1' : `0.${'0'.repeat(decimals - 1)}1`;
}

export class MexcRestError extends Error {
  override name = 'MexcRestError';
  constructor(message: string, readonly status: number, readonly code?: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

/**
 * What a failed request means for an order, the question live execution must answer exactly:
 *  - `rejected`: the exchange answered and refused it, so it did not happen (4xx with a body).
 *  - `rate_limited`: refused (429 / rate-limit code); back off before the next request.
 *  - `auth` / `clock`: refused because of credentials or timestamp; nothing works until fixed.
 *  - `unknown`: timeout, network error, 5xx or an unparseable reply. The request may or may
 *    not have been executed: the order state is UNKNOWN until queried (never assume either way).
 */
export type MexcFailure = 'rejected' | 'rate_limited' | 'auth' | 'clock' | 'unknown';

// Codes from the MEXC spot v3 error table. An unlisted 4xx code falls into `rejected`, which is
// still the safe reading (refused ⇒ not executed); only the reaction differs (halt vs retry later).
const AUTH_CODES = new Set([602, 700001, 700002, 700004, 700005, 700006, 700007, 10072]);
const CLOCK_CODES = new Set([700003]);
// -2011 "Unknown order sent"; -2013 "Order does not exist" (query of an id the exchange never saw).
const UNKNOWN_ORDER_CODES = new Set([-2011, -2013]);

export function classifyMexcError(err: unknown): MexcFailure {
  if (!(err instanceof MexcRestError)) return 'unknown';
  if (err.status === 429 || err.code === 429) return 'rate_limited';
  if (err.status === 0) return 'auth'; // missing credentials: refused locally, nothing was sent
  if (err.code !== undefined && AUTH_CODES.has(err.code)) return 'auth';
  if (err.code !== undefined && CLOCK_CODES.has(err.code)) return 'clock';
  if (err.status === 401 || err.status === 403) return 'auth';
  if (err.status >= 400 && err.status < 500 && err.code !== undefined) return 'rejected';
  return 'unknown';
}

/** The exchange does not know this order (never placed, or already gone): resolve by query. */
export const isUnknownOrder = (err: unknown): boolean => err instanceof MexcRestError && err.code !== undefined && UNKNOWN_ORDER_CODES.has(err.code);

/** Order as returned by query / cancel / openOrders (GET/DELETE /api/v3/order, /api/v3/openOrders). */
export interface MexcOrderRaw {
  symbol: string;
  orderId: string;
  clientOrderId: string;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty?: string;
  status: string;
  type?: string;
  side: 'BUY' | 'SELL';
  time?: number;
  updateTime?: number;
}

/** Fill as returned by GET /api/v3/myTrades. */
export interface MexcMyTrade {
  symbol: string;
  id: string;
  orderId: string;
  clientOrderId?: string;
  price: string;
  qty: string;
  quoteQty?: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
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

  /** Server − local clock (ms), as last measured by `syncTime`. */
  get timeOffset(): number {
    return this.timeOffsetMs;
  }

  private async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, params: Record<string, string | number> = {}, signed = false): Promise<T> {
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
      const b = (typeof body === 'object' && body !== null ? body : {}) as { msg?: string; code?: number };
      const ra = Number(res.headers.get('retry-after'));
      throw new MexcRestError(
        `MEXC ${method} ${path} → ${res.status}: ${b.msg ?? String(text).slice(0, 200)}`, res.status,
        typeof b.code === 'number' ? b.code : undefined, Number.isFinite(ra) && ra > 0 ? ra * 1_000 : undefined,
      );
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

  async bookTicker(symbol: string): Promise<MexcBookTicker> {
    return this.request('GET', '/api/v3/ticker/bookTicker', { symbol: symbol.toUpperCase() });
  }

  // ---------------- public, whole market (pair scanner) ----------------

  async exchangeInfoAll(): Promise<MexcSymbolRaw[]> {
    return (await this.request<{ symbols: MexcSymbolRaw[] }>('GET', '/api/v3/exchangeInfo')).symbols;
  }

  ticker24hAll(): Promise<MexcTicker24h[]> {
    return this.request('GET', '/api/v3/ticker/24hr');
  }

  bookTickerAll(): Promise<MexcBookTicker[]> {
    return this.request('GET', '/api/v3/ticker/bookTicker');
  }

  /** Most recent public trades (max 1000). */
  trades(symbol: string, limit = 1_000): Promise<MexcPublicTrade[]> {
    return this.request('GET', '/api/v3/trades', { symbol: symbol.toUpperCase(), limit: Math.min(1_000, Math.max(1, limit)) });
  }

  // ---------------- signed (live, phase E8) ----------------

  /** Post-only limit order: rejected (or canceled at once) by the exchange if it would take liquidity. */
  placeLimitMaker(symbol: string, side: 'BUY' | 'SELL', quantity: string, price: string, newClientOrderId: string) {
    return this.request<{ symbol: string; orderId: string; price?: string; origQty?: string; transactTime?: number }>(
      'POST', '/api/v3/order', { symbol, side, type: 'LIMIT_MAKER', quantity, price, newClientOrderId }, true,
    );
  }

  cancelOrder(symbol: string, origClientOrderId: string) {
    return this.request<MexcOrderRaw>('DELETE', '/api/v3/order', { symbol, origClientOrderId }, true);
  }

  cancelAll(symbol: string) {
    return this.request<MexcOrderRaw[]>('DELETE', '/api/v3/openOrders', { symbol }, true);
  }

  queryOrder(symbol: string, origClientOrderId: string) {
    return this.request<MexcOrderRaw>('GET', '/api/v3/order', { symbol, origClientOrderId }, true);
  }

  openOrders(symbol: string) {
    return this.request<MexcOrderRaw[]>('GET', '/api/v3/openOrders', { symbol }, true);
  }

  /** Own fills, newest last; `startTime` bounds the window (used to recover fills missed by the stream). */
  myTrades(symbol: string, startTime?: number, limit = 100) {
    return this.request<MexcMyTrade[]>('GET', '/api/v3/myTrades', { symbol, limit: Math.min(100, Math.max(1, limit)), ...(startTime !== undefined ? { startTime } : {}) }, true);
  }

  account() {
    return this.request<{ canTrade?: boolean; canWithdraw?: boolean; canDeposit?: boolean; permissions?: string[]; balances: Array<{ asset: string; free: string; locked: string }> }>('GET', '/api/v3/account', {}, true);
  }

  // ---------------- user data stream (listenKey: valid 60 min, extended by each keepalive) ----------------

  async createListenKey(): Promise<string> {
    const r = await this.request<{ listenKey?: string }>('POST', '/api/v3/userDataStream', {}, true);
    if (typeof r.listenKey !== 'string' || !/^[A-Za-z0-9]{16,128}$/.test(r.listenKey)) throw new MexcRestError('MEXC returned no valid listenKey', 200);
    return r.listenKey;
  }

  async keepAliveListenKey(listenKey: string): Promise<void> {
    await this.request('PUT', '/api/v3/userDataStream', { listenKey }, true);
  }

  async deleteListenKey(listenKey: string): Promise<void> {
    await this.request('DELETE', '/api/v3/userDataStream', { listenKey }, true);
  }
}

export function signMexc(query: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}
