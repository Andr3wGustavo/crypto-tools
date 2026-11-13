import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WITHDRAW_REQ_STREAM, WithdrawReportMsgSchema, WithdrawRequestMsgSchema, decodeMessage, encodeMessage, validChannelSecret, type WithdrawRequestMsg,
} from './channel';
import { ADDR, FakeWallet, NET } from '../testing/fake-wallet';
import { DEFAULT_WITHDRAWER, FileJournal, MemoryJournal, WithdrawSetupError, Withdrawer, resolveByHand, type WithdrawerConfig } from './withdrawer';

const T0 = 1_800_000_000_000;

function setup(over: Partial<WithdrawerConfig> = {}) {
  let now = T0;
  const wallet = new FakeWallet(() => now);
  const journal = new MemoryJournal();
  const logs: Array<{ level: string; o: Record<string, unknown> }> = [];
  const cfg: WithdrawerConfig = { coin: 'USDT', network: NET, address: ADDR, ...DEFAULT_WITHDRAWER, ...over };
  const w = new Withdrawer(cfg, wallet, journal, () => now, (level, o) => logs.push({ level, o }));
  const req = (id: string, amount: string, mode: WithdrawRequestMsg['mode'] = 'submit', createdTs = now): WithdrawRequestMsg => ({ v: 1, botId: 'mexc:SOLUSDT:live', id, asset: 'USDT', amount, createdTs, sentTs: now, mode });
  return { w, wallet, journal, logs, req, advance: (ms: number) => (now += ms), at: () => now };
}

describe('withdrawer: start-up gate', () => {
  it('refuses unless the network is enabled and the address is in the address book', async () => {
    const ok = setup();
    await expect(ok.w.verifySetup()).resolves.toMatchObject({ network: NET, fee: '1', min: '5' });

    const bad = setup({ network: 'TRX' });
    bad.wallet.book = [{ coin: 'USDT', network: NET, address: 'SomeoneElse111111111111111111111111111111111' }];
    const err = await bad.w.verifySetup().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WithdrawSetupError);
    expect((err as WithdrawSetupError).problems).toEqual([
      `network "TRX" not found for USDT (available: ${NET})`,
      "the treasury address is not in the account's USDT withdrawal address book",
    ]);
    const off = setup();
    off.wallet.config[0]!.networkList![0]!.withdrawEnable = false;
    await expect(off.w.verifySetup()).rejects.toThrow(/disabled by MEXC/);
  });
});

