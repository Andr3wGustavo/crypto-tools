import { devWallet } from './server';

/** Dev only: signs in as the dev wallet and prints the session cookie (for curl / Playwright). */
export async function devLogin(base = 'http://127.0.0.1:8080'): Promise<string> {
  const w = devWallet();
  const origin = new URL(base).origin;
  const n = await fetch(`${base}/auth/nonce`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ address: w.address }) });
  const { message } = (await n.json()) as { message: string };
  const v = await fetch(`${base}/auth/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ message, signature: Buffer.from(w.sign(message)).toString('base64') }),
  });
  if (!v.ok) throw new Error(`dev login failed: ${v.status}`);
  const c = /cortex_session=([^;]+)/.exec(v.headers.get('set-cookie') ?? '');
  if (!c) throw new Error('no session cookie');
  return c[1]!;
}

if (process.argv[1] && /dev[\\/]login\.ts$/.test(process.argv[1])) {
  devLogin(process.argv[2]).then((c) => console.log(c), (e) => {
    console.error(e);
    process.exit(1);
  });
}
