import { test, expect, expectPerceptibleScreen, axeViolations } from './support/ux.mjs';

async function openStudio(page, login = 'octo-sky') {
  await page.goto('/');
  await page.getByLabel('GitHub username').fill(login);
  await page.getByRole('button', { name: 'Show my sky' }).click();
  await expect(page.getByRole('heading', { name: `The sky of @${login}` })).toBeAttached();
  await expect(page.locator('[data-map] >> svg').first()).toBeVisible();
}

// The rendered map, read from the map host's shadow root. The footer stamps
// the render time, which is the one part that may differ between two renders.
const mapSvg = (page) => page.locator('[data-map]').evaluate((el) => (el.shadowRoot?.querySelector('svg')?.outerHTML || '')
  .replace(/<text class="generated-at"[^>]*>[^<]*<\/text>/g, ''));

async function stableMapSvg(page) {
  let last = null;
  await expect.poll(async () => {
    const now = await mapSvg(page);
    const same = now && now === last;
    last = now;
    return same;
  }, { intervals: [100, 200, 300] }).toBe(true);
  return last;
}

// showModal() makes everything outside the sheet inert for people, but the
// perception helpers only skip [inert] subtrees; mirror the browser's modal
// state for the duration of the check so the page behind is not counted.
async function expectPerceptibleDialog(page, options) {
  await page.evaluate(() => {
    for (const el of document.body.children) if (!el.matches('dialog[open]') && !el.inert) { el.inert = true; el.dataset.e2eInert = ''; }
  });
  try { await expectPerceptibleScreen(page, options); }
  finally {
    await page.evaluate(() => { for (const el of document.querySelectorAll('[data-e2e-inert]')) { el.inert = false; delete el.dataset.e2eInert; } });
  }
}

const theme = (page, name) => page.getByRole('radio', { name: new RegExp(`^${name}\\b`) });

async function pickTheme(page, name) {
  const card = theme(page, name);
  await card.click();
  await expect(card).toHaveAttribute('aria-checked', 'true');
}

// The top-bar Save keeps its icon-only form on phones, so match on how it starts.
const topbarSave = (page) => page.getByRole('banner').getByRole('button', { name: /^Save/ });

