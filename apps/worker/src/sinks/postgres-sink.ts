import { prisma as defaultClient, type Prisma, type PrismaClient } from '@cortex/db';
import type { LedgerTransaction, StrategyAction, StrategyConfig } from '@cortex/core';
import type { EngineOutput } from '../engine/shadow-engine';
import type { LiveOutput } from '../live/live-engine';

type Mode = 'shadow' | 'live';
type Output = EngineOutput | LiveOutput;
type Tx = Prisma.TransactionClient;
type OrderStatusRow = 'SENT' | 'NEW' | 'CANCEL_REQ' | 'CANCELED' | 'REJECTED' | 'EXPIRED' | 'UNKNOWN';

/** Where the sink reports failed writes (a pino logger fits). */
export interface SinkLog {
  error(o: object, msg: string): void;
}

/** One engine record's worth of outputs, captured right after the engine processed it. */
export interface PersistItem {
  /** The engine's record count after processing (1-based, identical in every replay). */
  seq: number;
  outs: ReadonlyArray<Output>;
  /** Ledger transactions this record posted, in posting order. */
  txs: readonly LedgerTransaction[];
  /** Edge sufficient statistics, when this record closed an edge window. */
  edge?: { n: number; mean: number; m2: number; prior: unknown };
  /** Live: protected profit — treasury plus withdrawals in flight (quote units) — with each quote sample. */
  treasury?: number;
}

export interface SinkContext {
  botId: string;
  /** Run directory name (`cfg-…` shadow, `live-…` live): one engine history. */
  run: string;
  mode: Mode;
  venue: string;
  symbol: string;
  base: string;
  quote: string;
  /** Live: the treasury wallet (display only), recorded on withdrawals. */
  wallet?: string | null;
}

/** What persistence reads from an engine (the shadow and live engines both qualify). */
export interface PersistableEngine {
  readonly recordCount: number;
  readonly ledger: { readonly transactions: readonly LedgerTransaction[] };
  readonly edge: { readonly state: { n: number; mean: number; m2: number }; readonly prior: unknown };
  treasuryView?(): { treasury: string; withdrawing: string };
}

/** Rows for one database transaction (see `buildRows`). */
export interface Rows {
  orders: Prisma.OrderCreateManyInput[];
  /** Status changes in order. */
  statuses: Array<{ id: string; status: OrderStatusRow; reason: string | null }>;
  fills: Prisma.FillCreateManyInput[];
  /** Placeholder rows for orders known only through a fill (never overwrite a real row). */
  fillOrders: Prisma.OrderCreateManyInput[];
  ledgerTxs: Prisma.LedgerTxCreateManyInput[];
  ledgerEntries: Prisma.LedgerEntryCreateManyInput[];
  events: Prisma.EventCreateManyInput[];
  samples: Prisma.QuoteSampleCreateManyInput[];
  equity: Prisma.EquitySnapshotCreateManyInput[];
  markouts: Prisma.MarkoutCreateManyInput[];
  risks: Prisma.RiskEventCreateManyInput[];
  withdrawals: Map<string, Prisma.WithdrawalCreateInput>;
  botStatus: string | null;
  edge: PersistItem['edge'] | null;
  lastSeq: number;
}

const EQUITY_EVERY_MS = 10_000;
const TERMINAL: ReadonlySet<OrderStatusRow> = new Set(['CANCELED', 'REJECTED', 'EXPIRED']);

/**
 * Maps engine outputs to rows. Pure and deterministic: the same items always give the same rows,
 * and every row has a key derived from (run, record seq, output index) or from an exchange / engine
 * id, so writing the same record twice is a no-op — and the rows do not depend on how records
 * are split into batches (a crash moves the boundaries).
 */
