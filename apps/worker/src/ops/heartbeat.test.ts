import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateHeartbeats, heartbeatFile, readHeartbeat, writeHeartbeat, type Heartbeat } from './heartbeat';

const NOW = 1_800_000_000_000;
const hb = (o: Partial<Heartbeat> = {}): Heartbeat => ({
  symbol: 'DOTUSDT', run: 'cfg-x', version: 'abc', pid: 1, startedAt: NOW - 1e6, ts: NOW - 5_000, records: 10, fills: 0,
  status: 'running', mexcAgeMs: 200, binanceAgeMs: 300, equity: 15, ...o,
});

describe('heartbeat / dead-man', () => {
  it('round-trips atomically through a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hb-'));
    const f = heartbeatFile(dir, 'DOTUSDT');
    writeHeartbeat(f, hb());
    expect(readHeartbeat(f)).toEqual(hb());
    expect(fs.readdirSync(dir)).toEqual(['DOTUSDT.json']);
    expect(readHeartbeat(path.join(dir, 'missing.json'))).toBeUndefined();
  });

  it('healthy farm passes; paused is a note, not a failure', () => {
    const r = evaluateHeartbeats(['A', 'B'], (s) => hb({ symbol: s, status: s === 'B' ? 'paused' : 'running' }), NOW);
    expect(r).toEqual({ ok: true, problems: [], notes: ['B: paused'] });
  });

  it('detects a missing worker, a dead process, a dead feed and a halt', () => {
    const cases: Record<string, Heartbeat | undefined> = {
      MISSING: undefined,
      DEAD: hb({ ts: NOW - 120_000 }),
      NOFEED: hb({ mexcAgeMs: null }),
      STALE: hb({ mexcAgeMs: 90_000 }),
      NOREF: hb({ binanceAgeMs: 600_000 }),
      HALT: hb({ status: 'halted' }),
    };
    const r = evaluateHeartbeats(Object.keys(cases), (s) => cases[s], NOW);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      'MISSING: no heartbeat',
      'DEAD: heartbeat 120 s old',
      'NOFEED: MEXC data never received',
      'STALE: MEXC data 90 s old',
      'NOREF: Binance data 600 s old',
      'HALT: halted (needs a human)',
    ]);
  });
});
