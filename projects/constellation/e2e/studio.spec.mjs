// The Studio: a full-size map, four tabs, Undo that restores exactly, and a
// star card that explains itself. Every change here is presentation only, so
// none of it may ask GitHub for anything.
import {
  test, expect, mapPresence, BANNED_TERMS, blankControls, overlappingControls, hasHorizontalScroll, visibleControls,
} from './support/ux.mjs';
import { repository } from './support/github-fixtures.mjs';

// expectPerceptibleScreen with a per-tab control budget; project names are
// the visitor's own data and never count as jargon.
const PROJECT_NAMES = Array.from({ length: 100 }, (_, i) => repository('x', i).name);
async function expectPerceptible(page, { maxControls, primary = 1 }) {
  expect.soft(await blankControls(page), 'controls with no visible label').toEqual([]);
  expect.soft(await overlappingControls(page), 'overlapping controls').toEqual([]);
  expect.soft(await hasHorizontalScroll(page), 'horizontal scroll').toBe(false);
  let text = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  for (const name of PROJECT_NAMES) text = text.split(name).join(' ');
  // Banned terms are plain words and phrases, so a word-start match is enough.
  expect.soft(BANNED_TERMS.filter((term) => new RegExp(`\\b${term.replace(/[^a-z ]/g, '.')}`).test(text)), 'jargon on screen').toEqual([]);
  const controls = await visibleControls(page);
  expect.soft(controls.length, `visible controls (${controls.map((c) => c.name).join(' | ')})`).toBeLessThanOrEqual(maxControls);
  expect.soft(controls.filter((c) => c.primary).length, 'primary actions on screen').toBe(primary);
}

// The GitHub stub is installed only when a test asks for the fixture; without
// it a journey would reach the real api.github.com.
test.beforeEach(async ({ github }) => { void github; });

async function openStudio(page, login = 'octo-sky') {
  await page.goto('/');
  await page.getByLabel('GitHub username').fill(login);
  await page.getByRole('button', { name: 'Show my sky' }).click();
  await expect(page.getByRole('heading', { name: `The sky of @${login}` })).toBeAttached();
  await expect(page.locator('[data-map] svg').first()).toBeVisible();
}

// The map lives in an open shadow root; these read what it currently draws.
const mapSvg = (page) => page.evaluate(() => document.querySelector('[data-map]')?.shadowRoot?.querySelector('svg')?.outerHTML || '');
const starIds = (page) => page.evaluate(() => [...(document.querySelector('[data-map]')?.shadowRoot?.querySelectorAll('.star[data-repo]') || [])].map((s) => s.dataset.repo));
const focusedStar = (page) => page.evaluate(() => document.querySelector('[data-map]')?.shadowRoot?.activeElement?.querySelector?.('.star')?.dataset.repo || null);

async function mapChangesFrom(page, before) {
  await expect.poll(() => mapSvg(page), { message: 'map redraws' }).not.toBe(before);
  return mapSvg(page);
}

const tab = (page, name) => page.getByRole('tab', { name, exact: true });
const panel = (page, name) => page.getByRole('tabpanel', { name, exact: true });
const topUndo = (page) => page.getByRole('banner').getByRole('button', { name: 'Undo', exact: true });
const topRedo = (page) => page.getByRole('banner').getByRole('button', { name: 'Redo', exact: true });

test('the map fills most of the screen and is not blank', async ({ page }, testInfo) => {
  await openStudio(page);
  const map = await mapPresence(page);
  expect(map.coverage).toBeGreaterThanOrEqual(testInfo.project.name.startsWith('mobile') ? 0.35 : 0.55);
  expect(map.variance).toBeGreaterThan(20);
});

for (const name of ['Look', 'Layout', 'Projects', 'Details']) {
  test(`the ${name} tab passes the perception checks`, async ({ page }) => {
    await openStudio(page);
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page, name)).toBeVisible();
    await expectPerceptible(page, { maxControls: 40, primary: 1 });
  });
}

