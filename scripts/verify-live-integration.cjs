// Uses only normal player UI actions against the deployed services. Creates two
// temporary guests, plays one game, checks rewards, then leaves the test session.
const { chromium, expect } = require('../integrations/between-turns/node_modules/@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const output = path.join(process.env.TEMP, 'rpg-integration-check');
fs.mkdirSync(output, { recursive: true });
const home = 'https://between-turns-paul.web.app/';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const contexts = []; const pages = []; const errors = []; let joined = false;
  try {
    for (let index = 0; index < 2; index++) {
      const context = await browser.newContext({ viewport: { width: index ? 390 : 1440, height: 1000 } });
      // Optional local test transport for Windows browsers that cannot finish
      // Google's TLS requests. Node still verifies HTTPS with the system CA;
      // real Google responses, origins, Auth and App Check remain unchanged.
      if (process.env.RPG_TEST_SYSTEM_CA_RELAY === 'true') await context.route(/^https:\/\/(?:[^/]+\.googleapis\.com|www\.google\.com|www\.gstatic\.com|recaptcha\.google\.com)\//, async route => {
        try {
          const request = route.request(); const headers = { ...request.headers() };
          delete headers['accept-encoding']; delete headers['content-length'];
          const response = await fetch(request.url(), { method: request.method(), headers, body: request.postDataBuffer() || undefined, signal: AbortSignal.timeout(30000) });
          const responseHeaders = Object.fromEntries(response.headers);
          delete responseHeaders['content-encoding']; delete responseHeaders['content-length'];
          await route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) });
        } catch { await route.abort(); }
      });
      contexts.push(context); const page = await context.newPage(); pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
    }
    const [a, b] = pages;
    await a.goto(home);
    await expect(a.locator('#entry-submit')).toBeEnabled({ timeout: 90000 });
    await a.locator('#player-name').fill('Integration Alpha'); await a.locator('#entry-submit').click();
    await expect(a.locator('#header-code')).toHaveText(/^[A-F0-9]{15}$/, { timeout: 60000 });
    const code = await a.locator('#header-code').innerText();
    await b.goto(home + '?join=' + code); await expect(b.locator('#entry-submit')).toBeEnabled({ timeout: 90000 });
    await b.locator('#player-name').fill('Integration Beta'); await b.locator('#entry-submit').click();
    await expect(b.locator('#header-code')).toHaveText(code, { timeout: 60000 }); joined = true;
    await expect(a.locator('#member-count')).toHaveText('2', { timeout: 30000 });
    await a.locator('#start-game').click();
    const bingo = pages.map(page => page.frameLocator('iframe[title="RPG Bingo"]'));
    const rewards = pages.map(page => page.frameLocator('iframe[title="My Rewards"]'));
    for (const frame of bingo) await expect(frame.locator('#embed-card button')).toHaveCount(25, { timeout: 90000 });
    const runUrl = await a.locator('iframe[title="RPG Bingo"]').getAttribute('src');
    await a.getByRole('button', { name: 'My Rewards', exact: true }).click();
    await expect(rewards[0].locator('#embed-message')).toContainText('Alpha', { timeout: 60000 });
    await expect(rewards[0].locator('#embed-retry')).toBeHidden();
    await a.getByRole('button', { name: 'Current Game', exact: true }).click();
    expect(await a.locator('iframe[title="RPG Bingo"]').getAttribute('src')).toBe(runUrl);
    // Reload just the child frame, proving the preserved parent iframe issues a fresh grant.
    const child = a.frames().find(frame => frame.url().startsWith('https://rpg-bingo-paul.web.app/embed'));
    await child.goto(child.url());
    await expect(bingo[0].locator('#embed-card button')).toHaveCount(25, { timeout: 90000 });
    let winningRoll = 0;
    for (let number = 1; number <= 20; number++) {
      const index = (number - 1) % 2;
      const button = bingo[index].getByRole('button', { name: `Record roll ${number}`, exact: true }).first();
      await button.click();
      for (const frame of bingo) await expect(frame.locator('#embed-roll')).toContainText(new RegExp(`\\b${number} rolls`), { timeout: 30000 });
      if ((await bingo[index].locator('#embed-message').innerText()).includes('Reviewing')) { winningRoll = number; break; }
    }
    expect(winningRoll).toBeGreaterThan(0);
    await expect.poll(async () => a.locator('iframe[title="RPG Bingo"]').getAttribute('src'), { timeout: 90000 }).not.toBe(runUrl);
    for (const page of pages) await page.getByRole('button', { name: 'My Rewards', exact: true }).click();
    for (const frame of rewards) {
      await frame.locator('#history-tab').click();
      await expect(frame.locator('.reward-card').first()).toBeVisible({ timeout: 60000 });
      expect(await frame.locator('.reward-card').count()).toBeGreaterThan(0);
      await frame.locator('#inventory-tab').click();
    }
    let owner = -1;
    for (let index = 0; index < rewards.length; index++) if (await rewards[index].getByRole('button', { name: 'Use reward', exact: true }).count()) { owner = index; break; }
    expect(owner).toBeGreaterThanOrEqual(0);
    await rewards[owner].getByRole('button', { name: 'Use reward', exact: true }).first().click();
    await expect(rewards[owner].getByRole('button', { name: 'Undo use', exact: true }).first()).toBeVisible({ timeout: 30000 });
    await pages[owner].reload();
    await expect(pages[owner].locator('#header-code')).toHaveText(code, { timeout: 60000 });
    await pages[owner].getByRole('button', { name: 'My Rewards', exact: true }).click();
    await expect(rewards[owner].getByRole('button', { name: 'Undo use', exact: true }).first()).toBeVisible({ timeout: 60000 });
    await rewards[owner].getByRole('button', { name: 'Undo use', exact: true }).first().click();
    await expect(rewards[owner].getByRole('button', { name: 'Use reward', exact: true }).first()).toBeVisible({ timeout: 30000 });
    for (const width of [390, 320]) {
      await a.setViewportSize({ width, height: 1000 });
      for (const view of ['My Rewards', 'Current Game']) {
        await a.getByRole('button', { name: view, exact: true }).click();
        expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const origin = view === 'Current Game' ? 'https://rpg-bingo-paul.web.app/embed' : 'https://rpg-rewards-paul.web.app/embed';
        const frame = a.frames().find(frame => frame.url().startsWith(origin));
        expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await a.screenshot({ path: path.join(output, `${view.replaceAll(' ', '-')}-${width}.png`), fullPage: true });
      }
    }
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ deployed: home, twoPlayers: true, iframeReload: true, navigationPreservesGame: true, winningRoll, rewards: true, consumptionPersists: true, phoneWidths: [390, 320], errors }));
  } catch (error) {
    for (let i = 0; i < pages.length; i++) { try { await pages[i].screenshot({ path: path.join(output, `failure-${i}.png`), fullPage: true }); } catch {} }
    throw error;
  } finally {
    if (joined) for (const page of pages) {
      try { await page.getByRole('button', { name: /^Session/ }).click(); await page.locator('#leave-session').click(); await page.locator('#confirm-leave').click(); await expect(page.locator('#welcome')).toBeVisible({ timeout: 30000 }); } catch {}
    }
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
