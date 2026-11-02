// Sign-in journeys. The test server runs on 127.0.0.1 with no OAuth app, so the
// personal-token form is the only way in, exactly as on a local preview.
import { test, expect, expectPerceptibleScreen, axeViolations } from './support/ux.mjs';

const EXPLANATION = 'Without signing in you can map any public account. Signing in lets Constellation read your pinned projects, every language in each project, and your recent activity.';
const PRIVACY = 'Your sign-in stays in this tab only. It is never saved, shared, or put in your map.';
const TOKEN = 'test-token';

/** GitHub's /user answers only for the one good token. Registered after the fixture, so it wins. */
async function stubViewer(page) {
  const seen = [];
  await page.route('https://api.github.com/user', (route) => {
    const auth = route.request().headers().authorization || '';
    seen.push(auth === `Bearer ${TOKEN}` ? 'good' : 'bad');
    return auth === `Bearer ${TOKEN}`
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ login: 'octo-sky', id: 1 }) })
      : route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Bad credentials' }) });
  });
  return seen;
}

// The dialog host makes the page behind an open sheet inert, so the shared
// checks already see only what a person can reach.
const expectPerceptibleDialog = expectPerceptibleScreen;

/**
 * Chrome logs every 401 as a console error, and GitHub answering 401 to a bad
 * token is the behaviour under test. Swap the fixture's console watcher for one
 * that forgives exactly that response and still fails on anything else.
 */
function forgiveGitHub401(page) {
  const problems = [];
  page.removeAllListeners('console');
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const from = message.location()?.url || '';
    if (from.startsWith('https://api.github.com/') && /status of 401/.test(message.text())) return;
    if (/api\.github\.com|status of (403|404)/.test(message.text())) return;
    problems.push(`console: ${message.text()}`);
  });
  return problems;
}

