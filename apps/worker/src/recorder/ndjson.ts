import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import type { InputRecord } from '../engine/shadow-engine';

/**
 * Hourly-rotated gzip NDJSON recorder of every engine input. These files are the ground truth for
 * replay, backtests (dashboard Simulator) and fill-intensity calibration.
 *
 * Layout: <dir>/<botKey>/<YYYY-MM-DD>/<HH>-<segment>.ndjson.gz (UTC hour of the record time).
 *
 * Crash-safety guarantees (24/7 operation):
 *  - One new segment file per process (`segment` = process start, ms). Never appends: appending a
 *    gzip member after a member truncated by a hard crash makes the rest of the file unreadable.
 *  - Z_SYNC_FLUSH every `flushEveryMs` of *record* time: a hard crash (OOM, SIGKILL, power loss)
 *    loses at most that much data, and everything before it stays decodable.
 *  - Rotation only moves forward: if the wall clock steps backwards, records keep going to the
 *    current file, so file order always equals record order (replay = live).
 */
export class NdjsonRecorder {
  private stream: zlib.Gzip | undefined;
  private file: fs.WriteStream | undefined;
  private currentKey = '';
  private written = 0;
  private lastFlushTs = Number.NEGATIVE_INFINITY;
  private readonly segment: string;
  private readonly flushEveryMs: number;

  constructor(
    private readonly dir: string,
    private readonly botKey: string,
    opts: { segment?: number; flushEveryMs?: number } = {},
  ) {
    this.segment = String(opts.segment ?? Date.now()).padStart(13, '0');
    this.flushEveryMs = opts.flushEveryMs ?? 1_000;
  }

  write(r: InputRecord): void {
    const d = new Date(r.ts);
    const day = d.toISOString().slice(0, 10);
    const hour = String(d.getUTCHours()).padStart(2, '0');
    const key = `${day}/${hour}`;
    if (key > this.currentKey) this.rotate(day, hour, key);
    this.stream!.write(`${JSON.stringify(r)}\n`);
    this.written++;
    if (r.ts - this.lastFlushTs >= this.flushEveryMs) {
      this.lastFlushTs = r.ts;
      this.stream!.flush(zlib.constants.Z_SYNC_FLUSH);
    }
  }

  get count(): number {
    return this.written;
  }

  private rotate(day: string, hour: string, key: string): void {
    this.stream?.end();
    const folder = path.join(this.dir, this.botKey, day);
    fs.mkdirSync(folder, { recursive: true });
    // 'wx': fail loudly rather than ever append to / overwrite an existing segment.
    this.file = fs.createWriteStream(path.join(folder, `${hour}-${this.segment}.ndjson.gz`), { flags: 'wx' });
    this.stream = zlib.createGzip({ level: 6 });
    this.stream.pipe(this.file);
    this.currentKey = key;
  }

  close(): Promise<void> {
    const f = this.file;
    this.stream?.end();
    this.stream = undefined;
    this.file = undefined;
    return f ? new Promise((res) => f.on('close', () => res())) : Promise.resolve();
  }
}

/**
 * Streams records from recorded files, in order. Tolerates the damage a hard crash can leave:
 * a truncated gzip tail and a partial last line. Corruption anywhere else still throws.
 */
export async function* readNdjsonGz(
  files: string[],
  onTruncated?: (file: string, detail: string) => void,
): AsyncGenerator<InputRecord> {
  for (const f of files) {
    // Z_SYNC_FLUSH as finishFlush: decode everything that was flushed even without a gzip trailer.
    const gunzip = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    const rl = readline.createInterface({ input: fs.createReadStream(f).pipe(gunzip), crlfDelay: Infinity });
    let pending: string | undefined;
    for await (const line of rl) {
      if (pending !== undefined) yield JSON.parse(pending) as InputRecord; // not the last line: must parse
      pending = line.trim() ? line : undefined;
    }
    if (pending !== undefined) {
      let rec: InputRecord | undefined;
      try {
        rec = JSON.parse(pending) as InputRecord;
      } catch {
        onTruncated?.(f, 'partial last line skipped');
      }
      if (rec) yield rec;
    }
  }
}

const SEGMENT_RE = /^(\d{2})(?:-(\d{13}))?\.ndjson\.gz$/;

/** All recordings under `dir`, ordered by (day, hour, segment). Legacy `<HH>.ndjson.gz` = segment 0. */
export function listRecordings(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ file: string; key: string }> = [];
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const m = SEGMENT_RE.exec(e.name);
        if (m) out.push({ file: full, key: `${path.basename(p)}/${m[1]}/${m[2] ?? '0'.repeat(13)}` });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((x) => x.file);
}
