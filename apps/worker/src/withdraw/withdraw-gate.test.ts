import { describe, expect, it } from 'vitest';
import { StreamTail, appendCapped, type RedisCaller } from './stream-tail';
import { WITHDRAW_KEY_ATTESTATION, checkWithdrawGate, type WithdrawGateEnv } from './withdraw-gate';
import { WithdrawSetupError } from './withdrawer';

const env: WithdrawGateEnv = {
  TRADING_MODE: 'live', WITHDRAW_ENABLED: 'true', MEXC_WITHDRAW_API_KEY: 'wk', MEXC_WITHDRAW_API_SECRET: 'ws',
  WITHDRAW_KEY_ATTESTED: WITHDRAW_KEY_ATTESTATION, WITHDRAW_CHANNEL_SECRET: 'c2f1a9e8b7d6c5b4a3928170f6e5d4c3', LIVE_SYMBOL: 'IOUSDT',
  WITHDRAW_NETWORK: 'Solana(SOL)', WITHDRAW_ADDRESS: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
};

const problems = (e: WithdrawGateEnv): string[] => {
  try {
    checkWithdrawGate(e);
    return [];
  } catch (err) {
    if (err instanceof WithdrawSetupError) return err.problems;
    throw err;
  }
};

describe('withdrawer gate', () => {
  it('opens with everything in place, with the plan defaults', () => {
    expect(checkWithdrawGate(env)).toMatchObject({
      botId: 'mexc:IOUSDT:live', apiKey: 'wk',
      config: { coin: 'USDT', network: 'Solana(SOL)', minAmount: 20, dailyCap: 100, cooldownMs: 86_400_000 },
    });
  });

  it('refuses each missing piece, and lists them all', () => {
    expect(problems({ ...env, TRADING_MODE: 'shadow' })).toEqual(['TRADING_MODE must be "live"']);
    expect(problems({ ...env, WITHDRAW_ENABLED: 'false' })[0]).toMatch(/WITHDRAW_ENABLED/);
    expect(problems({ ...env, MEXC_API_KEY: 'tradekey' })[0]).toMatch(/trading key/);
    expect(problems({ ...env, MEXC_API_KEY: 'wk' })).toHaveLength(2); // present at all + same key
    expect(problems({ ...env, WITHDRAW_KEY_ATTESTED: 'yes' })[0]).toMatch(/WITHDRAW_KEY_ATTESTED/);
    expect(problems({ ...env, WITHDRAW_CHANNEL_SECRET: 'short' })[0]).toMatch(/WITHDRAW_CHANNEL_SECRET/);
    expect(problems({ ...env, WITHDRAW_ADDRESS: '0x52908400098527886E0F7030069857D2E4169EE7' })[0]).toMatch(/Solana/);
    expect(problems({ ...env, WITHDRAW_MIN: '5' })[0]).toMatch(/WITHDRAW_MIN must be ≥ 20/);
    expect(problems({ ...env, WITHDRAW_DAILY_CAP: '5000' })[0]).toMatch(/WITHDRAW_DAILY_CAP/);
    expect(problems({ ...env, WITHDRAW_DAILY_CAP: 'abc' })[0]).toMatch(/WITHDRAW_DAILY_CAP/);
    expect(problems({}).length).toBeGreaterThanOrEqual(7);
  });
});

describe('stream tail', () => {
  it('starts after the current last entry and never skips entries between reads', async () => {
    const log: string[][] = [];
    const replies: unknown[] = [
      [['5-0', ['m', 'old']]], // XREVRANGE: the current last entry
      [['s', [['6-0', ['m', 'a', 'sig', 'x']], ['7-0', ['m', 'b']]]]],
      null,
      [['s', [['8-0', ['m', 'c']]]]],
      '9-0',
    ];
    const r: RedisCaller = { call: async (...args: string[]) => { log.push(args); return replies.shift(); } };
    const t = new StreamTail(r, 's');
    expect(await t.next(100)).toEqual([{ id: '6-0', fields: { m: 'a', sig: 'x' } }, { id: '7-0', fields: { m: 'b' } }]);
    expect(await t.next(100)).toEqual([]);
    expect(await t.next(100)).toEqual([{ id: '8-0', fields: { m: 'c' } }]);
    expect(log.map((a) => a.at(-1))).toEqual(['1', '5-0', '7-0', '7-0']);
    expect(await appendCapped(r, 's', 1000, { m: 'd', sig: 'y' })).toBe('9-0');
    expect(log.at(-1)).toEqual(['XADD', 's', 'MAXLEN', '~', '1000', '*', 'm', 'd', 'sig', 'y']);
  });
});