test('save a design, find it from Home, open it and delete it', async ({ page, github }, testInfo) => {
  await openStudio(page);
  await pickTheme(page, 'Dracula');
  const saved = await stableMapSvg(page);

  await topbarSave(page).click();
  const sheet = page.getByRole('dialog', { name: 'Save this design' });
  await expect(sheet).toBeVisible();
  const name = sheet.getByLabel('Name');
  // On touch screens the heading takes focus so the keyboard doesn't pop up uninvited.
  if (testInfo.project.name.startsWith('mobile')) {
    await expect(sheet.getByRole('heading', { name: 'Save this design' })).toBeFocused();
    await name.focus();
  }
  await expect(name).toBeFocused();
  await expect(name).toHaveValue(/^My sky – \S+ \d+$/);
  await expect(sheet.getByText('Saved in this browser. Download the settings file to keep a backup.')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await expectPerceptibleDialog(page, { primary: 1 });

  // An empty name is explained in place, not silently ignored.
  await name.fill('   ');
  await name.press('Enter');
  await expect(sheet.getByRole('alert')).toHaveText('Give your design a name.');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await name.fill('x'.repeat(81));
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet.getByRole('alert')).toContainText('80 characters or fewer');

  await name.fill('Night');
  await expect(sheet.getByRole('alert')).toHaveCount(0);
  await name.press('Enter');
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Saved “Night”.' })).toBeVisible();

  // Reusing a name says it will replace the earlier one.
  await topbarSave(page).click();
  await expect(sheet).toBeVisible();
  await name.fill('Night');
  await expect(sheet.getByRole('button', { name: 'Replace', exact: true })).toBeVisible();
  await expect(sheet.getByText(/Saving will replace it/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // A fresh visit: Home offers the saved design.
  await page.goto('/');
  const library = page.getByRole('button', { name: 'Your saved designs (1)' });
  await expect(library).toBeVisible();
  await library.click();
  const list = page.getByRole('dialog', { name: 'Your saved designs' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('heading', { name: '@octo-sky' })).toBeVisible();
  await expect(list.getByText('Night', { exact: true })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await expectPerceptibleDialog(page, { primary: 0 });

  await list.getByRole('button', { name: 'Open Night' }).click();
  await expect(list).toBeHidden();
  await expect(page.getByRole('heading', { name: 'The sky of @octo-sky' })).toBeAttached();
  await expect(theme(page, 'Dracula')).toHaveAttribute('aria-checked', 'true');
  expect(await stableMapSvg(page)).toBe(saved);

  // Delete asks once more, then removes the row.
  await page.goto('/');
  await page.getByRole('button', { name: 'Your saved designs (1)' }).click();
  await expect(list).toBeVisible();
  await list.getByRole('button', { name: 'Delete Night' }).click();
  const confirm = list.getByRole('button', { name: 'Confirm delete Night' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeFocused();
  await confirm.click();
  await expect(list.getByText('Night', { exact: true })).toHaveCount(0);
  await expect(list.getByText('Nothing saved yet. Use Save in the Studio to keep a design.')).toBeVisible();
  // Announcements made while a sheet is open go to its own live region.
  await expect(page.locator('dialog[open] [data-announcer]')).toHaveText('Deleted “Night”.');
  expect(await axeViolations(page)).toEqual([]);
});

test('an unconfirmed delete changes its mind after a few seconds', async ({ page, github }) => {
  await openStudio(page);
  await topbarSave(page).click();
  const sheet = page.getByRole('dialog', { name: 'Save this design' });
  await sheet.getByLabel('Name').fill('Keep me');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();

  await page.goto('/');
  await page.getByRole('button', { name: 'Your saved designs (1)' }).click();
  const list = page.getByRole('dialog', { name: 'Your saved designs' });
  await list.getByRole('button', { name: 'Delete Keep me' }).click();
  await expect(list.getByRole('button', { name: 'Confirm delete Keep me' })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Delete Keep me', exact: true })).toBeVisible({ timeout: 6000 });
  await expect(list.getByText('Keep me', { exact: true })).toBeVisible();
});

test('a full browser storage is explained, with the settings file as the way out', async ({ page, github }) => {
  await openStudio(page);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); }; });
  await topbarSave(page).click();
  const sheet = page.getByRole('dialog', { name: 'Save this design' });
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('alert')).toContainText('won’t let us save right now');
  await expect(sheet.getByRole('alert')).toContainText('Get it → Save the settings file');
  expect(await axeViolations(page)).toEqual([]);
  await expectPerceptibleDialog(page, { primary: 1 });
  await sheet.getByRole('button', { name: 'Open Get it' }).click();
  await expect(page.getByRole('dialog', { name: 'Save this design' })).toHaveCount(0);
});

test('thirty saved designs is the limit for one account', async ({ page, github }) => {
  await openStudio(page);
  // A draft exists only after a real edit.
  await pickTheme(page, 'Dracula');
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const key = 'constellation-config-v1:octo-sky';
    const value = JSON.parse(localStorage.getItem(key));
    value.presets = Array.from({ length: 30 }, (_, i) => ({ name: `Design ${i + 1}`, config: value.draft }));
    localStorage.setItem(key, JSON.stringify(value));
  });
  await topbarSave(page).click();
  const sheet = page.getByRole('dialog', { name: 'Save this design' });
  const name = sheet.getByLabel('Name');
  await name.fill('One more');
  await name.press('Enter');
  await expect(sheet.getByRole('alert')).toContainText('up to 30 saved designs');
  // Replacing an existing one is still allowed at the limit.
  await name.fill('Design 3');
  await expect(sheet.getByRole('button', { name: 'Replace', exact: true })).toBeVisible();
  await name.press('Enter');
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Saved “Design 3”.' })).toBeVisible();
});

async function expectDraftRestored(page) {
  await expect(page.getByRole('heading', { name: 'The sky of @octo-sky' })).toBeAttached();
  const toast = page.getByRole('status').filter({ hasText: 'Welcome back' });
  await expect(toast).toBeVisible();
  await expect(theme(page, 'Dracula')).toHaveAttribute('aria-checked', 'true');
  await toast.getByRole('button', { name: 'Start fresh' }).click();
  await expect(theme(page, 'Dracula')).toHaveAttribute('aria-checked', 'false');
}

test('the Studio restores your last design when you come back from Home', async ({ page, github }) => {
  await openStudio(page);
  await pickTheme(page, 'Dracula');
  // The draft is written on a short debounce and on pagehide.
  await page.waitForTimeout(600);
  await page.goto('/');
  await page.getByLabel('GitHub username').fill('octo-sky');
  await page.getByRole('button', { name: 'Show my sky' }).click();
  await expectDraftRestored(page);
});

test('the Studio restores your last design after a reload', async ({ page, github }) => {
  await openStudio(page);
  await pickTheme(page, 'Dracula');
  await page.waitForTimeout(600);
  // The Studio keeps ?user= in the address bar, so this is what a reload opens.
  await page.goto('/?user=octo-sky');
  await expectDraftRestored(page);
});

test('Home has no saved designs button until something is saved', async ({ page, github }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Try an example' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Your saved designs/ })).toHaveCount(0);
});
