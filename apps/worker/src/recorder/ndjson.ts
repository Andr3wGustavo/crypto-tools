import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import type { InputRecord } from '../engine/shadow-engine';

/**
 * Hourly-rotated gzip NDJSON recorder of every engine input. These files are the ground truth for
 * replay, boot restore, backtests (dashboard Simulator) and fill-intensity calibration.
 *
 * Layout: <dir>/<botKey>/<YYYY-MM-DD>/<HH>-<segment>.ndjson.gz (UTC hour of the record time).
 *
 * Crash-safety guarantees (24/7 operation):
 *  - One new segment file per process. Never appends: appending a gzip member after a member
 *    truncated by a hard crash makes the rest of the file unreadable.
 *  - Z_SYNC_FLUSH every `flushEveryMs` of *record* time: a hard crash (OOM, SIGKILL, power loss)
 *    loses at most that much data, and everything before it stays decodable.
 *  - File order = record order, always: rotation only moves forward inside a process, and a new
 *    process starts at or after the newest existing (day, hour, segment) — even if the wall clock
 *    stepped backwards across the restart. Boot restore and replay depend on this.
 */
export interface RecorderPosition {
  /** File of the last written record, relative to the recording root, '/'-separated. */
  file: string;
  /** Number of records written to that file (1-based line of the last record). */
  line: number;
  /** sha256 of the last record's line (without the newline). */
  sha: string;
}

export class NdjsonRecorder {
  private stream: zlib.Gzip | undefined;
  private file: fs.WriteStream | undefined;
  private currentKey = '';
  private currentRel = '';
  private line = 0;
  private lastSha = '';
  private written = 0;
  private lastFlushTs = Number.NEGATIVE_INFINITY;
  /** Rotated-out files still draining to disk: close() must wait for them too. */
  private closing = new Set<Promise<void>>();
  private readonly root: string;
  private readonly segment: string;
  private readonly floorKey: string;
  private readonly flushEveryMs: number;

  constructor(dir: string, botKey: string, opts: { segment?: number; flushEveryMs?: number } = {}) {
    this.root = path.join(dir, botKey);
    const last = lastRecordingKey(this.root);
    const seg = Math.max(opts.segment ?? Date.now(), last ? Number(last.segment) + 1 : 0);
    this.segment = String(seg).padStart(13, '0');
    this.floorKey = last ? `${last.day}/${last.hour}` : '';
    this.flushEveryMs = opts.flushEveryMs ?? 1_000;
  }

  /** Any input record (shadow or live): it only needs its timestamp for file rotation. */
  write(r: InputRecord | { t: string; ts: number }): void {
    let key = utcHourKey(r.ts);
    if (key < this.floorKey) key = this.floorKey;
    if (key > this.currentKey) this.rotate(key);
    const text = JSON.stringify(r);
    this.stream!.write(`${text}\n`);
    this.written++;
    this.line++;
    this.lastSha = sha256(text);
    if (r.ts - this.lastFlushTs >= this.flushEveryMs) {
      this.lastFlushTs = r.ts;
      this.stream!.flush(zlib.constants.Z_SYNC_FLUSH);
    }
  }

  get count(): number {
    return this.written;
  }

  /** Where the last record went; undefined before the first write. */
  position(): RecorderPosition | undefined {
    return this.line > 0 ? { file: this.currentRel, line: this.line, sha: this.lastSha } : undefined;
  }

  private rotate(key: string): void {
    this.finishCurrent();
    const [day, hour] = key.split('/') as [string, string];
    const folder = path.join(this.root, day);
    fs.mkdirSync(folder, { recursive: true });
    const name = `${hour}-${this.segment}.ndjson.gz`;
    // 'wx': fail loudly rather than ever append to / overwrite an existing segment.
    this.file = fs.createWriteStream(path.join(folder, name), { flags: 'wx' });
    this.stream = zlib.createGzip({ level: 6 });
    this.stream.pipe(this.file);
    this.currentKey = key;
    this.currentRel = `${day}/${name}`;
    this.line = 0;
  }

  /**
   * Resolves when EVERY file this recorder wrote is complete on disk (gzip trailer included) —
   * not only the current one: a rotated-out hour can still be draining when the process drains.
   */
  async close(): Promise<void> {
    this.finishCurrent();
    while (this.closing.size > 0) await Promise.all([...this.closing]);
  }

  private finishCurrent(): void {
    const { stream, file } = this;
    this.stream = undefined;
    this.file = undefined;
    if (!stream || !file) return;
    const done = new Promise<void>((res, rej) => {
      file.once('close', () => res());
      file.once('error', rej);
      stream.once('error', rej);
    }).finally(() => this.closing.delete(done));
    this.closing.add(done);
    stream.end();
  }
}

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

