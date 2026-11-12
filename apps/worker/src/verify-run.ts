import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { metaToOptions, type ReplayMeta } from './engine/run-meta';
import { stateDigest } from './engine/shadow-engine';
import { listRecordings } from './recorder/ndjson';
import { SnapshotStore, bootEngine } from './state/boot';

/**
 * Integrity check of a run directory — the backup restore test.
 *   node dist/verify-run.js <run dir>   (exit 0 = consistent)
 * Rebuilds the engine twice from the (restored) files: from genesis, and from the newest valid
 * snapshot + tail. Both must reach the same state digest. Works on a copy of the snapshots, so
 * the run directory is never modified (boot would quarantine invalid snapshots).
 */
export interface VerifyResult {
  ok: boolean;
  files: number;
  records: number;
  genesisDigest: string;
  snapshotDigest?: string;
  from: 'snapshot' | 'genesis';
  snapshot?: string;
  replayedFromSnapshot?: number;
  rejected: string[];
  truncated: string[];
  problems: string[];
}

export async function verifyRun(dir: string): Promise<VerifyResult> {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as ReplayMeta;
  const opts = metaToOptions(meta);
  const files = listRecordings(dir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-verify-'));
  try {
    const genesis = await bootEngine(opts, dir, new SnapshotStore(path.join(tmp, 'empty')));
    const genesisDigest = stateDigest(genesis.engine.snapshot());
    const problems: string[] = [];
    if (files.length === 0) problems.push('no recordings');

    const stateDir = path.join(dir, 'state');
    const copy = path.join(tmp, 'state');
    const names = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((n) => /^snap-\d{15}\.json$/.test(n)) : [];
    fs.mkdirSync(copy, { recursive: true });
    for (const n of names) fs.copyFileSync(path.join(stateDir, n), path.join(copy, n));
    if (names.length === 0) {
      return { ok: problems.length === 0, files: files.length, records: genesis.engine.recordCount, genesisDigest, from: 'genesis', rejected: [], truncated: genesis.truncated, problems };
    }
    const fromSnap = await bootEngine(opts, dir, new SnapshotStore(copy, names.length));
    const snapshotDigest = stateDigest(fromSnap.engine.snapshot());
    if (fromSnap.from !== 'snapshot') problems.push('no snapshot is consistent with the recordings');
    if (snapshotDigest !== genesisDigest) problems.push('snapshot + tail ≠ genesis replay');
    if (fromSnap.engine.recordCount !== genesis.engine.recordCount) problems.push(`record counts differ (${fromSnap.engine.recordCount} vs ${genesis.engine.recordCount})`);
    return {
      ok: problems.length === 0, files: files.length, records: genesis.engine.recordCount, genesisDigest, snapshotDigest,
      from: fromSnap.from, snapshot: fromSnap.snapshot, replayedFromSnapshot: fromSnap.replayed, rejected: fromSnap.rejected, truncated: genesis.truncated, problems,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: verify-run <run dir containing meta.json>');
    process.exit(2);
  }
  verifyRun(dir).then(
    (r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
