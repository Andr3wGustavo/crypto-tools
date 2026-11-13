import fs from 'node:fs';
import path from 'node:path';
import { decidePair, goProbabilityThreshold, type EdgeObservation, type PairDecision } from '@cortex/core';
import { metaToOptions, type ReplayMeta } from './engine/run-meta';
import { ShadowEngine } from './engine/shadow-engine';
import { liveAck } from './live/live-gate';
import { verifyEdgeProtocol, type EdgeProtocolFile } from './ops/edge-protocol-file';
import { runtimeFingerprint } from './ops/source-fingerprint';
import { listRecordings, readNdjsonGz, recordingHourSpan } from './recorder/ndjson';

/**
 * Official GO/NO-GO evaluation of a pre-registered multi-pair shadow.
 *   node dist/evaluate.js infra/prod/protocol.json --data /data/market [--as-of <ISO>] [--out report.json]
 *   npx tsx apps/worker/src/evaluate.ts infra/prod/protocol.json --data data/market
 *
 * Replays every pair's recordings with THIS code (deterministic: same inputs ⇒ same decisions as
 * the live shadow), cuts the edge windows that start after the registration and applies the
 * protocol's sequential rule. The report is "official" only if this code's fingerprint equals the
 * registered one. Running it more often or later never changes a decided look.
 */
export interface PairReport extends PairDecision {
  symbol: string;
  runDir?: string;
  records?: number;
  fills?: number;
  problems: string[];
}

export interface EvaluationReport {
  kind: 'edge-evaluation';
  protocolHash: string;
  official: boolean;
  codeFingerprint: string | null;
  registeredFingerprint: string;
  evaluatedAt: string;
  asOf: string | null;
  pairs: number;
  goThreshold: number;
  results: PairReport[];
  /** GO pairs ranked by the corrected lower bound of their edge (best first): live D1 takes the first. */
  go: string[];
  status: 'GO' | 'NO_GO' | 'PENDING';
}

interface Collected {
  observations: EdgeObservation[];
  fillTs: number[];
  dataEndTs: number;
  records: number;
}

async function collect(dir: string, windowMs: number, registeredAtMs: number): Promise<Collected> {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as ReplayMeta;
  const opts = metaToOptions(meta);
  if ((opts.edgeWindowMs ?? 3_600_000) !== windowMs) {
    throw new Error(`run edge window ${opts.edgeWindowMs ?? 3_600_000} ms ≠ protocol window ${windowMs} ms`);
  }
  const engine = new ShadowEngine(opts);
  const observations: EdgeObservation[] = [];
  const fillTs: number[] = [];
  let dataEndTs = Number.NEGATIVE_INFINITY;
  for await (const r of readNdjsonGz(listRecordings(dir), (f, d) => console.warn(`[evaluate] ${f}: ${d}`))) {
    const windowStart = engine.edgeWindowStartTs;
    for (const o of engine.process(r)) {
      if (o.kind === 'edge' && windowStart !== undefined && windowStart >= registeredAtMs) {
        observations.push({ startTs: windowStart, endTs: o.ts, returnBps: o.returnBps });
      } else if (o.kind === 'sim' && o.event.kind === 'fill' && o.event.ts >= registeredAtMs) {
        fillTs.push(o.event.ts);
      }
    }
    dataEndTs = r.ts;
  }
  return { observations, fillTs, dataEndTs, records: engine.recordCount };
}

/** Run directories of a pair that hold data from after the registration (coarse, by file name). */
function candidateRuns(dataDir: string, symbol: string, registeredAtMs: number): string[] {
  const parent = path.join(dataDir, `mexc-${symbol}`);
  if (!fs.existsSync(parent)) return [];
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^cfg-[0-9a-f]{12}$/.test(e.name) && fs.existsSync(path.join(parent, e.name, 'meta.json')))
    .map((e) => path.join(parent, e.name))
    .filter((d) => (recordingHourSpan(d)?.toMs ?? Number.NEGATIVE_INFINITY) > registeredAtMs)
    .sort();
}

