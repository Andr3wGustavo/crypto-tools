import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CommandEnvelope } from '@cortex/shared';
import { metaToOptions, type ReplayMeta } from '../../../worker/src/engine/run-meta';
import { ShadowEngine, type InputRecord, type ShadowEngineOptions } from '../../../worker/src/engine/shadow-engine';
import { BotViewBuilder, toWireEvents } from '../../../worker/src/ops/bot-view';
import { listRecordings, readNdjsonGz } from '../../../worker/src/recorder/ndjson';
import { syntheticInputs, testEngineOptions } from '../../../worker/src/testing/synthetic-inputs';
import { buildApp } from '../app';
import { DEMO_PAIRS, demoInputs, demoOptions } from './demo';
import { MemoryAudit } from '../audit';
import { base32Encode, base58Encode } from '../auth/encoding';
import { hotp, totpCounter } from '../auth/totp';
import type { CommandBus } from '../commands';
import { loadApiConfig } from '../config';
import { MemoryBotData } from '../data';
import { MemoryStore } from '../store';

/**
 * LOCAL DEVELOPMENT ONLY (never bundled, never in an image): the API with in-memory stores, fed
 * by a REAL recording replayed through the real engine, so the dashboard shows real market
 * behaviour without Docker, Redis or Postgres.
 *
 * - The recording's clock is shifted to now. The first part is fast-forwarded (chart history),
 *   then it plays in real time. When it ends, the feeds go stale and the engine pauses
 *   (fail-closed), which is exactly what production does.
 * - Commands from the dashboard go into the engine as recorded-style inputs, as in the worker.
 * - The dev wallet and TOTP secret are derived from fixed strings. They are dev-only and
 *   worthless: the allowlist of a real deployment never contains them.
 *
 *   npx tsx apps/api/src/dev/server.ts [runDir | --synthetic | --demo] [--port 8080] [--web apps/web/dist] [--ff 0.8] [--minutes 60] [--allow <your Solana address>]
 * Without a recording (CI, fresh clone) it uses a seeded synthetic market (labelled as such).
 * --demo runs several pairs on seeded synthetic markets (README screenshots and video).
 * --allow adds your own wallet to the allowlist, so you can sign in with Phantom.
 */
export const DEV_WALLET_SEED = crypto.createHash('sha256').update('cortex-dev-wallet (dev only, worthless)').digest();
export const DEV_TOTP_KEY = crypto.createHash('sha256').update('cortex-dev-totp (dev only, worthless)').digest().subarray(0, 20);

export function devWallet() {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), DEV_WALLET_SEED]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const address = base58Encode(new Uint8Array(spki.subarray(spki.length - 32)));
  return { address, sign: (m: string) => new Uint8Array(crypto.sign(null, Buffer.from(m), privateKey)) };
}

const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : d;
};

interface DevBot {
  botId: string;
  records: InputRecord[];
  i: number;
  shift: number;
  feed: (r: InputRecord) => void;
  engineTs: () => number;
}

/** One engine + view builder + clock-shifted record queue, publishing into the shared data store. */
function makeBot(data: MemoryBotData, opts: ShadowEngineOptions, records: InputRecord[], ff: number, label: { run: string; version: string }): DevBot {
  const cfg = opts.config;
  const botId = cfg.botId;
  const engine = new ShadowEngine(opts);
  const first = records[0]!.ts;
  const last = records[records.length - 1]!.ts;
  const cut = first + (last - first) * ff;
  const shift = Date.now() - cut; // the fast-forward point maps to "now"
  const viewer = new BotViewBuilder({ botId, mode: 'shadow', symbol: cfg.base + cfg.quote, base: cfg.base, quote: cfg.quote, run: label.run, version: label.version, startedAt: first + shift });
  let lastView = Number.NEGATIVE_INFINITY;
  let engineTs = 0;
  let mexcTs = 0;
  let binanceTs = 0;
  const feed = (r: InputRecord) => {
    engineTs = r.ts;
    if (r.t === 'book') r.venue === 'local' ? (mexcTs = r.ts) : (binanceTs = r.ts);
    if (r.t === 'trade') mexcTs = r.ts;
    const outs = engine.process(r);
    viewer.observe(r, outs);
    for (const e of toWireEvents(outs)) data.publishEvent(botId, e);
    if (r.ts - lastView >= 1_000) {
      lastView = r.ts;
      const v = viewer.view(engine, { mexcAgeMs: r.ts - mexcTs, binanceAgeMs: r.ts - binanceTs });
      data.publishView(v);
      const p = viewer.point(v);
      if (p) data.publishPoint(botId, p);
    }
  };
  const bot: DevBot = { botId, records, i: 0, shift, feed, engineTs: () => engineTs };
  const t0 = Date.now();
  while (bot.i < records.length && records[bot.i]!.ts <= cut) step(bot);
  console.log(`[dev] ${botId}: fast-forwarded ${bot.i}/${records.length} records in ${Date.now() - t0} ms; ${Math.round((last - cut) / 60_000)} min left in real time`);
  return bot;
}

