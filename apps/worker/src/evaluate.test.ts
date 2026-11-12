import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_EDGE_PROTOCOL_RULE, decidePair, type EdgeProtocolRule } from '@cortex/core';
import { describe, expect, it } from 'vitest';
import { ShadowEngine } from './engine/shadow-engine';
import { evaluateProtocol } from './evaluate';
import { makeEdgeProtocol, verifyEdgeProtocol } from './ops/edge-protocol-file';
import { sourceFingerprint } from './ops/source-fingerprint';
import { NdjsonRecorder } from './recorder/ndjson';
import { syntheticInputs, testEngineOptions } from './testing/synthetic-inputs';

const REPO = path.resolve(__dirname, '../../..');
const T0 = Date.UTC(2026, 0, 1);
const FP = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const pairsFile = (symbols: string[]) => ({
  scan: { file: 'scan.json', paramsHash: 'c'.repeat(64), startedAt: '2025-12-31T00:00:00.000Z' },
  pairs: symbols.map((symbol) => ({ symbol, reference: symbol })),
});
// 5-min windows, looks at 20 and 35 min; no fill minimum for a 40-min market (crosses an hour? no:
// one file — the multi-file path is covered by the recorder tests).
const opts = { ...testEngineOptions, edgeWindowMs: 5 * 60_000 };
const rule: EdgeProtocolRule = { ...DEFAULT_EDGE_PROTOCOL_RULE, windowMs: 5 * 60_000, looksHours: [20 / 60, 35 / 60], minFills: 0, maxGapFraction: 0.3, graceMs: 0 };
const records = syntheticInputs(40, 4);

