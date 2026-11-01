import { test, expect } from '@playwright/test';
import jsQR from 'jsqr';

test('guest identity, shared membership, game handoff, rewards, undo and phone layouts', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('status')).toBeEmpty({ timeout: 30_000 });
  await page.getByLabel('Your player name').fill('Paul');
  await page.getByLabel('Session name', { exact: true }).fill('The Drift crew');
  await page.getByLabel('Shared', { exact: true }).check();
  await page.getByRole('button', { name: 'Create session' }).click();
  await expect(page.getByRole('heading', { name: 'The Drift crew', exact: true })).toBeVisible();
  const code = await page.locator('#copy-code strong').innerText();
  const qr = page.getByRole('img', { name: 'QR code to join The Drift crew' });
  await expect(qr).toBeVisible();
  // Decode the actual rendered image so this verifies a scannable invitation, not just a link.
  const pixels = await qr.evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    const canvas = document.createElement('canvas');
    canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(element, 0, 0);
    return { data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data), width: canvas.width, height: canvas.height };
  });
  const decoded = jsQR(Uint8ClampedArray.from(pixels.data), pixels.width, pixels.height);
  expect(decoded).not.toBeNull();
  const invitation = decoded!.data;
  expect(invitation).toBe(`http://127.0.0.1:5173/?join=${code}`);
  await expect(page.getByRole('link', { name: 'Open join link', exact: true })).toHaveAttribute('href', invitation);
  const friendContext = await browser.newContext();
  const friend = await friendContext.newPage();
  try {
    await friend.goto(invitation);
    await expect(friend.getByRole('status')).toContainText('Party invitation ready');
    await expect(friend.getByLabel('Join code', { exact: true })).toHaveValue(code);
    await friend.getByLabel('Your player name').fill('Zintra');
    await friend.getByRole('button', { name: 'Join session', exact: true }).click();
    await expect(friend.getByRole('heading', { name: 'The Drift crew', exact: true })).toBeVisible();
    await expect(friend).toHaveURL('http://127.0.0.1:5173/');
    await page.goto('http://127.0.0.1:5174/connect');
    await expect(page.getByRole('button', { name: 'Continue to game' })).toBeEnabled({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Continue to game' }).click();
    await expect(page).toHaveURL('http://127.0.0.1:5174/');
    await expect(page.getByText('Connected as')).toContainText('Paul');
    await page.getByRole('button', { name: 'Draw reward' }).click();
    const offerName = await page.locator('section h2').innerText();
    await page.getByRole('button', { name: 'Record a win' }).click();
    await page.getByRole('button', { name: 'Record a win' }).click();
    await page.getByRole('link', { name: 'Open RPG Rewards' }).click();
    await expect(page.locator('.reward-card')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.reward-card h3')).toHaveText(offerName);
    await page.getByRole('button', { name: 'Use reward', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo use' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Undo use' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Undo use' }).click();
    await expect(page.getByRole('button', { name: 'Use reward', exact: true })).toBeVisible();
    await expect(friend.locator('.reward-card')).toHaveCount(0);
    await friend.getByRole('tab', { name: 'Session winners' }).click();
    await expect(friend.locator('.reward-card')).toHaveCount(1, { timeout: 15_000 });
    await expect(friend.locator('.reward-card')).toContainText('Paul');
    await expect(friend.getByRole('button', { name: 'Use reward' })).toHaveCount(0);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(page.getByRole('button', { name: 'Use reward', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      expect((await page.locator('.reward-info').boundingBox())!.width).toBeGreaterThan(150);
      await page.screenshot({ path: `test-results/rewards-${width}.png`, fullPage: true });
    }
    // Switching sessions preserves membership and keeps both reward pools separate.
    await page.locator('#session-forms summary').click();
    await page.getByLabel('Session name', { exact: true }).fill('Solo side quest');
    await page.getByLabel('Solo', { exact: true }).check();
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect(page.getByRole('heading', { name: 'Solo side quest', exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: /QR code to join/ })).toHaveCount(0);
    await expect(page.locator('.reward-card')).toHaveCount(0);
    await page.getByLabel('Current session', { exact: true }).selectOption({ label: 'The Drift crew' });
    await expect(page.locator('.reward-card')).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally { await friendContext.close(); }
});