test('tabs work by click and by arrow keys', async ({ page }) => {
  await openStudio(page);
  for (const name of ['Layout', 'Projects', 'Details', 'Look']) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page, name)).toBeVisible();
  }
  await tab(page, 'Look').focus();
  for (const name of ['Layout', 'Projects', 'Details', 'Look']) {
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, name)).toBeFocused();
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page, name)).toBeVisible();
  }
  await page.keyboard.press('ArrowLeft');
  await expect(tab(page, 'Details')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tab(page, 'Look')).toBeFocused();
  await page.keyboard.press('End');
  await expect(tab(page, 'Details')).toHaveAttribute('aria-selected', 'true');
});

test('theme and layout previews appear and stop loading', async ({ page }) => {
  await openStudio(page);
  const synthwave = page.getByRole('radio', { name: /^Synthwave/ });
  await expect(synthwave.locator('img')).toBeAttached({ timeout: 5000 });
  const firstCard = panel(page, 'Look').getByRole('radio').first();
  await expect.poll(() => firstCard.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0), { timeout: 5000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('[role=radiogroup] .loading').length), { timeout: 5000 }).toBe(0);
  await tab(page, 'Layout').click();
  const galaxy = page.getByRole('radio', { name: /^Galaxy/ });
  await expect.poll(() => galaxy.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false), { timeout: 5000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('[role=radiogroup] .loading').length), { timeout: 5000 }).toBe(0);
});

test('Look: a theme changes the map, Undo restores it exactly, Redo re-applies', async ({ page }) => {
  await openStudio(page);
  const before = await mapSvg(page);
  const synthwave = page.getByRole('radio', { name: /^Synthwave/ });
  await synthwave.click();
  await expect(synthwave).toHaveAttribute('aria-checked', 'true');
  const after = await mapChangesFrom(page, before);

  await topUndo(page).click();
  await expect.poll(() => mapSvg(page)).toBe(before);
  await expect(synthwave).toHaveAttribute('aria-checked', 'false');
  await topRedo(page).click();
  await expect.poll(() => mapSvg(page)).toBe(after);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => mapSvg(page)).toBe(before);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => mapSvg(page)).toBe(after);
});

test('Layout: Solar system changes the map', async ({ page }) => {
  await openStudio(page);
  await tab(page, 'Layout').click();
  const before = await mapSvg(page);
  const solar = page.getByRole('radio', { name: /^Solar system/ });
  await solar.click();
  await expect(solar).toHaveAttribute('aria-checked', 'true');
  await mapChangesFrom(page, before);
});

test('Layout: Through time is offered when projects span three or more years', async ({ page }) => {
  await openStudio(page);
  await tab(page, 'Layout').click();
  const time = page.getByRole('radio', { name: /^Through time/ });
  await expect(time).toHaveAttribute('aria-disabled', 'false');
  const before = await mapSvg(page);
  await time.click();
  await expect(time).toHaveAttribute('aria-checked', 'true');
  await mapChangesFrom(page, before);
});

test('Layout: Through time explains why it is unavailable for two projects', async ({ page }) => {
  await openStudio(page, 'tiny-sky');
  await tab(page, 'Layout').click();
  const time = page.getByRole('radio', { name: /^Through time/ });
  await expect(time).toHaveAttribute('aria-disabled', 'true');
  await expect(time).toContainText('Needs projects from at least three different years.');
  await time.click({ force: true });
  await expect(time).toHaveAttribute('aria-checked', 'false');
});

test('Details: project names can be turned off and the title is used', async ({ page }) => {
  await openStudio(page);
  await tab(page, 'Details').click();
  // Names are hidden with CSS, so count the ones a person can see.
  const labels = () => page.evaluate(() => [...document.querySelector('[data-map]').shadowRoot.querySelectorAll('.repo-label')].filter((el) => getComputedStyle(el).display !== 'none').length);
  expect(await labels()).toBeGreaterThan(0);
  const names = page.getByRole('switch', { name: 'Project names' });
  await expect(names).toBeChecked();
  await names.uncheck();
  await expect.poll(labels).toBe(0);

  await page.getByLabel('Title').fill('My night sky');
  await page.getByLabel('Title').press('Enter');
  // With moving rings the drawing is wrapped in a group; the image's name is the #title it points to.
  await expect.poll(() => page.evaluate(() => document.querySelector('[data-map]').shadowRoot.querySelector('svg title#title')?.textContent)).toBe('My night sky');
});

