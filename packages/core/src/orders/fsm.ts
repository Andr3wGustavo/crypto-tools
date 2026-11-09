import { shortHash } from '../math/rng';

export type OrderStatus =
  | 'INTENT' | 'SENT' | 'NEW' | 'PARTIAL' | 'FILLED'
  | 'CANCEL_REQ' | 'CANCELED' | 'REJECTED' | 'EXPIRED' | 'UNKNOWN';

export type OrderEvent =
  | 'send' | 'ack' | 'partial_fill' | 'fill' | 'cancel_request' | 'canceled'
  | 'rejected' | 'expired' | 'timeout' | 'reconcile_new' | 'reconcile_filled' | 'reconcile_canceled';

const T: Record<OrderStatus, Partial<Record<OrderEvent, OrderStatus>>> = {
  INTENT: { send: 'SENT', rejected: 'REJECTED' },
  SENT: { ack: 'NEW', partial_fill: 'PARTIAL', fill: 'FILLED', rejected: 'REJECTED', canceled: 'CANCELED', cancel_request: 'CANCEL_REQ', timeout: 'UNKNOWN', expired: 'EXPIRED' },
  NEW: { ack: 'NEW', partial_fill: 'PARTIAL', fill: 'FILLED', cancel_request: 'CANCEL_REQ', canceled: 'CANCELED', expired: 'EXPIRED', timeout: 'UNKNOWN' },
  PARTIAL: { partial_fill: 'PARTIAL', fill: 'FILLED', cancel_request: 'CANCEL_REQ', canceled: 'CANCELED', expired: 'EXPIRED', timeout: 'UNKNOWN' },
  // A cancel can race with fills: late fills keep the order in CANCEL_REQ (or FILLED).
  CANCEL_REQ: { ack: 'CANCEL_REQ', partial_fill: 'CANCEL_REQ', fill: 'FILLED', canceled: 'CANCELED', expired: 'EXPIRED', cancel_request: 'CANCEL_REQ', timeout: 'UNKNOWN' },
  UNKNOWN: { reconcile_new: 'NEW', reconcile_filled: 'FILLED', reconcile_canceled: 'CANCELED', ack: 'NEW', partial_fill: 'PARTIAL', fill: 'FILLED', canceled: 'CANCELED', rejected: 'REJECTED', expired: 'EXPIRED', timeout: 'UNKNOWN' },
  FILLED: {},
  CANCELED: {},
  REJECTED: {},
  EXPIRED: {},
};

export class IllegalOrderTransition extends Error {
  override name = 'IllegalOrderTransition';
}

export function nextStatus(s: OrderStatus, e: OrderEvent): OrderStatus {
  const n = T[s][e];
  if (!n) throw new IllegalOrderTransition(`${s} --${e}--> (illegal)`);
  return n;
}

export const isTerminal = (s: OrderStatus): boolean => s === 'FILLED' || s === 'CANCELED' || s === 'REJECTED' || s === 'EXPIRED';

/** Can still execute on the exchange (must be counted as exposure). */
export const canStillFill = (s: OrderStatus): boolean => !isTerminal(s) && s !== 'INTENT';

/** 6-char stable tag of a bot id (fits the 32-char clientOrderId limit). */
export const botTag = (botId: string): string => shortHash(botId, 6);

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Deterministic idempotency key: the same (bot, seq, side) always yields the same id,
 * so a retried or replayed placement can never create a duplicate order.
 */
export function makeClientOrderId(tag: string, seq: number, side: 'BUY' | 'SELL'): string {
  if (!Number.isInteger(seq) || seq < 0) throw new RangeError('seq must be a non-negative integer');
  const id = `cf${tag}${seq.toString(36)}${side === 'BUY' ? 'b' : 's'}`;
  if (!CLIENT_ID_RE.test(id)) throw new RangeError(`invalid clientOrderId ${id}`);
  return id;
}
