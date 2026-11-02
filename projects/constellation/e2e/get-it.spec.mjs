// "Get your map": every way a design leaves the Studio, checked the way a
// visitor would use it — downloads land with safe names, copied text works,
// a shared link reopens the same sky, and a settings file round-trips.
import { readFile } from 'node:fs/promises';
import { test, expect, expectPerceptibleScreen, axeViolations, visibleControls, overlappingControls } from './support/ux.mjs';

async function openStudio(page, login = 'octo-sky') {
  await page.goto('/');
  await page.getByLabel('GitHub username').fill(login);
  await page.getByRole('button', { name: 'Show my sky' }).click();
  await expect(page.getByRole('heading', { name: `The sky of @${login}` })).toBeAttached();
  await expect(page.locator('[data-map] >> svg').first()).toBeVisible();
}

async function openGetIt(page) {
  await page.getByRole('button', { name: 'Get it' }).click();
  const dialog = page.getByRole('dialog', { name: 'Get your map' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Get your map' })).toBeVisible();
  return dialog;
}

async function choose(dialog, name) {
  await dialog.getByRole('button', { name }).click();
  const heading = dialog.getByRole('heading', { name, level: 3 });
  await expect(heading).toBeFocused();
  return heading;
}

const mapSvg = (page) => page.evaluate(() => document.querySelector('[data-map]').shadowRoot.querySelector('svg').outerHTML);

async function download(page, click) {
  const [file] = await Promise.all([page.waitForEvent('download'), click()]);
  return { name: file.suggestedFilename(), body: await readFile(await file.path()) };
}

const primaries = async (page) => (await visibleControls(page)).filter((c) => c.primary).length;

test.describe('Get your map', () => {
  test('lists five plain choices and passes the screen checks', async ({ page, github }, testInfo) => {
    await openStudio(page);
    const dialog = await openGetIt(page);
    for (const name of ['Add it to your GitHub profile', 'Download an image', 'Put it on a website', 'Share a link', 'Save the settings file']) {
      await expect(dialog.getByRole('button', { name })).toBeVisible();
    }
    // Five equal choices: no single primary, and the Studio behind is inert.
    await expectPerceptibleScreen(page, { maxControls: 8, primary: 0 });
    expect(await axeViolations(page)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('get-it-list.png') });

    for (const name of ['Add it to your GitHub profile', 'Download an image', 'Put it on a website', 'Share a link', 'Save the settings file']) {
      await choose(dialog, name);
      await expectPerceptibleScreen(page, { primary: 1 });
      expect(await primaries(page), `${name}: one primary`).toBe(1);
      expect(await axeViolations(page), `${name}: axe`).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`get-it-${name.split(' ').slice(0, 2).join('-').toLowerCase()}.png`) });
      await dialog.getByRole('button', { name: 'Back' }).click();
      // Back lands on the choice you came from.
      await expect(dialog.getByRole('button', { name })).toBeFocused();
    }
  });

  test('downloads the map as SVG and PNG', async ({ page, github }) => {
    await openStudio(page);
    const calls = github.log.length;
    const dialog = await openGetIt(page);
    await choose(dialog, 'Download an image');
    const svg = await download(page, () => dialog.getByRole('button', { name: 'Download SVG' }).click());
    expect(svg.name).toBe('constellation-octo-sky.svg');
    expect(svg.body.toString('utf8').startsWith('<svg')).toBe(true);
    // The download is confirmed where the visitor is looking, then clears itself.
    const saved = dialog.getByRole('paragraph').filter({ hasText: 'Saved constellation-octo-sky.svg to your downloads.' });
    await expect(saved).toBeVisible();
    await expect(dialog.locator('[data-announcer]')).toHaveText('Saved constellation-octo-sky.svg to your downloads.');
    await expect(saved).toBeHidden({ timeout: 9000 });

    const png = await download(page, () => dialog.getByRole('button', { name: 'Download PNG' }).click());
    expect(png.name).toBe('constellation-octo-sky.png');
    expect(png.body.length).toBeGreaterThan(1000);
    expect([...png.body.subarray(1, 4)].map((b) => String.fromCharCode(b)).join('')).toBe('PNG');
    await expect(dialog.getByRole('paragraph').filter({ hasText: 'Saved constellation-octo-sky.png to your downloads.' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Download PNG' })).not.toHaveAttribute('aria-busy');
    // Presentation work never goes back to GitHub.
    expect(github.log.length).toBe(calls);
  });

  test('profile step writes the workflow and README snippet for the chosen repository', async ({ page, github }) => {
    await openStudio(page);
    const dialog = await openGetIt(page);
    await choose(dialog, 'Add it to your GitHub profile');
    const workflow = dialog.getByRole('region', { name: 'Workflow file' });
    const snippet = dialog.getByRole('region', { name: 'README snippet' });
    const repo = dialog.getByLabel('Repository');
    await expect(repo).toHaveValue('octo-sky/octo-sky');
    // The long workflow file stays folded until asked for.
    await expect(workflow).toBeHidden();
    await dialog.getByText('Show the file').click();
    await expect(workflow).toContainText('uses: mnichols08/constellation');
    await expect(snippet).toContainText('raw.githubusercontent.com/octo-sky/octo-sky/output/constellation.svg');
    await expect(dialog.getByText('Nothing is published until the workflow runs. After that it refreshes every day.')).toBeVisible();

    const create = dialog.getByRole('link', { name: 'Create the file on GitHub' });
    await expect(create).toHaveAttribute('target', '_blank');
    await expect(create).toHaveAttribute('rel', /noopener/);
    expect(new URL(await create.getAttribute('href')).pathname).toBe('/octo-sky/octo-sky/new/HEAD');
    await expect(dialog.getByRole('link', { name: 'Open the Actions page' })).toHaveAttribute('href', 'https://github.com/octo-sky/octo-sky/actions/workflows/constellation.yml');

    await repo.fill('octo-sky/portfolio');
    await expect(snippet).toContainText('raw.githubusercontent.com/octo-sky/portfolio/output/constellation.svg');
    expect(new URL(await create.getAttribute('href')).pathname).toBe('/octo-sky/portfolio/new/HEAD');

    await repo.fill('not a repository');
    await expect(repo).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByText('Enter the repository as owner/name, like octo-sky/octo-sky.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy README snippet' })).toBeDisabled();
    await expect(dialog.getByRole('link', { name: 'Create the file on GitHub' })).toHaveCount(0);

    await repo.fill('octo-sky/octo-sky');
    await expect(repo).not.toHaveAttribute('aria-invalid');
  });

  test('organizations publish from their .github repository', async ({ page, github }) => {
    await openStudio(page, 'sky-org');
    const dialog = await openGetIt(page);
    await choose(dialog, 'Add it to your GitHub profile');
    await expect(dialog.getByLabel('Repository')).toHaveValue('sky-org/.github');
    await expect(dialog.getByRole('region', { name: 'README snippet' })).toContainText('raw.githubusercontent.com/sky-org/.github/output/constellation.svg');
    await expect(dialog.getByRole('heading', { name: 'Paste this into profile/README.md' })).toBeVisible();
  });

  test('copies a share link that reopens the same design', async ({ page, github, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // A fixed clock keeps both visits on the same "today".
    await page.clock.setFixedTime(new Date('2026-10-01T12:00:00Z'));
    await openStudio(page);
    // Change something so the link carries more than the defaults.
    await page.getByRole('button', { name: 'Shuffle' }).click();
    await expect.poll(() => page.evaluate(() => document.querySelector('[data-map]').shadowRoot.querySelector('svg') !== null)).toBe(true);
    const dialog = await openGetIt(page);
    await choose(dialog, 'Share a link');
    const copy = dialog.getByRole('button', { name: 'Copy link' });
    await copy.click();
    await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    await expect(dialog.getByLabel('Link to this design')).toHaveValue(link);
    expect(link).toMatch(/[?&]view=/);
    expect(link).not.toMatch(/token/i);
    await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible({ timeout: 4000 });

    await page.keyboard.press('Escape');
    const original = await mapSvg(page);
    const shared = new URL(link);
    await page.goto(new URL(shared.search, `${baseURL}/`).href);
    await expect(page.getByRole('heading', { name: 'The sky of @octo-sky' })).toBeAttached();
    await expect.poll(() => mapSvg(page)).toBe(original);
  });

  test('saves and opens a settings file, and Undo brings the design back', async ({ page, github }) => {
    await openStudio(page);
    const original = await mapSvg(page);
    const dialog = await openGetIt(page);
    await choose(dialog, 'Save the settings file');
    const file = await download(page, () => dialog.getByRole('button', { name: 'Download settings file' }).click());
    expect(file.name).toBe('constellation-octo-sky.json');
    await expect(dialog.getByRole('paragraph').filter({ hasText: 'Saved constellation-octo-sky.json to your downloads.' })).toBeVisible();
    const text = file.body.toString('utf8');
    expect(text).toContain('"version": 7');
    const config = JSON.parse(text);
    expect(config.visualTheme).toBe('deep-space');

    // Too big is refused before it is read.
    await dialog.getByLabel('Open a settings file').setInputFiles({ name: 'huge.json', mimeType: 'application/json', buffer: Buffer.alloc(260000, 32) });
    await expect(dialog.getByText(/too big to be a settings file/)).toBeVisible();
    // Not JSON is explained, and nothing changes.
    await dialog.getByLabel('Open a settings file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{ nope') });
    await expect(dialog.getByText(/isn’t valid JSON/)).toBeVisible();
    expect(await mapSvg(page)).toBe(original);

    const changed = { ...config, visualTheme: 'dracula', colors: {} };
    await dialog.getByLabel('Open a settings file').setInputFiles({ name: 'mine.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(changed)) });
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Opened your settings. Undo brings back the previous design.')).toBeVisible();
    await expect.poll(() => mapSvg(page)).not.toBe(original);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => mapSvg(page)).toBe(original);
  });

  test('builds the interactive page and portfolio package', async ({ page, github }) => {
    await openStudio(page);
    const dialog = await openGetIt(page);
    await choose(dialog, 'Put it on a website');
    const html = await download(page, () => dialog.getByRole('button', { name: 'Download interactive page' }).click());
    expect(html.name).toBe('constellation-octo-sky.html');
    expect(html.body.toString('utf8')).toMatch(/^<!doctype html>/i);
    await expect(dialog.getByRole('paragraph').filter({ hasText: 'Saved constellation-octo-sky.html to your downloads.' })).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Image code' })).toContainText('<img src="constellation-octo-sky.svg"');

    const pack = await download(page, () => dialog.getByRole('button', { name: 'Download portfolio package' }).click());
    expect(pack.name).toBe('constellation-octo-sky-portfolio.json');
    const container = JSON.parse(pack.body.toString('utf8'));
    expect(container.format).toBe('constellation-portfolio-artifact');
    expect(Object.keys(container.files)).toEqual(expect.arrayContaining(['constellation.html', 'constellation.svg', 'manifest.json']));
  });

  test('Escape closes the dialog and returns focus to Get it', async ({ page, github }) => {
    await openStudio(page);
    const dialog = await openGetIt(page);
    await choose(dialog, 'Share a link');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Get it' })).toBeFocused();
    // Reopening starts from the list again.
    await openGetIt(page);
    await expect(page.getByRole('button', { name: 'Add it to your GitHub profile' })).toBeFocused();
  });

  test('every step reflows at 320px without sideways scrolling', async ({ page, github }, testInfo) => {
    // WCAG reflow is measured in a desktop browser at 320 CSS px; the phone
    // project's mobile viewport would zoom out instead of reflowing.
    test.skip(testInfo.project.name.startsWith('mobile'), 'Reflow is a desktop-browser check.');
    await page.setViewportSize({ width: 320, height: 640 });
    await openStudio(page);
    const dialog = await openGetIt(page);
    for (const name of ['Add it to your GitHub profile', 'Download an image', 'Put it on a website', 'Share a link', 'Save the settings file']) {
      await choose(dialog, name);
      // The dialog itself must fit; the Studio behind it is checked by its own journeys.
      const fit = await dialog.evaluate((el) => {
        const body = el.querySelector('.sheet-body');
        return { right: el.getBoundingClientRect().right, width: innerWidth, sideways: body.scrollWidth > body.clientWidth + 1 };
      });
      expect(fit.right, `${name}: dialog fits`).toBeLessThanOrEqual(fit.width + 1);
      expect(fit.sideways, `${name}: sideways scroll inside the dialog`).toBe(false);
      expect(await overlappingControls(page), `${name}: overlaps`).toEqual([]);
      await dialog.getByRole('button', { name: 'Back' }).click();
    }
  });

  test('the example sky asks for a real account before profile setup', async ({ page, github }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Try an example' }).click();
    await expect(page.locator('[data-map] >> svg').first()).toBeVisible();
    const dialog = await openGetIt(page);
    await choose(dialog, 'Add it to your GitHub profile');
    await expect(dialog.getByText('Load your own GitHub account to add it to a profile.')).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Workflow file' })).toHaveCount(0);
    await expectPerceptibleScreen(page, { primary: 1 });
    await dialog.getByRole('button', { name: 'Load my account' }).click();
    await expect(page.getByLabel('GitHub username')).toBeVisible();
    await expect(dialog).toBeHidden();
  });

  test('profile step explains how to finish on GitHub and how to tell it worked', async ({ page, github }) => {
    await openStudio(page);
    const dialog = await openGetIt(page);
    await choose(dialog, 'Add it to your GitHub profile');
    await expect(dialog.getByText('On GitHub, press the green “Commit changes” button.')).toBeVisible();
    await expect(dialog.getByText('A green tick means your picture is ready. A red cross means something went wrong — open the run to see why.')).toBeVisible();
    const problems = dialog.getByRole('link', { name: 'What can go wrong?' });
    await expect(problems).toHaveAttribute('href', 'https://github.com/mnichols08/constellation/blob/main/docs/publishing.md');
    await expect(problems).toHaveAttribute('rel', /noopener/);

    // The credit line is explained, not hidden.
    await expect(dialog.getByText('The last line credits the tool that made your picture. Keep it if you like, or delete it.')).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'README snippet' })).toContainText('Made with [GitHub Constellation]');

    const edit = dialog.getByRole('link', { name: 'Edit your README on GitHub' });
    await expect(edit).toHaveAttribute('href', 'https://github.com/octo-sky/octo-sky/edit/HEAD/README.md');
    await expect(edit).toHaveAttribute('target', '_blank');
    await expect(edit).toHaveAttribute('rel', /noopener/);
    await expect(dialog.getByText('Paste it anywhere, for example at the top.')).toBeVisible();

    await expect(dialog.getByRole('heading', { name: 'See it on your profile', level: 4 })).toBeVisible();
    const profileLink = dialog.getByRole('link', { name: 'Open your profile' });
    await expect(profileLink).toHaveAttribute('href', 'https://github.com/octo-sky');
    await expect(profileLink).toHaveAttribute('target', '_blank');
    await expect(profileLink).toHaveAttribute('rel', /noopener/);

    // Following another repository moves the README link with it.
    await dialog.getByLabel('Repository').fill('octo-sky/portfolio');
    await expect(edit).toHaveAttribute('href', 'https://github.com/octo-sky/portfolio/edit/HEAD/README.md');

    // Inline links inside sentences still have a 24px tall tap target.
    await dialog.getByLabel('Repository').fill('octo-sky/octo-sky');
    for (const name of ['Create it on GitHub', 'What can go wrong?']) {
      const box = await dialog.getByRole('link', { name }).boundingBox();
      expect(box.height, `${name}: tap target height`).toBeGreaterThanOrEqual(24);
    }
    expect(await axeViolations(page)).toEqual([]);
  });

  test('organizations finish on their own profile page', async ({ page, github }) => {
    await openStudio(page, 'sky-org');
    const dialog = await openGetIt(page);
    await choose(dialog, 'Add it to your GitHub profile');
    await expect(dialog.getByRole('link', { name: 'Edit your README on GitHub' })).toHaveAttribute('href', 'https://github.com/sky-org/.github/edit/HEAD/profile/README.md');
    await expect(dialog.getByRole('link', { name: 'Open the organization’s profile' })).toHaveAttribute('href', 'https://github.com/sky-org');
  });

  test('a bare repository name gets a one-click fix, and nothing is offered while it is wrong', async ({ page, github }) => {
    await openStudio(page);
    const dialog = await openGetIt(page);
    await choose(dialog, 'Add it to your GitHub profile');
    const repo = dialog.getByLabel('Repository');
    await repo.fill('octo-sky');
    await expect(repo).toHaveAttribute('aria-invalid', 'true');
    // Nothing to copy or open while the repository is wrong.
    await expect(dialog.getByRole('button', { name: 'Copy the file' })).toBeDisabled();
    await expect(dialog.getByRole('link', { name: 'Create it on GitHub' })).toHaveCount(0);
    const muted = dialog.getByText('Create it on GitHub', { exact: true });
    await expect(muted).toHaveAttribute('aria-disabled', 'true');
    await expect(muted).not.toHaveAttribute('href');
    await expect(dialog.getByRole('link', { name: 'Edit your README on GitHub' })).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Did you mean octo-sky/octo-sky?' }).click();
    await expect(repo).toHaveValue('octo-sky/octo-sky');
    await expect(repo).toBeFocused();
    await expect(repo).not.toHaveAttribute('aria-invalid');
    await expect(dialog.getByRole('button', { name: /Did you mean/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Copy the file' })).toBeEnabled();
    await expect(dialog.getByRole('link', { name: 'Create it on GitHub' })).toHaveAttribute('href', /github\.com\/new/);

    // Something that isn't a name at all gets no guess.
    await repo.fill('not a repository');
    await expect(dialog.getByRole('button', { name: /Did you mean/ })).toHaveCount(0);
  });

  test('settings that can’t be drawn block every export until undone', async ({ page, github }) => {
    await openStudio(page);
    const dialog = await openGetIt(page);
    await choose(dialog, 'Download an image');
    const before = await download(page, () => dialog.getByRole('button', { name: 'Download SVG' }).click());
    await dialog.getByRole('button', { name: 'Back' }).click();
    await choose(dialog, 'Save the settings file');
    const file = await download(page, () => dialog.getByRole('button', { name: 'Download settings file' }).click());
    const config = JSON.parse(file.body.toString('utf8'));
    // Valid settings that leave nothing to draw.
    const broken = { ...config, languages: ['NoSuchLanguage'] };
    await dialog.getByLabel('Open a settings file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(broken)) });
    await expect(dialog).toBeHidden();

    await openGetIt(page);
    const message = 'Your current settings can’t be drawn. Close this and undo the last change, then try again.';
    for (const name of ['Download an image', 'Put it on a website', 'Add it to your GitHub profile', 'Share a link', 'Save the settings file']) {
      await choose(dialog, name);
      await expect(dialog.getByText(message), `${name}: explains`).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Undo the last change' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: /^Download / }), `${name}: no downloads`).toHaveCount(0);
      await expect(dialog.getByRole('link', { name: 'Create the file on GitHub' })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Copy link' })).toHaveCount(0);
      await expectPerceptibleScreen(page, { primary: 1 });
      await dialog.getByRole('button', { name: 'Back' }).click();
    }

    await choose(dialog, 'Download an image');
    await dialog.getByRole('button', { name: 'Undo the last change' }).click();
    // The step comes back by itself once the map draws again.
    await expect(dialog.getByRole('button', { name: 'Download SVG' })).toBeVisible();
    await expect(dialog.getByText(message)).toHaveCount(0);
    await expect(dialog.getByRole('heading', { name: 'Download an image', level: 3 })).toBeFocused();
    const svg = await download(page, () => dialog.getByRole('button', { name: 'Download SVG' }).click());
    // What downloads is the design as it is again, not a leftover.
    expect(svg.body.equals(before.body)).toBe(true);
  });

  test('phones can share the link through the system share sheet', async ({ page, github }) => {
    await page.addInitScript(() => {
      window.__shares = [];
      window.__shareResult = 'ok';
      Object.defineProperty(Navigator.prototype, 'share', {
        configurable: true,
        value: async (data) => {
          window.__shares.push(data);
          if (window.__shareResult === 'abort') throw new DOMException('Share canceled', 'AbortError');
        },
      });
    });
    await openStudio(page);
    const dialog = await openGetIt(page);
    await choose(dialog, 'Share a link');
    // Copy stays the main way; Share sits beside it.
    await expect(dialog.getByRole('button', { name: 'Copy link' })).toHaveAttribute('data-primary', '');
    const share = dialog.getByRole('button', { name: 'Share…' });
    await expect(share).not.toHaveAttribute('data-primary');
    await expectPerceptibleScreen(page, { primary: 1 });
    await share.click();
    const link = await dialog.getByLabel('Link to this design').inputValue();
    await expect.poll(() => page.evaluate(() => window.__shares)).toEqual([{ title: 'octo-sky’s constellation', url: link }]);

    // Closing the share sheet is not an error.
    await page.evaluate(() => { window.__shareResult = 'abort'; });
    await share.click();
    await expect.poll(() => page.evaluate(() => window.__shares.length)).toBe(2);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.locator('[data-announcer]')).not.toHaveText(/didn’t work/);
  });

  test('browsers without a share sheet only offer Copy', async ({ page, github }) => {
    await page.addInitScript(() => { delete Navigator.prototype.share; });
    await openStudio(page);
    const dialog = await openGetIt(page);
    await choose(dialog, 'Share a link');
    await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Share…' })).toHaveCount(0);
  });

  test('the step heading takes focus with a quiet outline, not an input-like box', async ({ page, github }) => {
    await openStudio(page);
    const dialog = await openGetIt(page);
    await dialog.getByRole('button', { name: 'Download an image' }).focus();
    await page.keyboard.press('Enter');
    const heading = dialog.getByRole('heading', { name: 'Download an image', level: 3 });
    await expect(heading).toBeFocused();
    // The dialog's stylesheet loads on first open, so give it a moment to apply.
    await expect.poll(() => heading.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { visible: el.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset, radius: cs.borderTopLeftRadius };
    })).toEqual({ visible: true, style: 'solid', width: '2px', offset: '4px', radius: '6px' });
  });
});