test('Projects: list, hide, choose automatically, feature and search', async ({ page }) => {
  await openStudio(page);
  await tab(page, 'Projects').click();
  const list = panel(page, 'Projects');
  await expect(list.getByRole('checkbox')).toHaveCount(16);
  await expect(list.getByText(/^\d+ of 16 projects are on your map/)).toBeVisible();
  await expect(list.getByText(/picked automatically/)).toBeVisible();

  const aurora = list.getByRole('checkbox', { name: /^aurora-ui/ });
  await expect(aurora).toBeChecked();
  expect(await starIds(page)).toContain('octo-sky/aurora-ui');
  await aurora.uncheck();
  await expect.poll(() => starIds(page)).not.toContain('octo-sky/aurora-ui');
  await expect(list.getByText(/picked by you/)).toBeVisible();

  await list.getByRole('button', { name: 'Choose automatically' }).click();
  await expect.poll(() => starIds(page)).toContain('octo-sky/aurora-ui');
  await expect(aurora).toBeChecked();
  await expect(list.getByText(/picked automatically/)).toBeVisible();

  const before = await mapSvg(page);
  const feature = list.getByRole('button', { name: 'Feature aurora-ui' });
  await expect(feature).toHaveAttribute('aria-pressed', 'false');
  await feature.click();
  await expect(feature).toHaveAttribute('aria-pressed', 'true');
  await mapChangesFrom(page, before);

  await list.getByRole('searchbox', { name: 'Search your projects' }).fill('comet');
  await expect(list.getByRole('checkbox')).toHaveCount(1);
  await expect(list.getByRole('checkbox', { name: /^comet-cli/ })).toBeVisible();
  await list.getByRole('searchbox', { name: 'Search your projects' }).fill('no-such-project');
  await expect(list.getByText('No projects match')).toBeVisible();
});

test('Shuffle changes the map and the toast can undo it', async ({ page }) => {
  await openStudio(page);
  const before = await mapSvg(page);
  await page.getByRole('button', { name: 'Shuffle' }).click();
  await mapChangesFrom(page, before);
  const toast = page.getByRole('status').filter({ hasText: /Shuffled|New colours/ });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => mapSvg(page)).toBe(before);
  await expect(toast).toHaveCount(0);
});

test('a star card explains the star and can hide it', async ({ page }) => {
  await openStudio(page);
  const star = page.locator('[data-map] .repository').first();
  const id = await star.locator('.star').getAttribute('data-repo');
  const name = await star.locator('.star').getAttribute('data-label');
  await star.click();
  const card = page.getByRole('region', { name });
  await expect(card.getByRole('heading', { level: 2, name })).toBeVisible();
  await expect(card.getByText('Why it’s here')).toBeVisible();
  await card.getByRole('button', { name: 'Hide it' }).click();
  await expect(card).toBeHidden();
  await expect.poll(() => starIds(page)).not.toContain(id);
  await page.getByRole('status').filter({ hasText: `Took ${name} off the map` }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => starIds(page)).toContain(id);
});

test('closing a star card returns focus to its star', async ({ page }) => {
  await openStudio(page);
  const star = page.locator('[data-map] .repository').nth(2);
  const id = await star.locator('.star').getAttribute('data-repo');
  const name = await star.locator('.star').getAttribute('data-label');
  await star.click();
  const card = page.getByRole('region', { name });
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect.poll(() => focusedStar(page)).toBe(id);

  await star.click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Close project details' }).click();
  await expect(card).toBeHidden();
  await expect.poll(() => focusedStar(page)).toBe(id);
});

test('keyboard: Tab reaches a star and Enter opens its card', async ({ page }) => {
  await openStudio(page);
  let id = null;
  for (let i = 0; i < 6 && !id; i++) {
    await page.keyboard.press('Tab');
    id = await focusedStar(page);
  }
  expect(id, 'a star takes focus within a few Tabs').not.toBeNull();
  await page.keyboard.press('Enter');
  const name = id.split('/').pop();
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
});

