import Redis from 'ioredis';

/**
 * The small key-value surface the API needs. Redis in production (sessions survive an API
 * restart, nonces are single-use across processes), memory in tests.
 */
export interface KvStore {
  /** Set only if absent; false when the key already exists. */
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | undefined>;
  /** Atomic read-and-delete: the primitive behind single-use nonces. */
  getDel(key: string): Promise<string | undefined>;
  del(key: string): Promise<void>;
  ping(): Promise<boolean>;
}

export class MemoryStore implements KvStore {
  private m = new Map<string, { v: string; exp: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  private live(key: string) {
    const e = this.m.get(key);
    if (e && e.exp <= this.now()) {
      this.m.delete(key);
      return undefined;
    }
    return e;
  }
  async setNx(key: string, value: string, ttlMs: number) {
    if (this.live(key)) return false;
    this.m.set(key, { v: value, exp: this.now() + ttlMs });
    return true;
  }
  async set(key: string, value: string, ttlMs: number) {
    this.m.set(key, { v: value, exp: this.now() + ttlMs });
  }
  async get(key: string) {
    return this.live(key)?.v;
  }
  async getDel(key: string) {
    const e = this.live(key);
    this.m.delete(key);
    return e?.v;
  }
  async del(key: string) {
    this.m.delete(key);
  }
  async ping() {
    return true;
  }
}

export class RedisStore implements KvStore {
  constructor(readonly redis: Redis) {}
  async setNx(key: string, value: string, ttlMs: number) {
    return (await this.redis.set(key, value, 'PX', ttlMs, 'NX')) === 'OK';
  }
  async set(key: string, value: string, ttlMs: number) {
    await this.redis.set(key, value, 'PX', ttlMs);
  }
  async get(key: string) {
    return (await this.redis.get(key)) ?? undefined;
  }
  async getDel(key: string) {
    return (await this.redis.getdel(key)) ?? undefined;
  }
  async del(key: string) {
    await this.redis.del(key);
  }
  async ping() {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
