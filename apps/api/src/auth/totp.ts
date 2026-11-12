import crypto from 'node:crypto';

/**
 * TOTP (RFC 6238, HMAC-SHA1, 30 s steps, 6 digits — what every authenticator app speaks).
 * Used as step-up for commands that can increase risk. Replay-proof: a code is accepted only
 * for a time step strictly after the last accepted one (the caller persists `lastCounter`).
 */
export function hotp(key: Uint8Array, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export interface TotpOptions {
  stepSec?: number;
  digits?: number;
  /** Accepted clock drift, in steps on each side. */
  window?: number;
}

export function totpCounter(nowMs: number, stepSec = 30): number {
  return Math.floor(nowMs / 1000 / stepSec);
}

/**
 * Returns the matched time step, or undefined. Never accepts a step ≤ lastCounter (replay),
 * compares in constant time, and checks every candidate step (no early exit on match).
 */
export function verifyTotp(key: Uint8Array, code: string, nowMs: number, lastCounter: number, o: TotpOptions = {}): number | undefined {
  const digits = o.digits ?? 6;
  if (code.length !== digits || !/^[0-9]+$/.test(code)) return undefined;
  const now = totpCounter(nowMs, o.stepSec ?? 30);
  const w = o.window ?? 1;
  const given = Buffer.from(code);
  let matched: number | undefined;
  for (let c = now - w; c <= now + w; c++) {
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(key, c, digits)), given);
    if (ok && c > lastCounter && matched === undefined) matched = c;
  }
  return matched;
}

/** otpauth:// URI for enrolling the secret in an authenticator app. */
export function otpauthUri(secretBase32: string, account: string, issuer = 'Cortex Farm'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