test('the phone top bar shows the whole account name with 44px targets', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'phone layout');
  await openStudio(page);
  const bar = page.getByRole('banner');
  const chip = bar.getByRole('button', { name: /@octo-sky/ });
  await expect(chip).toHaveText('@octo-sky');
  expect(await chip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const name of ['Undo', 'Redo', 'Shuffle', 'Save', 'Get it']) {
    const box = await bar.getByRole('button', { name, exact: true }).boundingBox();
    expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44);
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44);
  }
  // The example sky's chip is 11 characters, about the longest common login.
  await chip.click();
  await page.getByRole('button', { name: 'Try an example' }).click();
  const example = bar.getByRole('button', { name: /^Example sky/ });
  await expect(example).toHaveText('Example sky');
  expect(await example.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('100 projects load and draw within five seconds', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('GitHub username').fill('big-sky');
  const started = Date.now();
  await page.getByRole('button', { name: 'Show my sky' }).click();
  await expect(page.getByRole('heading', { name: 'The sky of @big-sky' })).toBeAttached({ timeout: 5000 });
  await expect(page.locator('[data-map] .star').first()).toBeAttached({ timeout: 5000 });
  expect(Date.now() - started).toBeLessThan(5000);
});

test('an organization loads', async ({ page }) => {
  await openStudio(page, 'sky-org');
  expect((await starIds(page)).length).toBeGreaterThan(0);
});

test('changing how the map looks never asks GitHub for anything', async ({ page, github }) => {
  await openStudio(page);
  await page.waitForTimeout(500);
  const requests = github.log.length;
  let svg = await mapSvg(page);
  await page.getByRole('radio', { name: /^Synthwave/ }).click();
  svg = await mapChangesFrom(page, svg);
  await tab(page, 'Layout').click();
  await page.getByRole('radio', { name: /^Orbits/ }).click();
  svg = await mapChangesFrom(page, svg);
  await tab(page, 'Details').click();
  await page.getByRole('switch', { name: 'Project names' }).uncheck();
  svg = await mapChangesFrom(page, svg);
  await tab(page, 'Projects').click();
  await panel(page, 'Projects').getByRole('checkbox', { name: /^comet-cli/ }).uncheck();
  svg = await mapChangesFrom(page, svg);
  await page.getByRole('button', { name: 'Shuffle' }).click();
  svg = await mapChangesFrom(page, svg);
  await topUndo(page).click();
  await topUndo(page).click();
  await page.waitForTimeout(300);
  expect(github.log.slice(requests)).toEqual([]);
});

// ------------------------------------------------------------------------
// The map as one keyboard stop, an explicit move mode, and touch targets.

const announcer = (page) => page.locator('#announcer');
const starName = (page, id) => page.evaluate((repo) => document.querySelector('[data-map]').shadowRoot.querySelector(`.star[data-repo="${repo}"]`)?.dataset.label, id);
const starPosition = (page, id) => page.evaluate((repo) => {
  const star = document.querySelector('[data-map]').shadowRoot.querySelector(`.star[data-repo="${repo}"]`);
  return star ? [star.getAttribute('cx'), star.getAttribute('cy')] : null;
}, id);
/** Screen centres of every star, in document order. */
const starCentres = (page) => page.evaluate(() => [...document.querySelector('[data-map]').shadowRoot.querySelectorAll('.repository')].map((group) => {
  const box = group.querySelector('.star').getBoundingClientRect();
  return { id: group.querySelector('.star').dataset.repo, x: box.x + box.width / 2, y: box.y + box.height / 2 };
}));
const heading = (page) => page.getByRole('heading', { level: 1 });

/** Share of the viewport where the map is what a person would touch (nothing covers it). */
const unobscuredMapShare = (page) => page.evaluate(() => {
  let hits = 0;
  let total = 0;
  for (let y = 2; y < innerHeight; y += 8) {
    for (let x = 2; x < innerWidth; x += 8) {
      total++;
      if (document.elementFromPoint(x, y)?.matches('[data-map]')) hits++;
    }
  }
  return hits / total;
});

