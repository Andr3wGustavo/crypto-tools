import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import prismaPkg from '@prisma/client';
import type { PrismaClient } from '@cortex/db';
import { BN } from '@cortex/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ShadowEngine, engineConfigHash } from '../engine/shadow-engine';
import { backfillRun } from '../persist-backfill';
import { NdjsonRecorder } from '../recorder/ndjson';
import { syntheticInputs, testEngineOptions } from '../testing/synthetic-inputs';
import { persistReplay } from './persistence';
import { PostgresSink, buildRows, type PersistItem, type SinkContext } from './postgres-sink';
import { LIVE_CTX, SHADOW_CTX, liveRun, shadowRun } from '../testing/persist-fixtures';

/**
 * Against a real Postgres + TimescaleDB with the migrations applied (CI `migrate` job, or locally:
 * TEST_DATABASE_URL=postgresql://cortex:…@127.0.0.1:5432/farm_test). Skipped without it.
 * The tables are truncated before every test: never point this at a database you care about.
 */
const url = process.env.TEST_DATABASE_URL;
const { PrismaClient: Ctor } = prismaPkg;
const db: PrismaClient = url ? new Ctor({ datasources: { db: { url } } }) : (undefined as never);
const quiet = { error: () => undefined };

type Snapshot = Record<string, unknown>;

/** Everything the sink writes, normalized for comparison (ids of autoincrement rows excluded). */
async function dump(botId: string): Promise<Snapshot> {
  const orders = await db.order.findMany({ where: { botId }, orderBy: { clientOrderId: 'asc' }, select: { clientOrderId: true, status: true, filledQty: true, quantity: true, price: true, reason: true } });
  const fills = await db.fill.findMany({ where: { botId }, orderBy: { id: 'asc' }, select: { id: true, clientOrderId: true, quantity: true, price: true, quoteQty: true, fee: true, feeAsset: true } });
  const txs = await db.ledgerTx.findMany({ where: { botId }, orderBy: { id: 'asc' }, select: { id: true, kind: true, entries: { orderBy: { idx: 'asc' }, select: { idx: true, account: true, asset: true, amount: true } } } });
  const events = await db.event.findMany({ where: { botId }, orderBy: [{ key: 'asc' }], select: { key: true, type: true, ts: true } });
  const counts = {
    samples: await db.quoteSample.count({ where: { botId } }),
    equity: await db.equitySnapshot.count({ where: { botId } }),
    markouts: await db.markout.count({ where: { botId } }),
    risks: await db.riskEvent.count({ where: { botId } }),
  };
  const withdrawals = await db.withdrawal.findMany({ where: { botId }, select: { id: true, status: true, amount: true, fee: true, txHash: true, exchangeId: true, address: true } });
  const cursor = await db.persistCursor.findMany({ where: { botId }, select: { run: true, seq: true } });
  const bot = await db.bot.findUnique({ where: { id: botId }, select: { status: true } });
  const s = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
  return s({ orders, fills, txs, events, counts, withdrawals, cursor, bot });
}

async function persist(ctx: SinkContext, items: readonly PersistItem[], client: PrismaClient = db, batchItems = 500): Promise<PostgresSink> {
  const sink = new PostgresSink(ctx, quiet, client, { batchItems });
  await sink.init(testEngineOptions.config);
  for (const it of items) sink.push(it);
  expect(await sink.close()).toBe(true);
  return sink;
}

/** A client whose transactions fail `n` times AFTER doing all their writes (then roll back). */
function flaky(n: number): PrismaClient {
  let left = n;
  return new Proxy(db, {
    get(target, key, recv) {
      if (key !== '$transaction') return Reflect.get(target, key, recv);
      return (fn: (tx: unknown) => Promise<unknown>, o: unknown) =>
        target.$transaction(async (tx) => {
          const r = await fn(tx);
          if (left-- > 0) throw new Error('connection lost after the writes');
          return r;
        }, o as never);
    },
  });
}

