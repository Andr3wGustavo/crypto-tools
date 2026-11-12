/**
 * Phantom sign-in. The API builds the Sign-In With Solana message (domain, nonce, expiry),
 * the wallet signs exactly those bytes, and the API verifies the Ed25519 signature against the
 * allowlist. No private key or seed ever touches this page.
 * On a phone: open the dashboard inside the Phantom app's browser (it injects the provider).
 */
export interface PublicKeyLike {
  toString(): string;
}

export interface SolanaProvider {
  isPhantom?: boolean;
  publicKey?: PublicKeyLike | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKeyLike }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array }>;
}

type WalletWindow = { phantom?: { solana?: SolanaProvider }; solana?: SolanaProvider };

export function findPhantom(w: WalletWindow = window as unknown as WalletWindow): SolanaProvider | undefined {
  const p = w.phantom?.solana ?? w.solana;
  return p?.isPhantom ? p : undefined;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export interface SignInApi {
  nonce(address: string): Promise<{ message: string }>;
  verify(message: string, signature: string): Promise<{ address: string }>;
}

export type SignInStep = 'connect' | 'challenge' | 'sign' | 'verify';

/**
 * Connect → challenge → sign → verify. Before signing, the message is checked to be a sign-in
 * for this page's own domain, so the dashboard can never be used to make the wallet sign
 * something else.
 */
export async function signInWithPhantom(p: SolanaProvider, api: SignInApi, host: string, onStep: (s: SignInStep) => void = () => undefined): Promise<string> {
  onStep('connect');
  const { publicKey } = await p.connect();
  const address = publicKey.toString();
  onStep('challenge');
  const { message } = await api.nonce(address);
  const firstLine = message.split('\n', 1)[0] ?? '';
  if (firstLine !== `${host} wants you to sign in with your Solana account:` || !message.includes(`\n${address}\n`)) {
    throw new Error('mensagem de login inesperada: assinatura recusada');
  }
  onStep('sign');
  const { signature } = await p.signMessage(new TextEncoder().encode(message), 'utf8');
  onStep('verify');
  const r = await api.verify(message, toBase64(signature));
  return r.address;
}

/** User-facing reason for a failed sign-in. */
export function signInError(err: unknown): string {
  const e = err as { code?: number; message?: string; status?: number };
  if (e?.code === 4001) return 'Assinatura cancelada na carteira.';
  if (e?.status === 401) return 'Login recusado. Esta carteira está autorizada? (A allowlist fica no servidor.)';
  if (e?.status === 429) return 'Muitas tentativas. Aguarde um minuto.';
  return e?.message ? `Falha no login: ${e.message}` : 'Falha no login.';
}
