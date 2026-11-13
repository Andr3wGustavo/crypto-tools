/** The Redis calls a stream tail needs (ioredis `call` in production, a fake in tests). */
export interface RedisCaller {
  call(...args: string[]): Promise<unknown>;
}

export interface TailEntry {
  id: string;
  fields: Record<string, string>;
}

/**
 * Reads a Redis stream from "now" on, without losing entries between calls: the first read
 * starts after the stream's current last id (not `$` on every call, which would skip whatever
 * arrived between two reads).
 */
export class StreamTail {
  private lastId: string | undefined;

  constructor(private readonly r: RedisCaller, readonly stream: string) {}

  async next(blockMs: number, count = 20): Promise<TailEntry[]> {
    if (this.lastId === undefined) {
      const last = (await this.r.call('XREVRANGE', this.stream, '+', '-', 'COUNT', '1')) as Array<[string, string[]]> | null;
      this.lastId = last && last.length > 0 ? last[0]![0] : '0-0';
    }
    const res = (await this.r.call('XREAD', 'COUNT', String(count), 'BLOCK', String(blockMs), 'STREAMS', this.stream, this.lastId)) as
      | Array<[string, Array<[string, string[] | null]>]>
      | null;
    const out: TailEntry[] = [];
    for (const [, entries] of res ?? []) {
      for (const [id, kv] of entries) {
        const fields: Record<string, string> = {};
        for (let i = 0; kv && i + 1 < kv.length; i += 2) fields[kv[i]!] = kv[i + 1]!;
        out.push({ id, fields });
        this.lastId = id;
      }
    }
    return out;
  }
}

/** XADD with an approximate length cap. */
export async function appendCapped(r: RedisCaller, stream: string, max: number, fields: Record<string, string>): Promise<string> {
  return (await r.call('XADD', stream, 'MAXLEN', '~', String(max), '*', ...Object.entries(fields).flat())) as string;
}