async function openSignIn(page) {
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in with GitHub' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The secret must not survive anywhere a page, a share or an export could read it. */
async function expectTokenNowhere(page) {
  expect(await page.content()).not.toContain(TOKEN);
  const stored = await page.evaluate(() => {
    const dump = (s) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i))}`).join('\n');
    return { local: dump(localStorage), session: dump(sessionStorage), href: location.href, inputs: [...document.querySelectorAll('input')].map((i) => i.value).join('\n') };
  });
  expect(stored.local).not.toContain(TOKEN);
  expect(stored.session).not.toContain(TOKEN);
  expect(stored.href).not.toContain(TOKEN);
  expect(stored.inputs).not.toContain(TOKEN);
}

test('explains what signing in adds and offers the local token form', async ({ page, github }, testInfo) => {
  const dialog = await openSignIn(page);
  await expect(dialog.getByText(EXPLANATION)).toBeVisible();
  await expect(dialog.getByText(PRIVACY)).toBeVisible();
  // No OAuth app here, so there is no GitHub redirect button…
  await expect(dialog.getByRole('button', { name: 'Continue with GitHub' })).toHaveCount(0);
  // …and the token form is already open, labelled, and masked.
  const field = dialog.getByLabel('Personal access token');
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute('type', 'password');
  // Never offered to the password manager.
  await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(field).toHaveAttribute('data-lpignore', 'true');
  // On touch screens the heading takes focus so the keyboard doesn't pop up uninvited.
  if (testInfo.project.name.startsWith('mobile')) await expect(dialog.getByRole('heading', { name: 'Sign in with GitHub' })).toBeFocused();
  else await expect(field).toBeFocused();
  await expect(dialog.getByText('Read-only public access is enough. The token is kept in memory and cleared when you close this tab.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sign-in.png') });
  await expectPerceptibleDialog(page, { primary: 1, maxControls: 16 });
  expect(await axeViolations(page)).toEqual([]);

  // The disclosure is keyboard operable and its summary keeps a readable name.
  const summary = dialog.getByText('Use a personal access token (local only)');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(field).toBeHidden();
  await expectPerceptibleDialog(page, { primary: 0 });
  await page.keyboard.press('Enter');
  await expect(field).toBeVisible();

  // Escape closes and focus returns to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Sign in' })).toBeFocused();
  expect(github.log.filter((path) => path === '/user')).toEqual([]);
});

test('a rejected token is explained, cleared, and never kept', async ({ page }, testInfo) => {
  const consoleProblems = forgiveGitHub401(page);
  const seen = await stubViewer(page);
  const dialog = await openSignIn(page);
  const field = dialog.getByLabel('Personal access token');
  await field.fill('bad');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('GitHub rejected this token');
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
  expect(seen).toEqual(['bad']);
  await page.screenshot({ path: testInfo.outputPath('sign-in-error.png') });
  await expectPerceptibleDialog(page, { primary: 1 });
  await expect(page.getByRole('banner').getByText('Signed in as')).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  // An empty field is caught without asking GitHub.
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter a valid GitHub token');
  expect(seen).toEqual(['bad']);

  // Whatever was typed is gone once the dialog closes.
  await field.fill('half-typed-secret');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  expect(await page.content()).not.toContain('half-typed-secret');
  expect(await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.value))).not.toContain('half-typed-secret');
  expect(consoleProblems).toEqual([]);
});

test('a good token signs in, opens your sky, and signs out again', async ({ page, github }) => {
  const seen = await stubViewer(page);
  const dialog = await openSignIn(page);
  await dialog.getByLabel('Personal access token').fill(TOKEN);
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Signed in as @octo-sky.' })).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'The sky of @octo-sky' })).toBeAttached();
  expect(seen).toEqual(['good']);
  expect(github.log.some((path) => path.startsWith('/users/octo-sky'))).toBe(true);
  await expectTokenNowhere(page);

  // Back on Home (same page, so the in-memory session is still there).
  await page.getByRole('button', { name: /Choose a different account/ }).click();
  const header = page.getByRole('banner');
  await expect(header.getByText('Signed in as @octo-sky')).toBeVisible();
  await expect(header.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expectTokenNowhere(page);

  // The signed-in dialog offers your sky and a way out, reached from Home.
  const reopen = header.getByRole('button', { name: /Signed in as @octo-sky/ });
  await reopen.click();
  await expect(dialog.getByText('Signed in as @octo-sky', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Show my sky' })).toBeVisible();
  await expectPerceptibleDialog(page, { primary: 1 });
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Signed out.' })).toBeVisible();
  await expect(dialog.getByLabel('Personal access token')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(header.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expectTokenNowhere(page);
});

test('the hosted sign-in settings stay off on any other address', async ({ page }) => {
  // index.html carries the real app's settings, registered for GitHub Pages.
  // Served from 127.0.0.1 they can't complete sign-in, so only the token form shows.
  const dialog = await openSignIn(page);
  await expect(dialog.getByLabel('Personal access token')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Continue with GitHub' })).toHaveCount(0);
});

test('a copy with GitHub sign-in set up hands you to GitHub, token form tucked away', async ({ page, baseURL }) => {
  // Same page, but with an OAuth app registered for this address, the way a deployment would be.
  const setting = (name, value) => (html) => html.replace(new RegExp(`(name="${name}" content=")[^"]*"`), `$1${value}"`);
  await page.route((url) => url.hostname === '127.0.0.1' && url.pathname === '/', async (route) => {
    const response = await route.fetch();
    const body = [
      setting('constellation-oauth-client', 'test-client'),
      setting('constellation-oauth-exchange', 'https://exchange.example/token'),
      setting('constellation-oauth-redirect', new URL('/', baseURL).href),
    ].reduce((html, apply) => apply(html), await response.text());
    await route.fulfill({ response, body });
  });
  const dialog = await openSignIn(page);
  const go = dialog.getByRole('button', { name: 'Continue with GitHub' });
  await expect(go).toBeFocused();
  await expect(dialog.getByText(EXPLANATION)).toBeVisible();
  // The token is the fallback here, so it starts collapsed and is not the primary action.
  await expect(dialog.getByLabel('Personal access token')).toBeHidden();
  await expectPerceptibleDialog(page, { primary: 1 });
  expect(await axeViolations(page)).toEqual([]);

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().startsWith('https://github.com/login/oauth/authorize')),
    go.click(),
  ]);
  const url = new URL(request.url());
  expect(url.searchParams.get('client_id')).toBe('test-client');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('redirect_uri')).toBe(new URL('/', baseURL).href);
  expect(url.searchParams.get('state')).toBeTruthy();
});