async function writeRun(dataDir: string, symbol: string, cfg = 'cfg-0123456789ab', recs = records) {
  const parent = path.join(dataDir, `mexc-${symbol}`);
  const engine = new ShadowEngine(opts);
  fs.mkdirSync(path.join(parent, cfg), { recursive: true });
  const meta = { config: opts.config, startQuote: opts.startQuote, latencyMs: opts.latencyMs, info: { makerFeeRate: opts.makerFeeRate }, edgeWindowMs: opts.edgeWindowMs, configHash: engine.configHash };
  fs.writeFileSync(path.join(parent, cfg, 'meta.json'), JSON.stringify(meta));
  const rec = new NdjsonRecorder(parent, cfg, { segment: 1 });
  recs.forEach((r) => rec.write(r));
  await rec.close();
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-eval-'));

describe('pre-registered evaluation (protocol.json → replay → GO/NO-GO)', () => {
  it('replays a run with the engine, cuts windows after the registration and applies the rule', async () => {
    const data = tmp();
    await writeRun(data, 'SOLUSDT');
    const protocol = makeEdgeProtocol(pairsFile(['SOLUSDT', 'ETHUSDT']), new Date(T0 - 1), { fingerprint: FP, commit: COMMIT }, rule);
    const report = await evaluateProtocol(protocol, data, { fingerprint: FP, now: new Date(T0) });
    expect(report.official).toBe(true);
    expect(report.pairs).toBe(2); // the pair with no data still counts in the correction
    expect(report.goThreshold).toBeCloseTo(1 - 0.05 / 4, 12);
    const sol = report.results.find((r) => r.symbol === 'SOLUSDT')!;
    expect(sol.records).toBe(records.length);
    expect(sol.looks.length).toBeGreaterThanOrEqual(1);
    expect(['GO', 'NO_GO']).toContain(sol.decision); // the last look is decisive by construction
    expect(sol.looks[0]!.n).toBe(4); // four 5-min windows fit the 20-min look exactly (records every 100 ms)
    expect(report.results.find((r) => r.symbol === 'ETHUSDT')).toMatchObject({ decision: 'PENDING', reason: 'no recordings after the registration' });
    expect(report.status).toBe(report.go.length ? 'GO' : 'PENDING');

    // Independent check: the observations equal the engine's own edge outputs.
    const e = new ShadowEngine(opts);
    const edges = records.flatMap((r) => e.process(r)).filter((o) => o.kind === 'edge');
    expect(sol.looks[sol.looks.length - 1]!.n).toBeLessThanOrEqual(edges.length);
    expect(sol.looks[0]!.meanBps).toBeCloseTo(edges.slice(0, 4).reduce((a, o) => a + (o.kind === 'edge' ? o.returnBps : 0), 0) / 4, 10);

    // Deterministic: evaluating again (later) gives the same decisions.
    const again = await evaluateProtocol(protocol, data, { fingerprint: FP, now: new Date(T0 + 1e9) });
    expect(again.results).toEqual(report.results);
  });

  it('only windows that start after the registration count', async () => {
    const data = tmp();
    await writeRun(data, 'SOLUSDT');
    const late = makeEdgeProtocol(pairsFile(['SOLUSDT']), new Date(T0 + 15 * 60_000), { fingerprint: FP, commit: COMMIT }, rule);
    const r = (await evaluateProtocol(late, data, { fingerprint: FP })).results[0]!;
    expect(r.decision).toBe('PENDING'); // 25 min after the registration: look 0 (20 min) done, look 1 (35 min) not yet
    expect(r.startTs).toBeGreaterThanOrEqual(T0 + 15 * 60_000);
  });

  it('fail-closed: once the whole window could have elapsed, a pair without data is NO_GO and the protocol closes', async () => {
    const data = tmp();
    await writeRun(data, 'SOLUSDT');
    const p = makeEdgeProtocol(pairsFile(['SOLUSDT', 'ETHUSDT']), new Date(T0 - 1), { fingerprint: FP, commit: COMMIT }, rule);
    const r = await evaluateProtocol(p, data, { fingerprint: FP, asOf: new Date(T0 + 24 * 3_600_000) });
    expect(r.results.find((x) => x.symbol === 'ETHUSDT')).toMatchObject({ decision: 'NO_GO', reason: expect.stringMatching(/no data by the deadline/) });
    expect(r.results.every((x) => x.decision !== 'PENDING')).toBe(true);
    expect(r.status).toBe(r.go.length ? 'GO' : 'NO_GO');
  });

  it('a configuration change inside the window is a protocol violation (fail-closed NO_GO)', async () => {
    const data = tmp();
    await writeRun(data, 'SOLUSDT', 'cfg-0123456789ab');
    await writeRun(data, 'SOLUSDT', 'cfg-ba9876543210');
    const p = makeEdgeProtocol(pairsFile(['SOLUSDT']), new Date(T0 - 1), { fingerprint: FP, commit: COMMIT }, rule);
    const r = (await evaluateProtocol(p, data, { fingerprint: FP })).results[0]!;
    expect(r.decision).toBe('NO_GO');
    expect(r.reason).toMatch(/protocol violation/);
  });

  it('a run recorded with a different edge window cannot be judged by this protocol', async () => {
    const data = tmp();
    await writeRun(data, 'SOLUSDT');
    const p = makeEdgeProtocol(pairsFile(['SOLUSDT']), new Date(T0 - 1), { fingerprint: FP, commit: COMMIT }, { ...rule, windowMs: 3_600_000, looksHours: [168] });
    const r = (await evaluateProtocol(p, data, { fingerprint: FP })).results[0]!;
    expect(r.decision).toBe('NO_GO');
    expect(r.reason).toMatch(/edge window/);
  });

  it('not official when the running code is not the registered code', async () => {
    const data = tmp(); // no data needed: officiality depends only on the code identity
    const p = makeEdgeProtocol(pairsFile(['SOLUSDT']), new Date(T0 - 1), { fingerprint: FP, commit: COMMIT }, rule);
    expect((await evaluateProtocol(p, data, { fingerprint: 'd'.repeat(64) })).official).toBe(false);
    expect((await evaluateProtocol(p, data)).official).toBe(false);
  });

  it('the protocol file is tamper-evident', () => {
    const p = makeEdgeProtocol(pairsFile(['SOLUSDT', 'ETHUSDT']), new Date(T0), { fingerprint: FP, commit: COMMIT }, rule);
    expect(verifyEdgeProtocol(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(() => verifyEdgeProtocol({ ...p, pairs: ['SOLUSDT'] })).toThrow(/hash mismatch/); // dropping a pair lowers m
    expect(() => verifyEdgeProtocol({ ...p, rule: { ...p.rule, goMinEdgeBps: 0 } })).toThrow(/hash mismatch/);
    expect(() => verifyEdgeProtocol({ ...p, registeredAt: new Date(T0 + 1).toISOString() })).toThrow(/hash mismatch/);
    expect(() => makeEdgeProtocol(pairsFile(['SOLUSDT']), new Date(T0), { fingerprint: 'x', commit: COMMIT }, rule)).toThrow(/code identity/);
  });

  it('decidePair on the collected series equals the report (no hidden logic in the CLI)', async () => {
    const data = tmp();
    await writeRun(data, 'SOLUSDT');
    const p = makeEdgeProtocol(pairsFile(['SOLUSDT']), new Date(T0 - 1), { fingerprint: FP, commit: COMMIT }, rule);
    const r = (await evaluateProtocol(p, data, { fingerprint: FP })).results[0]!;
    const e = new ShadowEngine(opts);
    const observations: Array<{ startTs: number; endTs: number; returnBps: number }> = [];
    const fillTs: number[] = [];
    for (const rec of records) {
      const s = e.edgeWindowStartTs;
      for (const o of e.process(rec)) {
        if (o.kind === 'edge') observations.push({ startTs: s!, endTs: o.ts, returnBps: o.returnBps });
        if (o.kind === 'sim' && o.event.kind === 'fill') fillTs.push(o.event.ts);
      }
    }
    const direct = decidePair({ observations, fillTs, dataEndTs: records[records.length - 1]!.ts }, rule, 1);
    expect(r.decision).toBe(direct.decision);
    expect(r.looks).toEqual(direct.looks);
  });
});

describe('source fingerprint (identity of the judged code)', () => {
  it('the bundle-time script and the TS module agree on this repository', async () => {
    const mjs = (await import(pathToFileURL(path.join(REPO, 'scripts', 'source-fingerprint.mjs')).href)) as { sourceFingerprint: (root: string) => string; PINNED_PATHS: string[] };
    expect(mjs.sourceFingerprint(REPO)).toBe(sourceFingerprint(REPO));
    expect(sourceFingerprint(REPO)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores line endings and test files, but sees any code change', () => {
    const root = tmp();
    const src = path.join(root, 'pkg');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    const base = sourceFingerprint(root, ['pkg']);
    fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 1;\r\nexport const b = 2;\r\n');
    expect(sourceFingerprint(root, ['pkg'])).toBe(base);
    fs.writeFileSync(path.join(src, 'a.test.ts'), 'test');
    expect(sourceFingerprint(root, ['pkg'])).toBe(base);
    fs.writeFileSync(path.join(src, 'a.ts'), 'export const a = 2;\nexport const b = 2;\n');
    expect(sourceFingerprint(root, ['pkg'])).not.toBe(base);
  });
});
