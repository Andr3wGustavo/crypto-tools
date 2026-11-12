import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { testWallet as wallet } from '../testing/wallet';
import { base32Decode, base32Encode, base58Decode, base58Encode, solanaPublicKey } from './encoding';
import { buildSiwsMessage, checkSiws, parseSiwsMessage, verifySolanaSignature, type SiwsFields } from './siws';
import { hotp, otpauthUri, verifyTotp } from './totp';

describe('encodings', () => {
  it('base58 matches known vectors and round-trips any bytes (leading zeros included)', () => {
    expect(base58Encode(Buffer.from('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
    expect(base58Encode(Uint8Array.from([0, 0, 1]))).toBe('112');
    expect(Buffer.from(base58Decode('11111111111111111111111111111111'))).toEqual(Buffer.alloc(32)); // System Program
    fc.assert(fc.property(fc.uint8Array({ maxLength: 80 }), (b) => Buffer.from(base58Decode(base58Encode(b))).equals(Buffer.from(b))));
    expect(() => base58Decode('0OIl')).toThrow();
  });

  it('Solana addresses must be canonical 32-byte keys', () => {
    expect(solanaPublicKey('11111111111111111111111111111111')).toHaveLength(32);
    expect(() => solanaPublicKey(base58Encode(new Uint8Array(31).fill(7)))).toThrow();
    expect(() => solanaPublicKey(base58Encode(new Uint8Array(33).fill(7)))).toThrow();
  });

  it('base32 matches RFC 4648 vectors (unpadded) and round-trips', () => {
    const v: Array<[string, string]> = [['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
    for (const [plain, enc] of v) {
      expect(base32Encode(Buffer.from(plain))).toBe(enc);
      expect(base32Decode(`${enc.toLowerCase()}==`).toString()).toBe(plain);
    }
    fc.assert(fc.property(fc.uint8Array({ maxLength: 64 }), (b) => base32Decode(base32Encode(b)).equals(Buffer.from(b))));
  });
});

describe('TOTP (RFC 4226 / RFC 6238)', () => {
  const key = Buffer.from('12345678901234567890');

  it('HOTP matches the RFC 4226 test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, c) => expect(hotp(key, c)).toBe(code));
  });

  it('TOTP matches the RFC 6238 SHA-1 test vectors (8 digits)', () => {
    const v: Array<[number, string]> = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
    for (const [t, code] of v) expect(verifyTotp(key, code, t * 1000, -1, { digits: 8, window: 0 })).toBe(Math.floor(t / 30));
  });

  it('accepts ±1 step of drift, rejects replays, older steps and junk', () => {
    const t = 1_700_000_000_000;
    const c = Math.floor(t / 30_000);
    expect(verifyTotp(key, hotp(key, c - 1), t, -1)).toBe(c - 1);
    expect(verifyTotp(key, hotp(key, c + 1), t, -1)).toBe(c + 1);
    expect(verifyTotp(key, hotp(key, c + 2), t, -1)).toBeUndefined();
    expect(verifyTotp(key, hotp(key, c), t, c)).toBeUndefined(); // already used
    expect(verifyTotp(key, hotp(key, c - 1), t, c)).toBeUndefined(); // older than the last used
    for (const junk of ['', '12345', '1234567', 'abcdef', ' 12345']) expect(verifyTotp(key, junk, t, -1)).toBeUndefined();
    expect(otpauthUri('ABC', 'me')).toBe('otpauth://totp/Cortex%20Farm%3Ame?secret=ABC&issuer=Cortex%20Farm&algorithm=SHA1&digits=6&period=30');
  });
});

describe('Sign-In With Solana', () => {
  const w = wallet();
  const fields: SiwsFields = {
    domain: 'cortex.example.ts.net', address: w.address, statement: 'Sign in to the Cortex Farm operator console.', uri: 'https://cortex.example.ts.net',
    version: '1', chainId: 'mainnet', nonce: 'a1b2c3d4e5f6a7b8', issuedAt: '2026-11-12T10:00:00.000Z', expirationTime: '2026-11-12T10:05:00.000Z',
  };
  const text = buildSiwsMessage(fields);
  const expected = { ...fields, uri: fields.uri!, nonce: fields.nonce!, issuedAt: fields.issuedAt!, expirationTime: fields.expirationTime!, statement: fields.statement! };
  const now = Date.parse('2026-11-12T10:01:00Z');

  it('builds the wallet-standard text and parses it back exactly', () => {
    expect(text).toBe(
      `cortex.example.ts.net wants you to sign in with your Solana account:\n${w.address}\n\nSign in to the Cortex Farm operator console.\n\n` +
        'URI: https://cortex.example.ts.net\nVersion: 1\nChain ID: mainnet\nNonce: a1b2c3d4e5f6a7b8\nIssued At: 2026-11-12T10:00:00.000Z\nExpiration Time: 2026-11-12T10:05:00.000Z',
    );
    expect(parseSiwsMessage(text)).toEqual(fields);
    const noStatement = { domain: 'd.example', address: w.address, nonce: 'n0nce123', resources: ['https://a', 'ipfs://b'] };
    expect(parseSiwsMessage(buildSiwsMessage(noStatement))).toEqual(noStatement);
    expect(parseSiwsMessage(buildSiwsMessage({ domain: 'd.example', address: w.address }))).toEqual({ domain: 'd.example', address: w.address });
  });

  it('rejects anything that is not in canonical form', () => {
    const bad = [
      text.replace('Version: 1\nChain ID: mainnet', 'Chain ID: mainnet\nVersion: 1'), // reordered
      text.replace('Nonce: ', 'Nonce:  '), // extra space
      text.replace('Version: 1', 'Version: 1\nVersion: 1'), // duplicate
      text.replace('Chain ID: mainnet', 'Chain ID: mainnet\nEvil: yes'), // unknown field
      `${text}\n`, // trailing newline
      text.replace(' wants you', ' Wants you'),
    ];
    for (const b of bad) expect(() => parseSiwsMessage(b), b).toThrow();
  });

  it('verifies ed25519 signatures by the address and nothing else', () => {
    const sig = w.sign(text);
    expect(verifySolanaSignature(w.address, Buffer.from(text), sig)).toBe(true);
    expect(verifySolanaSignature(w.address, Buffer.from(`${text}x`), sig)).toBe(false);
    expect(verifySolanaSignature(wallet().address, Buffer.from(text), sig)).toBe(false);
    expect(verifySolanaSignature(w.address, Buffer.from(text), sig.subarray(0, 63))).toBe(false);
    expect(verifySolanaSignature('not-an-address', Buffer.from(text), sig)).toBe(false);
  });

  it('checkSiws: every field is bound, and the allowlist is enforced', () => {
    const allow = new Set([w.address]);
    expect(checkSiws(text, w.sign(text), expected, allow, now)).toEqual({ ok: true, address: w.address });
    expect(checkSiws(text, w.sign(text), expected, new Set(), now)).toEqual({ ok: false, reason: 'not_allowed' });
    expect(checkSiws(text, w.sign(text), expected, allow, Date.parse(fields.expirationTime!))).toEqual({ ok: false, reason: 'expired' });
    expect(checkSiws(text, w.sign(text), expected, allow, Date.parse('2026-11-12T09:58:00Z'))).toEqual({ ok: false, reason: 'not_yet_valid' });
    expect(checkSiws(text, w.sign(text), { ...expected, domain: 'evil.example' }, allow, now)).toEqual({ ok: false, reason: 'domain' });
    expect(checkSiws(text, w.sign(text), { ...expected, nonce: 'other' }, allow, now)).toEqual({ ok: false, reason: 'nonce' });
    expect(checkSiws(text, wallet().sign(text), expected, allow, now)).toEqual({ ok: false, reason: 'signature' });
    expect(checkSiws('hello', w.sign('hello'), expected, allow, now)).toEqual({ ok: false, reason: 'malformed' });
  });
});