describe('withdrawer: submit, status, idempotency', () => {
  it('submits once; every re-ask reports the exchange status; CONFIRMED carries the fee and tx', async () => {
    const { w, wallet, req, advance } = setup();
    expect(await w.handle(req('wdab12cd-1', '25'))).toEqual({ id: 'wdab12cd-1', status: 'SENT', exchangeId: '101' });
    expect(wallet.calls).toBe(1);
    advance(60_000);
    expect(await w.handle(req('wdab12cd-1', '25', 'submit', T0))).toMatchObject({ status: 'SENT', reason: 'APPLY' }); // a duplicate submit is never re-sent
    expect(await w.handle(req('wdab12cd-1', '25', 'status', T0))).toMatchObject({ status: 'SENT' });
    expect(wallet.calls).toBe(1);
    wallet.set('101', 7, '5xSig');
    expect(await w.handle(req('wdab12cd-1', '25', 'status', T0))).toEqual({ id: 'wdab12cd-1', status: 'CONFIRMED', exchangeId: '101', txId: '5xSig', amount: '25', fee: '1' });
  });

  it('MEXC FAILED / CANCEL ⇒ FAILED; an unknown status code stays in progress', async () => {
    const { w, wallet, req } = setup();
    await w.handle(req('wdab12cd-1', '25'));
    wallet.set('101', 42);
    expect(await w.handle(req('wdab12cd-1', '25', 'status'))).toMatchObject({ status: 'SENT', reason: 'status 42' });
    wallet.set('101', 9);
    expect(await w.handle(req('wdab12cd-1', '25', 'status'))).toMatchObject({ status: 'FAILED', reason: 'MEXC CANCEL' });
  });

  it('the amount reported as received (gross − fee) still settles the reserve exactly', async () => {
    const { w, wallet, req } = setup();
    await w.handle(req('wdab12cd-1', '25'));
    const r = wallet.history[0]!;
    r.amount = '24';
    wallet.set('101', 7);
    expect(await w.handle(req('wdab12cd-1', '25', 'status'))).toMatchObject({ status: 'CONFIRMED', amount: '25', fee: '1' });
    r.amount = '3';
    expect(await w.handle(req('wdab12cd-1', '25', 'status'))).toMatchObject({ status: 'CONFIRMED', amount: '3' }); // engine halts on this
  });

  it('a timed-out call stays SENT; found later in the history it resolves; never re-sent', async () => {
    const { w, wallet, req, advance, journal } = setup();
    wallet.next = 'timeout-but-done'; // executed, answer lost, and the history row has no id/remark
    expect(await w.handle(req('wdab12cd-1', '25'))).toMatchObject({ status: 'SENT', reason: expect.stringMatching(/outcome unknown/) });
    expect(journal.get('wdab12cd-1')?.state).toBe('submitting');
    advance(60_000);
    // Matched by address + amount + time (the call's answer was lost).
    expect(await w.handle(req('wdab12cd-1', '25', 'submit', T0))).toMatchObject({ status: 'SENT', exchangeId: '101' });
    expect(journal.get('wdab12cd-1')).toMatchObject({ state: 'submitted', exchangeId: '101' });
    expect(wallet.calls).toBe(1);
  });

  it('a timed-out call never found stays SENT and asks for a human after 30 min (never FAILED)', async () => {
    const { w, wallet, req, advance, journal, logs } = setup();
    wallet.next = 'timeout';
    await w.handle(req('wdab12cd-1', '25'));
    wallet.history = []; // not visible
    advance(31 * 60_000);
    const r = await w.handle(req('wdab12cd-1', '25', 'submit', T0));
    expect(r).toMatchObject({ status: 'SENT', reason: expect.stringMatching(/resolve/) });
    expect(logs.some((l) => l.level === 'error')).toBe(true);
    expect(wallet.calls).toBe(1);
    // The human checks MEXC and settles it.
    resolveByHand(journal, 'wdab12cd-1', 'FAILED', undefined, T0 + 1);
    expect(await w.handle(req('wdab12cd-1', '25', 'status', T0))).toMatchObject({ status: 'FAILED' });
    expect(() => resolveByHand(journal, 'wdab12cd-1', 'CONFIRMED', '1', T0 + 2)).toThrow(/already final/);
    expect(() => resolveByHand(journal, 'wdzz-1', 'FAILED', undefined, T0)).toThrow(/not in the journal/);
  });

  it('an exchange refusal is final (nothing sent) unless the refusal says it already exists', async () => {
    const a = setup();
    a.wallet.next = 'refuse';
    expect(await a.w.handle(a.req('wdab12cd-1', '25'))).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/exchange refused \(rejected\)/) });
    a.wallet.next = 'ok';
    expect(await a.w.handle(a.req('wdab12cd-1', '25'))).toMatchObject({ status: 'FAILED' }); // refused ids stay refused
    expect(a.wallet.calls).toBe(1);

    const b = setup();
    b.wallet.history.push({ id: '55', withdrawOrderId: 'wdab12cd-1', address: ADDR, amount: '25', applyTime: T0, coin: 'USDT', status: 4, transactionFee: '1' });
    expect(await b.w.handle(b.req('wdab12cd-1', '25'))).toMatchObject({ status: 'SENT', exchangeId: '55' }); // journal lost, history knows
    expect(b.wallet.calls).toBe(0);
  });

  it('abort: never submitted ⇒ FAILED forever; already sent ⇒ the real status', async () => {
    const { w, wallet, req } = setup();
    expect(await w.handle(req('wdab12cd-1', '25', 'abort'))).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/aborted/) });
    expect(await w.handle(req('wdab12cd-1', '25', 'submit'))).toMatchObject({ status: 'FAILED' });
    await w.handle(req('wdab12cd-2', '25'));
    expect(await w.handle(req('wdab12cd-2', '25', 'abort'))).toMatchObject({ status: 'SENT', exchangeId: '101' });
    expect(wallet.calls).toBe(1);
  });
});

