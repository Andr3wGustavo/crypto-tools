import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import type { InputRecord } from '../engine/shadow-engine';

/**
 * Hourly-rotated gzip NDJSON recorder of every engine input. These files are the ground truth for
 * replay, backtests (dashboard Simulator) and fill-intensity calibration.
 * Layout: <dir>/<botKey>/<YYYY-MM-DD>/<HH>.ndjson.gz (UTC).
 */
export class NdjsonRecorder {
  private stream: zlib.Gzip | undefined;
  private file: fs.WriteStream | undefined;
  private currentKey = '';
  private written = 0;

  constructor(private readonly dir: string, private readonly botKey: string) {}

  write(r: InputRecord): void {
    const d = new Date(r.ts);
    const day = d.toISOString().slice(0, 10);
    const hour = String(d.getUTCHours()).padStart(2, '0');
    const key = `${day}/${hour}`;
    if (key !== this.currentKey) this.rotate(day, hour, key);
    this.stream!.write(`${JSON.stringify(r)}\n`);
    this.written++;
  }

  get count(): number {
    return this.written;
  }

  private rotate(day: string, hour: string, key: string): void {
    this.closeSync();
    const folder = path.join(this.dir, this.botKey, day);
    fs.mkdirSync(folder, { recursive: true });
    // Append mode: a restart within the same hour adds a new gzip member (valid concatenated gzip).
    this.file = fs.createWriteStream(path.join(folder, `${hour}.ndjson.gz`), { flags: 'a' });
    this.stream = zlib.createGzip({ level: 6 });
    this.stream.pipe(this.file);
    this.currentKey = key;
  }

  private closeSync(): void {
    this.stream?.end();
    this.stream = undefined;
    this.file = undefined;
  }

  close(): Promise<void> {
    const f = this.file;
    this.stream?.end();
    this.stream = undefined;
    this.file = undefined;
    return f ? new Promise((res) => f.on('close', () => res())) : Promise.resolve();
  }
}

/** Streams records from one or more recorded files, in file order. */
export async function* readNdjsonGz(files: string[]): AsyncGenerator<InputRecord> {
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(f).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) yield JSON.parse(line) as InputRecord;
    }
  }
}

export function listRecordings(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ndjson.gz')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}
