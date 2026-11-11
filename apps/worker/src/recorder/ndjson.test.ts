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
    await new Promise((r) => setTimeout(r, 50)); // let the flushed bytes reach the file
    const [file] = listRecordings(dir);
    // Simulate SIGKILL: copy the file as it is on disk right now, without closing the recorder.
    const crashed = path.join(dir, 'bot', 'crashed');
    fs.mkdirSync(crashed);
    fs.copyFileSync(file!, path.join(crashed, '10-0000000000001.ndjson.gz'));
    expect(() => zlib.gunzipSync(fs.readFileSync(file!))).toThrow(); // really truncated (no trailer)
    const got = await readAll([path.join(crashed, '10-0000000000001.ndjson.gz')]);
    expect(got.length).toBeGreaterThanOrEqual(49);
    expect(got.map((r) => r.ts)).toEqual(got.map((_, i) => T0 + i * 1_000));
    await rec.close();
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

  it('reads legacy <HH>.ndjson.gz files (segment 0) before new segments of the same hour', () => {
    const dir = tmp();
    const day = path.join(dir, '2026-11-11');
    fs.mkdirSync(day, { recursive: true });
    for (const n of ['10-0000000000005.ndjson.gz', '10.ndjson.gz', '09-0000000000009.ndjson.gz', 'meta.json']) fs.writeFileSync(path.join(day, n), '');
    expect(listRecordings(dir).map((f) => path.basename(f))).toEqual(['09-0000000000009.ndjson.gz', '10.ndjson.gz', '10-0000000000005.ndjson.gz']);
  });
});
