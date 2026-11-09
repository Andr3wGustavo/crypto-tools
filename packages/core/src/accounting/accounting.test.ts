import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TREASURY, TreasuryPolicy, type WithdrawalContext } from '../treasury/treasury';
import { DEFAULT_LADDER, daysToTarget, stageFor, viability } from '../treasury/ladder';
import { InsufficientFundsError, Ledger, LedgerImbalanceError, assertBalanced } from './ledger';
import { AverageCostPosition, OversellError } from './position';

describe('Ledger (double entry)', () => {
  it('rejects unbalanced transactions', () => {
    expect(() =>
      assertBalanced({ id: 'x', ts: 0, kind: 'adjustment', postings: [{ account: 'cash:USDT', asset: 'USDT', amount: '1' }] }),
    ).toThrow(LedgerImbalanceError);
  });

  it('books a buy then a sell exactly, per asset', () => {
    const l = new Ledger();
    l.post(Ledger.deposit('d1', 0, 'USDT', '15'));
    l.post(Ledger.fill('f1', 1, { side: 'BUY', base: 'SOL', quote: 'USDT', price: '150.10', qty: '0.015', fee: '0', feeAsset: 'USDT' }));
    expect(l.balance('cash:USDT', 'USDT').toFixed()).toBe('12.7485');
    expect(l.balance('cash:SOL', 'SOL').toFixed()).toBe('0.015');
    l.post(Ledger.fill('f2', 2, { side: 'SELL', base: 'SOL', quote: 'USDT', price: '150.20', qty: '0.015', fee: '0.0001', feeAsset: 'USDT' }));
    expect(l.balance('cash:USDT', 'USDT').toFixed()).toBe('15.0014');
    expect(l.equity('USDT', { SOL: 150 })).toBeCloseTo(15.0014, 12);
    for (const [, v] of l.totals()) expect(v.isZero()).toBe(true);
  });

  it('is idempotent on transaction id and refuses overdrafts', () => {
    const l = new Ledger();
    expect(l.post(Ledger.deposit('d1', 0, 'USDT', '10'))).toBe(true);
    expect(l.post(Ledger.deposit('d1', 0, 'USDT', '10'))).toBe(false);
    expect(l.balance('cash:USDT', 'USDT').toFixed()).toBe('10');
    expect(() => l.post(Ledger.transfer('t1', 1, 'treasury_split', 'cash', 'treasury', 'USDT', '11'))).toThrow(InsufficientFundsError);
    expect(l.balance('cash:USDT', 'USDT').toFixed()).toBe('10'); // atomic: nothing applied
  });

  it('property: any sequence of valid operations conserves every asset and never overdraws', () => {
    const op = fc.oneof(
      fc.record({ t: fc.constant('dep' as const), a: fc.integer({ min: 1, max: 1000 }) }),
      fc.record({ t: fc.constant('buy' as const), px: fc.integer({ min: 100, max: 200 }), q: fc.integer({ min: 1, max: 50 }) }),
      fc.record({ t: fc.constant('sell' as const), px: fc.integer({ min: 100, max: 200 }), q: fc.integer({ min: 1, max: 50 }) }),
      fc.record({ t: fc.constant('skim' as const), a: fc.integer({ min: 1, max: 500 }) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
        const l = new Ledger();
        ops.forEach((o, i) => {
          const id = `t${i}`;
          try {
            if (o.t === 'dep') l.post(Ledger.deposit(id, i, 'USDT', o.a / 100));
            else if (o.t === 'skim') l.post(Ledger.transfer(id, i, 'treasury_split', 'cash', 'treasury', 'USDT', o.a / 100));
            else l.post(Ledger.fill(id, i, { side: o.t === 'buy' ? 'BUY' : 'SELL', base: 'SOL', quote: 'USDT', price: o.px, qty: o.q / 1000, fee: 0, feeAsset: 'USDT' }));
          } catch (e) {
            expect(e).toBeInstanceOf(InsufficientFundsError);
          }
        });
        for (const [, v] of l.totals()) expect(v.isZero()).toBe(true);
        for (const b of l.balances()) if (/^(cash|treasury):/.test(b.account)) expect(Number(b.amount)).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe('AverageCostPosition', () => {
  it('computes realized and unrealized PnL with fees', () => {
    const p = new AverageCostPosition();
    p.onFill({ side: 'BUY', price: 100, qty: 1, fee: 0.1, feeIn: 'quote' });
    p.onFill({ side: 'BUY', price: 110, qty: 1, fee: 0, feeIn: 'quote' });
    expect(p.avgCost()).toBeCloseTo(105.05, 12);
    expect(p.unrealizedPnl(120)).toBeCloseTo(240 - 210.1, 12);
    const r = p.onFill({ side: 'SELL', price: 120, qty: 1, fee: 0, feeIn: 'quote' });
    expect(r).toBeCloseTo(14.95, 12);
    expect(() => p.onFill({ side: 'SELL', price: 120, qty: 2, fee: 0, feeIn: 'quote' })).toThrow(OversellError);
  });
});

describe('TreasuryPolicy', () => {
  const t = new TreasuryPolicy(DEFAULT_TREASURY);
  const ctx: WithdrawalContext = {
    mode: 'live', halted: false, reconcileOk: true, equityConfirmed: true, now: 10 * 86_400_000,
    withdrawnLast24h: 0, networkMin: 1, networkFee: 1,
  };

  it('skims (1 − ρ) of profit, never touches losses, never exceeds free cash', () => {
    expect(t.skimAmount(1, 10)).toBe(0.5);
    expect(t.skimAmount(-1, 10)).toBe(0);
    expect(t.skimAmount(10, 2)).toBe(2);
  });

  it('property: skim is within [0, (1−ρ)·profit] and ≤ cash', () => {
    fc.assert(
      fc.property(fc.double({ min: -100, max: 100, noNaN: true }), fc.double({ min: 0, max: 100, noNaN: true }), (pnl, cash) => {
        const s = t.skimAmount(pnl, cash);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(Math.max(0, 0.5 * pnl) + 1e-12);
        expect(s).toBeLessThanOrEqual(cash + 1e-12);
      }),
    );
  });

  it('promotes half the treasury once it reaches the stage capital', () => {
    expect(t.promotionAmount(14.99, 15)).toBe(0);
    expect(t.promotionAmount(15, 15)).toBe(7.5);
  });

  it('withdrawal: each of the five locks blocks independently', () => {
    expect(t.withdrawalDecision(25, ctx)).toMatchObject({ allowed: true, amount: 25 });
    expect(t.withdrawalDecision(25, { ...ctx, mode: 'shadow' }).reasons).toContain('not_live');
    expect(t.withdrawalDecision(25, { ...ctx, halted: true }).reasons).toContain('halted');
    expect(t.withdrawalDecision(25, { ...ctx, reconcileOk: false }).reasons).toContain('reconcile_pending');
    expect(t.withdrawalDecision(19, ctx).reasons).toContain('below_minimum');
    expect(t.withdrawalDecision(25, { ...ctx, lastWithdrawalTs: ctx.now - 3600_000 }).reasons).toContain('cooldown');
    expect(t.withdrawalDecision(500, { ...ctx, withdrawnLast24h: 100 }).reasons).toContain('daily_cap');
    expect(t.withdrawalDecision(500, ctx).amount).toBe(100); // capped by daily cap
  });
});

describe('Capital ladder', () => {
  it('maps capital to stages and checks viability', () => {
    expect(stageFor(1000, 'shadow').stage).toBe(0);
    expect(stageFor(15, 'live').stage).toBe(1);
    expect(stageFor(60, 'live').stage).toBe(2);
    expect(stageFor(250, 'live')).toEqual(DEFAULT_LADDER[3]);
    expect(viability(15, 1.1).canTrade).toBe(true);
    expect(viability(10, 5.5).canTrade).toBe(false);
  });

  it('time to target T = ln(target/c0)/g', () => {
    expect(daysToTarget(15, 100, 0.003)).toBeCloseTo(Math.log(100 / 15) / 0.003, 9);
    expect(daysToTarget(15, 100, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});
