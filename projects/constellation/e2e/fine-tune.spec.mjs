import { test, expect, expectPerceptibleScreen, axeViolations, overlappingControls } from './support/ux.mjs';

async function openStudio(page) {
  await page.goto('/');
  await page.getByLabel('GitHub username').fill('octo-sky');
  await page.getByRole('button', { name: 'Show my sky' }).click();
  await expect(page.getByRole('heading', { name: 'The sky of @octo-sky' })).toBeAttached();
  await expect(page.locator('[data-map] svg').first()).toBeVisible();
}

async function openFineTune(page) {
  await page.getByRole('button', { name: 'Fine-tune every setting' }).click();
  const dialog = page.getByRole('dialog', { name: 'Fine-tune' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Fine-tune' })).toBeVisible();
  return dialog;
}

const mapSvg = (page) => page.locator('[data-map] svg').first().evaluate((svg) => svg.outerHTML);

// Requesting `github` installs the stub before the first navigation.
test.beforeEach(async ({ page, github }) => { void github;
  await openStudio(page);
});

test('Fine-tune lists every setting and passes the perception and axe checks', async ({ page }, testInfo) => {
  const dialog = await openFineTune(page);
  // Essential settings live here too.
  await expect(dialog.getByLabel('Glow', { exact: true })).toBeAttached();
  await expect(dialog.getByRole('switch', { name: 'Include forks' })).toBeAttached();
  await expect(dialog.getByLabel('Theme', { exact: true })).toBeAttached();
  await page.screenshot({ path: testInfo.outputPath('fine-tune.png') });
  expect(await axeViolations(page)).toEqual([]);
  await expectPerceptibleScreen(page, { maxControls: 200, primary: 0 });

  await dialog.getByText('Edit all settings as JSON').click();
  expect(await axeViolations(page)).toEqual([]);

  // The expert surface still reflows at 320 px: the sheet fits and nothing in it scrolls sideways.
  // (Whole-page scroll is the Studio's own budget, checked by its spec.)
  await page.setViewportSize({ width: 320, height: 640 });
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(await dialog.evaluate((sheet) => [...sheet.querySelectorAll('*')]
    .filter((el) => !el.closest('[hidden]') && !['TEXTAREA', 'SELECT'].includes(el.tagName) && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible')
    .map((el) => el.tagName))).toEqual([]);
  expect(await overlappingControls(page)).toEqual([]);
});

test('search filters live, keeps focus, and has an empty state', async ({ page }, testInfo) => {
  const dialog = await openFineTune(page);
  const search = dialog.getByLabel('Search settings');
  // On touch screens the heading takes focus so the keyboard doesn't pop up uninvited.
  if (testInfo.project.name.startsWith('mobile')) {
    await expect(dialog.getByRole('heading', { name: 'Fine-tune' })).toBeFocused();
    await search.focus();
  }
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute('placeholder', 'Search, e.g. glow, forks, title');

  await search.pressSequentially('glow');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('glow');
  await expect(dialog.getByLabel('Glow', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('switch', { name: 'Include forks' })).toBeHidden();

  await search.fill('zzzz');
  await expect(dialog.getByText('No settings match “zzzz”.')).toBeVisible();
  await expect(dialog.getByLabel('Glow', { exact: true })).toBeHidden();
  await expectPerceptibleScreen(page, { primary: 0 });
  await dialog.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  // The sheet's live region may still hold the announcement; only what is seen matters.
  await expect(dialog.getByText('No settings match').filter({ visible: true })).toHaveCount(0);
  await expect(dialog.getByRole('switch', { name: 'Include forks' })).toBeVisible();
  await expect(dialog.getByLabel('Glow', { exact: true })).toBeVisible();
});

test('a change here redraws the map, is undoable, and Ctrl+Z works after closing', async ({ page, github }) => {
  const before = await mapSvg(page);
  const undo = page.getByRole('banner').getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeDisabled();
  const calls = github.log.length;

  const dialog = await openFineTune(page);
  await dialog.getByLabel('Search settings').fill('line thickness');
  const thickness = dialog.getByLabel('Line thickness', { exact: true });
  await thickness.fill('2.5');
  await expect.poll(() => mapSvg(page)).not.toBe(before);
  expect(github.log.length, 'no GitHub requests for a presentation change').toBe(calls);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  // The Studio is inert behind the modal, so check the top bar once it is back.
  await expect(undo).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Fine-tune every setting' })).toBeFocused();
  await page.keyboard.press('Control+z');
  await expect.poll(() => mapSvg(page)).toBe(before);
});

test('JSON: invalid input shows an error and changes nothing; valid input applies', async ({ page }) => {
  const dialog = await openFineTune(page);
  await dialog.getByText('Edit all settings as JSON').click();
  const area = dialog.getByLabel('Settings as JSON');
  await expect(area).toBeVisible();
  const original = JSON.parse(await area.inputValue());
  expect(original).toBeTruthy();
  const before = await mapSvg(page);

  await area.fill('{ "visualTheme": ');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('isn’t valid JSON');
  await expect(area).toHaveValue('{ "visualTheme": ');
  expect(await mapSvg(page)).toBe(before);

  await area.fill(JSON.stringify({ ...original, visualTheme: 'dracula' }, null, 2));
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(alert).toBeHidden();
  await expect.poll(() => mapSvg(page)).not.toBe(before);
  await expect(dialog.getByLabel('Theme', { exact: true })).toHaveValue('dracula');
  expect(JSON.parse(await area.inputValue()).visualTheme).toBe('dracula');

  // Reset refills from the current settings.
  await area.fill('nonsense');
  await dialog.getByRole('button', { name: 'Reset' }).click();
  expect(JSON.parse(await area.inputValue()).visualTheme).toBe('dracula');
});

test('sign-in-only settings are locked in public mode', async ({ page }) => {
  const dialog = await openFineTune(page);
  await dialog.getByLabel('Search settings').fill('when you usually code');
  const rhythm = dialog.getByRole('switch', { name: 'Show when you usually code' });
  await expect(rhythm).toBeVisible();
  await expect(rhythm).toBeDisabled();
  await expect(dialog.getByText('Sign in with GitHub to use this.').filter({ visible: true })).toHaveCount(1);

  await dialog.getByLabel('Search settings').fill('');
  await expect(dialog.getByLabel('Highlight recent activity')).toBeDisabled();
});

test('start over asks twice, then Undo brings the design back', async ({ page }) => {
  const dialog = await openFineTune(page);
  await dialog.getByLabel('Search settings').fill('glow');
  await dialog.getByLabel('Glow', { exact: true }).fill('5');
  await dialog.getByLabel('Search settings').fill('');
  const changed = await mapSvg(page);

  const startOver = dialog.getByRole('button', { name: 'Start over with the default design' });
  await startOver.click();
  await expect(dialog.getByRole('button', { name: 'Click again to start over' })).toBeVisible();
  expect(await mapSvg(page)).toBe(changed);
  await dialog.getByRole('button', { name: 'Click again to start over' }).click();
  await expect(dialog.getByLabel('Glow', { exact: true })).not.toHaveValue('5');
  await expect(page.getByText('Undo brings yours back')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start over with the default design' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.keyboard.press('Control+z');
  await expect.poll(() => mapSvg(page)).toBe(changed);
});
