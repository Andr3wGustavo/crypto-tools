import fs from 'node:fs';
import path from 'node:path';

/** Written by every worker every few seconds; read by the dead-man and the deploy smoke test. */
export interface Heartbeat {
  symbol: string;
  run: string;
  version: string;
  pid: number;
  startedAt: number;
  ts: number;
  records: number;
  fills: number;
  status: 'running' | 'paused' | 'halted' | 'killed';
  /** ms since the last frame of each market-data stream (Infinity is written as null). */
  mexcAgeMs: number | null;
  binanceAgeMs: number | null;
  equity: number | null;
}

export interface HeartbeatLimits {
  /** The heartbeat file itself must be this fresh (the process is alive). */
  maxHeartbeatAgeMs: number;
  /** The execution venue's data must be this fresh (the feed is alive). */
  maxMexcAgeMs: number;
  /** The reference feed may lag more (the strategy falls back to the local mid). */
  maxBinanceAgeMs: number;
}

export const DEFAULT_HEARTBEAT_LIMITS: HeartbeatLimits = { maxHeartbeatAgeMs: 60_000, maxMexcAgeMs: 60_000, maxBinanceAgeMs: 300_000 };

/** Atomic write (tmp → rename): a reader never sees half a file. */
export function writeHeartbeat(file: string, hb: Heartbeat): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(hb));
  fs.renameSync(tmp, file);
}

export function readHeartbeat(file: string): Heartbeat | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Heartbeat;
  } catch {
    return undefined;
  }
}

export const heartbeatFile = (dir: string, symbol: string): string => path.join(dir, `${symbol}.json`);

/**
 * Farm health = every expected worker alive, fed and not stopped. `paused` (risk pause) is
 * reported but not a failure — it resumes on its own; `halted`/`killed` need a human.
 */
export function evaluateHeartbeats(
  expected: readonly string[],
  read: (symbol: string) => Heartbeat | undefined,
  now: number,
  l: HeartbeatLimits = DEFAULT_HEARTBEAT_LIMITS,
): { ok: boolean; problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const symbol of expected) {
    const hb = read(symbol);
    if (!hb) {
      problems.push(`${symbol}: no heartbeat`);
      continue;
    }
    const age = now - hb.ts;
    if (age > l.maxHeartbeatAgeMs) problems.push(`${symbol}: heartbeat ${Math.round(age / 1000)} s old`);
    if (hb.mexcAgeMs === null || hb.mexcAgeMs > l.maxMexcAgeMs) problems.push(`${symbol}: MEXC data ${hb.mexcAgeMs === null ? 'never received' : `${Math.round(hb.mexcAgeMs / 1000)} s old`}`);
    if (hb.binanceAgeMs === null || hb.binanceAgeMs > l.maxBinanceAgeMs) problems.push(`${symbol}: Binance data ${hb.binanceAgeMs === null ? 'never received' : `${Math.round(hb.binanceAgeMs / 1000)} s old`}`);
    if (hb.status === 'halted' || hb.status === 'killed') problems.push(`${symbol}: ${hb.status} (needs a human)`);
    else if (hb.status === 'paused') notes.push(`${symbol}: paused`);
  }
  return { ok: problems.length === 0, problems, notes };
}
