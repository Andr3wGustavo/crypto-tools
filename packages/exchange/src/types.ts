import type { SymbolRules } from '@cortex/core';

export interface BookTick {
  venue: string;
  symbol: string;
  /** Local receive time (ms). Strategy time is always local time, so replay = live. */
  ts: number;
  /** Exchange event time if provided (ms). */
  exchTs?: number;
  bid: number;
  bidQty: number;
  ask: number;
  askQty: number;
}

export interface TradeTick {
  venue: string;
  symbol: string;
  ts: number;
  exchTs?: number;
  tradeId?: string;
  price: number;
  qty: number;
  aggressor: 'buy' | 'sell';
}

export interface MarketDataHandlers {
  onBook?: (b: BookTick) => void;
  onTrade?: (t: TradeTick) => void;
  onStatus?: (s: { venue: string; state: 'connecting' | 'open' | 'closed' | 'stale' | 'error'; detail?: string }) => void;
}

export interface MarketStream {
  start(): void;
  stop(): void;
  /** ms since the last data frame (Infinity before the first). */
  lastMessageAgeMs(now?: number): number;
}

export interface VenueSymbolInfo {
  symbol: string;
  base: string;
  quote: string;
  rules: SymbolRules;
  makerFeeRate: number;
  takerFeeRate: number;
  tradable: boolean;
}

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();
