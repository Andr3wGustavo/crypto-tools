/**
 * README media: screenshots (desktop + phone) and a short screen recording of the dashboard.
 *
 * 1. npm run web:build
 * 2. npx tsx apps/api/src/dev/server.ts --demo --minutes 60 --ff 0.75 --port 8091 --origin http://127.0.0.1:8091
 * 3. npx tsx scripts/capture-media.ts [http://127.0.0.1:8091] [docs/media]
 *    With ffmpeg on the PATH the recording is also converted to tour.mp4 (H.264) and tour.gif.
 *
 * Signs in through the real UI with a stand-in Phantom whose signatures come from the dev wallet
 * held in this process (as the E2E test does). The demo bots run on seeded synthetic markets.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, devices, type Browser, type Page } from '@playwright/test';
import { devWallet } from '../apps/api/src/dev/server';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8091';
const OUT = path.resolve(process.argv[3] ?? 'docs/media');
fs.mkdirSync(OUT, { recursive: true });
const wallet = devWallet();

const PHANTOM_STUB = (address: string) => `
  window.phantom = { solana: {
    isPhantom: true,
    connect: async () => ({ publicKey: { toString: () => ${JSON.stringify(address)} } }),
    disconnect: async () => undefined,
    signMessage: async (bytes) => {
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      const sig = await window.__devSign(btoa(s));
      return { signature: Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)) };
    },
  } };`;

async function withPhantom(page: Page) {
  await page.exposeFunction('__devSign', (b64: string) => Buffer.from(wallet.sign(Buffer.from(b64, 'base64').toString('utf8'))).toString('base64'));
  // A string, not a function: tsx's helpers (__name) do not exist in the page.
  await page.addInitScript({ content: PHANTOM_STUB(wallet.address) });
}

async function signIn(page: Page, pauseMs = 0) {
  await withPhantom(page);
  await page.goto(BASE);
  await page.waitForTimeout(pauseMs);
  await page.getByRole('button', { name: 'Conectar Phantom' }).click();
  await page.getByRole('heading', { name: 'Visão geral' }).waitFor();
  await page.locator('header[data-conn="live"]').waitFor({ timeout: 15_000 });
}

/** Smooth scroll so the recording reads like a person looking at the page. */
async function glide(page: Page, to: number, ms = 1_600) {
  // A string, not a function: tsx's helpers (__name) do not exist in the page.
  await page.evaluate(`new Promise((done) => {
    const from = window.scrollY, y = ${to}, d = ${ms}, t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / d);
      window.scrollTo(0, from + (y - from) * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2));
      if (k < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  })`);
}

async function screenshots(browser: Browser) {
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await desk.newPage();
  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Console do operador' }).waitFor();
  await page.waitForTimeout(2_500);
  await withPhantom(page);
  await page.goto(BASE);
  await page.screenshot({ path: path.join(OUT, 'login.png') });
  await page.getByRole('button', { name: 'Conectar Phantom' }).click();
  await page.locator('header[data-conn="live"]').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(2_000);
  await page.screenshot({ path: path.join(OUT, 'overview.png') });
  await page.locator('a[href^="/bot/"]').first().click();
  await page.getByText('Preço ao vivo').waitFor();
  await page.getByText('Juntando pontos').waitFor({ state: 'detached', timeout: 30_000 });
  await page.waitForTimeout(2_000);
  await page.screenshot({ path: path.join(OUT, 'bot.png') });
  await page.screenshot({ path: path.join(OUT, 'bot-full.png'), fullPage: true });
  for (const [href, name] of [['/risk', 'risk'], ['/fills', 'fills'], ['/treasury', 'treasury'], ['/system', 'system']] as const) {
    await page.goto(BASE + href);
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  }
  await desk.close();

  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  await signIn(p);
  await p.waitForTimeout(2_000);
  await p.screenshot({ path: path.join(OUT, 'phone-overview.png') });
  await p.locator('a[href^="/bot/"]').first().click();
  await p.getByText('Preço ao vivo').waitFor();
  await p.waitForTimeout(2_000);
  await p.screenshot({ path: path.join(OUT, 'phone-bot.png') });
  await phone.close();
}

async function video(browser: Browser) {
  const dir = path.join(OUT, '.video');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } });
  const page = await ctx.newPage();
  await signIn(page, 1_800);
  await page.locator('a[href^="/bot/"]').first().waitFor();
  await page.waitForTimeout(3_500);
  await page.locator('a[href^="/bot/"]').first().hover();
  await page.waitForTimeout(800);
  await page.locator('a[href^="/bot/"]').first().click();
  await page.getByText('Preço ao vivo').waitFor();
  await page.getByText('Juntando pontos').waitFor({ state: 'detached', timeout: 30_000 }); // the chart, not its loading state
  await page.waitForTimeout(4_000);
  await glide(page, 700);
  await page.waitForTimeout(2_000);
  await glide(page, 1_500);
  await page.waitForTimeout(2_000);
  await glide(page, 0, 900);
  await page.getByRole('button', { name: 'Pausar' }).click();
  await page.locator('main').getByText('Pausado', { exact: true }).first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(2_000);
  for (const [href, ready] of [['/risk', 'Centro de risco'], ['/fills', 'Fills'], ['/treasury', 'Caixa e Tesouro'], ['/', 'Visão geral']] as const) {
    await page.goto(BASE + href);
    await page.getByRole('heading', { name: ready, exact: true }).waitFor();
    await page.locator('header[data-conn="live"]').waitFor();
    await page.waitForTimeout(href === '/fills' ? 3_400 : 2_600); // fills load from REST
  }
  const v = page.video();
  await ctx.close();
  const src = await v!.path();
  fs.renameSync(src, path.join(OUT, 'tour.webm'));
  fs.rmSync(dir, { recursive: true, force: true });
}

/** webm → mp4 (for the link) and gif (inline in the README). Skipped without ffmpeg. */
function convert() {
  const webm = path.join(OUT, 'tour.webm');
  const ff = (args: string[]) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.warn('ffmpeg not found: kept tour.webm only');
    return;
  }
  ff(['-i', webm, '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', path.join(OUT, 'tour.mp4')]);
  const palette = path.join(OUT, '.palette.png');
  // Kept under ~6 MB: GitHub stops rendering README images around 10 MB.
  const scale = 'fps=6,scale=760:-1:flags=lanczos';
  ff(['-i', webm, '-vf', `${scale},palettegen=max_colors=64:stats_mode=diff`, palette]);
  ff(['-i', webm, '-i', palette, '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, path.join(OUT, 'tour.gif')]);
  fs.rmSync(palette, { force: true });
  fs.rmSync(webm, { force: true });
}

async function main() {
  const browser = await chromium.launch();
  try {
    await screenshots(browser);
    await video(browser);
  } finally {
    await browser.close();
  }
  convert();
  console.log(`media written to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
