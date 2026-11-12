import { CommandEnvelopeSchema, RISKY_COMMANDS, commandStreamKey, type BotEvent, type CommandEnvelope } from '@cortex/shared';

/**
 * Operator commands from the API (Redis stream `bot:<botId>:commands`) into the engine.
 *
 * - Consumer group + XACK: at-least-once. A crash between read and ack re-delivers the command
 *   on the next boot; every engine command is idempotent (pause twice = paused).
 * - The worker stays the single writer: a command only becomes an engine *input record* here,
 *   so it is recorded and replays bit-for-bit like market data.
 * - Age policy: `pause` only reduces risk and always applies, even if it waited out a restart.
 *   Risky commands (resume / reset_*) were authorised by a TOTP step-up *at that moment*: after
 *   `maxRiskyAgeMs` they are refused, never applied late.
 * - A malformed entry, or one for another bot, is acknowledged and refused (never retried forever).
 */
export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

/** The few Redis stream operations needed (ioredis in production, a fake in tests). */
export interface StreamClient {
  ensureGroup(stream: string, group: string): Promise<void>;
  /** id '0' = this consumer's pending (unacked) entries, '>' = new entries. */
  readGroup(stream: string, group: string, consumer: string, id: '0' | '>', count: number, blockMs: number): Promise<StreamEntry[]>;
  ack(stream: string, group: string, id: string): Promise<void>;
  /** Appends to the bot's event stream and notifies the live channel (dashboard). */
  publishEvent(botId: string, e: BotEvent): Promise<void>;
}

export type CommandDecision = { apply: true; envelope: CommandEnvelope } | { apply: false; reason: string; envelope?: CommandEnvelope };

export function decideCommand(fields: Record<string, string>, botId: string, nowMs: number, maxRiskyAgeMs: number): CommandDecision {
  let raw: unknown;
  try {
    raw = JSON.parse(fields.c ?? '');
  } catch {
    return { apply: false, reason: 'malformed' };
  }
  const p = CommandEnvelopeSchema.safeParse(raw);
  if (!p.success) return { apply: false, reason: 'malformed' };
  const envelope = p.data;
  if (envelope.botId !== botId) return { apply: false, reason: 'wrong_bot', envelope };
  if (RISKY_COMMANDS.has(envelope.command) && nowMs - envelope.requestedAt > maxRiskyAgeMs) {
    return { apply: false, reason: 'expired', envelope };
  }
  return { apply: true, envelope };
}

export interface CommandSourceOptions {
  botId: string;
  client: StreamClient;
  /** Feeds the engine (records the input). Must not throw for a valid command. */
  apply: (c: CommandEnvelope) => void;
  now?: () => number;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  onError?: () => void;
  maxRiskyAgeMs?: number;
  blockMs?: number;
}

export const COMMAND_GROUP = 'worker';
const CONSUMER = 'engine';

export class CommandSource {
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly stream: string;
  private readonly now: () => number;
  private readonly maxRiskyAgeMs: number;
  applied = 0;
  refused = 0;

  constructor(private readonly o: CommandSourceOptions) {
    this.stream = commandStreamKey(o.botId);
    this.now = o.now ?? Date.now;
    this.maxRiskyAgeMs = o.maxRiskyAgeMs ?? 120_000;
  }

  /** Processes one batch: pending (crash leftovers) first, then new entries. Returns how many. */
  async poll(): Promise<number> {
    const { client } = this.o;
    let entries = await client.readGroup(this.stream, COMMAND_GROUP, CONSUMER, '0', 50, 0);
    if (entries.length === 0) entries = await client.readGroup(this.stream, COMMAND_GROUP, CONSUMER, '>', 50, this.o.blockMs ?? 5_000);
    for (const e of entries) {
      if (!this.running && this.loop) break; // stopping: leave the rest unacked for the next boot
      const d = decideCommand(e.fields, this.o.botId, this.now(), this.maxRiskyAgeMs);
      if (d.apply) {
        this.o.apply(d.envelope);
        this.applied++;
      } else {
        this.refused++;
      }
      const ts = this.now();
      const result: BotEvent = d.apply
        ? { k: 'command', ts, id: d.envelope.id, command: d.envelope.command, actor: d.envelope.actor, applied: true }
        : { k: 'command', ts, id: d.envelope?.id ?? null, command: d.envelope?.command ?? null, actor: d.envelope?.actor ?? null, applied: false, reason: d.reason };
      this.o.log?.[d.apply ? 'info' : 'warn']({ ...result, entry: e.id }, d.apply ? 'operator command applied' : 'operator command refused');
      await client.ack(this.stream, COMMAND_GROUP, e.id);
      await client.publishEvent(this.o.botId, result).catch(() => this.o.onError?.());
    }
    return entries.length;
  }

  /** Never throws: Redis being down at boot (or later) only delays commands, with backoff. */
  start(): void {
    this.running = true;
    this.loop = (async () => {
      let ready = false;
      let backoff = 1_000;
      while (this.running) {
        try {
          if (!ready) {
            await this.o.client.ensureGroup(this.stream, COMMAND_GROUP);
            ready = true;
          }
          const n = await this.poll();
          backoff = 1_000;
          // Yield to the event loop when idle (a client that does not block must not starve it).
          if (n === 0) await new Promise((r) => setImmediate(r));
        } catch (err) {
          if (!this.running) break;
          this.o.onError?.();
          this.o.log?.warn({ err: (err as Error).message, retryMs: backoff }, 'command stream unavailable');
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    })();
  }

  /** Stops after the current batch; disconnecting the client first unblocks a waiting read. */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}
