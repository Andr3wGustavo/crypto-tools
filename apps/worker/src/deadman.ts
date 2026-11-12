import { DEFAULT_HEARTBEAT_LIMITS, evaluateHeartbeats, heartbeatFile, readHeartbeat } from './ops/heartbeat';

/**
 * Dead-man sidecar. Every DEADMAN_EVERY_MS it checks every expected worker's heartbeat and pings
 * an external monitor (healthchecks.io): success when the whole farm is healthy, `/fail` with the
 * problems otherwise. If this process, the Docker daemon or the VPS dies, the pings stop and the
 * monitor alerts on its own — that is the point of a dead-man switch.
 *
 * Env: HEARTBEAT_DIR (default /data/health), EXPECTED_BOTS (comma-separated symbols),
 *      HEALTHCHECK_URL (optional: without it the result is only logged), DEADMAN_EVERY_MS (60000).
 */
const dir = process.env.HEARTBEAT_DIR ?? '/data/health';
const expected = (process.env.EXPECTED_BOTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const url = process.env.HEALTHCHECK_URL?.trim() || undefined;
const every = Number(process.env.DEADMAN_EVERY_MS ?? 60_000);

if (expected.length === 0) {
  console.error('EXPECTED_BOTS is empty — refusing to report a farm with no workers as healthy');
  process.exit(1);
}

async function ping(ok: boolean, body: string): Promise<void> {
  if (!url) return;
  try {
    await fetch(ok ? url : `${url}/fail`, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'healthcheck ping failed', err: (err as Error).message }));
  }
}

async function tick(): Promise<void> {
  const r = evaluateHeartbeats(expected, (s) => readHeartbeat(heartbeatFile(dir, s)), Date.now(), DEFAULT_HEARTBEAT_LIMITS);
  const line = { ts: new Date().toISOString(), ok: r.ok, workers: expected.length, problems: r.problems, notes: r.notes };
  console.log(JSON.stringify(line));
  await ping(r.ok, r.ok ? `${expected.length} workers healthy${r.notes.length ? `; ${r.notes.join('; ')}` : ''}` : r.problems.join('\n'));
}

void tick();
const timer = setInterval(() => void tick(), every);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => {
  clearInterval(timer);
  process.exit(0);
});
