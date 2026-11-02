import { test, expect, expectPerceptibleScreen, mapPresence, visibleControls } from './support/ux.mjs';

test('a username becomes a full-size map', async ({ page, github }, testInfo) => {
  await page.goto('/');
  const go = page.getByRole('button', { name: 'Show my sky' });
  await expect(go).toBeEnabled();
  await page.getByLabel('GitHub username').fill('octo-sky');
  await go.click();
  await expect(page.getByRole('heading', { name: 'The sky of @octo-sky' })).toBeAttached();
  await expect(page.locator('[data-map] >> svg').first()).toBeVisible();
  const map = await mapPresence(page);
  console.log(testInfo.project.name, 'map', map, 'controls', (await visibleControls(page)).length, 'github calls', github.log.length);
  await page.screenshot({ path: testInfo.outputPath('studio.png') });
  await expectPerceptibleScreen(page, { maxControls: 40, minMap: testInfo.project.name.startsWith('mobile') ? 0.3 : 0.5 });
});
