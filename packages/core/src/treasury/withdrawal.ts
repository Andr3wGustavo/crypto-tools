/**
 * Withdrawal state machine (treasury → owner's on-chain wallet).
 *
 *   PENDING ──► SENT ──► CONFIRMED
 *      │          │
 *      └──► FAILED ◄┘
 *
 *   PENDING    the amount is reserved (treasury → withdrawing) and handed to the withdrawer; it
 *              has NOT been submitted to the exchange yet.
 *   SENT       the withdrawer may have submitted it (written ahead of the API call). From here on
 *              only the exchange's own answer can end it: an ambiguous outcome stays SENT forever
 *              rather than risk a second payment.
 *   CONFIRMED  the exchange reports success: the reserve is settled (withdrawing → external + fee).
 *   FAILED     definitive failure (refused before sending, or failed / canceled by the exchange):
 *              the reserve goes back to the treasury.
 *
 * Re-reporting the current status is a no-op; terminal states never change.
 */
export type WithdrawalStatus = 'PENDING' | 'SENT' | 'CONFIRMED' | 'FAILED';

export const WITHDRAWAL_TERMINAL: ReadonlySet<WithdrawalStatus> = new Set(['CONFIRMED', 'FAILED']);

const ALLOWED: Record<WithdrawalStatus, readonly WithdrawalStatus[]> = {
  PENDING: ['SENT', 'FAILED', 'CONFIRMED'],
  SENT: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  FAILED: [],
};

export class WithdrawalTransitionError extends Error {
  override name = 'WithdrawalTransitionError';
}

/** 'same' = idempotent repeat; otherwise the new status. Throws on an impossible transition. */
export function nextWithdrawalStatus(from: WithdrawalStatus, to: WithdrawalStatus): WithdrawalStatus | 'same' {
  if (from === to) return 'same';
  // PENDING → CONFIRMED: the SENT report was lost, the exchange's final answer still counts.
  if (!ALLOWED[from].includes(to)) throw new WithdrawalTransitionError(`withdrawal ${from} → ${to} is not possible`);
  return to;
}

export interface WithdrawalRecord {
  /** Deterministic id; also the exchange's `withdrawOrderId` (idempotency across retries). */
  id: string;
  asset: string;
  /** Gross amount reserved and requested (the exchange deducts its fee from it). */
  amount: string;
  status: WithdrawalStatus;
  createdTs: number;
  updatedTs: number;
  exchangeId?: string;
  fee?: string;
  txId?: string;
  reason?: string;
}

/** Withdrawal ids: `wd<botTag>-<seq>`; letters/digits/dash only (safe as an exchange client id). */
export function withdrawalId(tag: string, seq: number): string {
  return `wd${tag}-${seq}`;
}

export const WITHDRAWAL_ID = /^wd[a-z0-9]{1,16}-\d{1,9}$/;
