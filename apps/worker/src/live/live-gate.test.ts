import { describe, expect, it } from 'vitest';
import type { EvaluationReport } from '../evaluate';
import { KEY_ATTESTATION, LiveGateError, checkLiveGate, liveAck, type LiveGateEnv } from './live-gate';

const report: EvaluationReport = {
  kind: 'edge-evaluation', protocolHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', official: true, codeFingerprint: 'f', registeredFingerprint: 'f',
  evaluatedAt: '2026-11-30T00:00:00.000Z', asOf: null, pairs: 3, goThreshold: 0.99, results: [], go: ['IOUSDT', 'ZKUSDT'], status: 'GO',
};
const env: LiveGateEnv = {
  TRADING_MODE: 'live', LIVE_SYMBOL: 'IOUSDT', LIVE_ACK: liveAck(report, 'IOUSDT'), LIVE_CAPITAL_QUOTE: '15',
  LIVE_KEY_ATTESTED: KEY_ATTESTATION, MEXC_API_KEY: 'k', MEXC_API_SECRET: 's', WITHDRAW_ENABLED: 'false',
};
const account = { canTrade: true, permissions: ['SPOT'] };

// Explicit `undefined` must reach the gate (a default parameter would silently replace it).
const problems = (e: LiveGateEnv, ...ra: [EvaluationReport | undefined, typeof account | undefined] | [EvaluationReport | undefined] | []): string[] => {
  const r = ra.length >= 1 ? ra[0] : report;
  const a = ra.length >= 2 ? ra[1] : account;
  try {
    checkLiveGate(e, r, a);
    return [];
  } catch (err) {
    if (err instanceof LiveGateError) return err.problems;
    throw err;
  }
};

describe('live gate', () => {
  it('opens only with every condition satisfied', () => {
    expect(liveAck(report, 'IOUSDT')).toBe('GO-a1b2c3d4e5f6-IOUSDT');
    expect(checkLiveGate(env, report, account)).toEqual({ symbol: 'IOUSDT', capitalQuote: 15, ack: 'GO-a1b2c3d4e5f6-IOUSDT' });
  });

  it('each missing piece refuses, and all reasons are listed at once', () => {
    expect(problems({ ...env, TRADING_MODE: 'shadow' })).toEqual(['TRADING_MODE must be "live"']);
    expect(problems(env, undefined)).toEqual(['no evaluation report (LIVE_REPORT_FILE)']);
    expect(problems(env, { ...report, status: 'PENDING' })).toEqual(['the protocol status is PENDING, not GO']);
    expect(problems(env, { ...report, official: false })).toEqual(['the report is not official (evaluated by code other than the registered code)']);
    expect(problems({ ...env, LIVE_SYMBOL: 'ZKUSDT', LIVE_ACK: liveAck(report, 'ZKUSDT') })).toEqual(['D1 must use the best GO pair (IOUSDT), not ZKUSDT']);
    expect(problems({ ...env, LIVE_SYMBOL: 'BTCUSDT', LIVE_ACK: liveAck(report, 'BTCUSDT') })).toEqual(['BTCUSDT is not a GO pair (GO: IOUSDT, ZKUSDT)']);
    expect(problems({ ...env, LIVE_ACK: 'yes' })[0]).toMatch(/LIVE_ACK does not match/);
    expect(problems({ ...env, LIVE_ACK: liveAck({ protocolHash: 'ffffffffffffffff' }, 'IOUSDT') })[0]).toMatch(/LIVE_ACK/); // ack of another report
    expect(problems({ ...env, LIVE_CAPITAL_QUOTE: '50' })).toEqual(['LIVE_CAPITAL_QUOTE 50 exceeds LIVE_CAPITAL_MAX 15']);
    expect(problems({ ...env, LIVE_CAPITAL_QUOTE: '-1' })).toEqual(['LIVE_CAPITAL_QUOTE must be a positive amount']);
    expect(problems({ ...env, LIVE_KEY_ATTESTED: 'yes' })[0]).toMatch(/LIVE_KEY_ATTESTED/);
    expect(problems({ ...env, WITHDRAW_ENABLED: 'true' })[0]).toMatch(/WITHDRAW_ENABLED/);
    expect(problems({ ...env, MEXC_API_SECRET: '' })[0]).toMatch(/MEXC_API_KEY/);
    expect(problems(env, report, undefined)).toEqual(['could not read the MEXC account with these keys']);
    expect(problems(env, report, { canTrade: false, permissions: ['SPOT'] })).toEqual(['the MEXC account cannot trade']);
    expect(problems({}, undefined, undefined).length).toBeGreaterThanOrEqual(6);
  });
});
