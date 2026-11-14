import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { InputRecord } from '../engine/shadow-engine';
import { NdjsonRecorder, listRecordings, readNdjsonGz } from './ndjson';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-rec-'));
const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 11, 10, 0, 0);

async function readAll(files: string[], onTruncated?: (f: string, d: string) => void) {
  const out: InputRecord[] = [];
  for await (const r of readNdjsonGz(files, onTruncated)) out.push(r);
  return out;
}

describe('NdjsonRecorder crash safety', () => {
  it('a hard crash loses at most the unflushed tail; everything flushed stays readable', async () => {
    const dir = tmp();
    const rec = new NdjsonRecorder(dir, 'bot', { segment: 1, flushEveryMs: 1_000 });
    for (let i = 0; i < 50; i++) rec.write({ t: 'clock', ts: T0 + i * 1_000 });
    // Simulate SIGKILL: copy the file as it is on disk, without closing the recorder. The flushed
    // bytes reach the file asynchronously, so poll (bounded) instead of guessing a delay: a fixed
    // sleep was flaky under a loaded test run.
    const copy = path.join(tmp(), '10-0000000000001.ndjson.gz'); // outside the recorder's tree
    let got: Awaited<ReturnType<typeof readAll>> = [];
    let file: string | undefined;
    for (const end = Date.now() + 5_000; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) {
      file = listRecordings(dir)[0];
      if (!file) continue;
      fs.copyFileSync(file, copy);
      got = await readAll([copy]);
      if (got.length >= 49) break;
    }
    expect(() => zlib.gunzipSync(fs.readFileSync(file!))).toThrow(); // really truncated (no trailer)
    expect(got.length).toBeGreaterThanOrEqual(49);
    expect(got.map((r) => r.ts)).toEqual(got.map((_, i) => T0 + i * 1_000));
    await rec.close();
  });

  it('durableCount never exceeds what a hard kill would leave readable, and reaches count on close', async () => {
    const dir = tmp();
    const rec = new NdjsonRecorder(dir, 'bot', { segment: 1, flushEveryMs: 1_000 });
    let checks = 0;
    for (let i = 0; i < 400; i++) {
      // Hour rotation in the middle (durability must carry across files).
      rec.write({ t: 'clock', ts: T0 + 3_000_000 + i * 1_000 });
      if (i % 40 !== 39) continue;
      await new Promise((r) => setTimeout(r, 15));
      const durable = rec.durableCount;
      expect(durable).toBeLessThanOrEqual(rec.count);
      // "SIGKILL now": copy every file as it is on disk and read what survives.
      const snap = tmp();
      const copies = listRecordings(dir).map((f, k) => {
        const c = path.join(snap, `${k}-${path.basename(f)}`);
        fs.copyFileSync(f, c);
        return c;
      });
      const survived = await readAll(copies, () => undefined);
      expect(survived.length).toBeGreaterThanOrEqual(durable);
      if (durable > 0) checks++;
    }
    expect(checks).toBeGreaterThan(5); // it really advances while running, not only at close
    await rec.close();
    expect(rec.durableCount).toBe(400);
  });

  it('a restart writes a new segment instead of appending to a damaged file, and order is preserved', async () => {
    const dir = tmp();
    const a = new NdjsonRecorder(dir, 'bot', { segment: 1 });
    a.write({ t: 'clock', ts: T0 });
    a.write({ t: 'clock', ts: T0 + 1 });
    await a.close();
    const b = new NdjsonRecorder(dir, 'bot', { segment: 2 });
    b.write({ t: 'clock', ts: T0 + 2 });
    b.write({ t: 'clock', ts: T0 + H }); // next hour
    await b.close();
    const files = listRecordings(path.join(dir, 'bot'));
    expect(files.map((f) => path.basename(f))).toEqual(['10-0000000000001.ndjson.gz', '10-0000000000002.ndjson.gz', '11-0000000000002.ndjson.gz']);
    expect((await readAll(files)).map((r) => r.ts)).toEqual([T0, T0 + 1, T0 + 2, T0 + H]);
  });

  it('a backwards wall-clock step never rotates back to an older file', async () => {
    const dir = tmp();
    const rec = new NdjsonRecorder(dir, 'bot', { segment: 1 });
    rec.write({ t: 'clock', ts: T0 + H - 10 });
    rec.write({ t: 'clock', ts: T0 + H + 5 }); // hour 11
    rec.write({ t: 'clock', ts: T0 + H - 3 }); // clock stepped back into hour 10
    await rec.close();
    const files = listRecordings(path.join(dir, 'bot'));
    expect(files).toHaveLength(2);
    expect((await readAll(files)).map((r) => r.ts)).toEqual([T0 + H - 10, T0 + H + 5, T0 + H - 3]);
  });

  it('skips only a partial LAST line; corruption mid-file still throws', async () => {
    const dir = tmp();
    const good = path.join(dir, '10-0000000000001.ndjson.gz');
    fs.writeFileSync(good, zlib.gzipSync('{"t":"clock","ts":1}\n{"t":"clock","ts":2}\n{"t":"clo'));
    const notes: string[] = [];
    expect((await readAll([good], (_f, d) => notes.push(d))).map((r) => r.ts)).toEqual([1, 2]);
    expect(notes).toEqual(['partial last line skipped']);
    const bad = path.join(dir, '10-0000000000002.ndjson.gz');
    fs.writeFileSync(bad, zlib.gzipSync('{"t":"clock","ts":1}\n{garbage\n{"t":"clock","ts":3}\n'));
    await expect(readAll([bad])).rejects.toThrow();
  });

  it('close() waits for rotated-out hours too: nothing is lost when the process drains right after a rotation', async () => {
    const dir = tmp();
    const rec = new NdjsonRecorder(dir, 'bot', { segment: 1 });
    const n = 60_000; // enough to keep the first hour's gzip busy when the rotation happens
    const pad = 'x'.repeat(40);
    // A big hour then a tiny one: the tiny file finishes first, so waiting only for the current
    // file would return while the big one is still being compressed and written.
    for (let i = 0; i < n; i++) {
      const ts = i < n - 10 ? T0 + Math.floor((i * H) / n) : T0 + H + i;
      rec.write({ t: 'command', ts, command: 'pause', pad } as unknown as InputRecord);
    }
    await rec.close();
    const notes: string[] = [];
    const got = await readAll(listRecordings(path.join(dir, 'bot')), (f, d) => notes.push(`${path.basename(f)}: ${d}`));
    expect(notes).toEqual([]);
    expect(got).toHaveLength(n);
  });

  it('a file without its gzip trailer is reported, not read silently', async () => {
    const dir = tmp();
    const text = '{"t":"clock","ts":1}\n{"t":"clock","ts":2}\n';
    const full = zlib.gzipSync(text);
    const ok = path.join(dir, '10-0000000000001.ndjson.gz');
    fs.writeFileSync(ok, full);
    const notes: string[] = [];
    expect(await readAll([ok], (_f, d) => notes.push(d))).toHaveLength(2);
    expect(notes).toEqual([]);
    // Same content, sync-flushed but never ended (what a crash or a still-open file looks like).
    const z = zlib.createGzip();
    const chunks: Buffer[] = [];
    z.on('data', (c: Buffer) => chunks.push(c));
    z.write(text);
    await new Promise<void>((res) => z.flush(zlib.constants.Z_SYNC_FLUSH, () => res()));
    const open = path.join(dir, '10-0000000000002.ndjson.gz');
    fs.writeFileSync(open, Buffer.concat(chunks));
    expect(await readAll([open], (_f, d) => notes.push(d))).toHaveLength(2);
    expect(notes).toEqual(['gzip trailer missing: the file was not closed (crash, or still being written)']);
  });

  it('reads legacy <HH>.ndjson.gz files (segment 0) before new segments of the same hour', () => {
    const dir = tmp();
    const day = path.join(dir, '2026-11-11');
    fs.mkdirSync(day, { recursive: true });
    for (const n of ['10-0000000000005.ndjson.gz', '10.ndjson.gz', '09-0000000000009.ndjson.gz', 'meta.json']) fs.writeFileSync(path.join(day, n), '');
    expect(listRecordings(dir).map((f) => path.basename(f))).toEqual(['09-0000000000009.ndjson.gz', '10.ndjson.gz', '10-0000000000005.ndjson.gz']);
  });
});
