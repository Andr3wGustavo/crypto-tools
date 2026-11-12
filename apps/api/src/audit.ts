import type { PrismaClient } from '@cortex/db';

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
}

export class MemoryAudit implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(e: AuditEvent) {
    this.events.push(e);
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
}
