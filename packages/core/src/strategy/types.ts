import type { AsParams } from '../quoting/avellaneda';
import type { Side, SymbolRules } from '../quoting/quote-builder';
import type { RiskAction, RiskLimits, RiskViolation } from '../risk/risk-manager';
import type { LeadLagParams } from '../signals/lead-lag';
import type { MarkoutParams, MarkoutResult } from '../signals/markouts';
import type { VolParams } from '../stats/vol';

export interface StrategyConfig {
  botId: string;
  base: string;
  quote: string;
  rules: SymbolRules;
  as: AsParams;
  makerFeeBps: number;
  /** Order size = max(minNotional · minOrderMultiple, orderFraction · equity). */
  orderFraction: number;
  minOrderMultiple: number;
  /** Inventory cap = max(order size, maxInventoryFraction · equity) — "1 lot or 20%". */
  maxInventoryFraction: number;
  requote: { minIntervalMs: number; thresholdBps: number; maxAgeMs: number };
  /** Reduce-side minimum edge decays from cost to `minEdgeBpsAtFull` as inventory ages. */
  inventoryDecay: { startMs: number; fullMs: number; minEdgeBpsAtFull: number };
  pennyMinSpreadTicks: number;
  maxDeviationBps: number;
  cashBufferPct: number;
  sampleIntervalMs: number;
  vol: VolParams;
  leadLag: LeadLagParams;
  markouts: MarkoutParams;
  risk: RiskLimits;
}

export interface BookEvent {
  kind: 'book';
  venue: 'local' | 'reference';
  ts: number;
  bid: number;
  bidQty: number;
  ask: number;
  askQty: number;
}

export type StrategyEvent =
  | BookEvent
  /** UNKNOWN (live only): the outcome of a request is unknown; the side is frozen until resolved. */
  | { kind: 'order'; ts: number; clientOrderId: string; status: 'NEW' | 'CANCELED' | 'REJECTED' | 'EXPIRED' | 'UNKNOWN'; reason?: string }
  | { kind: 'fill'; ts: number; clientOrderId: string; fillId: string; side: Side; price: number; qty: number; fee: number; feeAsset: 'quote' | 'base' }
  | { kind: 'timer'; ts: number }
  | { kind: 'health'; ts: number; errorsLastMin: number; eventLoopLagMs: number; clockSkewMs: number; reconcileDiverged: boolean }
  | { kind: 'balances'; ts: number; quote: number; base: number }
  | { kind: 'command'; ts: number; command: 'pause' | 'resume' | 'reset_halt' | 'reset_kill' }
  /**
   * Live only: the venue cannot be trusted right now (user stream down, re-syncing, rate limited,
   * clock, auth). Non-null ⇒ cancel everything and do not quote; null ⇒ quote again. Never sent
   * in shadow, so shadow behaviour is unchanged.
   */
  | { kind: 'venue'; ts: number; hold: string | null }
  /**
   * Live only: quote moved out of (negative) or into (positive) the tradable balance by the
   * treasury (profit skim). Not PnL: start / peak / day-start equity move by the same amount, so
   * drawdown and loss limits are unaffected. Never sent in shadow.
   */
  | { kind: 'transfer'; ts: number; quote: number; reason: string };

export type BotStatus = 'running' | 'paused' | 'halted' | 'killed';

export interface QuoteSampleOut {
  kind: 'sample';
  ts: number;
  fair: number;
  mid: number;
  bid?: number;
  ask?: number;
  halfSpreadBps: number;
  skewBps: number;
  sigmaBps: number;
  asBps: number;
  q: number;
  toxic: boolean;
  equity: number;
  inventoryQty: number;
  quoteBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export type StrategyAction =
  | { kind: 'place'; ts: number; clientOrderId: string; side: Side; price: string; qty: string }
  | { kind: 'cancel'; ts: number; clientOrderId: string; reason: string }
  | { kind: 'risk'; ts: number; action: RiskAction; violations: RiskViolation[] }
  | { kind: 'status'; ts: number; status: BotStatus; quoting: boolean; reason: string }
  | ({ kind: 'markout' } & MarkoutResult)
  | QuoteSampleOut
  | { kind: 'error'; ts: number; message: string };
