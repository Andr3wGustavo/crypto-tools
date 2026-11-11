import { prisma, type Prisma } from '@cortex/db';
import type { LedgerTransaction, StrategyAction, StrategyConfig } from '@cortex/core';
import type { EngineOutput } from '../engine/shadow-engine';
import type { Logger } from '../logger';

type Mode = 'shadow' | 'live';

/**
 * Batched, ordered persistence of engine outputs. The engine never awaits the database:
 * outputs are queued and flushed every `flushMs`. A failed flush keeps its batch for retry
 * (bounded) and increments the error counter that feeds the risk manager.
 */
export class PostgresSink {
  private queue: EngineOutput[] = [];
  private flushing = false;
  private timer: NodeJS.Timeout | undefined;
  errors = 0;
  private lastEquityTs = 0;

  constructor(
    private readonly botId: string,
    private readonly symbol: string,
    private readonly mode: Mode,
    private readonly edgeState: () => { n: number; mean: number; m2: number; prior: unknown },
    private readonly lookupTx: (id: string) => LedgerTransaction | undefined,
    private readonly log: Logger,
    private readonly flushMs = 1_000,
    private readonly maxQueue = 200_000,
  ) {}

  async init(venue: string, symbol: string, config: StrategyConfig): Promise<void> {
    await prisma.bot.upsert({
      where: { id: this.botId },
      update: { status: 'running', mode: this.mode },
      create: { id: this.botId, venue, symbol, mode: this.mode, status: 'running' },
    });
    const params = JSON.parse(JSON.stringify(config)) as Prisma.InputJsonValue;
    const last = await prisma.botConfig.findFirst({ where: { botId: this.botId }, orderBy: { version: 'desc' } });
    if (!last || JSON.stringify(last.params) !== JSON.stringify(params)) {
      // Pre-registration: every parameter change becomes a new immutable version.
      await prisma.botConfig.create({ data: { botId: this.botId, version: (last?.version ?? 0) + 1, params, createdBy: 'worker' } });
    }
    this.timer = setInterval(() => void this.flush(), this.flushMs);
  }

