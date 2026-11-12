import type Redis from 'ioredis';
import type { StreamClient, StreamEntry } from './command-source';

/** StreamClient over ioredis. Needs its own connection: XREADGROUP BLOCK holds it while waiting. */
export class IoRedisStreamClient implements StreamClient {
  constructor(private readonly r: Redis) {}

  async ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.r.call('XGROUP', 'CREATE', stream, group, '$', 'MKSTREAM');
    } catch (err) {
      if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
    }
  }

  async readGroup(stream: string, group: string, consumer: string, id: '0' | '>', count: number, blockMs: number): Promise<StreamEntry[]> {
    const block = id === '>' && blockMs > 0 ? ['BLOCK', String(blockMs)] : [];
    const res = (await this.r.call('XREADGROUP', 'GROUP', group, consumer, 'COUNT', String(count), ...block, 'STREAMS', stream, id)) as
      | Array<[string, Array<[string, string[] | null]>]>
      | null;
    const out: StreamEntry[] = [];
    for (const [, entries] of res ?? []) {
      for (const [entryId, kv] of entries) {
        const fields: Record<string, string> = {};
        // A pending entry trimmed from the stream comes back with null fields: refused + acked upstream.
        for (let i = 0; kv && i + 1 < kv.length; i += 2) fields[kv[i]!] = kv[i + 1]!;
        out.push({ id: entryId, fields });
      }
    }
    return out;
  }

  async ack(stream: string, group: string, id: string): Promise<void> {
    await this.r.call('XACK', stream, group, id);
  }

  async publish(stream: string, payload: Record<string, unknown>): Promise<void> {
    await this.r.call('XADD', stream, 'MAXLEN', '~', '10000', '*', 'o', JSON.stringify(payload));
  }
}
