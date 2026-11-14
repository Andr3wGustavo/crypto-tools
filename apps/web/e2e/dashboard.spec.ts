import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { hotp, totpCounter } from '../../api/src/auth/totp';
import { DEV_TOTP_KEY, devWallet } from '../../api/src/dev/server';

/**
 * The dashboard, end to end: real API, real engine, a browser.
 * - Sign-in through the actual UI with a stand-in Phantom provider whose signatures come from
 *   the dev wallet key held in this Node process (the page never sees a key).
 * - Every page renders with live data and without console errors. CSP violations surface as
 *   console errors, so this also proves the strict CSP does not break the app.
 * - Pause is one click; resume needs the TOTP code; both reach the engine and come back live.
 */
const SHOTS = path.resolve(import.meta.dirname, '../../../test-results/screens');
fs.mkdirSync(SHOTS, { recursive: true });
const wallet = devWallet();

async function withPhantom(page: Page) {
  await page.exposeFunction('__devSign', (b64: string) => Buffer.from(wallet.sign(Buffer.from(b64, 'base64').toString('utf8'))).toString('base64'));
  await page.addInitScript((address: string) => {
    const w = window as unknown as { phantom: unknown; __devSign: (b64: string) => Promise<string> };
    w.phantom = {
      solana: {
        isPhantom: true,
        connect: async () => ({ publicKey: { toString: () => address } }),
        disconnect: async () => undefined,
        signMessage: async (bytes: Uint8Array) => {
          let s = '';
          for (const b of bytes) s += String.fromCharCode(b);
          const sig = await w.__devSign(btoa(s));
          return { signature: Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)) };
        },
      },
    };
  }, wallet.address);
}

function consoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    // 401 on /auth/me before sign-in is the expected "not signed in" probe.
    if (m.type() === 'error' && !/401 \(Unauthorized\)/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function signIn(page: Page) {
  await withPhantom(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Conectar Phantom' }).click();
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  await expect(page.locator('header[data-conn="live"]')).toBeVisible({ timeout: 15_000 });
}

/** Mobile-first: no page may scroll sideways. */
async function noHorizontalScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `page is ${sw}px wide in a ${iw}px viewport`).toBeLessThanOrEqual(iw);
}
const shot = async (page: Page, name: string) => {
  await noHorizontalScroll(page);
  await page.screenshot({ path: path.join(SHOTS, `${test.info().project.name}-${name}.png`), fullPage: true });
};

test('without a wallet: the sign-in page explains how to get one, and the data stays locked', async ({ page, request }) => {
  const errors = consoleErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Console do operador' })).toBeVisible();
  await expect(page.getByText('Phantom não encontrada.')).toBeVisible({ timeout: 6_000 });
  await expect(page.getByText('Sua sessão expirou')).toHaveCount(0); // a first visit is not an expiry
  await shot(page, '00-login');
  expect((await request.get('/bots')).status()).toBe(401);
  expect(errors).toEqual([]);
});

test('sign in with Phantom → every page renders live data, no console errors', async ({ page }) => {
  test.setTimeout(150_000); // nine full-page screenshots at mobile pixel density
  const errors = consoleErrors(page);
  await signIn(page);
  await expect(page.locator('a[href^="/bot/"]').first()).toBeVisible();
  await page.waitForTimeout(1_500); // sparklines fill from the series
  await shot(page, '01-overview');

  await page.locator('a[href^="/bot/"]').first().click();
  await expect(page.getByText('Preço ao vivo')).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.getByText('Cascata de PnL')).toBeVisible();
  await page.waitForTimeout(1_000);
  await shot(page, '02-bot');

  for (const [href, heading, name] of [
    ['/risk', 'Centro de risco', '03-risk'], ['/fills', 'Fills', '04-fills'], ['/logs', 'Logs', '05-logs'],
    ['/system', 'Sistema', '06-system'], ['/treasury', 'Caixa e Tesouro', '07-treasury'], ['/settings', 'Ajustes', '08-settings'],
  ] as const) {
    await page.goto(href);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await page.waitForTimeout(700);
    await shot(page, name);
  }
  await expect(page.getByText('login', { exact: true }).first()).toBeVisible(); // audit log shows our sign-in
  expect(errors).toEqual([]);
});

test('pause is one click; resume needs the 2FA code; the engine applies both', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one engine: run the command flow once');
  await signIn(page);
  await page.locator('a[href^="/bot/"]').first().click();
  const badge = page.locator('main').getByText(/^\s*(Cotando|Ativo, sem cotar|Pausado)\s*$/).first();
  await expect(badge).toBeVisible();

  await page.getByRole('button', { name: 'Pausar' }).click();
  await expect(page.locator('main').getByText('Pausado', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /Retomar/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Código 2FA').fill('000000');
  await dialog.getByRole('button', { name: 'Confirmar' }).click();
  await expect(dialog.getByRole('alert')).toContainText('inválido');
  await shot(page, '09-totp');

  await dialog.getByLabel('Código 2FA').fill(hotp(DEV_TOTP_KEY, totpCounter(Date.now())));
  await dialog.getByRole('button', { name: 'Confirmar' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('main').getByText(/^\s*(Cotando|Ativo, sem cotar)\s*$/).first()).toBeVisible({ timeout: 10_000 });

  await page.goto('/logs');
  await page.getByPlaceholder('Buscar…').fill('retomar');
  await expect(page.getByText(/retomar \(aplicado\)/).first()).toBeVisible();
});
