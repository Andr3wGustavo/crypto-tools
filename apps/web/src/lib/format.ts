/** Display formatting (pt-BR). Pure functions: unit-tested. Never used for accounting. */

const nf = (min: number, max: number) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max });
const usd2 = nf(2, 2);
const usd4 = nf(4, 4);
const int = nf(0, 0);

export const DASH = '—';
const ok = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/** US$ with 2 decimals; below US$1 shows 4 (shadow capital is small). */
export function fmtUsd(x: number | null | undefined, signed = false): string {
  if (!ok(x)) return DASH;
  const s = Math.abs(x) < 1 && x !== 0 ? usd4.format(Math.abs(x)) : usd2.format(Math.abs(x));
  const sign = x < 0 ? '−' : signed && x > 0 ? '+' : '';
  return `${sign}US$ ${s}`;
}

/** Basis points with sign control: 1 bp = 0.01 %. */
export function fmtBps(x: number | null | undefined, digits = 1, signed = false): string {
  if (!ok(x)) return DASH;
  const sign = x < 0 ? '−' : signed && x > 0 ? '+' : '';
  return `${sign}${nf(digits, digits).format(Math.abs(x))} bps`;
}

export function fmtPct(x: number | null | undefined, digits = 1, signed = false): string {
  if (!ok(x)) return DASH;
  const sign = x < 0 ? '−' : signed && x > 0 ? '+' : '';
  return `${sign}${nf(digits, digits).format(Math.abs(x * 100))}%`;
}

export function fmtInt(x: number | null | undefined): string {
  return ok(x) ? int.format(x) : DASH;
}

/** Price with enough decimals for its magnitude (tick sizes vary from 1e-8 to 1e-1). */
export function fmtPrice(x: number | null | undefined): string {
  if (!ok(x)) return DASH;
  const a = Math.abs(x);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  return nf(d, d).format(x);
}

export function fmtQty(x: number | null | undefined): string {
  if (!ok(x)) return DASH;
  const a = Math.abs(x);
  return nf(0, a >= 100 ? 2 : a >= 1 ? 4 : 6).format(x);
}

/** "agora", "12 s", "4 min", "3 h", "2 d". */
export function fmtAge(ms: number | null | undefined): string {
  if (!ok(ms)) return DASH;
  const s = Math.max(0, ms) / 1000;
  if (s < 1) return 'agora';
  if (s < 60) return `${Math.floor(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!ok(ms)) return DASH;
  const m = Math.floor(Math.max(0, ms) / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${mm}min` : `${mm}min`;
}

const tf = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dtf = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const fmtTime = (ts: number) => (ok(ts) ? tf.format(ts) : DASH);
export const fmtDateTime = (ts: number) => (ok(ts) ? dtf.format(ts) : DASH);

/** `GqVo…UtDwH` — wallet addresses on screen. */
export function shortAddr(a: string, head = 4, tail = 4): string {
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/** `mexc:IOUSDT:shadow` → `IO/USDT`. */
export function pairLabel(symbol: string, base?: string, quote?: string): string {
  if (base && quote) return `${base}/${quote}`;
  const q = ['USDT', 'USDC', 'USD1', 'BTC', 'ETH'].find((x) => symbol.endsWith(x) && symbol.length > x.length);
  return q ? `${symbol.slice(0, -q.length)}/${q}` : symbol;
}

export const botSymbol = (botId: string) => botId.split(':')[1] ?? botId;

/** RFC 4180 CSV (quotes doubled; fields with separators quoted). */
export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
