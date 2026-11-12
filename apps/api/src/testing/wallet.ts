import crypto from 'node:crypto';
import { base58Encode } from '../auth/encoding';

/** A throwaway ed25519 keypair behaving like a Phantom wallet: base58 address, signs UTF-8 text. */
export function testWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return { address: base58Encode(raw), sign: (msg: string) => crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey) };
}
