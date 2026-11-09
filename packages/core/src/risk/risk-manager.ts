/**
 * Stateless risk evaluation. Called on every timer tick and after every fill.
 * Severity order: kill > halt > pause > reduce_only > ok.
 *   kill        : loss budget breached — manual reset required, never auto-resumes.
 *   halt        : drawdown / daily loss / reconciliation divergence — stays until reset (daily auto-clears next UTC day).
 *   pause       : transient health problems (stale data, errors, lag, clock) — auto-resumes when clear.
 *   reduce_only : inventory over cap — no new bids.
 */
export type RiskAction = 'ok' | 'reduce_only' | 'pause' | 'halt' | 'kill';

export interface RiskLimits {
  maxDrawdownPct: number;
  dailyLossPct: number;
  lossBudgetQuote: number;
  maxInventoryNotional: number;
  maxTickerAgeMs: number;
  maxErrorsPerMin: number;
  maxEventLoopLagMs: number;
  maxClockSkewMs: number;
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxDrawdownPct: 0.15,
  dailyLossPct: 0.1,
  lossBudgetQuote: 3,
  maxInventoryNotional: 3,
  maxTickerAgeMs: 3_000,
  maxErrorsPerMin: 10,
  maxEventLoopLagMs: 200,
  maxClockSkewMs: 1_000,
};

export interface RiskInputs {
  equity: number;
  peakEquity: number;
  dayStartEquity: number;
  startEquity: number;
  inventoryNotional: number;
  tickerAgeMs: number;
  errorsLastMin: number;
  eventLoopLagMs: number;
  clockSkewMs: number;
  reconcileDiverged: boolean;
}

export interface RiskViolation {
  rule: string;
  severity: Exclude<RiskAction, 'ok'>;
  message: string;
}

export interface RiskDecision {
  action: RiskAction;
  violations: RiskViolation[];
}

const RANK: Record<RiskAction, number> = { ok: 0, reduce_only: 1, pause: 2, halt: 3, kill: 4 };

export function evaluateRisk(l: RiskLimits, i: RiskInputs): RiskDecision {
  const v: RiskViolation[] = [];
  const loss = i.startEquity - i.equity;
  if (loss >= l.lossBudgetQuote) {
    v.push({ rule: 'loss_budget', severity: 'kill', message: `loss ${loss.toFixed(4)} ≥ budget ${l.lossBudgetQuote}` });
  }
  if (i.peakEquity > 0) {
    const dd = (i.peakEquity - i.equity) / i.peakEquity;
    if (dd >= l.maxDrawdownPct) {
      v.push({ rule: 'max_drawdown', severity: 'halt', message: `drawdown ${(dd * 100).toFixed(2)}% ≥ ${(l.maxDrawdownPct * 100).toFixed(2)}%` });
    }
  }
  if (i.dayStartEquity > 0) {
    const dl = (i.dayStartEquity - i.equity) / i.dayStartEquity;
    if (dl >= l.dailyLossPct) {
      v.push({ rule: 'daily_loss', severity: 'halt', message: `daily loss ${(dl * 100).toFixed(2)}% ≥ ${(l.dailyLossPct * 100).toFixed(2)}%` });
    }
  }
  if (i.reconcileDiverged) v.push({ rule: 'reconcile', severity: 'halt', message: 'exchange state diverged from internal state' });
  if (i.tickerAgeMs > l.maxTickerAgeMs) v.push({ rule: 'stale_ticker', severity: 'pause', message: `ticker age ${i.tickerAgeMs}ms` });
  if (i.errorsLastMin > l.maxErrorsPerMin) v.push({ rule: 'error_rate', severity: 'pause', message: `${i.errorsLastMin} errors/min` });
  if (i.eventLoopLagMs > l.maxEventLoopLagMs) v.push({ rule: 'event_loop_lag', severity: 'pause', message: `lag ${i.eventLoopLagMs}ms` });
  if (Math.abs(i.clockSkewMs) > l.maxClockSkewMs) v.push({ rule: 'clock_skew', severity: 'pause', message: `skew ${i.clockSkewMs}ms` });
  if (i.inventoryNotional > l.maxInventoryNotional) {
    v.push({ rule: 'inventory_cap', severity: 'reduce_only', message: `inventory ${i.inventoryNotional.toFixed(4)} > ${l.maxInventoryNotional}` });
  }
  const action = v.reduce<RiskAction>((acc, x) => (RANK[x.severity] > RANK[acc] ? x.severity : acc), 'ok');
  return { action, violations: v };
}

/**
 * Worst-case live loss bound promised to the user:
 *   L_max ≈ lossBudget + maxInventoryNotional · extremeGapPct
 * (excludes exchange counterparty risk).
 */
export function worstCaseLoss(l: RiskLimits, extremeGapPct = 0.5): number {
  return l.lossBudgetQuote + l.maxInventoryNotional * extremeGapPct;
}
