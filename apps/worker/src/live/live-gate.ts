import type { EvaluationReport } from '../evaluate';

/**
 * The live gate: every condition must hold or the live worker refuses to boot. It is checked
 * once at boot, and the reasons are listed all together so the operator fixes them in one pass.
 *
 * What the API can prove is checked (report, account can trade). What it cannot (MEXC exposes no
 * API-key permission or IP-binding endpoint) is an explicit, typed operator attestation — never
 * an assumption.
 */
export interface LiveGateEnv {
  TRADING_MODE?: string;
  LIVE_SYMBOL?: string;
  LIVE_ACK?: string;
  LIVE_CAPITAL_QUOTE?: string;
  LIVE_CAPITAL_MAX?: string;
  /** Typed by the operator after checking in the MEXC UI: trade-only key, withdrawals off, bound to the VPS IP. */
  LIVE_KEY_ATTESTED?: string;
  MEXC_API_KEY?: string;
  MEXC_API_SECRET?: string;
  WITHDRAW_ENABLED?: string;
}

export interface LiveGateAccount {
  canTrade?: boolean;
  permissions?: string[];
}

export interface LiveGateResult {
  symbol: string;
  capitalQuote: number;
  ack: string;
}

export const KEY_ATTESTATION = 'trade-only,no-withdraw,ip-bound';

/** The value the operator must type for a GO report and pair: a deliberate, auditable act. */
export const liveAck = (report: Pick<EvaluationReport, 'protocolHash'>, symbol: string): string => `GO-${report.protocolHash.slice(0, 12)}-${symbol}`;

export class LiveGateError extends Error {
  override name = 'LiveGateError';
  constructor(readonly problems: string[]) {
    super(`live trading refused:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

export function checkLiveGate(env: LiveGateEnv, report: EvaluationReport | undefined, account: LiveGateAccount | undefined): LiveGateResult {
  const problems: string[] = [];
  const symbol = (env.LIVE_SYMBOL ?? '').toUpperCase();
  if (env.TRADING_MODE !== 'live') problems.push('TRADING_MODE must be "live"');
  if (!/^[A-Z0-9]{4,20}$/.test(symbol)) problems.push('LIVE_SYMBOL must be one pair, e.g. IOUSDT');

  if (!report) {
    problems.push('no evaluation report (LIVE_REPORT_FILE)');
  } else {
    if (report.kind !== 'edge-evaluation') problems.push('LIVE_REPORT_FILE is not an edge evaluation report');
    if (!report.official) problems.push('the report is not official (evaluated by code other than the registered code)');
    if (report.status !== 'GO') problems.push(`the protocol status is ${report.status}, not GO`);
    if (symbol && !report.go.includes(symbol)) problems.push(`${symbol} is not a GO pair (GO: ${report.go.join(', ') || 'none'})`);
    else if (symbol && report.go[0] !== symbol) problems.push(`D1 must use the best GO pair (${report.go[0]}), not ${symbol}`);
    if (symbol && env.LIVE_ACK !== liveAck(report, symbol)) problems.push(`LIVE_ACK does not match this report and pair (expected the value printed by the evaluator for ${symbol})`);
  }

  const capital = Number(env.LIVE_CAPITAL_QUOTE);
  const max = env.LIVE_CAPITAL_MAX === undefined ? 15 : Number(env.LIVE_CAPITAL_MAX);
  if (!(capital > 0)) problems.push('LIVE_CAPITAL_QUOTE must be a positive amount');
  else if (!(capital <= max)) problems.push(`LIVE_CAPITAL_QUOTE ${capital} exceeds LIVE_CAPITAL_MAX ${max}`);

  if (!env.MEXC_API_KEY || !env.MEXC_API_SECRET) problems.push('MEXC_API_KEY / MEXC_API_SECRET missing');
  if (env.LIVE_KEY_ATTESTED !== KEY_ATTESTATION) problems.push(`LIVE_KEY_ATTESTED must be "${KEY_ATTESTATION}" after checking the key in the MEXC UI`);
  if (env.WITHDRAW_ENABLED === 'true') problems.push('WITHDRAW_ENABLED must be false in the trading process (withdrawals use a separate key and process)');

  if (!account) problems.push('could not read the MEXC account with these keys');
  else {
    if (account.canTrade === false) problems.push('the MEXC account cannot trade');
    if (account.permissions && !account.permissions.includes('SPOT')) problems.push('the API key has no SPOT permission');
  }

  if (problems.length > 0) throw new LiveGateError(problems);
  return { symbol, capitalQuote: capital, ack: env.LIVE_ACK! };
}
