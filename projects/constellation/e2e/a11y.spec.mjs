// Accessibility is correctness: axe on every screen state, a keyboard-only
// journey where focus is always visible, 320px reflow, forced colours and
// reduced motion.
import { test, expect, axeViolations, blankControls, hasHorizontalScroll } from './support/ux.mjs';
import { encodeShare } from '../src/share-link.mjs';

// The GitHub stub is installed only when a test asks for the fixture.
test.beforeEach(async ({ github }) => { void github; });

async function openStudio(page, login = 'octo-sky') {
  await page.goto('/');
  await page.getByLabel('GitHub username').fill(login);
  await page.getByRole('button', { name: 'Show my sky' }).click();
  await expect(page.getByRole('heading', { name: `The sky of @${login}` })).toBeAttached();
  await expect(page.locator('[data-map] svg').first()).toBeVisible();
}

const tab = (page, name) => page.getByRole('tab', { name, exact: true });
const mapSvg = (page) => page.evaluate(() => document.querySelector('[data-map]')?.shadowRoot?.querySelector('svg')?.outerHTML || '');

/**
 * Where focus is (through the map's shadow root) and whether a sighted
 * keyboard user can see it: an outline, or for stars the focus stroke the map
 * draws on the star itself.
 */
function focusState(page) {
  return page.evaluate(() => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { lost: true, visible: false, name: '<body>' };
    const cs = getComputedStyle(el);
    let visible = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
    const star = el.querySelector?.(':scope > .star');
    if (!visible && star) {
      const s = getComputedStyle(star);
      visible = s.stroke !== 'none' && parseFloat(s.strokeWidth) >= 1.5;
    }
    const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 50);
    return { lost: false, visible, name, role: el.getAttribute('role') || el.tagName.toLowerCase() };
  });
}

async function pressAndCheck(page, key) {
  await page.keyboard.press(key);
  const state = await focusState(page);
  expect(state.lost, `focus lost after ${key}`).toBe(false);
  expect(state.visible, `focus visible on "${state.name}" after ${key}`).toBe(true);
  return state;
}