test('the map is one Tab stop: Tab enters on a star and the next Tab leaves the map', async ({ page }) => {
  await openStudio(page);
  await heading(page).focus();
  await page.keyboard.press('Tab');
  const first = await focusedStar(page);
  expect(first, 'Tab lands on a star').not.toBeNull();
  await page.keyboard.press('Tab');
  expect(await focusedStar(page), 'the next Tab leaves the map').toBeNull();
  expect(await page.evaluate(() => document.querySelector('[data-map]').shadowRoot.querySelectorAll('[tabindex="0"]').length)).toBe(1);
  // The map's credit link is not a stop either.
  const links = await page.evaluate(() => [...document.querySelector('[data-map]').shadowRoot.querySelectorAll('svg a')].map((a) => [a.getAttribute('tabindex'), a.getAttribute('aria-hidden')]));
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) expect(link).toEqual(['-1', 'true']);
});

test('Tab lands on the selected star', async ({ page }) => {
  await openStudio(page);
  const star = page.locator('[data-map] .repository').nth(3);
  const id = await star.locator('.star').getAttribute('data-repo');
  await star.click();
  await expect(page.getByRole('region', { name: await starName(page, id) })).toBeVisible();
  await heading(page).focus();
  await page.keyboard.press('Tab');
  expect(await focusedStar(page)).toBe(id);
});

test('arrow keys move focus between stars by direction, Home and End jump, nothing moves', async ({ page }) => {
  await openStudio(page);
  const positions = () => page.evaluate(() => [...document.querySelector('[data-map]').shadowRoot.querySelectorAll('.star')].map((s) => `${s.getAttribute('cx')},${s.getAttribute('cy')}`).join(' '));
  const before = await positions();
  await heading(page).focus();
  await page.keyboard.press('Tab');
  const order = await starIds(page);
  await page.keyboard.press('Home');
  expect(await focusedStar(page)).toBe(order[0]);
  await page.keyboard.press('End');
  expect(await focusedStar(page)).toBe(order.at(-1));
  const directions = [['ArrowRight', 1, 0], ['ArrowDown', 0, 1], ['ArrowLeft', -1, 0], ['ArrowUp', 0, -1]];
  for (const [key, dx, dy] of [...directions, ...directions]) {
    const from = await focusedStar(page);
    const centres = await starCentres(page);
    const origin = centres.find((c) => c.id === from);
    const ahead = centres.filter((c) => c.id !== from && ((c.x - origin.x) * dx + (c.y - origin.y) * dy) > 2);
    await page.keyboard.press(key);
    const to = await focusedStar(page);
    expect(to, `${key} keeps focus on a star`).not.toBeNull();
    if (ahead.length) {
      const target = centres.find((c) => c.id === to);
      expect(((target.x - origin.x) * dx + (target.y - origin.y) * dy), `${key} goes that way`).toBeGreaterThan(2);
    }
  }
  await page.waitForTimeout(150);
  expect(await positions(), 'navigating never moves a star').toBe(before);
  await expect(topUndo(page)).toBeDisabled();
});

test('Move it: arrows move the star, Enter ends, and the whole move is one Undo step', async ({ page }) => {
  await openStudio(page);
  const star = page.locator('[data-map] .repository').nth(1);
  const id = await star.locator('.star').getAttribute('data-repo');
  const name = await starName(page, id);
  const start = await starPosition(page, id);
  await star.click();
  const card = page.getByRole('region', { name });
  await card.getByRole('button', { name: 'Move it' }).click();
  await expect(card).toBeHidden();
  await expect.poll(() => focusedStar(page)).toBe(id);
  await expect(announcer(page)).toHaveText(`Moving ${name}. Use arrow keys, then Enter.`);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => starPosition(page, id)).not.toEqual(start);
  expect(await focusedStar(page), 'focus stays on the moving star').toBe(id);
  await page.keyboard.press('Enter');
  await expect(announcer(page)).toHaveText(`Moved ${name}.`);
  await expect(card, 'Enter ends moving instead of opening the card').toBeHidden();
  const moved = await starPosition(page, id);
  // Out of move mode, arrows only move focus.
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  expect(await starPosition(page, id)).toEqual(moved);
  await expect(topUndo(page)).toHaveAttribute('title', `Undo Move ${name} (Ctrl+Z)`);
  await topUndo(page).click();
  await expect.poll(() => starPosition(page, id)).toEqual(start);
  await expect(topUndo(page), 'three arrow presses were one step').toBeDisabled();
});

