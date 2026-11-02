// How it works: a page anyone can read in a minute, with a live example sky
// drawn by the Studio's own engine and no GitHub requests.
import { test, expect, expectPerceptibleScreen, axeViolations } from './support/ux.mjs';

test.beforeEach(async ({ github }) => { void github; });

const sky = (page) => page.getByRole('img', { name: /^An example sky/ });

test('Home links to the page and credits its maker', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('contentinfo');
  await expect(footer).toContainText(/Made with ♥?love by mnichols08/);
  await expect(footer.getByRole('link', { name: 'mnichols08' })).toHaveAttribute('href', 'https://github.com/mnichols08');
  await footer.getByRole('link', { name: 'How it works' }).click();
  await expect(page).toHaveURL(/\/how-it-works\.html$/);
  await expect(page.getByRole('heading', { level: 1, name: 'How it works' })).toBeVisible();
});

test('the page explains the three steps and draws a live example sky', async ({ page, github }) => {
  await page.goto('/how-it-works.html');
  await expect(sky(page)).toBeVisible();
  await expect(page.locator('#demo-fallback')).toHaveCount(0);
  for (const step of ['Type a GitHub username', 'Make it yours', 'Get it']) {
    await expect(page.getByRole('heading', { level: 3, name: step })).toBeVisible();
  }
  await expect(page.getByRole('contentinfo')).toContainText(/Made with ♥?love by mnichols08/);
  expect(github.log, 'the example never asks GitHub').toEqual([]);
  expect(await axeViolations(page)).toEqual([]);
  await expectPerceptibleScreen(page, { primary: 1 });
});

test('switching layout and theme redraws the example and says so', async ({ page }) => {
  await page.goto('/how-it-works.html');
  await expect(sky(page)).toBeVisible();
  const first = await sky(page).evaluate((svg) => svg.outerHTML);
  await page.getByRole('radio', { name: 'Rings' }).check();
  await expect(page.getByRole('status')).toHaveText('Showing the Rings layout.');
  await expect(sky(page)).toHaveAttribute('aria-label', /Rings layout/);
  const rings = await sky(page).evaluate((svg) => svg.outerHTML);
  expect(rings).not.toBe(first);
  await page.getByRole('radio', { name: 'Synthwave' }).check();
  await expect(page.getByRole('status')).toHaveText('Showing the Synthwave theme.');
  await expect(sky(page)).toHaveAttribute('aria-label', /Rings layout, Synthwave theme/);
  expect(await sky(page).evaluate((svg) => svg.outerHTML)).not.toBe(rings);
  // Keyboard: arrow keys move through a radio group.
  await page.getByRole('radio', { name: 'Synthwave' }).press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Solarized' })).toBeChecked();
});

test('without the map engine the page still reads and points to the Studio', async ({ page }) => {
  // Stands in for a browser that blocks WebAssembly: the example never draws.
  await page.route('**/src/app/how-it-works.mjs', (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.goto('/how-it-works.html');
  await expect(page.locator('#demo-fallback')).toBeVisible();
  await expect(page.locator('#demo-controls')).toBeHidden();
  await expect(page.getByRole('heading', { level: 2, name: 'Reading the map' })).toBeVisible();
});

test('Home and How it works invite a star on GitHub, in a new tab', async ({ page }) => {
  for (const path of ['/', '/how-it-works.html']) {
    await page.goto(path);
    const star = page.getByRole('contentinfo').getByRole('link', { name: 'Star on GitHub (opens in a new tab)' });
    await expect(star).toBeVisible();
    await expect(star).toHaveAttribute('href', 'https://github.com/mnichols08/constellation');
    await expect(star).toHaveAttribute('target', '_blank');
    await expect(star).toHaveAttribute('rel', /noopener/);
  }
  // The page's closing call to action offers it beside Make my sky.
  await expect(page.getByRole('main').getByRole('link', { name: 'Star on GitHub (opens in a new tab)' })).toBeVisible();
  // Clicking opens GitHub in a new tab and keeps this one where it was.
  await page.route('https://github.com/mnichols08/constellation', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'repository' }));
  const [tab] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('contentinfo').getByRole('link', { name: /Star on GitHub/ }).click()]);
  await tab.waitForLoadState();
  expect(tab.url()).toBe('https://github.com/mnichols08/constellation');
  await expect(page).toHaveURL(/how-it-works\.html$/);
});
