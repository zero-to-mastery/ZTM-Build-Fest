// Regressions found by the first-time-visitor walkthroughs and the code
// review of the rebuilt Studio. Each test fails on the behaviour it fixed.
import { test, expect } from './support/ux.mjs';

async function openStudio(page, login = 'octo-sky') {
  await page.goto('/');
  await page.getByLabel('GitHub username').fill(login);
  await page.getByRole('button', { name: 'Show my sky' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`@${login}`) })).toBeAttached();
  await expect(page.locator('[data-map] svg').first()).toBeVisible();
}
const mapSvg = (page) => page.evaluate(() => document.querySelector('[data-map]')?.shadowRoot?.querySelector('svg')?.outerHTML || '');
const lastBackground = (svg) => [...svg.matchAll(/--sky-background:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase()).at(-1);
const starCount = (page) => page.evaluate(() => document.querySelector('[data-map]')?.shadowRoot?.querySelectorAll('.star[data-repo]').length || 0);
const draftTheme = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('constellation-config-v1:octo-sky') || 'null')?.draft?.visualTheme ?? null);

test('changing glow keeps the chosen theme’s colours', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('radio', { name: /Dracula/ }).click();
  await expect.poll(async () => lastBackground(await mapSvg(page))).toBe('#282a36');
  const glow = page.getByRole('slider', { name: 'Glow' });
  await glow.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => lastBackground(await mapSvg(page))).toBe('#282a36');
  await expect(page.getByRole('radio', { name: /Dracula/ })).toHaveAttribute('aria-checked', 'true');
});

test('custom CSS from Fine-tune reaches the map; unsafe CSS is explained', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('button', { name: 'Fine-tune every setting' }).click();
  const dialog = page.getByRole('dialog', { name: 'Fine-tune' });
  await dialog.getByLabel('Search settings').fill('custom css');
  const css = dialog.getByLabel('Custom CSS');
  await css.fill('.repo-label { letter-spacing: 3px }');
  await css.blur();
  await expect.poll(() => mapSvg(page)).toContain('letter-spacing: 3px');
  await css.fill('.x { background: url(https://example.com/a.png) }');
  await css.blur();
  await expect(page.getByRole('alert').filter({ hasText: 'self-contained' })).toBeVisible();
  await expect.poll(() => mapSvg(page)).not.toContain('example.com');
});

test('Shuffle keeps every project star and shows one toast', async ({ page }) => {
  await openStudio(page);
  const stars = await starCount(page);
  expect(stars).toBe(16);
  const shuffle = page.getByRole('button', { name: /Shuffle/ }).first();
  for (let i = 0; i < 15; i++) {
    await shuffle.click();
    await expect.poll(() => starCount(page), { message: `shuffle ${i + 1}` }).toBe(16);
    const svg = await mapSvg(page);
    expect(svg).not.toMatch(/temporal|0x[0-9a-f]{4}/i);
  }
  await expect(page.getByRole('status').filter({ hasText: /Shuffled 15 times/ })).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: /Shuffled|New colours/ })).toHaveCount(1);
});

test('an untouched design is not saved as a draft', async ({ page }) => {
  await openStudio(page);
  await page.waitForTimeout(700);
  await page.goto('/?user=octo-sky');
  await expect(page.getByRole('heading', { name: /@octo-sky/ })).toBeAttached();
  await page.waitForTimeout(700);
  expect(await draftTheme(page)).toBeNull();
  await expect(page.getByText('Welcome back')).toHaveCount(0);
});

test('opening a share link does not overwrite your draft', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openStudio(page);
  // Make a share link of a Synthwave design…
  await page.getByRole('radio', { name: /Synthwave/ }).click();
  await page.getByRole('button', { name: 'Get it' }).click();
  await page.getByRole('button', { name: /Share a link/ }).click();
  const link = await page.getByRole('dialog').getByRole('textbox').inputValue();
  await page.keyboard.press('Escape');
  // …then keep working on a Dracula design, which becomes the draft.
  await page.getByRole('radio', { name: /Dracula/ }).click();
  await expect.poll(() => draftTheme(page)).toBe('dracula');
  const shared = new URL(link);
  await page.goto(`/${shared.search}`);
  await expect(page.getByRole('radio', { name: /Synthwave/ })).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(700);
  expect(await draftTheme(page)).toBe('dracula');
  await page.goto('/?user=octo-sky');
  await expect(page.getByRole('radio', { name: /Dracula/ })).toHaveAttribute('aria-checked', 'true');
});

test('Ctrl+Z works while a slider or switch has focus', async ({ page }) => {
  await openStudio(page);
  const before = await mapSvg(page);
  const glow = page.getByRole('slider', { name: 'Glow' });
  await glow.focus();
  await page.keyboard.press('End');
  await expect.poll(() => mapSvg(page)).not.toBe(before);
  await expect(glow).toBeFocused();
  await page.keyboard.press('Control+z');
  await expect.poll(() => mapSvg(page)).toBe(before);
});

test('the tab title says where you are', async ({ page }) => {
  await page.goto('/');
  const home = await page.title();
  await page.getByLabel('GitHub username').fill('octo-sky');
  await page.getByRole('button', { name: 'Show my sky' }).click();
  await expect(page).toHaveTitle('@octo-sky’s sky — Constellation');
  await page.getByRole('button', { name: 'Get it' }).click();
  await expect(page).toHaveTitle('Get your map — @octo-sky’s sky — Constellation');
  await page.keyboard.press('Escape');
  await expect(page).toHaveTitle('@octo-sky’s sky — Constellation');
  await page.getByRole('button', { name: /Choose a different account/ }).click();
  await expect(page).toHaveTitle(home);
});