test('Escape also ends moving', async ({ page }) => {
  await openStudio(page);
  const star = page.locator('[data-map] .repository').first();
  const id = await star.locator('.star').getAttribute('data-repo');
  const name = await starName(page, id);
  await star.click();
  await page.getByRole('region', { name }).getByRole('button', { name: 'Move it' }).click();
  await expect.poll(() => focusedStar(page)).toBe(id);
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(() => starPosition(page, id)).not.toBeNull();
  await page.keyboard.press('Escape');
  await expect(announcer(page)).toHaveText(`Moved ${name}.`);
  const moved = await starPosition(page, id);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(150);
  expect(await starPosition(page, id)).toEqual(moved);
});

test('dragging a star with the pointer still moves it', async ({ page }) => {
  await openStudio(page);
  const star = page.locator('[data-map] .repository').nth(2);
  const id = await star.locator('.star').getAttribute('data-repo');
  const start = await starPosition(page, id);
  const box = await star.locator('.star').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => starPosition(page, id)).not.toEqual(start);
  await expect(page.getByRole('region', { name: await starName(page, id) }), 'a drag is not a click').toBeHidden();
  await topUndo(page).click();
  await expect.poll(() => starPosition(page, id)).toEqual(start);
});

test('the hint speaks to keyboard users and goes away when a star is opened by keyboard', async ({ page }) => {
  await openStudio(page);
  const hint = page.locator('.stage-hint');
  await expect(hint).toBeVisible();
  await heading(page).focus();
  await page.keyboard.press('Tab');
  await expect(hint).toHaveText('Press Enter on a star to see why it’s there.');
  const id = await focusedStar(page);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: await starName(page, id) })).toBeVisible();
  await expect(hint).toBeHidden();
});

test('the Studio title is visible over the map and the star card never covers it', async ({ page }) => {
  await openStudio(page);
  const title = heading(page);
  const count = new Set(await starIds(page)).size;
  await expect(title).toHaveText(`The sky of @octo-sky · ${count} projects`);
  const box = await title.boundingBox();
  const stage = await page.locator('.stage').boundingBox();
  expect(box.width, 'the title is on screen, not visually hidden').toBeGreaterThan(120);
  expect(box.height).toBeGreaterThan(16);
  expect(box.x).toBeGreaterThanOrEqual(stage.x);
  expect(box.y).toBeGreaterThanOrEqual(stage.y);
  const star = page.locator('[data-map] .repository').first();
  const name = await star.locator('.star').getAttribute('data-label');
  await star.click();
  const card = page.getByRole('region', { name });
  await expect(card).toBeVisible();
  const cardBox = await card.boundingBox();
  const overlap = Math.min(box.y + box.height, cardBox.y + cardBox.height) - Math.max(box.y, cardBox.y) > 0
    && Math.min(box.x + box.width, cardBox.x + cardBox.width) - Math.max(box.x, cardBox.x) > 0;
  expect(overlap, 'the card sits clear of the title').toBe(false);
  // Hiding a star hands focus to the title, which a sighted keyboard user can see.
  await card.getByRole('button', { name: 'Hide it' }).focus();
  await page.keyboard.press('Enter');
  await expect(title).toBeFocused();
  expect(await title.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
});

test('the example sky has a visible title too', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try an example' }).click();
  await expect(heading(page)).toHaveText(/^An example sky · \d+ projects$/);
  expect((await heading(page).boundingBox()).width).toBeGreaterThan(120);
});