test.describe('axe finds no WCAG 2.2 AA violations', () => {
  test('on Home', async ({ page }) => {
    await page.goto('/');
    expect(await axeViolations(page)).toEqual([]);
  });

  test('while loading', async ({ page }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route('https://api.github.com/**', async (route) => { await gate; await route.fallback(); });
    await page.goto('/');
    await page.getByLabel('GitHub username').fill('octo-sky');
    await page.getByRole('button', { name: 'Show my sky' }).click();
    await expect(page.getByText('Finding your projects')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    release();
  });

  test('after an error', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('GitHub username').fill('nobody-here');
    await page.getByRole('button', { name: 'Show my sky' }).click();
    await expect(page.getByText('We couldn’t find that GitHub account')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });

  test('on every Studio tab', async ({ page }) => {
    await openStudio(page);
    for (const name of ['Look', 'Layout', 'Projects', 'Details']) {
      await tab(page, name).click();
      await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
      expect(await axeViolations(page), `${name} tab`).toEqual([]);
    }
  });

  test('with a star card open', async ({ page }) => {
    await openStudio(page);
    const star = page.locator('[data-map] .repository').first();
    const name = await star.locator('.star').getAttribute('data-label');
    await star.click();
    await expect(page.getByRole('region', { name })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });

  test('with the star card of a featured project open', async ({ page }) => {
    await openStudio(page);
    const star = page.locator('[data-map] .repository').first();
    const name = await star.locator('.star').getAttribute('data-label');
    await star.click();
    const card = page.getByRole('region', { name });
    await card.getByRole('button', { name: 'Feature it' }).click();
    await expect(card.getByRole('button', { name: 'Feature it' })).toHaveAttribute('aria-pressed', 'true');
    expect(await axeViolations(page)).toEqual([]);
    // Only the star icon is amber; the words keep the normal text colour.
    const colours = await card.getByRole('button', { name: 'Feature it' }).evaluate((button) => ({
      text: getComputedStyle(button).color,
      body: getComputedStyle(document.body).color,
      icon: getComputedStyle(button.querySelector('svg')).fill,
    }));
    expect(colours.text).toBe(colours.body);
    expect(colours.icon).not.toBe('none');
  });
});

test('stars are named once; how to use the map is said once, on the map', async ({ page }) => {
  await openStudio(page);
  const names = await page.evaluate(() => [...document.querySelector('[data-map]').shadowRoot.querySelectorAll('.repository')]
    .map((group) => [group.getAttribute('aria-label'), group.querySelector('.star').dataset.label]));
  for (const [label, name] of names) expect(label).toBe(name);
  await expect(page.locator('[data-map] svg').first()).toHaveAccessibleDescription('Arrow keys move between stars. Enter opens details.');

  const star = page.locator('[data-map] .repository').first();
  const name = await star.locator('.star').getAttribute('data-label');
  await star.click();
  await page.getByRole('region', { name }).getByRole('button', { name: 'Feature it' }).click();
  await expect(page.locator('[data-map]').getByRole('button', { name: `${name}, featured`, exact: true })).toBeAttached();
});

test('headings: the panel has a heading and every tab has section headings', async ({ page }) => {
  await openStudio(page);
  const aside = page.getByRole('complementary', { name: 'Customize your map' });
  await expect(aside.getByRole('heading', { level: 2, name: 'Customize your map' })).toBeAttached();
  expect(await aside.getAttribute('aria-labelledby')).toBeTruthy();
  for (const name of ['Look', 'Layout', 'Projects', 'Details']) {
    await tab(page, name).click();
    const section = page.getByRole('tabpanel', { name, exact: true });
    expect(await section.getByRole('heading', { level: 3 }).count(), `${name} has section headings`).toBeGreaterThan(0);
  }
  await expect(page.getByRole('tabpanel', { name: 'Details' }).getByRole('heading', { level: 3, name: 'What stars show' })).toBeVisible();
});

test('slider values are not read twice', async ({ page }) => {
  await openStudio(page);
  for (const name of ['Look', 'Layout', 'Projects', 'Details']) await tab(page, name).click();
  const outputs = await page.locator('.panel output').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-hidden')));
  expect(outputs.length).toBeGreaterThan(0);
  for (const value of outputs) expect(value).toBe('true');
  for (const slider of await page.locator('.panel input[type=range]').all()) expect(await slider.getAttribute('aria-valuetext')).toBeTruthy();
});

test('picture cards are named by their name and described by their hint', async ({ page }) => {
  await openStudio(page);
  await tab(page, 'Layout').click();
  const galaxy = page.getByRole('radio', { name: 'Galaxy', exact: true });
  await expect(galaxy).toBeVisible();
  const hint = (await galaxy.locator('.gallery-hint').textContent()).trim();
  expect(hint.length).toBeGreaterThan(0);
  await expect(galaxy).toHaveAccessibleDescription(hint);
});

test('keyboard only: username, theme, Get it, with focus always visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('GitHub username')).toBeFocused();
  await page.keyboard.type('octo-sky');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'The sky of @octo-sky' })).toBeAttached();
  await expect(page.locator('[data-map] svg').first()).toBeVisible();
  // The Studio moves focus to its heading so screen readers announce the change.
  expect((await focusState(page)).lost).toBe(false);

  // Tab through the stars to the Look tab.
  let state;
  for (let i = 0; i < 80; i++) {
    state = await pressAndCheck(page, 'Tab');
    if (state.role === 'tab' && state.name === 'Look') break;
  }
  expect(state.name, 'Tab reaches the Look tab').toBe('Look');

  // Into the theme gallery; arrow keys choose a theme.
  state = await pressAndCheck(page, 'Tab');
  expect(state.role).toBe('radio');
  const before = await mapSvg(page);
  state = await pressAndCheck(page, 'ArrowRight');
  expect(state.role).toBe('radio');
  const themes = page.getByRole('radiogroup', { name: 'Theme' });
  await expect(themes.getByRole('radio', { checked: true })).toBeFocused();
  await expect.poll(() => mapSvg(page)).not.toBe(before);
  state = await pressAndCheck(page, 'ArrowDown');
  await expect(themes.getByRole('radio', { checked: true })).toBeFocused();

  // Back up to Get it, open it with Enter, close it with Escape.
  for (let i = 0; i < 80; i++) {
    state = await pressAndCheck(page, 'Shift+Tab');
    if (state.name === 'Get it') break;
  }
  expect(state.name, 'Shift+Tab reaches Get it').toBe('Get it');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect((await focusState(page)).lost, 'focus moves into the dialog').toBe(false);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Get it' })).toBeFocused();
  expect((await focusState(page)).visible, 'focus visible on Get it after closing').toBe(true);
});

test('320px wide: no horizontal scroll on Home or in the Studio', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  expect(await hasHorizontalScroll(page)).toBe(false);
  await openStudio(page);
  for (const name of ['Look', 'Layout', 'Projects', 'Details']) {
    await tab(page, name).click();
    expect(await hasHorizontalScroll(page), `${name} tab`).toBe(false);
  }
});

test('forced colours: every control stays visible', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/');
  expect(await blankControls(page)).toEqual([]);
  await openStudio(page);
  for (const name of ['Look', 'Layout', 'Projects', 'Details']) {
    await tab(page, name).click();
    expect(await blankControls(page), `${name} tab`).toEqual([]);
  }
});

const runningAnimation = (page) => page.evaluate(() => {
  const svg = document.querySelector('[data-map]').shadowRoot.querySelector('svg');
  const smil = svg.querySelectorAll('animate, animateTransform, animateMotion, set').length;
  const star = svg.querySelector('.star');
  return { smil: smil > 0 && !svg.animationsPaused(), css: star ? getComputedStyle(star).animationName !== 'none' : false };
});

test('reduced motion: the map does not move', async ({ page }) => {
  await openStudio(page);
  expect(await runningAnimation(page)).toEqual({ smil: false, css: false });
});

test('reduced motion: spinning rings and floating stars stay still', async ({ page }) => {
  const shared = new URL(encodeShare('http://127.0.0.1/', 'octo-sky', {
    visualTheme: 'deep-space', ringAnimation: { enabled: true }, floatingAnimation: { enabled: true },
  }));
  await page.goto(`/${shared.search}`);
  await expect(page.getByRole('heading', { name: 'The sky of @octo-sky' })).toBeAttached();
  await expect(page.locator('[data-map] svg').first()).toBeVisible();
  expect(await runningAnimation(page)).toEqual({ smil: false, css: false });
});
