import { test, expect } from '@playwright/test';
test('welcome fits a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create a session', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'screenshots/welcome-mobile.png', fullPage: true });
  const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => (el as HTMLElement).getBoundingClientRect().right > innerWidth + 1).map(el => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right })));
  expect(overflow).toEqual([]);
});
test('two guests join, names stay unique, invitations work, navigation and identity persist', async ({ browser }) => {
  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const alice = await aliceContext.newPage(); const bob = await bobContext.newPage();
  try {
  const errors: string[] = []; alice.on('pageerror', error => errors.push(error.message)); bob.on('pageerror', error => errors.push(error.message));
  await alice.goto('/'); await expect(alice.getByRole('button', { name: 'Create a session', exact: true })).toBeEnabled();
  await alice.screenshot({ path: 'screenshots/welcome-desktop.png', fullPage: true });
  await alice.getByLabel('What should we call you?').fill('Alice'); await alice.getByRole('button', { name: 'Create a session', exact: true }).click();
  await expect(alice.getByRole('heading', { name: 'Gather the party.' })).toBeVisible();
  const code = await alice.locator('#header-code').innerText(); expect(code).toMatch(/^[A-F0-9]{15}$/);
  await expect(alice.getByRole('button', { name: 'Start playing' })).toBeDisabled();
  await expect(alice.getByText('Integration coming soon', { exact: true })).toBeVisible();
  await alice.getByRole('button', { name: 'Invite players' }).click();
  await expect(alice.locator('#invite-qr')).toHaveAttribute('src', /^data:image\/png/);
  // Decode the actual QR bitmap, not just its displayed label.
  const qr = await alice.locator('#invite-qr').getAttribute('src');
  const { PNG } = await import('pngjs'); const { default: jsQR } = await import('jsqr');
  const png = PNG.sync.read(Buffer.from(qr!.split(',')[1], 'base64'));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height); expect(decoded?.data).toContain(`?join=${code}`);
  await bob.goto(decoded!.data); await expect(bob.getByRole('button', { name: 'Join the session', exact: true })).toBeEnabled();
  await expect(bob.getByLabel('Session code', { exact: true })).toHaveValue(code);
  await bob.getByLabel('What should we call you?').fill('alice'); await bob.getByRole('button', { name: 'Join the session', exact: true }).click();
  await expect(bob.getByRole('status').filter({ hasText: 'already taken' })).toBeVisible();
  await bob.getByLabel('What should we call you?').fill('Bob'); await bob.getByRole('button', { name: 'Join the session', exact: true }).click();
  await expect(bob.locator('#header-code')).toHaveText(code);
  await expect(alice.locator('#roster')).toContainText('Bob'); await expect(alice.locator('#member-count')).toHaveText('2');
  await bob.getByRole('button', { name: 'My Rewards', exact: true }).click(); await expect(bob.getByRole('heading', { name: 'Your wins belong here.' })).toBeVisible();
  await bob.reload(); await expect(bob.locator('#header-code')).toHaveText(code); await expect(bob.locator('#player-label')).toHaveText('Playing as Bob');
  await bob.getByRole('button', { name: /^Session/ }).click(); await expect(bob.locator('#roster')).toContainText('Alice');
  await bob.screenshot({ path: 'screenshots/session-mobile.png', fullPage: true });
  for (const width of [390, 320]) {
    await bob.setViewportSize({ width, height: 844 });
    expect(await bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const name of ['Current Game', 'My Rewards']) { await bob.getByRole('button', { name, exact: true }).click(); expect(await bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
    await bob.getByRole('button', { name: /^Session/ }).click();
  }
  await bob.getByRole('button', { name: 'Leave session', exact: true }).first().click(); await bob.locator('#confirm-leave').click();
  await expect(bob.getByRole('heading', { name: 'The adventure between adventures.' })).toBeVisible();
  await expect(alice.locator('#member-count')).toHaveText('1');
  await bob.getByRole('tab', { name: 'Create a session', exact: true }).click();
  await bob.getByRole('button', { name: 'Create a session', exact: true }).click();
  await expect(bob.locator('#header-code')).not.toHaveText(code);
  const temporary = await bob.locator('#header-code').innerText();
  await bob.goto(decoded!.data); await expect(bob.getByRole('button', { name: 'Stay in my current session' })).toBeVisible();
  await bob.getByRole('button', { name: 'Stay in my current session' }).click(); await expect(bob.locator('#header-code')).toHaveText(temporary);
  await bob.goto(decoded!.data); await expect(bob.getByRole('button', { name: 'Join the session', exact: true })).toBeEnabled();
  await bob.getByRole('button', { name: 'Join the session', exact: true }).click(); await expect(bob.locator('#header-code')).toHaveText(code);
  await expect(alice.locator('#member-count')).toHaveText('2');
  await bob.getByRole('button', { name: /^Session/ }).click(); await bob.locator('#leave-session').click(); await bob.locator('#confirm-leave').click();
  await expect(bob.getByRole('heading', { name: 'The adventure between adventures.' })).toBeVisible(); await expect(alice.locator('#member-count')).toHaveText('1');
  await alice.screenshot({ path: 'screenshots/session-desktop.png', fullPage: true });
  await bob.setViewportSize({ width: 320, height: 844 }); expect(await bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  } finally { await aliceContext.close(); await bobContext.close(); }
});