describe.skipIf(!url)('PostgresSink against Postgres + TimescaleDB', () => {
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE "Order", "Fill", "LedgerTx", "LedgerEntry", "events", "quote_samples", "equity_snapshots",
      "Markout", "RiskEvent", "Withdrawal", "EdgeState", "PersistCursor", "BotConfig", "Bot" CASCADE`);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it('shadow: the database holds exactly the engine books (fills, orders, ledger, cursor)', async () => {
    const { engine, items } = shadowRun();
    await persist(SHADOW_CTX, items);
    const botId = SHADOW_CTX.botId;

    expect(await db.fill.count({ where: { botId } })).toBe(engine.fillCount);
    // Ledger balances in SQL = the engine's exact ledger; every transaction sums to zero per asset.
    const bal = await db.$queryRaw<Array<{ account: string; asset: string; amount: string }>>`
      SELECT e."account", e."asset", SUM(e."amount")::text AS amount FROM "LedgerEntry" e JOIN "LedgerTx" t ON t."id" = e."txId"
      WHERE t."botId" = ${botId} GROUP BY 1, 2`;
    const want = engine.ledger.balances();
    expect(bal).toHaveLength(want.length);
    for (const w of want) expect(new BN(bal.find((b) => b.account === w.account && b.asset === w.asset)!.amount).eq(w.amount)).toBe(true);
    const unbalanced = await db.$queryRaw<unknown[]>`
      SELECT e."txId", e."asset" FROM "LedgerEntry" e GROUP BY 1, 2 HAVING SUM(e."amount") <> 0`;
    expect(unbalanced).toEqual([]);
    // Orders: filled quantity = sum of their fills; fully filled ⇔ FILLED.
    const bad = await db.$queryRaw<unknown[]>`
      SELECT o."clientOrderId" FROM "Order" o LEFT JOIN "Fill" f ON f."clientOrderId" = o."clientOrderId"
      WHERE o."botId" = ${botId} GROUP BY o."clientOrderId", o."filledQty", o."quantity", o."status"
      HAVING o."filledQty" <> COALESCE(SUM(f."quantity"), 0) OR ((o."filledQty" >= o."quantity") <> (o."status" = 'FILLED'))`;
    expect(bad).toEqual([]);
    const cur = await db.persistCursor.findUnique({ where: { botId_run: { botId, run: SHADOW_CTX.run } } });
    expect(Number(cur!.seq)).toBe(Math.max(...items.filter((i) => i.outs.length || i.txs.length).map((i) => i.seq)));
    const rows = buildRows(SHADOW_CTX, items);
    expect(await db.event.count({ where: { botId } })).toBe(rows.events.length);
    expect(await db.edgeState.count({ where: { botId } })).toBe(1);
  });

  it('a batch mixing orders with and without a reason is written (raw queries take one JSON parameter, never arrays)', async () => {
    const ts = 1_700_000_000_000;
    const place = (cid: string) => ({ kind: 'action' as const, action: { kind: 'place' as const, ts, clientOrderId: cid, side: 'BUY' as const, price: 88, qty: 0.05, reason: 'quote' } });
    const items: PersistItem[] = [
      { seq: 1, txs: [], outs: [place('cfa'), place('cfb'), place('cfc')] },
      {
        seq: 2, txs: [], outs: [
          { kind: 'sim', event: { kind: 'order', ts: ts + 1, clientOrderId: 'cfa', status: 'NEW' } },
          { kind: 'action', action: { kind: 'cancel', ts: ts + 2, clientOrderId: 'cfb', reason: 'reprice' } },
          { kind: 'sim', event: { kind: 'order', ts: ts + 3, clientOrderId: 'cfc', status: 'REJECTED', reason: 'post only' } },
        ],
      },
    ] as PersistItem[];
    await persist(SHADOW_CTX, items);
    const rows = await db.order.findMany({ where: { botId: SHADOW_CTX.botId }, orderBy: { clientOrderId: 'asc' }, select: { clientOrderId: true, status: true, reason: true } });
    expect(rows).toEqual([
      { clientOrderId: 'cfa', status: 'NEW', reason: null },
      { clientOrderId: 'cfb', status: 'CANCEL_REQ', reason: 'reprice' },
      { clientOrderId: 'cfc', status: 'REJECTED', reason: 'post only' },
    ]);
  });

  it('exactly once: a batch that fails after its writes is rolled back and retried; re-sending is a no-op', async () => {
    const { items } = shadowRun();
    await persist(SHADOW_CTX, items);
    const clean = await dump(SHADOW_CTX.botId);

    await db.$executeRawUnsafe(`TRUNCATE "Order", "Fill", "LedgerTx", "LedgerEntry", "events", "quote_samples", "equity_snapshots",
      "Markout", "RiskEvent", "Withdrawal", "EdgeState", "PersistCursor", "BotConfig", "Bot" CASCADE`);
    const sink = new PostgresSink(SHADOW_CTX, quiet, flaky(3), { batchItems: 500 });
    await sink.init(testEngineOptions.config);
    for (const it of items) sink.push(it);
    while (sink.backlog > 0) await sink.flush(); // three failures, then success
    expect(sink.errors).toBe(3);
    expect(await dump(SHADOW_CTX.botId)).toEqual(clean);

    // Whole history again with the cursor (a genesis replay): dropped before the database.
    const again = await persist(SHADOW_CTX, items);
    expect(again.errors).toBe(0);
    expect(await dump(SHADOW_CTX.botId)).toEqual(clean);
    // ...and even without the cursor, every row is keyed: writing it twice changes nothing.
    await db.persistCursor.deleteMany({});
    await persist(SHADOW_CTX, items);
    expect(await dump(SHADOW_CTX.botId)).toEqual(clean);
  });

  it('crash between flushes: the boot replay re-sends exactly the missing tail', async () => {
    const inputs = syntheticInputs(20, 4);
    const full = shadowRun(20, 4);
    await persist(SHADOW_CTX, full.items);
    const clean = await dump(SHADOW_CTX.botId);

    // First life: only the first 60 % of the records reach the database, then a hard crash.
    await db.$executeRawUnsafe(`TRUNCATE "Order", "Fill", "LedgerTx", "LedgerEntry", "events", "quote_samples", "equity_snapshots",
      "Markout", "RiskEvent", "Withdrawal", "EdgeState", "PersistCursor", "BotConfig", "Bot" CASCADE`);
    const cut = Math.floor(full.items.length * 0.6);
    await persist(SHADOW_CTX, full.items.slice(0, cut));

    // Second life: genesis replay of the recording through the boot hooks, then normal flushing.
    const sink = new PostgresSink(SHADOW_CTX, quiet, db, { batchItems: 500 });
    expect(await sink.init(testEngineOptions.config)).toBe(Math.max(...full.items.slice(0, cut).filter((i) => i.outs.length || i.txs.length).map((i) => i.seq)));
    const hooks = persistReplay<ShadowEngine, (typeof inputs)[number]>(sink, { warn: () => undefined }, () => undefined);
    const engine = new ShadowEngine(testEngineOptions);
    hooks.onStart!(engine);
    for (const r of inputs) await hooks.onRecord!(engine, r, engine.process(r));
    expect(await sink.close()).toBe(true);
    expect(await dump(SHADOW_CTX.botId)).toEqual(clean);
  });

  it('persist-backfill fills a hole below the cursor from the recording, touching nothing else', async () => {
    const inputs = syntheticInputs(20, 4);
    const full = shadowRun(20, 4);
    await persist(SHADOW_CTX, full.items);
    const clean = await dump(SHADOW_CTX.botId);

    // The worker started while Postgres was down: only the last 40 % of the run reached it.
    await db.$executeRawUnsafe(`TRUNCATE "Order", "Fill", "LedgerTx", "LedgerEntry", "events", "quote_samples", "equity_snapshots",
      "Markout", "RiskEvent", "Withdrawal", "EdgeState", "PersistCursor", "BotConfig", "Bot" CASCADE`);
    await persist(SHADOW_CTX, full.items.slice(Math.floor(full.items.length * 0.6)));
    expect(await dump(SHADOW_CTX.botId)).not.toEqual(clean);

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-backfill-'));
    try {
      const dir = path.join(parent, SHADOW_CTX.run);
      fs.mkdirSync(dir);
      const o = testEngineOptions;
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        botId: SHADOW_CTX.botId, info: { symbol: 'SOLUSDT', makerFeeRate: o.makerFeeRate }, config: o.config, startQuote: o.startQuote,
        latencyMs: o.latencyMs, edgeWindowMs: o.edgeWindowMs, configHash: engineConfigHash(o),
      }));
      const rec = new NdjsonRecorder(parent, SHADOW_CTX.run);
      for (const r of inputs) rec.write(r);
      await rec.close();
      const res = await backfillRun(dir, db);
      expect(res.records).toBe(inputs.length);
      expect(await dump(SHADOW_CTX.botId)).toEqual(clean);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('live: real fills, the books, the treasury and the withdrawal land in the live tables', async () => {
    const { h, items } = liveRun();
    await persist(LIVE_CTX, items, db, 50);
    const botId = LIVE_CTX.botId;
    expect(await db.fill.count({ where: { botId, mode: 'live' } })).toBe(h.engine.fillCount);
    const w = await db.withdrawal.findMany({ where: { botId } });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ status: 'CONFIRMED', exchangeId: 'E1', txHash: '5xSig', address: LIVE_CTX.wallet, network: null });
    expect(w[0]!.amount.toString()).toBe('0.04');
    expect(w[0]!.fee!.toString()).toBe('0.01');
    const bal = await db.$queryRaw<Array<{ account: string; asset: string; amount: string }>>`
      SELECT e."account", e."asset", SUM(e."amount")::text AS amount FROM "LedgerEntry" e JOIN "LedgerTx" t ON t."id" = e."txId"
      WHERE t."botId" = ${botId} GROUP BY 1, 2`;
    for (const x of h.engine.ledger.balances()) expect(new BN(bal.find((b) => b.account === x.account && b.asset === x.asset)!.amount).eq(x.amount)).toBe(true);
    // The fill that arrived without a client id is linked to its real order through the engine.
    const orphans = await db.order.count({ where: { botId, status: 'UNKNOWN' } });
    expect(orphans).toBe(0);
    expect((await db.bot.findUnique({ where: { id: botId } }))!.status).toBe('running');
    expect(await db.equitySnapshot.count({ where: { botId, treasury: { gt: 0 } } })).toBeGreaterThan(0);
  });
});