  push(outs: EngineOutput[]): void {
    for (const o of outs) this.queue.push(o);
    if (this.queue.length > this.maxQueue) {
      this.queue.splice(0, this.queue.length - this.maxQueue);
      this.errors++;
      this.log.error({ maxQueue: this.maxQueue }, 'postgres sink queue overflow; oldest outputs dropped');
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue;
    this.queue = [];
    try {
      await this.write(batch);
    } catch (err) {
      this.errors++;
      this.log.error({ err: (err as Error).message, size: batch.length }, 'postgres flush failed; will retry');
      this.queue = batch.concat(this.queue);
    } finally {
      this.flushing = false;
    }
  }

  private async write(batch: EngineOutput[]): Promise<void> {
    const mode = this.mode;
    const botId = this.botId;
    const orders: Prisma.OrderCreateManyInput[] = [];
    const orderStatus: Array<{ id: string; status: 'CANCEL_REQ' | 'NEW' | 'CANCELED' | 'REJECTED'; reason?: string }> = [];
    const fills: Prisma.FillCreateManyInput[] = [];
    const fillQty = new Map<string, number>();
    const events: Prisma.EventCreateManyInput[] = [];
    const samples: Prisma.QuoteSampleCreateManyInput[] = [];
    const equity: Prisma.EquitySnapshotCreateManyInput[] = [];
    const markouts: Prisma.MarkoutCreateManyInput[] = [];
    const risks: Prisma.RiskEventCreateManyInput[] = [];
    const txs: LedgerTransaction[] = [];
    let edge: Extract<EngineOutput, { kind: 'edge' }> | undefined;

    const ev = (ts: number, type: string, payload: unknown) =>
      events.push({ ts: new Date(ts), mode, botId, type, payload: payload as Prisma.InputJsonValue });

    for (const o of batch) {
      if (o.kind === 'action') {
        const a: StrategyAction = o.action;
        switch (a.kind) {
          case 'place':
            orders.push({ clientOrderId: a.clientOrderId, botId, mode, venue: 'mexc', symbol: this.symbol, side: a.side, price: a.price, quantity: a.qty, status: 'SENT', createdAt: new Date(a.ts) });
            ev(a.ts, 'order.place', a);
            break;
          case 'cancel':
            orderStatus.push({ id: a.clientOrderId, status: 'CANCEL_REQ', reason: a.reason });
            ev(a.ts, 'order.cancel', a);
            break;
          case 'sample':
            samples.push({ botId, ts: new Date(a.ts), fair: a.fair, bid: a.bid ?? null, ask: a.ask ?? null, halfSpreadBps: a.halfSpreadBps, skewBps: a.skewBps, sigmaBps: a.sigmaBps, toxic: a.toxic });
            if (a.ts - this.lastEquityTs >= 10_000) {
              this.lastEquityTs = a.ts;
              equity.push({
                botId, mode, ts: new Date(a.ts), equity: a.equity, cash: a.quoteBalance, treasury: 0,
                inventoryQty: a.inventoryQty, inventoryValue: a.inventoryQty * a.fair,
                realizedPnl: a.realizedPnl, unrealizedPnl: a.unrealizedPnl, fees: 0, mid: a.mid,
              });
            }
            break;
          case 'markout':
            markouts.push({ fillId: a.fillId, horizonMs: a.horizonMs, botId, ts: new Date(a.ts), bps: a.bps });
            break;
          case 'risk':
            for (const v of a.violations) risks.push({ botId, ts: new Date(a.ts), severity: v.severity, rule: v.rule, message: v.message });
            break;
          case 'status':
            ev(a.ts, 'bot.status', a);
            break;
          case 'error':
            ev(a.ts, 'bot.error', a);
            break;
        }
      } else if (o.kind === 'sim') {
        const e = o.event;
        if (e.kind === 'fill') {
          fills.push({ id: e.fillId, clientOrderId: e.clientOrderId, botId, mode, side: e.side, price: e.price, quantity: e.qty, quoteQty: e.price * e.qty, fee: e.fee, feeAsset: 'quote', isMaker: true, ts: new Date(e.ts) });
          fillQty.set(e.clientOrderId, (fillQty.get(e.clientOrderId) ?? 0) + e.qty);
          ev(e.ts, 'order.fill', e);
        } else {
          orderStatus.push({ id: e.clientOrderId, status: e.status, ...(e.reason ? { reason: e.reason } : {}) });
          ev(e.ts, `order.${e.status.toLowerCase()}`, e);
        }
      } else if (o.kind === 'ledger') {
        const tx = this.lookupTx(o.txId);
        if (tx) txs.push(tx);
      } else if (o.kind === 'edge') {
        edge = o;
        ev(o.ts, 'edge.window', o);
      } else if (o.kind === 'reconcile') {
        ev(o.ts, 'reconcile.diverged', o);
      }
    }

    if (orders.length) await prisma.order.createMany({ data: orders, skipDuplicates: true });
    for (const s of orderStatus) {
      await prisma.order.updateMany({ where: { clientOrderId: s.id }, data: { status: s.status, ...(s.reason ? { reason: s.reason } : {}) } });
    }
    if (fills.length) await prisma.fill.createMany({ data: fills, skipDuplicates: true });
    for (const [id, q] of fillQty) await prisma.order.updateMany({ where: { clientOrderId: id }, data: { filledQty: { increment: q } } });
    for (const tx of txs) {
      await prisma.ledgerTx.upsert({
        where: { id: `${botId}:${tx.id}` },
        update: {},
        create: {
          id: `${botId}:${tx.id}`, ts: new Date(tx.ts), mode, botId, kind: tx.kind, ref: tx.ref ?? null,
          entries: { create: tx.postings.map((p) => ({ account: p.account, asset: p.asset, amount: p.amount })) },
        },
      });
    }
    if (samples.length) await prisma.quoteSample.createMany({ data: samples, skipDuplicates: true });
    if (equity.length) await prisma.equitySnapshot.createMany({ data: equity, skipDuplicates: true });
    if (markouts.length) await prisma.markout.createMany({ data: markouts, skipDuplicates: true });
    if (risks.length) await prisma.riskEvent.createMany({ data: risks });
    if (events.length) await prisma.event.createMany({ data: events });
    if (edge) {
      const st = this.edgeState();
      const data = { mode, n: st.n, mean: st.mean, m2: st.m2, prior: st.prior as Prisma.InputJsonValue };
      await prisma.edgeState.upsert({ where: { botId }, update: data, create: { botId, ...data } });
    }
  }
}
