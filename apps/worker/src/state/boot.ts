import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_STATE_VERSION, ShadowEngine, engineConfigHash, type EngineSnapshot, type InputRecord, type ShadowEngineOptions } from '../engine/shadow-engine';
import { listRecordings, readNdjsonLines, relRecording, sha256, type RecorderPosition } from '../recorder/ndjson';

/** Engine state + the exact recorded input it reflects (the last record processed). */
export interface WorkerSnapshot {
  engine: EngineSnapshot;
  cursor: RecorderPosition | undefined;
  writtenAt: string;
}

const SNAP_RE = /^snap-(\d{15})\.json$/;

/**
 * Snapshots on disk, written atomically (tmp → fsync → rename), so a crash mid-write never leaves
 * a half snapshot under a valid name. Keeps the newest `keep`; older ones are pruned.
 */
export class SnapshotStore {
  constructor(
    readonly dir: string,
    private readonly keep = 3,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  save(s: WorkerSnapshot): string {
    const name = `snap-${String(s.engine.records).padStart(15, '0')}.json`;
    const final = path.join(this.dir, name);
    const tmp = `${final}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(s));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, final);
    for (const old of this.list().slice(this.keep)) fs.rmSync(path.join(this.dir, old), { force: true });
    return name;
  }

  /** Snapshot file names, newest (most records) first. */
  list(): string[] {
    return fs.readdirSync(this.dir).filter((n) => SNAP_RE.test(n)).sort().reverse();
  }

  /**
   * Moves a rejected snapshot out of rotation (kept for forensics). Otherwise an invalid snapshot
   * with a high record count would stay "newest" and push valid ones out of the keep window.
   */
  quarantine(name: string): void {
    const dir = path.join(this.dir, 'rejected');
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(path.join(this.dir, name), path.join(dir, `${Date.now()}-${name}`));
  }

  load(name: string): WorkerSnapshot {
    return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as WorkerSnapshot;
  }
}

export interface BootResult<E = ShadowEngine> {
  engine: E;
  from: 'snapshot' | 'genesis';
  snapshot?: string;
  /** Records replayed on top of the snapshot (or from genesis). */
  replayed: number;
  /** Snapshots that were rejected (and quarantined), with the reason, newest first. */
  rejected: string[];
  truncated: string[];
}

/**
 * Boot restore = newest valid snapshot + replay of every record recorded after it.
 * A snapshot is valid only if its cursor points at a record that still exists on disk with the
 * same sha256 — e.g. a periodic snapshot taken just before a hard crash may reference records that
 * never reached the disk; it is then skipped for an older one. With no valid snapshot the engine
 * is rebuilt from genesis (the recordings are the source of truth; snapshots only save time).
 * Because the engine is deterministic, the result equals one uninterrupted run over the same records.
 */
export function bootEngine(opts: ShadowEngineOptions, root: string, store: SnapshotStore, hooks?: BootHooks<ShadowEngine, InputRecord>): Promise<BootResult> {
  return bootAny<ShadowEngine, InputRecord>({
    configHash: engineConfigHash(opts), stateVersion: ENGINE_STATE_VERSION,
    create: () => new ShadowEngine(opts), restore: (s) => ShadowEngine.restore(opts, s),
  }, root, store, hooks);
}

/** How to build, restore and identify one kind of engine (shadow or live). */
export interface EngineKind<E extends { process(r: R): unknown }, R> {
  configHash: string;
  stateVersion: number;
  create(): E;
  restore(s: EngineSnapshot): E;
  /** Marker type only (records are JSON-parsed as R). */
  readonly record?: R;
}

/**
 * Observers of the boot replay (e.g. persistence re-sending what the database may have missed).
 * `onStart` sees the engine right before its first replayed record; `onRecord` sees every replayed
 * record with its outputs, and may return a promise to apply backpressure.
 */
export interface BootHooks<E extends { process(r: R): unknown }, R> {
  onStart?(engine: E): void;
  onRecord?(engine: E, r: R, outs: ReturnType<E['process']>): void | Promise<void>;
}

/** Same algorithm for every engine kind: newest valid snapshot + tail, else genesis replay. */
export async function bootAny<E extends { process(r: R): unknown }, R>(kind: EngineKind<E, R>, root: string, store: SnapshotStore, hooks: BootHooks<E, R> = {}): Promise<BootResult<E>> {
  const step = (engine: E, r: R): void | Promise<void> => {
    const outs = engine.process(r) as ReturnType<E['process']>;
    return hooks.onRecord?.(engine, r, outs);
  };
  const files = listRecordings(root);
  const hash = kind.configHash;
  const rejected: string[] = [];
  const truncated: string[] = [];
  const reject = (name: string, why: string) => {
    rejected.push(`${name}: ${why}`);
    store.quarantine(name);
  };
  const onTruncated = (f: string, d: string) => truncated.push(`${relRecording(root, f)}: ${d}`);

  for (const name of store.list()) {
    let snap: WorkerSnapshot;
    try {
      snap = store.load(name);
    } catch (err) {
      reject(name, `unreadable (${(err as Error).message})`);
      continue;
    }
    if (snap.engine?.v !== kind.stateVersion || snap.engine.configHash !== hash) {
      reject(name, 'different engine version or configuration');
      continue;
    }
    const cursor = snap.cursor;
    if (!cursor) {
      reject(name, 'no cursor');
      continue;
    }
    const idx = files.findIndex((f) => relRecording(root, f) === cursor.file);
    if (idx < 0) {
      reject(name, `cursor file ${cursor.file} not found`);
      continue;
    }
    let engine: E;
    try {
      engine = kind.restore(snap.engine);
    } catch (err) {
      reject(name, `restore failed (${(err as Error).message})`);
      continue;
    }
    let verified = false;
    let replayed = 0;
    let failure = `cursor ${cursor.file}:${cursor.line} is beyond the durable recording`;
    for await (const l of readNdjsonLines(files.slice(idx), onTruncated)) {
      if (!verified) {
        if (l.file !== files[idx]) break;
        if (l.line < cursor.line) continue;
        if (sha256(l.text) !== cursor.sha) {
          failure = `record at cursor ${cursor.file}:${cursor.line} does not match`;
          break;
        }
        verified = true;
        hooks.onStart?.(engine);
        continue;
      }
      const p = step(engine, JSON.parse(l.text) as R);
      if (p) await p;
      replayed++;
    }
    if (!verified) {
      reject(name, failure);
      continue;
    }
    return { engine, from: 'snapshot', snapshot: name, replayed, rejected, truncated };
  }

  const engine = kind.create();
  hooks.onStart?.(engine);
  let replayed = 0;
  for await (const l of readNdjsonLines(files, onTruncated)) {
    const p = step(engine, JSON.parse(l.text) as R);
    if (p) await p;
    replayed++;
  }
  return { engine, from: 'genesis', replayed, rejected, truncated };
}
