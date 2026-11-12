import { z } from 'zod';

/**
 * Wire contracts shared by the worker (single writer of trading state), the API, the dashboard
 * and the Discord bot. The API never mutates trading state: it enqueues a validated command,
 * the worker records it as an input (so it is replayable) and applies it.
 */

import { BotIdSchema } from './bot-id';

export { BOT_ID_RE, BotIdSchema } from './bot-id';

/** Operator commands the engine understands (apps/worker EngineCommand). */
export const EngineCommandSchema = z.enum(['pause', 'resume', 'reset_halt', 'reset_kill']);
export type EngineCommandName = z.infer<typeof EngineCommandSchema>;

/**
 * Commands that can increase risk need a fresh TOTP code on top of the session (step-up).
 * Pausing only ever reduces risk, so it is always one click away (and allowed to service tokens).
 */
export const RISKY_COMMANDS: ReadonlySet<EngineCommandName> = new Set(['resume', 'reset_halt', 'reset_kill']);

/** One command on the bus: Redis stream `bot:<botId>:commands`, field `c` = JSON of this. */
export const CommandEnvelopeSchema = z.object({
  id: z.string().uuid(),
  botId: BotIdSchema,
  command: EngineCommandSchema,
  /** Wallet address or `service:<name>`. */
  actor: z.string().min(1).max(64),
  requestedAt: z.number().int().positive(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

export const commandStreamKey = (botId: string): string => `bot:${botId}:commands`;

export * from './dashboard';