test('phone: the panel scrolls inside itself while the map and tabs stay put', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStudio(page);
  for (const name of ['Projects', 'Details', 'Look']) {
    await tab(page, name).click();
    await page.evaluate(() => {
      const scroller = document.querySelector('.panel-scroll');
      scroller.scrollTop = scroller.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.scrollY), `${name}: the page itself does not scroll`).toBe(0);
    expect(await unobscuredMapShare(page), `${name}: map share`).toBeGreaterThanOrEqual(0.35);
    for (const label of ['Look', 'Layout', 'Projects', 'Details']) {
      const box = await tab(page, label).boundingBox();
      expect(box.y, `${label} tab on screen`).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      const onTop = await tab(page, label).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      });
      expect(onTop, `${label} tab is not covered`).toBe(true);
    }
  }
  // Switching tabs starts the new tab at its top.
  await tab(page, 'Projects').click();
  await page.evaluate(() => { document.querySelector('.panel-scroll').scrollTop = 400; });
  await tab(page, 'Layout').click();
  expect(await page.evaluate(() => document.querySelector('.panel-scroll').scrollTop)).toBe(0);
});

test('phone landscape: map and panel sit side by side', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await openStudio(page);
  const map = await page.locator('[data-map]').boundingBox();
  const side = await page.locator('.panel').boundingBox();
  const tabs = await page.getByRole('tablist').boundingBox();
  expect(side.x, 'the panel is beside the map').toBeGreaterThanOrEqual(map.x + map.width - 1);
  expect(side.width).toBeLessThanOrEqual(340);
  expect(tabs.x).toBeGreaterThanOrEqual(map.x + map.width - 1);
  expect(await unobscuredMapShare(page)).toBeGreaterThanOrEqual(0.5);
  expect(await hasHorizontalScroll(page)).toBe(false);
  // A star card stays a corner card here, leaving most of the map in view.
  const star = page.locator('[data-map] .repository').first();
  await star.click();
  const card = page.getByRole('region', { name: await star.locator('.star').getAttribute('data-label') });
  await expect(card).toBeVisible();
  expect((await card.boundingBox()).width).toBeLessThanOrEqual(map.width * 0.7);
  await expect(card.getByRole('button', { name: 'Move it' })).toBeInViewport();
});

test('touch: each star is at least a 40px target and its name opens it too', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'coarse pointers only');
  await openStudio(page);
  const hitSize = async () => (await page.locator('[data-map] .repository .star-hit').first().boundingBox()) || { width: 0, height: 0 };
  const box = await hitSize();
  expect(box.width).toBeGreaterThanOrEqual(40);
  expect(box.height).toBeGreaterThanOrEqual(40);
  // Still 40px after the map changes size.
  await page.setViewportSize({ width: 360, height: 740 });
  await expect.poll(async () => (await hitSize()).width).toBeGreaterThanOrEqual(40);
  const label = page.locator('[data-map] .repo-label').first();
  const id = await label.getAttribute('data-repo');
  await label.tap();
  await expect(page.getByRole('region', { name: await starName(page, id) })).toBeVisible();
});

test('tapping empty sky closes the star card; the card keeps clear of the map edges', async ({ page }) => {
  await openStudio(page);
  const star = page.locator('[data-map] .repository').first();
  const name = await star.locator('.star').getAttribute('data-label');
  await star.click();
  const card = page.getByRole('region', { name });
  await expect(card).toBeVisible();
  const stage = await page.locator('.stage').boundingBox();
  const box = await card.boundingBox();
  expect(box.x - stage.x, 'left gap').toBeGreaterThanOrEqual(12);
  expect(box.y - stage.y, 'top gap').toBeGreaterThanOrEqual(12);
  expect(stage.x + stage.width - (box.x + box.width), 'right gap').toBeGreaterThanOrEqual(12);
  // The visible map ends where the panel starts (on phones its rounded top overlaps the map).
  const panelTop = (await page.locator('.panel').boundingBox()).y;
  const mapBottom = panelTop > stage.y ? Math.min(stage.y + stage.height, panelTop) : stage.y + stage.height;
  expect(mapBottom - (box.y + box.height), 'bottom gap').toBeGreaterThanOrEqual(12);
  // A point of open sky: on the map, not on a star or a name, not under the card.
  const point = await page.evaluate(() => {
    const host = document.querySelector('[data-map]');
    const r = host.getBoundingClientRect();
    for (let y = r.top + 20; y < r.bottom - 20; y += 9) {
      for (let x = r.left + 20; x < r.right - 20; x += 9) {
        if (document.elementFromPoint(x, y) !== host) continue;
        const inner = host.shadowRoot.elementFromPoint(x, y);
        if (inner && !inner.closest('.repository, .repo-label, a')) return { x, y };
      }
    }
    return null;
  });
  expect(point).not.toBeNull();
  await page.mouse.click(point.x, point.y);
  await expect(card).toBeHidden();
});