const utcHourKey = (ts: number): string => {
  const d = new Date(ts);
  return `${d.toISOString().slice(0, 10)}/${String(d.getUTCHours()).padStart(2, '0')}`;
};

export interface RecordedLine {
  file: string;
  /** 1-based line number inside `file`. */
  line: number;
  text: string;
}

/**
 * Streams raw lines from recorded files, in order. Tolerates the damage a hard crash can leave:
 * a truncated gzip tail and a partial last line. Corruption anywhere else still throws.
 */
export async function* readNdjsonLines(files: string[], onTruncated?: (file: string, detail: string) => void): AsyncGenerator<RecordedLine> {
  for (const f of files) {
    // Z_SYNC_FLUSH as finishFlush: decode everything that was flushed even without a gzip trailer.
    const gunzip = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    let inflated = 0;
    gunzip.on('data', (c: Buffer) => {
      inflated += c.length;
    });
    const rl = readline.createInterface({ input: fs.createReadStream(f).pipe(gunzip), crlfDelay: Infinity });
    let pending: string | undefined;
    let line = 0;
    for await (const raw of rl) {
      if (pending !== undefined) {
        JSON.parse(pending); // not the last line: must be complete, or the file is corrupt
        yield { file: f, line: ++line, text: pending };
      }
      pending = raw.trim() ? raw : undefined;
    }
    if (pending !== undefined) {
      let ok = true;
      try {
        JSON.parse(pending);
      } catch {
        ok = false;
        onTruncated?.(f, 'partial last line skipped');
      }
      if (ok) yield { file: f, line: ++line, text: pending };
    }
    if (!hasGzipTrailer(f, inflated)) onTruncated?.(f, 'gzip trailer missing: the file was not closed (crash, or still being written)');
  }
}

/**
 * A closed single-member gzip file ends with ISIZE = uncompressed size mod 2^32. A file cut by a
 * crash (or still open) ends in compressed data instead: the check fails with probability 1 − 2^-32.
 */
function hasGzipTrailer(file: string, inflated: number): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 18) return false; // 10-byte header + 8-byte trailer
    const tail = Buffer.alloc(4);
    fs.readSync(fd, tail, 0, 4, size - 4);
    return tail.readUInt32LE(0) === inflated % 2 ** 32;
  } finally {
    fs.closeSync(fd);
  }
}

/** Parsed records from recorded files, in order (see readNdjsonLines for crash tolerance). */
export async function* readNdjsonGz(files: string[], onTruncated?: (file: string, detail: string) => void): AsyncGenerator<InputRecord> {
  for await (const l of readNdjsonLines(files, onTruncated)) yield JSON.parse(l.text) as InputRecord;
}

const SEGMENT_RE = /^(\d{2})(?:-(\d{13}))?\.ndjson\.gz$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface RecordingEntry {
  file: string;
  day: string;
  hour: string;
  segment: string;
  key: string;
}

function scan(dir: string): RecordingEntry[] {
  if (!fs.existsSync(dir)) return [];
  const out: RecordingEntry[] = [];
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const m = SEGMENT_RE.exec(e.name);
        const day = path.basename(p);
        if (m && DAY_RE.test(day)) {
          const segment = m[2] ?? '0'.repeat(13);
          out.push({ file: full, day, hour: m[1]!, segment, key: `${day}/${m[1]}/${segment}` });
        }
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * UTC time span covered by the recordings under `dir`, from the file names: [first hour, last hour + 1 h).
 * Coarse (hour granularity) but needs no decompression; undefined when there are no recordings.
 */
export function recordingHourSpan(dir: string): { fromMs: number; toMs: number } | undefined {
  const all = scan(dir);
  if (all.length === 0) return undefined;
  const ms = (e: RecordingEntry) => Date.parse(`${e.day}T${e.hour}:00:00Z`);
  return { fromMs: Math.min(...all.map(ms)), toMs: Math.max(...all.map(ms)) + 3_600_000 };
}

/** All recordings under `dir`, ordered by (day, hour, segment). Legacy `<HH>.ndjson.gz` = segment 0. */
export function listRecordings(dir: string): string[] {
  return scan(dir).map((x) => x.file);
}

function lastRecordingKey(dir: string): { day: string; hour: string; segment: string } | undefined {
  const all = scan(dir);
  if (all.length === 0) return undefined;
  let maxSeg = '0'.repeat(13);
  for (const e of all) if (e.segment > maxSeg) maxSeg = e.segment;
  const last = all[all.length - 1]!;
  return { day: last.day, hour: last.hour, segment: maxSeg };
}

/** `file` relative to the recording root, '/'-separated (the form stored in snapshots). */
export function relRecording(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
