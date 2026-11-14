import type { BootHooks } from '../state/boot';
import type { EngineOutput } from '../engine/shadow-engine';
import type { LiveOutput } from '../live/live-engine';
import type { Logger } from '../logger';
import { LedgerTap, type PersistableEngine, type PostgresSink } from './postgres-sink';

/** Above this many queued items the boot replay waits for the database. */
const BOOT_BACKLOG = 5_000;

type Output = EngineOutput | LiveOutput;

/**
 * Boot hooks that hand every replayed record to the sink. Records already durable (at or below
 * the run's cursor) are dropped by the sink, so a restart re-sends exactly what the database may
 * have missed between the last flush and the crash. `onTap` receives the tap the worker then keeps
 * using for live records.
 */
export function persistReplay<E extends PersistableEngine & { process(r: R): ReadonlyArray<Output> }, R>(
  sink: PostgresSink,
  log: Pick<Logger, 'warn'>,
  onTap: (tap: LedgerTap) => void,
): BootHooks<E, R> {
  let tap: LedgerTap | undefined;
  let backpressure = true;
  return {
    onStart(engine) {
      tap = new LedgerTap(engine);
      onTap(tap);
      if (engine.recordCount > sink.persistedSeq) {
        // The snapshot is ahead of the database: those records will not be replayed here.
        log.warn({ persistedSeq: sink.persistedSeq, snapshotSeq: engine.recordCount }, 'Postgres misses records before the snapshot: run persist-backfill on this run dir to restore them');
      }
    },
    onRecord(_engine, _r, outs) {
      sink.push(tap!.item(outs));
      if (backpressure && sink.backlog >= BOOT_BACKLOG) {
        return sink.drain().then((ok) => {
          backpressure = ok; // the database is failing: stop waiting for it, the queue keeps the rest
        });
      }
    },
  };
}
