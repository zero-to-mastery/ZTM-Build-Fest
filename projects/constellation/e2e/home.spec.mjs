// Home: one field, one primary action, and a plain sentence for every way
// loading an account can go wrong.
import { test, expect, expectPerceptibleScreen, axeViolations } from './support/ux.mjs';

// The GitHub stub is installed only when a test asks for the fixture; without
// it a journey would reach the real api.github.com.
test.beforeEach(async ({ github }) => { void github; });

const field = (page) => page.getByLabel('GitHub username');
const go = (page) => page.getByRole('button', { name: 'Show my sky' });

async function submit(page, login) {
  await field(page).fill(login);
  await go(page).click();
}

test('first visit: headline, focused field, one primary action, accessible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /written in the stars/ })).toBeVisible();
  await expect(field(page)).toBeFocused();
  await expect(go(page)).toBeEnabled();
  expect(await axeViolations(page)).toEqual([]);
  // Sign in, the field, Show my sky, Try an example, and three quiet footer
  // links (the maker, How it works, Star on GitHub).
  await expectPerceptibleScreen(page, { maxControls: 7, primary: 1 });
});

test('typing works before the app is ready, and an early Enter is kept', async ({ page }) => {
  // Hold the app's script so the page is in the moment before it is ready.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/src/app/boot.mjs', async (route) => { await gate; await route.fallback(); });
  await page.goto('/', { waitUntil: 'commit' });
  await expect(field(page)).toBeFocused();
  await page.keyboard.type('octo-sky');
  await page.keyboard.press('Enter');
  await expect(go(page)).toBeDisabled();
  release();
  await expect(page.getByRole('heading', { name: /The sky of @octo-sky/ })).toBeAttached();
});

test('an empty submit asks for a username and keeps focus in the field', async ({ page, github }) => {
  await page.goto('/');
  await go(page).click();
  await expect(page.getByText('Enter a GitHub username')).toBeVisible();
  await expect(field(page)).toBeFocused();
  expect(github.log).toEqual([]);
});

test('an unknown account says so plainly', async ({ page }) => {
  await page.goto('/');
  await submit(page, 'nobody-here');
  await expect(page.getByText('We couldn’t find that GitHub account')).toBeVisible();
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue('nobody-here');
});

test('a rate limit suggests signing in', async ({ page, github }) => {
  await github.mode('rate-limited');
  await page.goto('/');
  await submit(page, 'octo-sky');
  await expect(page.getByRole('status').filter({ hasText: /sign in/i })).toBeVisible();
});

test('being offline says GitHub could not be reached', async ({ page }) => {
  // A real aborted request makes Chrome log "net::ERR_INTERNET_DISCONNECTED",
  // which the fixture counts as a console error. Fail the fetch in the page
  // instead: the Studio sees the same TypeError a dropped connection gives.
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => (String(input?.url || input).startsWith('https://api.github.com/')
      ? Promise.reject(new TypeError('Failed to fetch'))
      : original(input, init));
  });
  await page.goto('/');
  await submit(page, 'octo-sky');
  await expect(page.getByText(/couldn’t reach GitHub/)).toBeVisible();
});

test('an account with no public projects says so', async ({ page }) => {
  await page.goto('/');
  await submit(page, 'empty-sky');
  await expect(page.getByText(/doesn’t have any public projects/)).toBeVisible();
});

test('loading shows progress and Cancel returns home', async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // Hold every GitHub response until the test has looked at the loading state.
  await page.route('https://api.github.com/**', async (route) => { await gate; await route.fallback(); });
  await page.goto('/');
  await submit(page, 'octo-sky');
  await expect(page.getByText('Finding your projects')).toBeVisible();
  await expect(go(page)).toBeHidden();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(go(page)).toBeVisible();
  await expect(field(page)).toHaveValue('octo-sky');
  release();
  // The cancelled load must not take over the screen when it finishes.
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: 'The sky of @octo-sky' })).not.toBeAttached();
  await expect(go(page)).toBeVisible();
});

test('the example sky opens without asking GitHub for anything', async ({ page, github }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try an example' }).click();
  await expect(page.getByRole('heading', { name: 'An example sky' })).toBeAttached();
  await expect(page.locator('[data-map] svg').first()).toBeVisible();
  expect(github.log).toEqual([]);
});

test('?user= opens the Studio directly', async ({ page }) => {
  await page.goto('/?user=octo-sky');
  await expect(page.getByRole('heading', { name: 'The sky of @octo-sky' })).toBeAttached();
  await expect(page.locator('[data-map] svg').first()).toBeVisible();
});

test('the last account is remembered after going home', async ({ page }) => {
  await page.goto('/');
  await submit(page, 'octo-sky');
  await expect(page.getByRole('heading', { name: 'The sky of @octo-sky' })).toBeAttached();
  await page.getByRole('button', { name: /@octo-sky/ }).click();
  await expect(go(page)).toBeVisible();
  await expect(field(page)).toHaveValue('octo-sky');
  await page.reload();
  await expect(field(page)).toHaveValue('octo-sky');
});
