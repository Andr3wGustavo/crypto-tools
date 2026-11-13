import crypto from 'node:crypto';
import { botKeys, type BotEvent } from '@cortex/shared';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { sampleView } from '../../../api/src/testing/fixtures';
import { Alerter } from './alerter';
import { DiscordNotifier, WEBHOOK_RE, toEmbed } from './discord';
import { AlertRules, DEFAULT_ALERT_RULES, dailySummary, type Alert } from './rules';

const BOT = 'mexc:IOUSDT:shadow';
const T = Date.UTC(2026, 10, 13, 12);
const status = (s: 'running' | 'paused' | 'halted' | 'killed', reason: string, ts = T): BotEvent => ({ k: 'status', ts, status: s, quoting: s === 'running', reason });
const titles = (a: Alert[]) => a.map((x) => `${x.severity}:${x.title}`);
/** A healthy view (equity at its peak, feeds fresh): only the rule under test can fire. */
const ok = (ts: number, over: Parameters<typeof sampleView>[2] = {}) => sampleView(BOT, ts, { pnl: { equity: 15, startEquity: 15, peakEquity: 15, realized: 0, unrealized: 0 }, ...over });

describe('alert rules (AFK)', () => {
  it('halt, kill and reconcile divergence are critical, every time; recovery is reported', () => {
    const r = new AlertRules();
    expect(titles(r.onEvent(BOT, status('running', 'start'), T))).toEqual([]);
    expect(titles(r.onEvent(BOT, status('halted', 'max_drawdown'), T))).toEqual(['critical:IOUSDT: HALT']);
    expect(titles(r.onEvent(BOT, status('halted', 'max_drawdown'), T + 1))).toEqual([]); // same status: no repeat
    expect(titles(r.onEvent(BOT, status('running', 'manual_reset_halt'), T + 2))).toEqual(['resolved:IOUSDT: voltou a operar']);
    expect(titles(r.onEvent(BOT, status('killed', 'loss_budget'), T + 3))).toEqual(['critical:IOUSDT: KILL']);
    expect(titles(r.onEvent(BOT, { k: 'reconcile', ts: T, ok: false, diffs: 2 }, T + 4))).toEqual(['critical:IOUSDT: divergência de reconciliação']);
    expect(r.onEvent(BOT, { k: 'reconcile', ts: T, ok: true, diffs: 0 }, T + 5)).toEqual([]);
  });

  it('live venue holds: fatal is critical at once; a transient hold alerts only if it lasts', () => {
    const r = new AlertRules();
    const view = (ts: number) => [{ botId: BOT, view: ok(ts, { quoting: false }) }];
    r.onEvent(BOT, status('running', 'start'), T);
    expect(r.onEvent(BOT, status('running', 'venue_hold:stream_down'), T)).toEqual([]);
    expect(titles(r.onViews(view(T + 30_000), T + 30_000)).filter((x) => x.includes('live'))).toEqual([]);
    r.onEvent(BOT, status('running', 'venue_hold:syncing'), T + 40_000); // still the same hold episode
    expect(titles(r.onViews(view(T + 61_000), T + 61_000))).toEqual(['warn:IOUSDT: live sem cotar']);
    expect(r.onEvent(BOT, status('running', 'venue_ok'), T + 70_000)).toEqual([]);
    expect(titles(r.onViews([{ botId: BOT, view: ok(T + 71_000) }], T + 71_000))).toEqual(['resolved:IOUSDT: live voltou a cotar']);
    // A short blip never alerts.
    r.onEvent(BOT, status('running', 'venue_hold:rate_limited'), T + 80_000);
    r.onEvent(BOT, status('running', 'venue_ok'), T + 90_000);
    expect(r.onViews([{ botId: BOT, view: ok(T + 200_000) }], T + 200_000)).toEqual([]);
    // Fatal: critical immediately, once; resolved when a human clears it.
    expect(titles(r.onEvent(BOT, status('running', 'venue_hold:fatal:auth'), T + 300_000))).toEqual(['critical:IOUSDT: live travado (auth)']);
    expect(r.onEvent(BOT, status('running', 'venue_hold:fatal:auth'), T + 301_000)).toEqual([]);
    expect(titles(r.onViews(view(T + 500_000), T + 500_000)).filter((x) => x.includes('live'))).toEqual([]);
    expect(titles(r.onEvent(BOT, status('running', 'venue_ok'), T + 600_000))).toEqual(['resolved:IOUSDT: live liberado']);
  });

  it('withdrawals: confirmed is info (with the tx), failed is a warning, in-flight steps are silent', () => {
    const r = new AlertRules();
    const wd = (status: 'PENDING' | 'SENT' | 'CONFIRMED' | 'FAILED', extra = {}): BotEvent => ({ k: 'withdrawal', ts: T, id: 'wdab12cd-1', status, amount: 25, fee: null, txId: null, reason: null, ...extra });
    expect(r.onEvent(BOT, wd('PENDING'), T)).toEqual([]);
    expect(r.onEvent(BOT, wd('SENT'), T)).toEqual([]);
    const ok1 = r.onEvent(BOT, wd('CONFIRMED', { fee: 1, txId: '5xSig' }), T);
    expect(titles(ok1)).toEqual(['info:IOUSDT: saque confirmado']);
    expect(ok1[0]!.text).toContain('5xSig');
    expect(titles(r.onEvent(BOT, wd('FAILED', { reason: 'cooldown' }), T))).toEqual(['warn:IOUSDT: saque não feito']);
  });

  it('an automatic pause alerts only if it lasts (no spam for a feed blip); manual pauses never', () => {
    const r = new AlertRules();
    const view = (over = {}) => [{ botId: BOT, view: ok(T, { status: 'paused', quoting: false, ...over }) }];
    r.onEvent(BOT, status('running', 'start'), T);
    r.onEvent(BOT, status('paused', 'stale_local_data'), T);
    expect(titles(r.onViews(view(), T + 30_000).filter((a) => a.title.includes('pausado')))).toEqual([]);
    r.onEvent(BOT, status('running', 'data_ok'), T + 31_000); // the blip ended in time
    expect(r.onViews([{ botId: BOT, view: ok(T + 70_000) }], T + 70_000)).toEqual([]);

    r.onEvent(BOT, status('paused', 'toxic_flow'), T + 100_000);
    expect(titles(r.onViews(view({ ts: T + 170_000 }), T + 170_000))).toEqual(['warn:IOUSDT: pausado automaticamente']);
    r.onEvent(BOT, status('running', 'flow_ok'), T + 180_000);
    expect(titles(r.onViews([{ botId: BOT, view: ok(T + 190_000) }], T + 190_000))).toEqual(['resolved:IOUSDT: voltou a cotar']);

    r.onEvent(BOT, status('paused', 'manual_pause'), T + 200_000);
    expect(r.onViews(view({ ts: T + 900_000 }), T + 900_000)).toEqual([]);
  });

  it('stale bot and dead feed: one alert when they start, a reminder after repeatMs, one when they clear', () => {
    const r = new AlertRules();
    const fresh = ok(T);
    expect(r.onViews([{ botId: BOT, view: fresh }], T + 1_000)).toEqual([]);
    expect(titles(r.onViews([{ botId: BOT, view: fresh }], T + 130_000))).toEqual(['critical:IOUSDT: sem dados']);
    expect(r.onViews([{ botId: BOT, view: fresh }], T + 600_000)).toEqual([]);
    expect(titles(r.onViews([{ botId: BOT, view: fresh }], T + 130_000 + DEFAULT_ALERT_RULES.repeatMs))[0]).toMatch(/sem dados \(ainda, há \d+ min\)/);
    const back = ok(T + 3e7);
    expect(titles(r.onViews([{ botId: BOT, view: back }], T + 3e7))).toEqual(['resolved:IOUSDT: dados de volta']);

    const deadFeed = ok(T + 4e7, { feeds: { mexcAgeMs: 200_000, binanceAgeMs: 10 } });
    expect(titles(r.onViews([{ botId: BOT, view: deadFeed }], T + 4e7))).toEqual(['critical:IOUSDT: feed da MEXC parado']);
    expect(titles(r.onViews([{ botId: BOT, view: ok(T + 4e7 + 1) }], T + 4e7 + 1))).toEqual(['resolved:IOUSDT: feed da MEXC de volta']);
    expect(titles(r.onViews([{ botId: BOT, view: undefined }], T + 5e7))).toEqual(['critical:IOUSDT: sem dados']);
  });

  it('drawdown and error bursts are conditions with resolution', () => {
    const r = new AlertRules();
    const dd = (equity: number) => [{ botId: BOT, view: ok(T, { pnl: { equity, startEquity: 15, peakEquity: 15, realized: 0, unrealized: 0 } }) }];
    expect(r.onViews(dd(14.6), T)).toEqual([]); // 2.7%
    expect(titles(r.onViews(dd(14.5), T))).toEqual(['warn:IOUSDT: drawdown 3.33%']);
    expect(titles(r.onViews(dd(14.9), T))).toEqual(['resolved:IOUSDT: drawdown abaixo de 3.00%']);

    const err = (i: number): BotEvent => ({ k: 'error', ts: T + i, message: `boom ${i}` });
    const out = [0, 1, 2, 3, 4, 5].flatMap((i) => r.onEvent(BOT, err(i), T + i * 1_000));
    expect(titles(out)).toEqual(['warn:IOUSDT: rajada de erros']);
    expect(titles(r.onViews([{ botId: BOT, view: ok(T + 400_000) }], T + 400_000))).toEqual(['resolved:IOUSDT: erros normalizados']);
  });

  it('commands are reported; refused ones as warnings', () => {
    const r = new AlertRules();
    expect(titles(r.onEvent(BOT, { k: 'command', ts: T, id: 'x', command: 'resume', actor: 'GqVo', applied: true }, T))).toEqual(['info:IOUSDT: comando retomar']);
    expect(titles(r.onEvent(BOT, { k: 'command', ts: T, id: 'x', command: 'resume', actor: 'GqVo', applied: false, reason: 'expired' }, T))).toEqual(['warn:IOUSDT: comando recusado']);
  });

  it('daily digest: per-bot 24 h change, honest when there is no 24 h history', () => {
    const a = dailySummary([
      { botId: BOT, status: 'running', equity: 15.2, equity24hAgo: 15, fills24h: 12, edgeN: 30, edgeMeanBps: 0.5 },
      { botId: 'mexc:ZROUSDT:shadow', status: 'paused', equity: 15, equity24hAgo: null, fills24h: 0, edgeN: 2, edgeMeanBps: 0 },
    ], T);
    expect(a.text).toContain('**IOUSDT** · running · 24h +0.2000 USDT (133.3 bps) · 12 fills');
    expect(a.text).toContain('**ZROUSDT** · paused · 24h sem histórico');
    expect(a.text).toContain('Total 24h: +0.2000 USDT');
  });
});