export function buildRows(ctx: SinkContext, items: readonly PersistItem[]): Rows {
  const { botId, mode, run } = ctx;
  const r: Rows = {
    orders: [], statuses: [], fills: [], fillOrders: [], ledgerTxs: [], ledgerEntries: [], events: [], samples: [], equity: [],
    markouts: [], risks: [], withdrawals: new Map(), botStatus: null, edge: null, lastSeq: 0,
  };
  const created = new Set<string>();
  const equityBuckets = new Set<number>();
  const assetOf = (a: 'quote' | 'base') => (a === 'base' ? ctx.base : ctx.quote);
  const ev = (key: string, ts: number, type: string, payload: unknown) =>
    r.events.push({ key, ts: new Date(ts), mode, botId, type, payload: json(payload) });
  type FillLike = { ts: number; clientOrderId: string; fillId: string; side: 'BUY' | 'SELL'; price: number; qty: number; fee: number; feeAsset: 'quote' | 'base' };
  const fill = (key: string, f: FillLike, isMaker: boolean) => {
    const cid = f.clientOrderId || `unknown-${f.fillId}`;
    r.fills.push({
      id: f.fillId, clientOrderId: cid, botId, mode, side: f.side, price: f.price, quantity: f.qty, quoteQty: decMul(f.price, f.qty),
      fee: f.fee, feeAsset: assetOf(f.feeAsset), isMaker, ts: new Date(f.ts),
    });
    if (!created.has(cid)) {
      created.add(cid);
      r.fillOrders.push({
        clientOrderId: cid, botId, mode, venue: ctx.venue, symbol: ctx.symbol, side: f.side, price: f.price, quantity: f.qty,
        status: 'UNKNOWN', reason: 'known only through a fill', createdAt: new Date(f.ts),
      });
    }
    ev(key, f.ts, 'order.fill', f);
  };

  for (const item of items) {
    r.lastSeq = Math.max(r.lastSeq, item.seq);
    if (item.edge) r.edge = item.edge;
    for (const tx of item.txs) {
      const id = `${botId}:${run}:${tx.id}`;
      r.ledgerTxs.push({ id, ts: new Date(tx.ts), mode, botId, kind: tx.kind, ref: tx.ref ?? null, memo: tx.memo ?? null });
      tx.postings.forEach((p, idx) => r.ledgerEntries.push({ txId: id, idx, account: p.account, asset: p.asset, amount: String(p.amount) }));
    }
    item.outs.forEach((o, i) => {
      const key = `${run}:${item.seq}:${i}`;
      switch (o.kind) {
        case 'action': {
          const a: StrategyAction = o.action;
          switch (a.kind) {
            case 'place':
              r.orders.push({ clientOrderId: a.clientOrderId, botId, mode, venue: ctx.venue, symbol: ctx.symbol, side: a.side, price: a.price, quantity: a.qty, status: 'SENT', createdAt: new Date(a.ts) });
              created.add(a.clientOrderId);
              ev(key, a.ts, 'order.place', a);
              break;
            case 'cancel':
              r.statuses.push({ id: a.clientOrderId, status: 'CANCEL_REQ', reason: a.reason });
              ev(key, a.ts, 'order.cancel', a);
              break;
            case 'sample': {
              r.samples.push({ botId, ts: new Date(a.ts), fair: a.fair, bid: a.bid ?? null, ask: a.ask ?? null, halfSpreadBps: a.halfSpreadBps, skewBps: a.skewBps, sigmaBps: a.sigmaBps, toxic: a.toxic });
              // One point per 10-second bucket, keyed by the bucket start: the first sample of the
              // bucket wins (the database skips later ones), with no state carried between batches.
              const bucket = Math.floor(a.ts / EQUITY_EVERY_MS) * EQUITY_EVERY_MS;
              if (!equityBuckets.has(bucket)) {
                equityBuckets.add(bucket);
                r.equity.push({
                  botId, mode, ts: new Date(bucket), equity: a.equity, cash: a.quoteBalance, treasury: item.treasury ?? 0,
                  inventoryQty: a.inventoryQty, inventoryValue: a.inventoryQty * a.fair,
                  realizedPnl: a.realizedPnl, unrealizedPnl: a.unrealizedPnl, fees: 0, mid: a.mid,
                });
              }
              break;
            }
            case 'markout':
              r.markouts.push({ fillId: a.fillId, horizonMs: a.horizonMs, botId, ts: new Date(a.ts), bps: a.bps });
              break;
            case 'risk':
              a.violations.forEach((v, j) => r.risks.push({ id: `${key}:${j}`, botId, ts: new Date(a.ts), severity: v.severity, rule: v.rule, message: v.message }));
              ev(key, a.ts, `risk.${a.action}`, a);
              break;
            case 'status':
              r.botStatus = a.status;
              ev(key, a.ts, 'bot.status', a);
              break;
            case 'error':
              ev(key, a.ts, 'bot.error', a);
              break;
          }
          break;
        }
        case 'sim': {
          const e = o.event;
          if (e.kind === 'fill') fill(key, e, true);
          else {
            r.statuses.push({ id: e.clientOrderId, status: e.status, reason: e.reason ?? null });
            ev(key, e.ts, `order.${e.status.toLowerCase()}`, e);
          }
          break;
        }
        case 'exec_fill':
          fill(key, o.event, o.event.isMaker);
          break;
        case 'order_status':
          // FILLED / PARTIAL are derived from the fills themselves (see PostgresSink.write).
          if (o.status !== 'INTENT' && o.status !== 'PARTIAL' && o.status !== 'FILLED') r.statuses.push({ id: o.clientOrderId, status: o.status, reason: o.reason ?? null });
          ev(key, o.ts, `order.${o.status.toLowerCase()}`, o);
          break;
        case 'exec_warning':
          ev(key, o.ts, 'live.warning', o);
          break;
        case 'sync':
          ev(key, o.ts, o.ok ? 'live.sync' : 'live.sync_failed', o);
          break;
        case 'request':
          ev(key, o.ts, `live.request.${o.op}`, o);
          break;
        case 'withdraw_request':
          // Re-asked periodically until final: only decisions are events (the row holds the state).
          if (o.mode !== 'status') ev(key, o.ts, `treasury.withdraw_${o.mode}`, o);
          break;
        case 'withdrawal': {
          const w = o.w;
          r.withdrawals.set(w.id, {
            id: w.id, botId, status: w.status, asset: w.asset, network: null, address: ctx.wallet ?? null, amount: w.amount,
            fee: w.fee ?? null, exchangeId: w.exchangeId ?? null, txHash: w.txId ?? null, error: w.reason ?? null, createdAt: new Date(w.createdTs),
          });
          ev(key, o.ts, 'treasury.withdrawal', o);
          break;
        }
        case 'treasury':
          ev(key, o.ts, 'treasury.skim', o);
          break;
        case 'ledger':
          break; // the transaction itself travels with the item
        case 'edge':
          ev(key, o.ts, 'edge.window', o);
          break;
        case 'reconcile':
          ev(key, o.ts, 'reconcile.diverged', o);
          break;
      }
    });
  }
  return r;
}

