import type { PrismaClient } from '@cortex/db';
import type { AuditEntry } from '@cortex/shared';

/** Append-only audit trail of every auth decision and command (who, what, from where). */
export interface AuditEvent {
  actor: string;
  action: string;
  target?: string;
  data?: Record<string, unknown>;
  ip?: string;
}

export interface AuditSink {
  record(e: AuditEvent): Promise<void>;
  /** Newest first; `beforeTs` is an exclusive cursor (ms). */
  list(limit: number, beforeTs?: number): Promise<AuditEntry[]>;
}

export class MemoryAudit implements AuditSink {
  readonly events: AuditEvent[] = [];
  private readonly rows: AuditEntry[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  async record(e: AuditEvent) {
    this.events.push(e);
    this.rows.push({ ts: this.now(), actor: e.actor, action: e.action, target: e.target ?? null, ip: e.ip ?? null, data: e.data ?? null });
  }
  async list(limit: number, beforeTs?: number) {
    const out: AuditEntry[] = [];
    for (let i = this.rows.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.rows[i]!;
      if (beforeTs === undefined || r.ts < beforeTs) out.push(r);
    }
    return out;
  }
}

/** AuditLog table (packages/db). A failed audit write fails the request: no unaudited actions. */
export class PrismaAudit implements AuditSink {
  constructor(private readonly prisma: PrismaClient) {}
  async record(e: AuditEvent) {
    await this.prisma.auditLog.create({
      data: { actor: e.actor, action: e.action, target: e.target ?? null, ip: e.ip ?? null, ...(e.data ? { data: e.data as object } : {}) },
    });
  }
  async list(limit: number, beforeTs?: number) {
    const rows = await this.prisma.auditLog.findMany({
      where: beforeTs === undefined ? {} : { ts: { lt: new Date(beforeTs) } },
      orderBy: { ts: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({ ts: r.ts.getTime(), actor: r.actor, action: r.action, target: r.target, ip: r.ip, data: (r.data as Record<string, unknown> | null) ?? null }));
  }
}
