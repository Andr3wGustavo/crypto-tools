/**
 * Cash / Treasury / Withdrawal policy ("empilhar lucro").
 *  - Realized profit is split: ρ stays in cash (compounds), (1 − ρ) moves to the treasury.
 *  - Losses are absorbed by cash only. The treasury never pays for losses.
 *  - Promotion: when treasury ≥ k · stageCapital, a fraction is promoted back to cash (two-stage compound).
 *  - Withdrawal (live only) has five independent locks: mode, halt, reconciliation/equity confirmation,
 *    minimum amount (≥ max(min, network min + fee)), cooldown (1/day) and daily cap — plus the
 *    in-flight lock (one withdrawal at a time, see withdrawal.ts).
 *  - Live: promotion is off. The capital stage (D1 → D2 …) is an operator decision (LIVE_CAPITAL_QUOTE).
 */
export interface TreasuryParams {
  reinvestRatio: number;
  promotion: { enabled: boolean; thresholdMultiple: number; fraction: number };
  withdrawal: { minAmount: number; cooldownMs: number; dailyCap: number; floor: number };
}

export const DEFAULT_TREASURY: TreasuryParams = {
  reinvestRatio: 0.5,
  promotion: { enabled: true, thresholdMultiple: 1, fraction: 0.5 },
  withdrawal: { minAmount: 20, cooldownMs: 24 * 3600_000, dailyCap: 100, floor: 0 },
};

export interface WithdrawalContext {
  mode: 'shadow' | 'live';
  halted: boolean;
  /** Lock: a previous withdrawal is not final yet (never two in flight). */
  inFlight?: boolean;
  reconcileOk: boolean;
  equityConfirmed: boolean;
  now: number;
  lastWithdrawalTs?: number;
  withdrawnLast24h: number;
  networkMin: number;
  networkFee: number;
}

export interface WithdrawalDecision {
  allowed: boolean;
  amount: number;
  reasons: string[];
}

const round8 = (x: number) => Math.floor(x * 1e8) / 1e8;

export class TreasuryPolicy {
  constructor(readonly p: TreasuryParams = DEFAULT_TREASURY) {
    if (!(p.reinvestRatio >= 0 && p.reinvestRatio <= 1)) throw new RangeError('reinvestRatio must be in [0,1]');
  }

  /** Amount to move cash → treasury for a realized PnL delta (0 for losses). Capped by free cash. */
  skimAmount(realizedDelta: number, cashFree: number): number {
    if (!(realizedDelta > 0)) return 0;
    return round8(Math.max(0, Math.min((1 - this.p.reinvestRatio) * realizedDelta, cashFree)));
  }

  /**
   * Live skim (cash → treasury) owed now, in quote units rounded down to `step`.
   *
   * Only profit that is BOTH realized (closed round trips) AND confirmed by mark-to-market equity
   * counts: target = (1 − ρ) · max(0, min(realized, profitToDate)), where profitToDate includes
   * everything already skimmed. The treasury never gives back (later losses lower the target, the
   * skimmed total stays). Capped by the quote not committed to resting orders (`spare`).
   */
  skimDue(i: { realizedPnl: number; profitToDate: number; skimmed: number; spare: number; step?: number; min?: number }): number {
    const step = i.step ?? 0.01;
    const floor = (x: number) => Math.floor(x / step + 1e-9) * step;
    const target = (1 - this.p.reinvestRatio) * Math.max(0, Math.min(i.realizedPnl, i.profitToDate));
    const due = floor(Math.min(target - i.skimmed, i.spare));
    const amount = Number(due.toFixed(12));
    return amount >= (i.min ?? step) - 1e-12 ? amount : 0;
  }

  /** Amount to move treasury → cash (promotion), or 0. */
  promotionAmount(treasury: number, stageCapital: number): number {
    const pr = this.p.promotion;
    if (!pr.enabled || !(stageCapital > 0)) return 0;
    return treasury >= pr.thresholdMultiple * stageCapital ? round8(pr.fraction * treasury) : 0;
  }

  withdrawalDecision(treasury: number, ctx: WithdrawalContext): WithdrawalDecision {
    const w = this.p.withdrawal;
    const reasons: string[] = [];
    if (ctx.mode !== 'live') reasons.push('not_live');
    if (ctx.halted) reasons.push('halted');
    if (ctx.inFlight) reasons.push('in_flight');
    if (!ctx.reconcileOk) reasons.push('reconcile_pending');
    if (!ctx.equityConfirmed) reasons.push('equity_unconfirmed');
    if (ctx.lastWithdrawalTs !== undefined && ctx.now - ctx.lastWithdrawalTs < w.cooldownMs) reasons.push('cooldown');
    const capLeft = Math.max(0, w.dailyCap - ctx.withdrawnLast24h);
    const amount = round8(Math.min(Math.max(0, treasury - w.floor), capLeft));
    const minimum = Math.max(w.minAmount, ctx.networkMin + ctx.networkFee);
    if (capLeft <= 0) reasons.push('daily_cap');
    if (amount < minimum) reasons.push('below_minimum');
    return { allowed: reasons.length === 0, amount: reasons.length === 0 ? amount : 0, reasons };
  }
}