/** price × qty without binary noise (both sit on a decimal step grid). */
function decMul(a: number, b: number): string {
  return String(Number((a * b).toPrecision(15)));
}

function json(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

/**
 * Builds the persistence item for each record the engine processes: its outputs plus the ledger
 * transactions it posted (the ledger only appends, so "posted since the last record").
 */
export class LedgerTap {
  private index: number;

  /** A fresh engine (no record yet) starts at 0: its opening deposit belongs to the first record. */
  constructor(private readonly engine: PersistableEngine) {
    this.index = engine.recordCount === 0 ? 0 : engine.ledger.transactions.length;
  }

  item(outs: ReadonlyArray<Output>): PersistItem {
    const all = this.engine.ledger.transactions;
    const txs = all.length > this.index ? all.slice(this.index) : [];
    this.index = all.length;
    const item: PersistItem = { seq: this.engine.recordCount, outs, txs };
    let sample = false;
    for (const o of outs) {
      if (o.kind === 'edge') item.edge = { ...this.engine.edge.state, prior: this.engine.edge.prior };
      else if (o.kind === 'action' && o.action.kind === 'sample') sample = true;
    }
    if (sample && this.engine.treasuryView) {
      const t = this.engine.treasuryView();
      item.treasury = Number(t.treasury) + Number(t.withdrawing);
    }
    return item;
  }
}

/**
 * Batched, ordered, exactly-once persistence of engine outputs (shadow and live).
 *
 * - The engine never waits for the database: items are queued and flushed every `flushMs`.
 * - A flush is ONE database transaction that also advances the run's `PersistCursor`: the batch
 *   and the cursor land together or not at all, and a failed batch is retried as a whole.
 * - Rows have deterministic keys, so writing a record twice is a no-op. On boot the worker pushes
 *   the records it replays after its snapshot; those at or below the durable cursor are dropped.
 * - Anything older that never reached the database (an outage longer than the queue, or a run
 *   started while Postgres was down) is rebuilt from the recordings by `persist-backfill`.
 */
export class PostgresSink {
  private queue: PersistItem[] = [];
  private flushing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  /** Highest record seq durably in Postgres. */
  persistedSeq = 0;
  errors = 0;

  constructor(
    private readonly ctx: SinkContext,
    private readonly log: SinkLog,
    private readonly db: PrismaClient = defaultClient,
    private readonly opts: {
      flushMs?: number;
      maxQueue?: number;
      batchItems?: number;
      /**
       * Highest record seq already durable in the recording. Postgres never gets ahead of it:
       * after a hard kill the engine resumes from the recording, and rows for records the
       * recording lost would be phantoms the replayed engine never saw. Default: no limit.
       */
      durableSeq?: () => number;
    } = {},
  ) {}

  /** Registers the bot and its config version and reads the durable cursor (no flushing yet). */
  async init(config: StrategyConfig): Promise<number> {
    const { botId, venue, symbol, mode, run } = this.ctx;
    await this.db.bot.upsert({ where: { id: botId }, update: { mode }, create: { id: botId, venue, symbol, mode, status: 'starting' } });
    const params = json(config);
    const last = await this.db.botConfig.findFirst({ where: { botId }, orderBy: { version: 'desc' } });
    if (!last || JSON.stringify(last.params) !== JSON.stringify(params)) {
      // Pre-registration: every parameter change becomes a new immutable version.
      await this.db.botConfig.create({ data: { botId, version: (last?.version ?? 0) + 1, params, createdBy: 'worker', note: run } });
    }
    const cur = await this.db.persistCursor.findUnique({ where: { botId_run: { botId, run } } });
    this.persistedSeq = cur ? Number(cur.seq) : 0;
    return this.persistedSeq;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), this.opts.flushMs ?? 1_000);
  }

  /** Items waiting for the database. */
  get backlog(): number {
    return this.queue.length;
  }

  push(item: PersistItem): void {
    if (item.seq <= this.persistedSeq) return; // already durable (boot replay)
    if (item.outs.length === 0 && item.txs.length === 0) return;
    this.queue.push(item);
    const max = this.opts.maxQueue ?? 200_000;
    if (this.queue.length > max) {
      const dropped = this.queue.splice(0, this.queue.length - max);
      this.errors++;
      this.log.error({ maxQueue: max, fromSeq: dropped[0]!.seq, toSeq: dropped.at(-1)!.seq }, 'postgres queue overflow: oldest records dropped (persist-backfill restores them from the recording)');
    }
  }

  /** Flushes until the queue is empty; stops at the first failed write (and returns false). */
  async drain(): Promise<boolean> {
    while (this.flushable() > 0) {
      const before = this.errors;
      await this.flush();
      if (this.errors !== before) return false;
    }
    return true;
  }

  async close(): Promise<boolean> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return this.drain();
  }

  /** Writes up to `batchItems` queued items in one transaction. Concurrent callers share it. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.flushable() === 0) return Promise.resolve();
    this.flushing = this.flushOnce().finally(() => (this.flushing = null));
    return this.flushing;
  }

  /** Queued items that may be written now (their records are durable), capped at one batch. */
  private flushable(): number {
    const max = Math.min(this.queue.length, this.opts.batchItems ?? 2_000);
    const limit = this.opts.durableSeq?.() ?? Number.POSITIVE_INFINITY;
    let n = 0;
    while (n < max && this.queue[n]!.seq <= limit) n++;
    return n;
  }

  private async flushOnce(): Promise<void> {
    const batch = this.queue.slice(0, this.flushable());
    if (batch.length === 0) return;
    try {
      const rows = buildRows(this.ctx, batch);
      await this.db.$transaction((tx) => this.write(tx, rows), { maxWait: 10_000, timeout: 60_000 });
      this.queue.splice(0, batch.length);
      this.persistedSeq = Math.max(this.persistedSeq, rows.lastSeq);
    } catch (err) {
      this.errors++;
      this.log.error({ err: (err as Error).message, items: batch.length }, 'postgres flush failed; will retry');
    }
  }

  private async write(tx: Tx, r: Rows): Promise<void> {
    const { botId, run, mode } = this.ctx;
    if (r.orders.length) await tx.order.createMany({ data: r.orders, skipDuplicates: true });
    if (r.fillOrders.length) await tx.order.createMany({ data: r.fillOrders, skipDuplicates: true });
    if (r.statuses.length) {
      // The result must not depend on where batch boundaries fall (a crash moves them), so:
      // - status: the last word per order in the batch; terminal rows never move, and a partly
      //   filled order stays PARTIAL until a terminal status (FILLED is derived from the fills);
      // - reason: the FIRST reason an order ever gets (why it was canceled / refused) is kept.
      const last = new Map<string, { status: OrderStatusRow; reason: string | null }>();
      for (const s of r.statuses) {
        const prev = last.get(s.id);
        const reason = prev?.reason ?? s.reason;
        last.set(s.id, prev && TERMINAL.has(prev.status) ? { status: prev.status, reason } : { status: s.status, reason });
      }
      // One JSON parameter, unpacked by Postgres: Prisma 5's binding of array parameters in raw
      // queries is unreliable (seen failing with 08P01 / 22P03 depending on the values).
      const rows = [...last].map(([id, v]) => ({ id, st: v.status, rs: v.reason }));
      await tx.$executeRaw`
        UPDATE "Order" o SET
          "status" = CASE WHEN o."status" IN ('FILLED', 'CANCELED', 'REJECTED', 'EXPIRED')
                            OR (o."status" = 'PARTIAL' AND v.st IN ('SENT', 'NEW', 'UNKNOWN', 'CANCEL_REQ'))
                          THEN o."status" ELSE v.st::"OrderStatus" END,
          "reason" = COALESCE(o."reason", v.rs), "updatedAt" = NOW()
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS v(id text, st text, rs text)
        WHERE o."clientOrderId" = v.id`;
    }
    if (r.fills.length) {
      await tx.fill.createMany({ data: r.fills, skipDuplicates: true });
      // The filled quantity is the sum of the stored fills: idempotent, never double-counted.
      const ids = [...new Set(r.fills.map((f) => f.clientOrderId))];
      await tx.$executeRaw`
        UPDATE "Order" o SET "filledQty" = f.q, "updatedAt" = NOW(),
          "status" = CASE WHEN f.q >= o."quantity" THEN 'FILLED'::"OrderStatus"
                          WHEN o."status" IN ('SENT', 'NEW', 'UNKNOWN', 'CANCEL_REQ') THEN 'PARTIAL'::"OrderStatus"
                          ELSE o."status" END
        FROM (SELECT "clientOrderId", SUM("quantity") AS q FROM "Fill"
              WHERE "clientOrderId" IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) GROUP BY 1) f
        WHERE o."clientOrderId" = f."clientOrderId"`;
    }
    if (r.ledgerTxs.length) {
      await tx.ledgerTx.createMany({ data: r.ledgerTxs, skipDuplicates: true });
      await tx.ledgerEntry.createMany({ data: r.ledgerEntries, skipDuplicates: true });
    }
    if (r.samples.length) await tx.quoteSample.createMany({ data: r.samples, skipDuplicates: true });
    if (r.equity.length) await tx.equitySnapshot.createMany({ data: r.equity, skipDuplicates: true });
    if (r.markouts.length) await tx.markout.createMany({ data: r.markouts, skipDuplicates: true });
    if (r.risks.length) await tx.riskEvent.createMany({ data: r.risks, skipDuplicates: true });
    if (r.events.length) await tx.event.createMany({ data: r.events, skipDuplicates: true });
    for (const w of r.withdrawals.values()) {
      const { id, createdAt: _created, botId: _bot, ...change } = w;
      await tx.withdrawal.upsert({ where: { id }, update: change, create: w });
    }
    if (r.botStatus) await tx.bot.update({ where: { id: botId }, data: { status: r.botStatus } });
    if (r.edge) {
      const data = { mode, n: r.edge.n, mean: r.edge.mean, m2: r.edge.m2, prior: json(r.edge.prior) };
      await tx.edgeState.upsert({ where: { botId }, update: data, create: { botId, ...data } });
    }
    // Monotonic: a backfill writing older records never moves the cursor back.
    await tx.$executeRaw`
      INSERT INTO "PersistCursor" ("botId", "run", "seq", "updatedAt") VALUES (${botId}, ${run}, ${BigInt(r.lastSeq)}, NOW())
      ON CONFLICT ("botId", "run") DO UPDATE SET "seq" = GREATEST("PersistCursor"."seq", EXCLUDED."seq"), "updatedAt" = NOW()`;
  }
}
