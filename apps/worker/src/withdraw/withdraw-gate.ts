import { validChannelSecret } from './channel';
import { DEFAULT_WITHDRAWER, WithdrawSetupError, type WithdrawerConfig } from './withdrawer';

/** Typed by the operator after creating the withdraw key: what they checked in the MEXC UI. */
export const WITHDRAW_KEY_ATTESTATION = 'withdraw-only,ip-bound,address-whitelisted';
/** Hard limits of the plan: never below US$20, never more than this per day. */
export const WITHDRAW_MIN_FLOOR = 20;
export const WITHDRAW_DAILY_CAP_CEILING = 1_000;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type WithdrawGateEnv = Partial<Record<string, string | undefined>>;

export interface WithdrawGate {
  botId: string;
  apiKey: string;
  apiSecret: string;
  channelSecret: string;
  config: WithdrawerConfig;
}

const num = (v: string | undefined, dflt: number) => (v === undefined || v.trim() === '' ? dflt : Number(v));

/**
 * The withdrawer process starts only when every condition holds (all problems listed at once):
 * live mode, WITHDRAW_ENABLED=true here (and only here), its own withdraw-only key and never the
 * trading key, the operator's key attestation, an authenticated channel, one Solana treasury
 * address, and limits inside the plan's hard bounds.
 */
export function checkWithdrawGate(env: WithdrawGateEnv): WithdrawGate {
  const problems: string[] = [];
  if (env.TRADING_MODE !== 'live') problems.push('TRADING_MODE must be "live"');
  if (env.WITHDRAW_ENABLED !== 'true') problems.push('WITHDRAW_ENABLED must be "true" (in the withdrawer only)');
  const apiKey = env.MEXC_WITHDRAW_API_KEY ?? '';
  const apiSecret = env.MEXC_WITHDRAW_API_SECRET ?? '';
  if (!apiKey || !apiSecret) problems.push('MEXC_WITHDRAW_API_KEY and MEXC_WITHDRAW_API_SECRET are required');
  if (env.MEXC_API_KEY || env.MEXC_API_SECRET) problems.push('the trading key (MEXC_API_KEY / MEXC_API_SECRET) must not be given to the withdrawer');
  if (apiKey && apiKey === env.MEXC_API_KEY) problems.push('the withdraw key must be a different key from the trading key');
  if (env.WITHDRAW_KEY_ATTESTED !== WITHDRAW_KEY_ATTESTATION) {
    problems.push(`WITHDRAW_KEY_ATTESTED must be "${WITHDRAW_KEY_ATTESTATION}" (withdraw permission only, bound to the VPS IP, treasury address in the address book)`);
  }
  if (!validChannelSecret(env.WITHDRAW_CHANNEL_SECRET)) problems.push('WITHDRAW_CHANNEL_SECRET must be a random string of at least 32 characters (same value in the live process)');
  const symbol = env.LIVE_SYMBOL ?? '';
  if (!/^[A-Z0-9]{4,20}$/.test(symbol)) problems.push('LIVE_SYMBOL is required (the live bot whose treasury this withdrawer serves)');
  const coin = (env.WITHDRAW_COIN ?? 'USDT').toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(coin)) problems.push('WITHDRAW_COIN is not a coin symbol');
  const network = env.WITHDRAW_NETWORK ?? '';
  if (!network.trim()) problems.push('WITHDRAW_NETWORK is required (the exact MEXC network name, e.g. the Solana network of USDT)');
  const address = env.WITHDRAW_ADDRESS ?? '';
  if (!SOLANA_ADDRESS.test(address)) problems.push('WITHDRAW_ADDRESS must be the Solana treasury wallet address (base58, 32–44 characters)');
  const minAmount = num(env.WITHDRAW_MIN, DEFAULT_WITHDRAWER.minAmount);
  const dailyCap = num(env.WITHDRAW_DAILY_CAP, DEFAULT_WITHDRAWER.dailyCap);
  if (!(minAmount >= WITHDRAW_MIN_FLOOR)) problems.push(`WITHDRAW_MIN must be ≥ ${WITHDRAW_MIN_FLOOR}`);
  if (!(dailyCap >= minAmount && dailyCap <= WITHDRAW_DAILY_CAP_CEILING)) problems.push(`WITHDRAW_DAILY_CAP must be between WITHDRAW_MIN and ${WITHDRAW_DAILY_CAP_CEILING}`);
  if (problems.length > 0) throw new WithdrawSetupError(problems);
  return {
    botId: `mexc:${symbol}:live`,
    apiKey, apiSecret,
    channelSecret: env.WITHDRAW_CHANNEL_SECRET!,
    config: { ...DEFAULT_WITHDRAWER, coin, network, address, minAmount, dailyCap, ...(env.WITHDRAW_MEMO ? { memo: env.WITHDRAW_MEMO } : {}) },
  };
}
