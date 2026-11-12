import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeEdgeProtocol } from './edge-protocol-file';
import { renderPairsCompose, validatePairs, type PairsFile } from './pairs-compose';
import { PINNED_PATHS, sourceFingerprint } from './source-fingerprint';

/**
 * Turns a scan report into the pre-registered production experiment (run from the repo root).
 *   npx tsx apps/worker/src/ops/pairs-cli.ts data/scans/scan-<ts>.json [--out infra/prod]
 * Writes pairs.json (the selection + the scan it came from), compose.pairs.yaml and protocol.json
 * (the GO/NO-GO rule, the registration time and the fingerprint of the judged code).
 * Commit all three BEFORE starting the shadow window: the commit time is the pre-registration.
 * Refuses to run when the judged code has uncommitted changes (the fingerprint would describe
 * code that exists nowhere else).
 */
const file = process.argv[2];
if (!file) {
  console.error('usage: pairs-cli <scan report.json> [--out infra/prod]');
  process.exit(2);
}
const i = process.argv.indexOf('--out');
const out = i > 0 ? process.argv[i + 1]! : path.join('infra', 'prod');
const report = JSON.parse(fs.readFileSync(file, 'utf8')) as {
  kind: string; paramsHash: string; startedAt: string; selected: Array<{ symbol: string; reference: string }>;
};
if (report.kind !== 'pair-scan') throw new Error(`${file} is not a pair-scan report`);

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const dirty = git('status', '--porcelain', '--', ...PINNED_PATHS);
if (dirty) {
  console.error(`the judged code has uncommitted changes — commit them first:\n${dirty}`);
  process.exit(1);
}

const pairs: PairsFile = {
  scan: { file: path.basename(file), paramsHash: report.paramsHash, startedAt: report.startedAt },
  pairs: report.selected.map(({ symbol, reference }) => ({ symbol, reference })),
};
validatePairs(pairs);
const protocol = makeEdgeProtocol(pairs, new Date(), { fingerprint: sourceFingerprint(process.cwd()), commit: git('rev-parse', 'HEAD') });

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'pairs.json'), `${JSON.stringify(pairs, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'compose.pairs.yaml'), renderPairsCompose(pairs));
fs.writeFileSync(path.join(out, 'protocol.json'), `${JSON.stringify(protocol, null, 2)}\n`);
console.log(`${pairs.pairs.length} pairs → ${out}/{pairs.json, compose.pairs.yaml, protocol.json}`);
console.log(`protocol ${protocol.hash.slice(0, 12)} · code ${protocol.code.fingerprint.slice(0, 12)} @ ${protocol.code.commit.slice(0, 12)} · registered ${protocol.registeredAt}`);