test('320×568: the star card’s buttons are fully visible', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openStudio(page);
  const star = page.locator('[data-map] .repository').first();
  const name = await star.locator('.star').getAttribute('data-label');
  await star.click();
  const card = page.getByRole('region', { name });
  await expect(card).toBeVisible();
  const cardBox = await card.boundingBox();
  for (const button of await card.locator('.card-actions > *').all()) {
    const box = await button.boundingBox();
    const label = (await button.textContent()).trim();
    expect(box.y, `${label} top`).toBeGreaterThanOrEqual(cardBox.y);
    expect(box.y + box.height, `${label} bottom inside the card`).toBeLessThanOrEqual(cardBox.y + cardBox.height);
    expect(box.x + box.width, `${label} right`).toBeLessThanOrEqual(Math.min(cardBox.x + cardBox.width, 320));
    expect(box.y + box.height, `${label} on screen`).toBeLessThanOrEqual(568);
  }
});

test('320×568: Shuffle and Save stay 44px and the account chip keeps “@” and six characters', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openStudio(page);
  const bar = page.getByRole('banner');
  for (const name of ['Shuffle', 'Save']) {
    const box = await bar.getByRole('button', { name, exact: true }).boundingBox();
    expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44);
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44);
  }
  const chip = bar.getByRole('button', { name: /@octo-sky/ });
  const room = await chip.evaluate((el) => {
    const cs = getComputedStyle(el);
    const context = document.createElement('canvas').getContext('2d');
    context.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { inner, needed: context.measureText('@octo-s…').width };
  });
  expect(room.inner, 'room for “@octo-s…”').toBeGreaterThanOrEqual(room.needed);
  expect(await hasHorizontalScroll(page)).toBe(false);
});

test('gallery: after Undo, focus follows the checked card', async ({ page }) => {
  await openStudio(page);
  const themes = page.getByRole('radiogroup', { name: 'Theme' });
  const originalValue = await themes.getByRole('radio', { checked: true }).getAttribute('data-value');
  await themes.getByRole('radio', { checked: true }).focus();
  await page.keyboard.press('ArrowRight');
  const next = themes.getByRole('radio', { checked: true });
  await expect(next).toBeFocused();
  expect(await next.getAttribute('data-value')).not.toBe(originalValue);
  await page.keyboard.press('ControlOrMeta+z');
  const restored = themes.locator(`[data-value="${originalValue}"]`);
  await expect(restored).toHaveAttribute('aria-checked', 'true');
  await expect(restored).toBeFocused();
  await expect(restored).toHaveAttribute('tabindex', '0');
});

test('a toast shown over a dialog never covers the sheet', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('button', { name: 'Fine-tune every setting' }).click();
  const dialog = page.getByRole('dialog', { name: 'Fine-tune' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Start over/ }).click();
  await dialog.getByRole('button', { name: 'Click again to start over' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Started over' });
  await expect(toast).toBeVisible();
  await expect.poll(async () => {
    const a = await toast.boundingBox();
    const b = await dialog.boundingBox();
    return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) <= 0;
  }, { message: 'toast and sheet do not overlap' }).toBe(true);
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
});

test('dialogs focus their first field with a mouse, and their heading on touch', async ({ page }, testInfo) => {
  await openStudio(page);
  await page.getByRole('button', { name: 'Fine-tune every setting' }).click();
  const sheet = page.getByRole('dialog', { name: 'Fine-tune' });
  await expect(sheet).toBeVisible();
  const search = sheet.getByLabel('Search settings');
  if (testInfo.project.name.startsWith('mobile')) {
    // A focused text field would pop up the on-screen keyboard over the sheet.
    await expect(sheet.getByRole('heading', { name: 'Fine-tune' })).toBeFocused();
    await expect(search).not.toBeFocused();
  } else {
    await expect(search).toBeFocused();
  }
});
