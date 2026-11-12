import { z } from 'zod';

/** `mexc:<SYMBOL>:<mode>` — the worker's bot id. */
export const BOT_ID_RE = /^mexc:[A-Z0-9]{2,20}:(shadow|live)$/;
export const BotIdSchema = z.string().regex(BOT_ID_RE, 'invalid bot id');
