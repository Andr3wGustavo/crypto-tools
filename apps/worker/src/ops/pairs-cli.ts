import fs from 'node:fs';
import path from 'node:path';
import { renderPairsCompose, validatePairs, type PairsFile } from './pairs-compose';

/**
 * Turns a scan report into the pre-registered production pair set.
 *   npx tsx apps/worker/src/ops/pairs-cli.ts data/scans/scan-<ts>.json [--out infra/prod]
 * Writes pairs.json (the selection + the scan it came from) and compose.pairs.yaml.
 * Commit both BEFORE starting the shadow window: the commit time is the pre-registration.
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
const pairs: PairsFile = {
  scan: { file: path.basename(file), paramsHash: report.paramsHash, startedAt: report.startedAt },
  pairs: report.selected.map(({ symbol, reference }) => ({ symbol, reference })),
};
validatePairs(pairs);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'pairs.json'), `${JSON.stringify(pairs, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'compose.pairs.yaml'), renderPairsCompose(pairs));
console.log(`${pairs.pairs.length} pairs → ${path.join(out, 'pairs.json')}, ${path.join(out, 'compose.pairs.yaml')}`);
