import path from 'node:path';
import 'dotenv/config';
import { MexcRest } from '@cortex/exchange';
import Redis from 'ioredis';
import { createLogger } from './logger';
import {
  WITHDRAW_EVT_STREAM, WITHDRAW_REQ_STREAM, WITHDRAW_STREAM_MAX, WithdrawRequestMsgSchema, decodeMessage, encodeMessage, type WithdrawReportMsg,
} from './withdraw/channel';
import { StreamTail, appendCapped } from './withdraw/stream-tail';
import { checkWithdrawGate } from './withdraw/withdraw-gate';
import { FileJournal, Withdrawer, resolveByHand } from './withdraw/withdrawer';

/**
 * Cortex Farm WITHDRAWER (phase E9): the only process holding a withdraw key. It sends treasury
 * profit to ONE whitelisted Solana wallet, when — and only when — the live engine asks and every
 * one of its own limits agrees. It never trades and never sees the trading key.
 *
 *   node dist/worker/withdraw.js                                  run
 *   node dist/worker/withdraw.js resolve <id> failed              a human settles an unresolved one
 *   node dist/worker/withdraw.js resolve <id> confirmed <fee>       (after checking MEXC by hand)
 */
async function main(): Promise<void> {
  const log = createLogger((process.env.LOG_LEVEL as 'info') ?? 'info');
  const dataDir = process.env.WITHDRAW_DATA_DIR ?? './data/withdraw';
  const journal = new FileJournal(path.join(dataDir, 'journal.ndjson'));

  const [cmd, id, outcome, fee] = process.argv.slice(2);
  if (cmd === 'resolve') {
    if (!id || (outcome !== 'confirmed' && outcome !== 'failed')) throw new Error('usage: resolve <id> failed | resolve <id> confirmed <fee>');
    const e = resolveByHand(journal, id, outcome === 'confirmed' ? 'CONFIRMED' : 'FAILED', fee, Date.now());
    log.warn({ entry: e }, 'withdrawal resolved by hand: the live engine applies it on its next re-ask');
    return;
  }
  if (cmd !== undefined) throw new Error(`unknown command ${cmd}`);

  const gate = checkWithdrawGate(process.env);
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required (the channel to the live process)');
  const rest = new MexcRest({ apiKey: gate.apiKey, apiSecret: gate.apiSecret, recvWindow: 5_000 });
  await rest.syncTime();
  const withdrawer = new Withdrawer(gate.config, rest, journal, Date.now, (level, o) => log[level](o, String(o.msg ?? 'withdrawer')));
  const venue = await withdrawer.verifySetup();
  log.warn({ botId: gate.botId, coin: gate.config.coin, ...venue, min: gate.config.minAmount, dailyCap: gate.config.dailyCap }, 'Cortex Farm WITHDRAWER armed');

  const reader = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const writer = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  for (const c of [reader, writer]) c.on('error', (err) => log.warn({ err: err.message }, 'redis'));
  const tail = new StreamTail(reader, WITHDRAW_REQ_STREAM);
  let running = true;

  const stop = (signal: string) => {
    if (!running) return;
    running = false;
    log.warn({ signal }, 'withdrawer stopping');
    reader.disconnect();
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (running) {
    let entries;
    try {
      entries = await tail.next(5_000);
    } catch (err) {
      if (!running) break;
      log.warn({ err: (err as Error).message }, 'request stream read failed; retrying');
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    for (const entry of entries) {
      const d = decodeMessage(entry.fields, WithdrawRequestMsgSchema, gate.channelSecret);
      if (!d.ok) {
        log.error({ entry: entry.id, reason: d.reason }, 'withdraw request refused (not authenticated / invalid)');
        continue;
      }
      if (d.msg.botId !== gate.botId) {
        log.error({ entry: entry.id, botId: d.msg.botId }, 'withdraw request for another bot refused');
        continue;
      }
      try {
        const report = await withdrawer.handle(d.msg);
        if (!report) continue;
        const msg: WithdrawReportMsg = { v: 1, botId: gate.botId, ...report, sentTs: Date.now() };
        await appendCapped(writer, WITHDRAW_EVT_STREAM, WITHDRAW_STREAM_MAX, encodeMessage(msg, gate.channelSecret));
        log.info({ id: report.id, status: report.status, mode: d.msg.mode, reason: report.reason }, 'withdraw report');
      } catch (err) {
        // Nothing is lost: the engine re-asks; the journal makes the next answer exact.
        log.error({ id: d.msg.id, err: (err as Error).message }, 'withdraw request failed; the engine will ask again');
      }
    }
  }
  writer.disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