test('Fine-tune search understands everyday spellings', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('button', { name: 'Fine-tune every setting' }).click();
  const dialog = page.getByRole('dialog', { name: 'Fine-tune' });
  await dialog.getByLabel('Search settings').fill('color');
  await expect(dialog.getByLabel('Sky colour')).toBeVisible();
  await expect(dialog.getByText('No settings match').filter({ visible: true })).toHaveCount(0);
});

test('toasts are cleared when you leave the Studio', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('button', { name: /Shuffle/ }).first().click();
  await expect(page.getByRole('status').filter({ hasText: /New colours/ })).toBeVisible();
  await page.getByRole('button', { name: /Choose a different account/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /New colours/ })).toHaveCount(0);
});

test('the default theme comes first and the adaptive theme has a plain name', async ({ page }) => {
  await openStudio(page);
  const names = await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio').evaluateAll((cards) => cards.map((card) => card.querySelector('.gallery-name')?.textContent));
  expect(names[0]).toBe('Deep Space');
  expect(names).toContain('Adaptive');
  expect(names).not.toContain('Mnix');
});

test('signed in, turning on activity fetches recent activity once', async ({ page, github }) => {
  test.skip(test.info().project.name !== 'desktop', 'one project is enough for a data check');
  await page.route('https://api.github.com/user', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ login: 'octo-sky', id: 1 }) }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Personal access token').fill('test-token');
  await page.getByRole('dialog').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /@octo-sky/ })).toBeAttached();
  const before = github.log.filter((path) => /events/.test(path)).length;
  await page.getByRole('button', { name: 'Fine-tune every setting' }).click();
  const dialog = page.getByRole('dialog', { name: 'Fine-tune' });
  await dialog.getByLabel('Search settings').fill('activity');
  await dialog.getByLabel('Highlight recent activity').selectOption('glow');
  await expect.poll(() => github.log.filter((path) => /events/.test(path)).length).toBe(before + 1);
  await dialog.getByLabel('Highlight recent activity').selectOption('pulse');
  await page.waitForTimeout(500);
  expect(github.log.filter((path) => /events/.test(path)).length).toBe(before + 1);
});

test('see-through themes are shown on the page background, not the dark stage', async ({ page }) => {
  await openStudio(page);
  const stage = page.getByRole('region', { name: /The sky of @octo-sky/ });
  const backgroundOf = (locator) => locator.evaluate((el) => getComputedStyle(el).backgroundColor);
  const darkStage = await backgroundOf(stage);
  await page.getByRole('radio', { name: 'Adaptive', exact: true }).click();
  await expect.poll(() => backgroundOf(stage)).toBe(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
  await page.getByRole('radio', { name: 'Deep Space', exact: true }).click();
  await expect.poll(() => backgroundOf(stage)).toBe(darkStage);
});

test('new maps have round orbits; Wide is one click away and undoable', async ({ page }) => {
  await openStudio(page);
  const ringScale = async () => (await mapSvg(page)).match(/class="identity-ring"[^>]*scale\(([\d.]+) ([\d.]+)\)/)?.slice(1).map(Number);
  const [x, y] = await ringScale();
  expect(x).toBeCloseTo(y, 5);
  await page.getByRole('tab', { name: 'Layout', exact: true }).click();
  const shape = page.getByRole('group', { name: 'Orbit shape' });
  await expect(shape.getByRole('radio', { name: 'Round' })).toBeChecked();
  await shape.getByRole('radio', { name: 'Wide' }).click();
  await expect.poll(async () => { const [sx, sy] = await ringScale(); return sx / sy; }).toBeGreaterThan(1.8);
  await page.getByRole('banner').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => { const [sx, sy] = await ringScale(); return sx / sy; }).toBeCloseTo(1, 5);
});

test('new skies move gently; Still and Lively change it; reduced motion keeps it still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openStudio(page);
  const motion = () => page.evaluate(() => {
    const root = document.querySelector('[data-map]')?.shadowRoot;
    const svg = root?.querySelector('svg');
    return {
      smil: svg?.querySelectorAll('animate, animateTransform').length || 0,
      // Floating stars animate the star itself; spinning rings animate ring arcs.
      floating: [...(svg?.querySelectorAll('.star animate, .repository animate') || [])].length,
      running: svg ? svg.animationsPaused() === false : false,
    };
  });
  const gentle = await motion();
  expect(gentle.smil).toBeGreaterThan(0);
  expect(gentle.running).toBe(true);
  // Rings turning behind Galaxy are decoration: stars can still be dragged.
  await expect(page.locator('[data-map] .repository').first()).toHaveClass(/draggable/);

  await page.getByRole('tab', { name: 'Details', exact: true }).click();
  const level = page.getByRole('group', { name: 'Motion' });
  await expect(level.getByRole('radio', { name: 'Gentle' })).toBeChecked();
  await level.getByRole('radio', { name: 'Still' }).click();
  await expect.poll(async () => (await motion()).smil).toBe(0);
  await level.getByRole('radio', { name: 'Lively' }).click();
  await expect.poll(async () => (await motion()).floating).toBeGreaterThan(0);

  // Reduced motion: the same Lively design shows no ring or star motion.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.locator('[data-map] svg').first()).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Details', exact: true })).toBeVisible();
  expect(await page.evaluate(() => {
    const svg = document.querySelector('[data-map]')?.shadowRoot?.querySelector('svg');
    return svg ? [...svg.querySelectorAll('animate, animateTransform')].filter((a) => a.closest('.ring-motion-active, .repository')).length : -1;
  })).toBe(0);
});
