import { commandStreamKey, CommandEnvelopeSchema, type CommandEnvelope } from '@cortex/shared';
import type Redis from 'ioredis';

/** Where validated commands go. The worker is the only consumer and the only state writer. */
export interface CommandBus {
  send(c: CommandEnvelope): Promise<string>;
}

export class MemoryBus implements CommandBus {
  readonly sent: CommandEnvelope[] = [];
  async send(c: CommandEnvelope) {
    this.sent.push(CommandEnvelopeSchema.parse(c));
    return String(this.sent.length);
  }
}

/** XADD bot:<id>:commands (capped): survives a worker restart, consumed in order. */
export class RedisStreamBus implements CommandBus {
  constructor(private readonly redis: Redis) {}
  async send(c: CommandEnvelope) {
    const env = CommandEnvelopeSchema.parse(c);
    const id = await this.redis.xadd(commandStreamKey(env.botId), 'MAXLEN', '~', '1000', '*', 'c', JSON.stringify(env));
    if (!id) throw new Error('XADD returned no id');
    return id;
  }
}
