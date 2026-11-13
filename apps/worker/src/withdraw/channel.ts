import crypto from 'node:crypto';
import { WITHDRAWAL_ID, canonicalJson } from '@cortex/core';
import { z } from 'zod';

/**
 * The channel between the live trading process and the withdrawer process (two Redis streams).
 *
 *   live ──  cortex:withdraw:req  ──► withdrawer      "submit | status | abort withdrawal <id>"
 *   live ◄── cortex:withdraw:evt  ───  withdrawer      "<id> is SENT | CONFIRMED | FAILED"
 *
 * Both directions are authenticated with HMAC-SHA256 over the canonical JSON message, keyed by
 * WITHDRAW_CHANNEL_SECRET (shared by the two processes only). Without it, anything that can
 * write to Redis could ask for a withdrawal, or fake a FAILED report that releases a reserve.
 * Delivery is at-least-once (the live engine re-asks until the withdrawal is final) and every
 * answer is idempotent, so readers start from new entries only and need no cursor.
 */
export const WITHDRAW_REQ_STREAM = 'cortex:withdraw:req';
export const WITHDRAW_EVT_STREAM = 'cortex:withdraw:evt';
export const WITHDRAW_STREAM_MAX = 1_000;
export const MIN_CHANNEL_SECRET = 32;

const decimal = z.string().regex(/^\d{1,12}(\.\d{1,18})?$/);

export const WithdrawRequestMsgSchema = z.object({
  v: z.literal(1),
  botId: z.string().min(1).max(64),
  id: z.string().regex(WITHDRAWAL_ID),
  asset: z.string().regex(/^[A-Z0-9]{2,12}$/),
  amount: decimal,
  createdTs: z.number().int().positive(),
  sentTs: z.number().int().positive(),
  mode: z.enum(['submit', 'status', 'abort']),
}).strict();
export type WithdrawRequestMsg = z.infer<typeof WithdrawRequestMsgSchema>;

export const WithdrawReportMsgSchema = z.object({
  v: z.literal(1),
  botId: z.string().min(1).max(64),
  id: z.string().regex(WITHDRAWAL_ID),
  status: z.enum(['SENT', 'CONFIRMED', 'FAILED']),
  amount: decimal.optional(),
  fee: decimal.optional(),
  exchangeId: z.string().max(64).optional(),
  txId: z.string().max(128).optional(),
  reason: z.string().max(300).optional(),
  sentTs: z.number().int().positive(),
}).strict();
export type WithdrawReportMsg = z.infer<typeof WithdrawReportMsgSchema>;

export function signMessage(msg: object, secret: string): string {
  return crypto.createHmac('sha256', secret).update(canonicalJson(msg)).digest('hex');
}

/** Stream entry fields for a message: `m` (JSON) + `sig`. */
export function encodeMessage(msg: object, secret: string): Record<string, string> {
  return { m: JSON.stringify(msg), sig: signMessage(msg, secret) };
}

export type Decoded<T> = { ok: true; msg: T } | { ok: false; reason: string };

/** Verifies the signature first (constant time), then the shape. Never throws. */
export function decodeMessage<T>(fields: Record<string, string>, schema: z.ZodType<T>, secret: string): Decoded<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(fields.m ?? '');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(signMessage(raw, secret), 'hex');
  const got = Buffer.from(/^[0-9a-f]{64}$/.test(fields.sig ?? '') ? fields.sig! : '', 'hex');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return { ok: false, reason: 'bad_signature' };
  const p = schema.safeParse(raw);
  return p.success ? { ok: true, msg: p.data } : { ok: false, reason: 'invalid' };
}

export function validChannelSecret(s: string | undefined): s is string {
  return typeof s === 'string' && s.length >= MIN_CHANNEL_SECRET && !/^(.)\1*$/.test(s);
}