export async function evaluateProtocol(
  protocol: EdgeProtocolFile,
  dataDir: string,
  opts: { asOf?: Date; fingerprint?: string; now?: Date } = {},
): Promise<EvaluationReport> {
  const p = verifyEdgeProtocol(protocol);
  const registeredAtMs = Date.parse(p.registeredAt);
  const m = p.pairs.length; // every registered pair counts, evaluated or not
  const asOfMs = opts.asOf ? opts.asOf.getTime() : Number.NEGATIVE_INFINITY;
  const results: PairReport[] = [];
  for (const symbol of p.pairs) {
    const runs = candidateRuns(dataDir, symbol, registeredAtMs);
    if (runs.length === 0) {
      const d = decidePair({ observations: [], fillTs: [], dataEndTs: Number.NEGATIVE_INFINITY }, p.rule, m, { asOf: asOfMs, registeredAt: registeredAtMs });
      results.push({ symbol, ...d, reason: d.decision === 'PENDING' ? 'no recordings after the registration' : d.reason, problems: [] });
      continue;
    }
    if (runs.length > 1) {
      // Two configurations inside one window = the experiment changed mid-flight: fail closed.
      results.push({
        symbol, decision: 'NO_GO', reason: 'protocol violation: the configuration changed during the window (a new window must be registered)',
        looks: [], problems: runs.map((r) => `run ${path.basename(r)}`),
      });
      continue;
    }
    const runDir = runs[0]!;
    try {
      const c = await collect(runDir, p.rule.windowMs, registeredAtMs);
      const d = decidePair({ observations: c.observations, fillTs: c.fillTs, dataEndTs: c.dataEndTs }, p.rule, m, { asOf: asOfMs, registeredAt: registeredAtMs });
      results.push({ symbol, runDir: path.basename(runDir), records: c.records, fills: c.fillTs.length, problems: [], ...d });
    } catch (err) {
      results.push({ symbol, runDir: path.basename(runDir), decision: 'NO_GO', reason: `run cannot be evaluated: ${(err as Error).message}`, looks: [], problems: [(err as Error).message] });
    }
  }
  const lower = (r: PairReport) => r.looks[r.decidedAtLook ?? -1]?.lowerBoundBps ?? Number.NEGATIVE_INFINITY;
  const go = results.filter((r) => r.decision === 'GO').sort((a, b) => lower(b) - lower(a) || a.symbol.localeCompare(b.symbol)).map((r) => r.symbol);
  const pending = results.some((r) => r.decision === 'PENDING');
  const fingerprint = opts.fingerprint;
  return {
    kind: 'edge-evaluation',
    protocolHash: p.hash,
    official: fingerprint === p.code.fingerprint,
    codeFingerprint: fingerprint ?? null,
    registeredFingerprint: p.code.fingerprint,
    evaluatedAt: (opts.now ?? new Date()).toISOString(),
    asOf: opts.asOf ? opts.asOf.toISOString() : null,
    pairs: m,
    goThreshold: goProbabilityThreshold(p.rule, m),
    results,
    go,
    // GO as soon as one pair is GO (each GO is already corrected for every pair and look);
    // NO_GO only when no pair can still become GO.
    status: go.length > 0 ? 'GO' : pending ? 'PENDING' : 'NO_GO',
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function cli(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('usage: evaluate <protocol.json> [--data data/market] [--as-of <ISO>] [--out report.json]');
    process.exit(2);
  }
  const asOfArg = arg('--as-of');
  const asOf = asOfArg ? new Date(asOfArg) : undefined;
  if (asOf && Number.isNaN(asOf.getTime())) throw new Error(`invalid --as-of ${asOfArg}`);
  const fingerprint = runtimeFingerprint();
  const report = await evaluateProtocol(JSON.parse(fs.readFileSync(file, 'utf8')), arg('--data') ?? path.join('data', 'market'), {
    ...(asOf ? { asOf } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const out = arg('--out');
  if (out) fs.writeFileSync(out, json);
  else process.stdout.write(json);

  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  console.error(`\nprotocol ${report.protocolHash.slice(0, 12)} · ${report.pairs} pairs · GO needs P ≥ ${report.goThreshold.toFixed(5)}`);
  if (!report.official) console.error('!! NOT OFFICIAL: this code is not the registered code (fingerprint differs)');
  for (const r of report.results) {
    const l = r.looks[r.looks.length - 1];
    const stats = l ? `look ${l.look} (${l.hours} h): mean ${l.meanBps.toFixed(2)} bp/h, P(μ>ε) ${pct(l.pGo)}, P(μ>0) ${pct(l.pPositive)}, fills ${l.fills}, gaps ${pct(l.gapFraction)}` : '';
    console.error(`${r.symbol.padEnd(14)} ${r.decision.padEnd(8)} ${stats}\n${' '.repeat(24)}${r.reason}`);
  }
  console.error(`STATUS: ${report.status}${report.go.length ? ` → live D1 candidate: ${report.go[0]}` : ''}`);
  if (report.status === 'GO' && report.official) {
    // The operator types this into LIVE_ACK to open the live gate (apps/worker/src/live/live-gate.ts).
    console.error(`LIVE_ACK=${liveAck(report, report.go[0]!)}`);
  }
  process.exit(report.official ? 0 : 3);
}

if (require.main === module) {
  cli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