describe('Discord delivery', () => {
  const URL_OK = 'https://discord.com/api/webhooks/123456789/abc-DEF_123';
  const alert = (i: number, severity: Alert['severity'] = 'info'): Alert => ({ severity, botId: BOT, ts: T, title: `t${i}`, text: 'x' });

  it('validates the URL and never accepts something that is not a webhook', () => {
    expect(WEBHOOK_RE.test(URL_OK)).toBe(true);
    for (const u of ['http://discord.com/api/webhooks/1/a', 'https://evil.com/api/webhooks/1/a', 'https://discord.com/api/webhooks/1/a?x=1']) expect(WEBHOOK_RE.test(u)).toBe(false);
    expect(() => new DiscordNotifier({ url: 'https://evil.com/x' })).toThrow(/not a Discord webhook/);
    expect(toEmbed(alert(1, 'critical'))).toMatchObject({ title: '🔴 t1', color: 0xef4444 });
  });

  it('batches 10 embeds per message, retries 429 with retry_after and 5xx, gives up on 4xx', async () => {
    const calls: Array<{ n: number; status: number }> = [];
    const sleeps: number[] = [];
    const script = [429, 500, 200, 200, 400];
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      const status = script.shift() ?? 200;
      calls.push({ n: (JSON.parse(init.body) as { embeds: unknown[] }).embeds.length, status });
      return new Response(status === 429 ? JSON.stringify({ retry_after: 1.5 }) : '{}', { status });
    }) as unknown as typeof fetch;
    const logs: unknown[] = [];
    const d = new DiscordNotifier({ url: URL_OK, fetchImpl, minIntervalMs: 0, sleep: async (ms) => void sleeps.push(ms), log: (x) => logs.push(x) });
    d.push(Array.from({ length: 12 }, (_, i) => alert(i)));
    await d.flush();
    expect(calls.map((c) => [c.n, c.status])).toEqual([[10, 429], [10, 500], [10, 200], [2, 200]]);
    expect(sleeps[0]).toBe(1_600); // retry_after honoured
    expect(d.sent).toBe(12);
    d.push([alert(99)]);
    await d.flush();
    expect(d.failed).toBe(1); // 400: not retried
    expect(JSON.stringify(logs)).not.toContain('webhooks'); // the secret URL is never logged
  });

  it('a storm is bounded: keeps the most severe, says how many were dropped', async () => {
    const bodies: Array<{ content?: string; embeds: Array<{ title: string }> }> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      await gate;
      bodies.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const d = new DiscordNotifier({ url: URL_OK, fetchImpl, minIntervalMs: 0, maxQueue: 5, sleep: async () => undefined });
    d.push([alert(0)]); // in flight
    d.push([alert(1, 'critical'), ...Array.from({ length: 8 }, (_, i) => alert(i + 2))]);
    release();
    await d.flush();
    const second = bodies[1]!;
    expect(second.embeds.length).toBe(5);
    expect(second.embeds[0]!.title).toBe('🔴 t1');
    expect(second.content).toMatch(/4 alerta\(s\) descartados/);
  });
});

