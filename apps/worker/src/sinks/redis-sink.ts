import { BOTS_SET_KEY, EVENTS_MAX, FILLS_MAX, SERIES_MAX_POINTS, botKeys, type BotEvent, type BotView, type LiveMessage, type SeriesPoint } from '@cortex/shared';
import Redis from 'ioredis';
import type { Logger } from '../logger';

export type RedisCmd = [string, ...string[]];

/** The Redis operations the publisher needs: ioredis in production, a fake in tests. */
export interface LiveRedis {
  /** Runs the commands in order (one round trip) and returns each reply, or throws. */
  exec(cmds: RedisCmd[]): Promise<unknown[]>;
  ready(): boolean;
}

/**
 * Real-time fan-out to the API and the dashboard, using the contracts in @cortex/shared:
 *   SADD bots <id>                      registry
 *   SET  bot:<id>:view   + PUBLISH live  latest BotView, at most once per second
 *   XADD bot:<id>:series + PUBLISH live  one chart point per SERIES_STEP_MS (24 h kept)
 *   XADD bot:<id>:events + PUBLISH live  every notable event (fills also go to bot:<id>:fills)
 *
 * The engine never waits on it. Writes are chained so live messages keep the engine's order,
 * and each live event carries its stream id, so the dashboard can merge history with the live
 * feed without duplicates. A failure is counted (it feeds the risk manager), never thrown. While
 * Redis is down nothing is queued: the dashboard is a view, and the recording is the record.
 */
export class RedisSink {
  errors = 0;
  private lastView = Number.NEGATIVE_INFINITY;
  private chain: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private lastErrLog = Number.NEGATIVE_INFINITY;
  private readonly k: ReturnType<typeof botKeys>;

  constructor(
    private readonly r: LiveRedis,
    private readonly botId: string,
    private readonly log: Pick<Logger, 'warn'>,
    private readonly viewEveryMs = 1_000,
    private readonly maxInFlight = 1_000,
  ) {
    this.k = botKeys(botId);
  }

  async init(): Promise<void> {
    await this.r.exec([['SADD', BOTS_SET_KEY, this.botId]]);
  }

  /** `now` is the engine clock. The view is built lazily, at most once per `viewEveryMs`. */
  push(events: readonly BotEvent[], now: number, view: () => BotView, point: (v: BotView) => SeriesPoint | undefined): void {
    if (!this.r.ready()) return;
    let v: BotView | undefined;
    let p: SeriesPoint | undefined;
    if (now - this.lastView >= this.viewEveryMs) {
      this.lastView = now;
      v = view();
      p = point(v);
    }
    if (events.length === 0 && !v) return;
    if (this.inFlight >= this.maxInFlight) {
      this.fail(new Error(`redis publisher backlog ≥ ${this.maxInFlight}: dropping (dashboard only)`));
      return;
    }
    this.inFlight++;
    const evs = [...events];
    this.chain = this.chain
      .then(() => this.write(evs, v, p))
      .catch((e: Error) => this.fail(e))
      .finally(() => {
        this.inFlight--;
      });
  }

  private async write(events: BotEvent[], v: BotView | undefined, p: SeriesPoint | undefined): Promise<void> {
    const cmds: RedisCmd[] = [];
    for (const e of events) {
      cmds.push(['XADD', this.k.events, 'MAXLEN', '~', String(EVENTS_MAX), '*', 'e', JSON.stringify(e)]);
      if (e.k === 'fill') cmds.push(['XADD', this.k.fills, 'MAXLEN', '~', String(FILLS_MAX), '*', 'e', JSON.stringify(e)]);
    }
    if (v) cmds.push(['SET', this.k.view, JSON.stringify(v)]);
    if (p) cmds.push(['XADD', this.k.series, 'MAXLEN', '~', String(SERIES_MAX_POINTS), '*', 'p', JSON.stringify(p)]);
    const replies = await this.r.exec(cmds);

    const live: LiveMessage[] = [];
    let i = 0;
    for (const e of events) {
      // The events-stream id is the cursor the dashboard dedupes and paginates on.
      live.push({ t: 'event', botId: this.botId, id: String(replies[i]), e });
      i += e.k === 'fill' ? 2 : 1;
    }
    if (v) live.push({ t: 'view', view: v });
    if (p) live.push({ t: 'point', botId: this.botId, p });
    await this.r.exec(live.map((m): RedisCmd => ['PUBLISH', this.k.live, JSON.stringify(m)]));
  }

  private fail(e: Error): void {
    this.errors++;
    const t = Date.now();
    if (t - this.lastErrLog >= 60_000) {
      this.lastErrLog = t;
      this.log.warn({ err: e.message, errors: this.errors }, 'redis publish failed (throttled log)');
    }
  }

  /** Waits for the writes already queued (the caller's shutdown timer bounds it). */
  async flush(): Promise<void> {
    await this.chain;
  }
}

/** ioredis adapter. Offline queue disabled: while Redis is down, publishing is skipped, not buffered. */
export class IoRedisLive implements LiveRedis {
  private readonly r: Redis;
  private lastErrLog = Number.NEGATIVE_INFINITY;
  errors = 0;

  constructor(url: string, log: Pick<Logger, 'warn'>) {
    this.r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.r.on('error', (e: Error) => {
      this.errors++;
      // ioredis retries forever while Redis is down: log at most once a minute, count every error.
      const now = Date.now();
      if (now - this.lastErrLog >= 60_000) {
        this.lastErrLog = now;
        log.warn({ err: e.message || e.name, errors: this.errors }, 'redis error (throttled)');
      }
    });
  }

  /** Connects; on failure the client is torn down so it stops reconnecting in the background. */
  async connect(): Promise<void> {
    try {
      await this.r.connect();
    } catch (err) {
      this.r.disconnect();
      throw err;
    }
  }

  ready(): boolean {
    return this.r.status === 'ready';
  }

  async exec(cmds: RedisCmd[]): Promise<unknown[]> {
    if (cmds.length === 0) return [];
    const pipe = this.r.pipeline();
    for (const [c, ...a] of cmds) pipe.call(c, ...a);
    const res = (await pipe.exec()) ?? [];
    return res.map(([err, val]) => {
      if (err) throw err;
      return val;
    });
  }

  async close(): Promise<void> {
    await this.r.quit().catch(() => undefined);
  }
}
