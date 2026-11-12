import crypto from 'node:crypto';
import { commandStreamKey, type CommandEnvelope } from '@cortex/shared';
import { describe, expect, it } from 'vitest';
import { CommandSource, decideCommand, type StreamClient, type StreamEntry } from './command-source';

const BOT = 'mexc:IOUSDT:shadow';
const T = Date.UTC(2026, 10, 12, 12);

/** In-memory Redis stream with one consumer group: delivered-but-unacked entries stay pending. */
class FakeStreams implements StreamClient {
  entries: StreamEntry[] = [];
  delivered = 0;
  pending = new Set<string>();
  published: Array<Record<string, unknown>> = [];
  failNext = 0;
  private seq = 0;
  add(c: unknown) {
    this.entries.push({ id: `${++this.seq}-0`, fields: { c: typeof c === 'string' ? c : JSON.stringify(c) } });
  }
  async ensureGroup() {}
  async readGroup(_s: string, _g: string, _c: string, id: '0' | '>', count: number) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('ECONNREFUSED');
    }
    if (id === '0') return this.entries.filter((e) => this.pending.has(e.id)).slice(0, count);
    const fresh = this.entries.slice(this.delivered, this.delivered + count);
    this.delivered += fresh.length;
    fresh.forEach((e) => this.pending.add(e.id));
    return fresh;
  }
  async ack(_s: string, _g: string, id: string) {
    this.pending.delete(id);
  }
  async publishEvent(_b: string, payload: Record<string, unknown>) {
    this.published.push(payload);
  }
}

const env = (command: string, ageMs = 0, botId = BOT): CommandEnvelope =>
  ({ id: crypto.randomUUID(), botId, command, actor: 'Wallet1111', requestedAt: T - ageMs }) as CommandEnvelope;

describe('operator commands → engine (command source)', () => {
  it('decideCommand: validates, binds to this bot, and expires only risky commands', () => {
    expect(decideCommand({ c: JSON.stringify(env('pause', 3_600_000)) }, BOT, T, 120_000)).toMatchObject({ apply: true }); // stale pause still applies
    expect(decideCommand({ c: JSON.stringify(env('resume', 120_001)) }, BOT, T, 120_000)).toMatchObject({ apply: false, reason: 'expired' });
    expect(decideCommand({ c: JSON.stringify(env('resume', 1_000)) }, BOT, T, 120_000)).toMatchObject({ apply: true });
    expect(decideCommand({ c: JSON.stringify(env('pause', 0, 'mexc:ZROUSDT:shadow')) }, BOT, T, 120_000)).toMatchObject({ apply: false, reason: 'wrong_bot' });
    expect(decideCommand({ c: '{nope' }, BOT, T, 120_000)).toEqual({ apply: false, reason: 'malformed' });
    expect(decideCommand({}, BOT, T, 120_000)).toEqual({ apply: false, reason: 'malformed' });
    expect(decideCommand({ c: JSON.stringify({ ...env('withdraw'), command: 'withdraw' }) }, BOT, T, 120_000)).toEqual({ apply: false, reason: 'malformed' });
  });

  it('applies valid commands in order, acks everything, refuses the rest, and reports each outcome', async () => {
    const s = new FakeStreams();
    const applied: string[] = [];
    const src = new CommandSource({ botId: BOT, client: s, apply: (c) => applied.push(c.command), now: () => T });
    s.add(env('pause'));
    s.add('garbage');
    s.add(env('resume', 10 * 60_000));
    s.add(env('reset_halt'));
    expect(await src.poll()).toBe(4);
    expect(applied).toEqual(['pause', 'reset_halt']);
    expect(s.pending.size).toBe(0);
    expect(s.published.map((p) => [p.command, p.applied, p.reason])).toEqual([
      ['pause', true, undefined], [null, false, 'malformed'], ['resume', false, 'expired'], ['reset_halt', true, undefined],
    ]);
    expect([src.applied, src.refused]).toEqual([2, 2]);
  });

  it('a crash between read and ack re-delivers the command on the next boot (at-least-once)', async () => {
    const s = new FakeStreams();
    s.add(env('pause'));
    const crashing = new CommandSource({
      botId: BOT, client: s, now: () => T,
      apply: () => {
        throw new Error('killed before ack');
      },
    });
    await expect(crashing.poll()).rejects.toThrow();
    expect(s.pending.size).toBe(1);
    const applied: string[] = [];
    const reboot = new CommandSource({ botId: BOT, client: s, apply: (c) => applied.push(c.command), now: () => T });
    await reboot.poll();
    expect(applied).toEqual(['pause']);
    expect(s.pending.size).toBe(0);
  });

  it('survives the stream being down (backoff, error counted) and resumes', async () => {
    const s = new FakeStreams();
    s.failNext = 1;
    let errors = 0;
    const applied: string[] = [];
    const src = new CommandSource({ botId: BOT, client: s, apply: (c) => applied.push(c.command), now: () => T, onError: () => errors++, blockMs: 0 });
    s.add(env('pause'));
    src.start();
    const t0 = Date.now();
    while (applied.length === 0 && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 20));
    await src.stop();
    expect(errors).toBe(1);
    expect(applied).toEqual(['pause']);
  });

  it('uses the shared stream key', () => {
    expect(commandStreamKey(BOT)).toBe('bot:mexc:IOUSDT:shadow:commands');
  });
});
