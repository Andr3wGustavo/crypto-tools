import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShadowEngine, stateDigest, type InputRecord } from '../engine/shadow-engine';
import { NdjsonRecorder, listRecordings } from '../recorder/ndjson';
import { syntheticInputs, testEngineOptions as opts } from '../testing/synthetic-inputs';
import { SnapshotStore, bootEngine } from './boot';

const recs = syntheticInputs(15, 21);

function uninterrupted(rs: InputRecord[]) {
  const e = new ShadowEngine(opts);
  for (const r of rs) e.process(r);
  return e;
}

/** One worker process: record + process `rs`, snapshot every `every` records (and at the end if `final`). */
async function runProcess(dir: string, store: SnapshotStore, engine: ShadowEngine, rs: InputRecord[], segment: number, every: number, final: boolean) {
  const rec = new NdjsonRecorder(dir, 'run', { segment });
  rs.forEach((r, i) => {
    rec.write(r);
    engine.process(r);
    if ((i + 1) % every === 0) store.save({ engine: engine.snapshot(), cursor: rec.position(), writtenAt: '' });
  });
  await rec.close();
  if (final) store.save({ engine: engine.snapshot(), cursor: rec.position(), writtenAt: '' });
}

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-boot-'));
  return { dir, root: path.join(dir, 'run'), store: new SnapshotStore(path.join(dir, 'run', 'state')) };
};

describe('boot restore (kill / restart)', () => {
  const target = stateDigest(uninterrupted(recs).snapshot());

  it('kill -9 between snapshots → restart → state equals one uninterrupted run, bit for bit', async () => {
    const { dir, root, store } = setup();
    const kill = 7_777; // not a multiple of the snapshot interval: there is a tail to replay
    await runProcess(dir, store, new ShadowEngine(opts), recs.slice(0, kill), 1, 1_000, false);

    const boot = await bootEngine(opts, root, store);
    expect(boot.from).toBe('snapshot');
    expect(boot.replayed).toBe(kill % 1_000);
    expect(boot.engine.recordCount).toBe(kill);
    expect(stateDigest(boot.engine.snapshot())).toBe(stateDigest(uninterrupted(recs.slice(0, kill)).snapshot()));

    await runProcess(dir, store, boot.engine, recs.slice(kill), 2, 1_000, true);
    expect(stateDigest(boot.engine.snapshot())).toBe(target);

    // Graceful shutdown wrote a final snapshot: the next boot replays nothing.
    const again = await bootEngine(opts, root, store);
    expect(again.replayed).toBe(0);
    expect(stateDigest(again.engine.snapshot())).toBe(target);
    // And a from-scratch rebuild of the recordings agrees too.
    const genesis = await bootEngine(opts, root, new SnapshotStore(path.join(dir, 'empty')));
    expect(genesis.from).toBe('genesis');
    expect(stateDigest(genesis.engine.snapshot())).toBe(target);
    expect(listRecordings(root)).toHaveLength(2);
  });

  it('skips a snapshot that points past the durable recording, or is corrupt, for an older valid one', async () => {
    const { dir, root, store } = setup();
    await runProcess(dir, store, new ShadowEngine(opts), recs.slice(0, 3_500), 1, 1_000, false);
    const [newest] = store.list();
    // Simulate a periodic snapshot whose records never reached the disk (crash right after it).
    const ahead = store.load(newest!);
    ahead.cursor = { ...ahead.cursor!, line: ahead.cursor!.line + 900 };
    ahead.engine.records += 900; // keep the name newest
    store.save(ahead);
    fs.writeFileSync(path.join(store.dir, 'snap-999999999999999.json'), '{"engine":'); // torn / corrupt
    const boot = await bootEngine(opts, root, store);
    expect(boot.from).toBe('snapshot');
    expect(boot.rejected.map((r) => r.split(':')[0])).toEqual(['snap-999999999999999.json', `snap-${String(3_900).padStart(15, '0')}.json`]);
    expect(stateDigest(boot.engine.snapshot())).toBe(stateDigest(uninterrupted(recs.slice(0, 3_500)).snapshot()));
    // Rejected snapshots are quarantined, so they can never crowd valid ones out of the keep window.
    expect(store.list()).toEqual([`snap-${String(3_000).padStart(15, '0')}.json`, `snap-${String(2_000).padStart(15, '0')}.json`]);
    expect(fs.readdirSync(path.join(store.dir, 'rejected'))).toHaveLength(2);
  });

  it('a different configuration never resumes from old state', async () => {
    const { dir, root, store } = setup();
    await runProcess(dir, store, new ShadowEngine(opts), recs.slice(0, 2_000), 1, 1_000, true);
    const other = { ...opts, latencyMs: 300 };
    const boot = await bootEngine(other, root, store);
    expect(boot.from).toBe('genesis');
    expect(boot.rejected.every((r) => r.includes('different engine version or configuration'))).toBe(true);
  });

  it('a restart with the wall clock behind the last file still records after it', async () => {
    const { dir, root } = setup();
    const a = new NdjsonRecorder(dir, 'run', { segment: 5_000 });
    a.write({ t: 'clock', ts: Date.UTC(2026, 10, 11, 12, 30) });
    await a.close();
    const b = new NdjsonRecorder(dir, 'run', { segment: 10 }); // clock (and segment) went backwards
    b.write({ t: 'clock', ts: Date.UTC(2026, 10, 11, 11, 59) });
    await b.close();
    expect(listRecordings(root).map((f) => path.relative(root, f).split(path.sep).join('/'))).toEqual([
      '2026-11-11/12-0000000005000.ndjson.gz',
      '2026-11-11/12-0000000005001.ndjson.gz',
    ]);
  });
});
