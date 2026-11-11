import Redis from 'ioredis';
import type { EngineOutput } from '../engine/shadow-engine';
import type { Logger } from '../logger';

/**
 * Real-time fan-out for the API/dashboard:
 *   SET  bot:<id>:snapshot   latest state (JSON), refreshed ≤ 1/s
 *   XADD bot:<id>:events     non-sample outputs (MAXLEN ≈ 10k)
 *   PUBLISH bot:<id>:live    every output, for WebSocket push
 * Failures never block the engine; they are counted.
 */
export class RedisSink {
  private readonly r: Redis;
  errors = 0;
  private lastSnap = 0;
  private lastErrLog = Number.NEGATIVE_INFINITY;

  constructor(url: string, private readonly botId: string, private readonly log: Logger) {
    this.r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.r.on('error', (e) => {
      this.errors++;
      // ioredis retries forever while Redis is down: log at most once a minute, count every error.
      const now = Date.now();
      if (now - this.lastErrLog >= 60_000) {
        this.lastErrLog = now;
        this.log.warn({ err: e.message || e.name, errors: this.errors }, 'redis error (throttled)');
      }
    });
  }

  /** Connects; on failure the client is torn down so it stops reconnecting in the background. */
  async init(): Promise<void> {
    try {
      await this.r.connect();
    } catch (err) {
      this.r.disconnect();
      throw err;
    }
  }

  push(outs: EngineOutput[], snapshot: () => unknown, now: number): void {
    if (this.r.status !== 'ready') return;
    const pipe = this.r.pipeline();
    for (const o of outs) {
      const isSample = o.kind === 'action' && o.action.kind === 'sample';
      const json = JSON.stringify(o);
      pipe.publish(`bot:${this.botId}:live`, json);
      if (!isSample) pipe.xadd(`bot:${this.botId}:events`, 'MAXLEN', '~', '10000', '*', 'o', json);
    }
    if (now - this.lastSnap >= 1_000) {
      this.lastSnap = now;
      pipe.set(`bot:${this.botId}:snapshot`, JSON.stringify({ ts: now, ...(snapshot() as object) }));
    }
    pipe.exec().catch((e: Error) => {
      this.errors++;
      this.log.warn({ err: e.message }, 'redis pipeline failed');
    });
  }

  async close(): Promise<void> {
    await this.r.quit().catch(() => undefined);
  }
}
