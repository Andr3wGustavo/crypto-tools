import { BN } from '@cortex/core';
import { describe, expect, it } from 'vitest';
import { LIVE_CTX, SHADOW_CTX, liveRun, shadowRun } from '../testing/persist-fixtures';
import type { PrismaClient } from '@cortex/db';
import { PostgresSink, buildRows, type PersistItem } from './postgres-sink';

const sumByAsset = (entries: ReadonlyArray<{ txId: string; asset: string; amount: string | number | object }>) => {
  const m = new Map<string, InstanceType<typeof BN>>();
  for (const e of entries) m.set(`${e.txId}|${e.asset}`, (m.get(`${e.txId}|${e.asset}`) ?? new BN(0)).plus(String(e.amount)));
  return m;
};

describe('postgres rows (pure mapping)', () => {
  it('shadow: deterministic, uniquely keyed, balanced, and batch-independent', () => {
    const { engine, items } = shadowRun();
    expect(engine.fillCount).toBeGreaterThan(5);
    const a = buildRows(SHADOW_CTX, items);
    const b = buildRows(SHADOW_CTX, items);
    expect(b).toEqual(a);

    // Keys: unique events, risks, fills, orders, ledger txs and postings.
    const uniq = (xs: unknown[]) => new Set(xs).size === xs.length;
    expect(uniq(a.events.map((e) => e.key))).toBe(true);
    expect(uniq(a.risks.map((x) => x.id))).toBe(true);
    expect(uniq(a.fills.map((f) => f.id))).toBe(true);
    expect(uniq(a.orders.map((o) => o.clientOrderId))).toBe(true);
    expect(uniq(a.ledgerTxs.map((t) => t.id))).toBe(true);
    expect(uniq(a.ledgerEntries.map((e) => `${e.txId}#${e.idx}`))).toBe(true);
    expect(a.fills).toHaveLength(engine.fillCount);
    expect(a.ledgerTxs).toHaveLength(engine.ledger.transactions.length);
    expect(a.lastSeq).toBe(engine.recordCount);
    // Every fill points at an order the batch created (shadow never needs placeholders).
    expect(a.fillOrders).toEqual([]);
    for (const v of sumByAsset(a.ledgerEntries).values()) expect(v.isZero()).toBe(true);

    // Equity points: one per 10-second bucket, keyed by the bucket start. Split into batches, a
    // bucket may appear in two of them: the database keeps the first, which is the same point.
    const ts = a.equity.map((e) => (e.ts as Date).getTime());
    expect(ts.every((t) => t % 10_000 === 0)).toBe(true);
    expect(new Set(ts).size).toBe(ts.length);
    const chunks = [];
    for (let i = 0; i < items.length; i += 777) chunks.push(buildRows(SHADOW_CTX, items.slice(i, i + 777)));
    const firstPerBucket = new Map<number, unknown>();
    for (const e of chunks.flatMap((c) => c.equity)) if (!firstPerBucket.has((e.ts as Date).getTime())) firstPerBucket.set((e.ts as Date).getTime(), e);
    expect([...firstPerBucket.values()]).toEqual(a.equity);
    expect(chunks.flatMap((c) => c.events)).toEqual(a.events);
  });

  it('live: real fills, fee assets, unknown-order placeholders, the opening deposit and the withdrawal', () => {
    const { h, items } = liveRun();
    const r = buildRows(LIVE_CTX, items);
    expect(r.fills).toHaveLength(h.engine.fillCount);
    expect(r.fills.map((f) => f.id)).toEqual(h.trades.map((t) => t.tradeId));
    expect(r.fills.every((f) => f.feeAsset === 'USDT' && f.isMaker === true && f.mode === 'live')).toBe(true);
    // The opening balances, the fills, the skim and the withdrawal all reach the books.
    const kinds = new Set(r.ledgerTxs.map((t) => t.kind));
    for (const k of ['deposit', 'fill', 'treasury_split', 'withdrawal_reserve', 'withdrawal']) expect(kinds.has(k as never)).toBe(true);
    expect(r.ledgerTxs).toHaveLength(h.engine.ledger.transactions.length);
    for (const v of sumByAsset(r.ledgerEntries).values()) expect(v.isZero()).toBe(true);
    const w = [...r.withdrawals.values()];
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ status: 'CONFIRMED', amount: '0.04', fee: '0.01', exchangeId: 'E1', txHash: '5xSig', address: LIVE_CTX.wallet, network: null });
    expect(r.events.some((e) => e.type === 'treasury.withdraw_submit')).toBe(true);
    expect(r.events.some((e) => e.type === 'treasury.withdraw_status')).toBe(false); // periodic re-asks are not events
    expect(r.statuses.some((s) => s.status === 'NEW')).toBe(true);
    expect(r.equity.some((e) => (e.treasury as number) > 0)).toBe(true);
  });

  it('a fill of an order the batch does not know gets a placeholder that never overwrites a real row', () => {
    const ts = 1_700_000_000_000;
    const item: PersistItem = {
      seq: 7, txs: [],
      outs: [{ kind: 'exec_fill', event: { kind: 'fill', ts, clientOrderId: '', fillId: 'T9', tradeId: 'T9', side: 'SELL', price: 88.1, qty: 0.03, fee: 0.0001, feeAsset: 'base', isMaker: false } }],
    };
    const r = buildRows(LIVE_CTX, [item]);
    expect(r.fills[0]).toMatchObject({ id: 'T9', clientOrderId: 'unknown-T9', feeAsset: 'SOL', isMaker: false, quoteQty: '2.643' });
    expect(r.fillOrders[0]).toMatchObject({ clientOrderId: 'unknown-T9', status: 'UNKNOWN' });
    expect(r.events[0]!.key).toBe('live-test:7:0');
  });

  it('never writes a record the recording has not made durable (no phantom rows after a kill)', async () => {
    const { items } = shadowRun(5);
    // A database stub: any `tx.model.method(...)` or tagged query resolves (nothing is checked here).
    const noop: unknown = new Proxy(() => undefined, { get: () => noop, apply: async () => 0 });
    const db = {
      $transaction: async (fn: (tx: unknown) => Promise<void>) => {
        await fn(noop);
      },
    } as unknown as PrismaClient;
    let durable = 0;
    const sink = new PostgresSink(SHADOW_CTX, { error: () => undefined }, db, { durableSeq: () => durable, batchItems: 50 });
    const real = items.filter((i) => i.outs.length > 0 || i.txs.length > 0).slice(0, 120);
    for (const it of real) sink.push(it);
    await sink.flush();
    expect(sink.backlog).toBe(120); // nothing durable yet: nothing written
    durable = real[69]!.seq;
    expect(await sink.drain()).toBe(true); // drains what it may, and does not spin on the rest
    expect(sink.backlog).toBe(50);
    expect(sink.persistedSeq).toBe(real[69]!.seq);
    durable = Number.POSITIVE_INFINITY;
    expect(await sink.close()).toBe(true);
    expect(sink.backlog).toBe(0);
    expect(sink.persistedSeq).toBe(real[119]!.seq);
    expect(sink.errors).toBe(0);
  });
});