function step(b: DevBot): void {
  const r = b.records[b.i++]!;
  b.feed({ ...r, ts: r.ts + b.shift } as InputRecord);
}

async function main() {
  const runDir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join('data', 'e2-proof', 'mexc-SOLUSDT');
  const port = Number(arg('--port', '8080'));
  const webDir = arg('--web', path.join('apps', 'web', 'dist'));
  const ff = Number(arg('--ff', '0.8'));
  const origin = arg('--origin', `http://127.0.0.1:${port}`)!;
  const minutes = Number(arg('--minutes', '60'));

  const data = new MemoryBotData();
  const bots: DevBot[] = [];
  if (process.argv.includes('--demo')) {
    // Several pairs on seeded synthetic markets (run "demo-synthetic"): README screenshots and video.
    for (const d of DEMO_PAIRS) bots.push(makeBot(data, demoOptions(d), demoInputs(d, minutes), ff, { run: 'demo-synthetic', version: 'dev-demo' }));
  } else {
    const synthetic = process.argv.includes('--synthetic') || !fs.existsSync(path.join(runDir, 'meta.json'));
    const opts = synthetic ? testEngineOptions : metaToOptions(JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8')) as ReplayMeta);
    const records: InputRecord[] = [];
    if (synthetic) records.push(...syntheticInputs(minutes, 11));
    else for await (const r of readNdjsonGz(listRecordings(runDir), (f, d) => console.warn(`[dev] ${f}: ${d}`))) records.push(r);
    if (records.length < 2) throw new Error(`no recordings in ${runDir}`);
    bots.push(makeBot(data, opts, records, ff, { run: synthetic ? 'synthetic' : path.basename(runDir), version: synthetic ? 'dev-synthetic' : 'dev-replay' }));
  }
  const byId = new Map(bots.map((b) => [b.botId, b]));

  const bus: CommandBus = {
    async send(c: CommandEnvelope) {
      const b = byId.get(c.botId);
      if (!b) throw new Error(`unknown bot ${c.botId}`);
      const ts = Math.max(b.engineTs(), Date.now());
      b.feed({ t: 'command', ts, command: c.command });
      data.publishEvent(b.botId, { k: 'command', ts, id: c.id, command: c.command, actor: c.actor, applied: true });
      return `${ts}-0`;
    },
  };
  // After the recording: only the clock advances, so the feeds age and the engine fails closed.
  setInterval(() => {
    const now = Date.now();
    for (const b of bots) {
      while (b.i < b.records.length && b.records[b.i]!.ts + b.shift <= now) step(b);
      if (b.i >= b.records.length && now > b.engineTs()) b.feed({ t: 'clock', ts: now });
    }
  }, 100);

  const wallet = devWallet();
  const totpSecret = base32Encode(DEV_TOTP_KEY);
  const config = loadApiConfig({
    API_ORIGIN: origin, API_ALLOWED_WALLETS: [wallet.address, ...(arg('--allow')?.split(',') ?? [])].join(','), API_TOTP_SECRET: totpSecret, API_COOKIE_SECURE: 'false', API_PORT: String(port),
  });
  const app = await buildApp({
    config, store: new MemoryStore(), audit: new MemoryAudit(), bus, data, version: 'dev',
    webDir: webDir && fs.existsSync(path.join(webDir, 'index.html')) ? path.resolve(webDir) : undefined,
    authRatePerMin: 1_000,
  });
  await app.listen({ host: '127.0.0.1', port });
  console.log(`[dev] dashboard: ${origin}  (wallet ${wallet.address}; TOTP secret ${totpSecret}; current code ${hotp(DEV_TOTP_KEY, totpCounter(Date.now()))})`);
  const stop = () => void app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && /dev[\\/]server\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