const url = process.env.REDIS_TEST_URL;
describe.skipIf(!url)('alerter against a real Redis', () => {
  const conns: Redis[] = [];
  afterAll(() => conns.forEach((c) => c.disconnect()));

  it('reads events through its group (resumes after restart), checks views, sends the digest once', async () => {
    const r = new Redis(url!);
    conns.push(r);
    const bot = `mexc:AL${crypto.randomBytes(3).toString('hex').toUpperCase()}:shadow`;
    const k = botKeys(bot);
    await r.sadd('bots', bot);
    let now = T;
    const got: Alert[] = [];
    const mk = () => new Alerter({ redis: { call: (c, ...a) => r.call(c, ...a) }, deliver: (a) => got.push(...a), now: () => now, blockMs: 100, dailyUtcHour: 12 });
    const a1 = mk();
    await a1.refreshBots();
    await r.xadd(k.events, '*', 'e', JSON.stringify(status('halted', 'max_drawdown')));
    await a1.readEvents(); // pending pass (empty)
    await a1.readEvents();
    expect(titles(got)).toContain(`critical:${bot.split(':')[1]}: HALT`);

    // Restart before the ack of a new event: the new instance gets it from its pending list.
    await r.xadd(k.events, '*', 'e', JSON.stringify({ k: 'reconcile', ts: T, ok: false, diffs: 1 }));
    await r.call('XREADGROUP', 'GROUP', 'alerter', 'alerter-1', 'COUNT', '10', 'STREAMS', k.events, '>'); // delivered, never acked (crash)
    got.length = 0;
    const a2 = mk();
    await a2.refreshBots();
    await a2.readEvents();
    expect(titles(got)).toEqual([`critical:${bot.split(':')[1]}: divergência de reconciliação`]);

    await r.set(k.view, JSON.stringify(sampleView(bot, now - 300_000)));
    got.length = 0;
    await a2.checkViews();
    expect(titles(got)).toEqual([`critical:${bot.split(':')[1]}: sem dados`]);

    got.length = 0;
    expect(await a2.maybeDaily()).toBe(true);
    expect(await a2.maybeDaily()).toBe(false);
    expect(got[0]!.title).toBe('Resumo diário da farm');
    now += 3_600_000;
    expect(await a2.maybeDaily()).toBe(false); // 13:00: not the hour
    await r.del(k.events, k.view);
    await r.srem('bots', bot);
  });
});