describe('withdrawer: the limits it enforces on its own', () => {
  it('minimum = max(US$20, network min + fee), maximum, daily cap, multiple, stale requests', async () => {
    const { w, wallet, req, advance } = setup();
    expect(await w.handle(req('wdab12cd-1', '19.99'))).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/below the minimum 20/) });
    wallet.config[0]!.networkList![0]!.withdrawMin = '22';
    expect(await w.handle(req('wdab12cd-2', '22.5'))).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/below the minimum 23/) });
    expect(await w.handle(req('wdab12cd-3', '150'))).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/daily cap 100/) });
    wallet.config[0]!.networkList![0]!.withdrawIntegerMultiple = '1';
    expect(await w.handle(req('wdab12cd-4', '30.5'))).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/multiple/) });
    const old = req('wdab12cd-5', '30', 'submit', T0);
    advance(11 * 60_000);
    expect(await w.handle(old)).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/stale/) });
    expect(wallet.calls).toBe(0);
  });

  it('one per 24 h, counted from the EXCHANGE history (manual withdrawals too)', async () => {
    const { w, wallet, req, advance } = setup();
    wallet.history.push({ id: '9', address: 'Elsewhere', amount: '30', applyTime: T0 - 2 * 3_600_000, coin: 'USDT', status: 7 }); // by hand
    expect(await w.handle(req('wdab12cd-1', '25'))).toMatchObject({ status: 'FAILED', reason: 'cooldown: last USDT withdrawal 120 min ago' });
    advance(23 * 3_600_000); // the manual one is now 25 h old
    expect(await w.handle(req('wdab12cd-2', '25'))).toMatchObject({ status: 'SENT' });
    advance(60_000);
    expect(await w.handle(req('wdab12cd-3', '25'))).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/cooldown/) });
    expect(wallet.calls).toBe(1);
  });

  it('the daily cap sums the 24 h history; failed / canceled withdrawals do not count', async () => {
    const { w, wallet, req } = setup({ cooldownMs: 3_600_000 });
    wallet.history.push({ id: '9', address: 'Elsewhere', amount: '90', applyTime: T0 - 2 * 3_600_000, coin: 'USDT', status: 6 });
    expect(await w.handle(req('wdab12cd-1', '25'))).toMatchObject({ status: 'FAILED', reason: 'daily cap: 90 already withdrawn in 24 h' });
    wallet.set('9', 8);
    expect(await w.handle(req('wdab12cd-2', '25'))).toMatchObject({ status: 'SENT' });
  });

  it('the address must still be whitelisted at submit time', async () => {
    const { w, wallet, req } = setup();
    wallet.book = [];
    expect(await w.handle(req('wdab12cd-1', '25'))).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/address book/) });
    expect(wallet.calls).toBe(0);
  });
});

describe('withdrawer: journal and channel', () => {
  it('the file journal survives a restart and ignores a torn last line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdj-'));
    const file = path.join(dir, 'journal.ndjson');
    const j = new FileJournal(file);
    j.append({ id: 'wdab12cd-1', state: 'submitting', ts: 1, amount: '25' });
    j.append({ id: 'wdab12cd-1', state: 'submitted', ts: 2, amount: '25', exchangeId: '7' });
    fs.appendFileSync(file, '{"id":"wdab12cd-2","sta');
    const k = new FileJournal(file);
    expect(k.get('wdab12cd-1')).toMatchObject({ state: 'submitted', exchangeId: '7' });
    expect(k.get('wdab12cd-2')).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('messages are authenticated: a forged, altered or malformed entry is refused', () => {
    const secret = 'k'.repeat(16) + 'Q'.repeat(16) + 'z';
    expect(validChannelSecret(secret)).toBe(true);
    expect(validChannelSecret('a'.repeat(40))).toBe(false);
    expect(validChannelSecret('short')).toBe(false);
    const msg: WithdrawRequestMsg = { v: 1, botId: 'mexc:SOLUSDT:live', id: 'wdab12cd-1', asset: 'USDT', amount: '25', createdTs: T0, sentTs: T0, mode: 'submit' };
    const f = encodeMessage(msg, secret);
    expect(decodeMessage(f, WithdrawRequestMsgSchema, secret)).toEqual({ ok: true, msg });
    expect(decodeMessage(f, WithdrawRequestMsgSchema, `${secret}x`)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(decodeMessage({ ...f, m: f.m!.replace('"25"', '"2500"') }, WithdrawRequestMsgSchema, secret)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(decodeMessage({ m: '{', sig: f.sig! }, WithdrawRequestMsgSchema, secret)).toEqual({ ok: false, reason: 'malformed' });
    const odd = { ...msg, id: 'wd; rm -rf' };
    expect(decodeMessage(encodeMessage(odd, secret), WithdrawRequestMsgSchema, secret)).toEqual({ ok: false, reason: 'invalid' });
    const rep = { v: 1 as const, botId: 'b', id: 'wdab12cd-1', status: 'CONFIRMED' as const, amount: '25', fee: '1', sentTs: T0 };
    expect(decodeMessage(encodeMessage(rep, secret), WithdrawReportMsgSchema, secret)).toEqual({ ok: true, msg: rep });
    expect(WITHDRAW_REQ_STREAM).toBe('cortex:withdraw:req');
  });
});
