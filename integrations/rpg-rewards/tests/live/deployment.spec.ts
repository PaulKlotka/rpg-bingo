import { test, expect } from '@playwright/test';
import jsQR from 'jsqr';

test('deployed guest identity, App Check, QR membership and API access controls', async ({ page, browser, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('status')).toBeEmpty();
  await page.getByLabel('Your player name').fill('Deployment check host');
  const name = `Deployment check ${new Date().toISOString()}`;
  await page.getByLabel('Session name', { exact: true }).fill(name);
  await page.getByLabel('Shared', { exact: true }).check();
  await page.getByRole('button', { name: 'Create session' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const image = page.getByRole('img', { name: `QR code to join ${name}`, exact: true });
  const pixels = await image.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(img, 0, 0);
    return { data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data), width: canvas.width, height: canvas.height };
  });
  const qr = jsQR(Uint8ClampedArray.from(pixels.data), pixels.width, pixels.height);
  expect(qr).not.toBeNull();
  expect(new URL(qr!.data).origin).toBe('https://rpg-rewards-paul.web.app');
  const guest = await browser.newContext();
  try {
    const guestPage = await guest.newPage();
    await guestPage.goto(qr!.data);
    await expect(guestPage.getByRole('status')).toContainText('Party invitation ready');
    await guestPage.getByLabel('Your player name').fill('Deployment check guest');
    await guestPage.getByRole('button', { name: 'Join session', exact: true }).click();
    await expect(guestPage.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(guestPage.locator('.session-heading .eyebrow')).toContainText('2 PLAYERS');
    await guestPage.reload();
    await expect(guestPage.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(guestPage.locator('.session-heading .muted')).toContainText('Deployment check guest');
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(image).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: 'test-results/live-rewards-phone.png', fullPage: true });
  } finally { await guest.close(); }
  const api = 'https://us-central1-rpg-rewards-paul.cloudfunctions.net';
  expect((await request.post(`${api}/gameApi`, { data: { action: 'draw' } })).status()).toBe(403);
  expect((await request.post(`${api}/playerCommand`, { data: { data: { action: 'list' } } })).status()).toBe(401);
  expect(errors).toEqual([]);
});
