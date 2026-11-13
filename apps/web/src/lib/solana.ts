import { SOLANA_RPC_URL, USDT_SOLANA_MINT } from '@cortex/shared';

/** Solscan links (opened by the user; nothing is sent automatically). */
export const solscanTx = (sig: string) => `https://solscan.io/tx/${encodeURIComponent(sig)}`;
export const solscanAccount = (addr: string) => `https://solscan.io/account/${encodeURIComponent(addr)}`;

/** Sum of the parsed token amounts of a `getTokenAccountsByOwner` (jsonParsed) answer, or null. */
export function parseTokenBalance(json: unknown): number | null {
  const accounts = (json as { result?: { value?: unknown } } | null)?.result?.value;
  if (!Array.isArray(accounts)) return null;
  let total = 0;
  for (const a of accounts) {
    const ui = (a as { account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmountString?: string } } } } } })?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString;
    const x = Number(ui);
    if (ui === undefined || !Number.isFinite(x)) return null;
    total += x;
  }
  return total;
}

/** USDT held by `owner` on Solana, read from the public RPC. Null when unavailable. */
export async function usdtBalance(owner: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const res = await fetchImpl(SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [owner, { mint: USDT_SOLANA_MINT }, { encoding: 'jsonParsed' }] }),
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok ? parseTokenBalance(await res.json()) : null;
  } catch {
    return null;
  }
}
