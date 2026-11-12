import crypto from 'node:crypto';
import { solanaPublicKey } from './encoding';

/**
 * Sign-In With Solana (the wallet-standard `solana:signIn` message, as Phantom builds it; also
 * what `signMessage` of the same text produces). Pure functions: the route layer owns nonces.
 *
 *   <domain> wants you to sign in with your Solana account:
 *   <address>
 *
 *   <statement>
 *
 *   URI: <uri>
 *   Version: 1
 *   Chain ID: <chainId>
 *   Nonce: <nonce>
 *   Issued At: <ISO-8601>
 *   Expiration Time: <ISO-8601>
 *
 * The server builds the expected fields, the wallet signs, and the server re-parses what was
 * signed and compares every field: nothing the client sends is trusted except the signature.
 */
export interface SiwsFields {
  domain: string;
  address: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

const FIELD_ORDER: Array<[keyof SiwsFields, string]> = [
  ['uri', 'URI'],
  ['version', 'Version'],
  ['chainId', 'Chain ID'],
  ['nonce', 'Nonce'],
  ['issuedAt', 'Issued At'],
  ['expirationTime', 'Expiration Time'],
  ['notBefore', 'Not Before'],
  ['requestId', 'Request ID'],
];

export function buildSiwsMessage(f: SiwsFields): string {
  let msg = `${f.domain} wants you to sign in with your Solana account:\n${f.address}`;
  if (f.statement) msg += `\n\n${f.statement}`;
  const lines: string[] = [];
  for (const [k, label] of FIELD_ORDER) {
    const v = f[k];
    if (typeof v === 'string' && v) lines.push(`${label}: ${v}`);
  }
  if (f.resources?.length) lines.push('Resources:', ...f.resources.map((r) => `- ${r}`));
  if (lines.length) msg += `\n\n${lines.join('\n')}`;
  return msg;
}

/** Strict parser: the inverse of buildSiwsMessage; throws on anything else. */
export function parseSiwsMessage(text: string): SiwsFields {
  const m = /^(?<domain>[^\s]+) wants you to sign in with your Solana account:\n(?<address>[1-9A-HJ-NP-Za-km-z]{32,44})(?<rest>[\s\S]*)$/.exec(text);
  if (!m?.groups) throw new Error('not a Sign-In With Solana message');
  const f: SiwsFields = { domain: m.groups.domain!, address: m.groups.address! };
  const blocks = m.groups.rest!.length ? m.groups.rest!.replace(/^\n\n/, '').split('\n\n') : [];
  if (m.groups.rest!.length && !m.groups.rest!.startsWith('\n\n')) throw new Error('malformed message header');
  let fieldBlock: string | undefined;
  if (blocks.length === 2) {
    f.statement = blocks[0]!;
    fieldBlock = blocks[1];
  } else if (blocks.length === 1) {
    if (/^(URI|Version|Chain ID|Nonce|Issued At|Expiration Time|Not Before|Request ID|Resources):/.test(blocks[0]!)) fieldBlock = blocks[0];
    else f.statement = blocks[0]!;
  } else if (blocks.length > 2) throw new Error('malformed message');
  if (f.statement !== undefined && f.statement.includes('\n')) throw new Error('statement must be one line');
  if (fieldBlock) {
    const lines = fieldBlock.split('\n');
    let i = 0;
    let order = 0;
    for (; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === 'Resources:') {
        f.resources = lines.slice(i + 1).map((r) => {
          if (!r.startsWith('- ')) throw new Error('malformed resources');
          return r.slice(2);
        });
        break;
      }
      const sep = line.indexOf(': ');
      if (sep < 0) throw new Error(`malformed field line "${line}"`);
      const label = line.slice(0, sep);
      const value = line.slice(sep + 2);
      if (!value || value !== value.trim()) throw new Error(`empty or padded value for "${label}"`);
      const idx = FIELD_ORDER.findIndex(([, l]) => l === label);
      if (idx < order) throw new Error(`unknown, duplicate or out-of-order field "${label}"`);
      order = idx + 1;
      (f as unknown as Record<string, string>)[FIELD_ORDER[idx]![0]] = value;
    }
  }
  if (buildSiwsMessage(f) !== text) throw new Error('message is not in canonical form');
  return f;
}

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Ed25519 signature check of `message` by the Solana `address` (node:crypto, no dependency). */
export function verifySolanaSignature(address: string, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(solanaPublicKey(address))]), format: 'der', type: 'spki' });
  } catch {
    return false;
  }
  try {
    return crypto.verify(null, message, key, signature);
  } catch {
    return false;
  }
}

export type SiwsRejection =
  | 'malformed'
  | 'domain'
  | 'uri'
  | 'nonce'
  | 'address'
  | 'not_allowed'
  | 'issued_at'
  | 'expired'
  | 'not_yet_valid'
  | 'signature';

/**
 * Full check of a signed message against what the server issued for that nonce. Returns the
 * reason of the FIRST failed check (for the audit log; the client only ever sees "rejected").
 */
export function checkSiws(
  text: string,
  signature: Uint8Array,
  expected: { domain: string; uri: string; nonce: string; issuedAt: string; expirationTime: string; address: string; statement: string },
  allowlist: ReadonlySet<string>,
  nowMs: number,
  skewMs = 60_000,
): { ok: true; address: string } | { ok: false; reason: SiwsRejection } {
  let f: SiwsFields;
  try {
    f = parseSiwsMessage(text);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (f.domain !== expected.domain) return { ok: false, reason: 'domain' };
  if (f.uri !== expected.uri || f.statement !== expected.statement || f.version !== '1') return { ok: false, reason: 'uri' };
  if (f.nonce !== expected.nonce) return { ok: false, reason: 'nonce' };
  if (f.address !== expected.address) return { ok: false, reason: 'address' };
  if (f.issuedAt !== expected.issuedAt || f.expirationTime !== expected.expirationTime) return { ok: false, reason: 'issued_at' };
  if (Date.parse(f.issuedAt) > nowMs + skewMs) return { ok: false, reason: 'not_yet_valid' };
  if (!(nowMs < Date.parse(f.expirationTime))) return { ok: false, reason: 'expired' };
  if (!verifySolanaSignature(f.address, Buffer.from(text, 'utf8'), signature)) return { ok: false, reason: 'signature' };
  // Allowlist last: an attacker learns nothing about it from timing of the earlier checks.
  if (!allowlist.has(f.address)) return { ok: false, reason: 'not_allowed' };
  return { ok: true, address: f.address };
}
