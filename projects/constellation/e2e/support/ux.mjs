// Perception checks: assertions about what a person actually sees, not what the
// DOM contains. Each one exists because a past release shipped the failure.
import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { stubGitHub, repository, accounts } from './github-fixtures.mjs';

// Words a first-time visitor should never need to decode. Canonical engine
// terms may still appear in docs and config; they never appear on screen.
export const BANNED_TERMS = [
  'semantic', 'topology', 'seed', 'ring mapping', 'ring meaning', 'account sun',
  'design code', 'visual bridge', 'technical shape', 'temporal', 'hierarchy',
  'node mode', 'connection basis', 'arrangement', 'evidence resolution',
  'randomize / locks', 'quality lab', 'story clarity', 'atlas',
];

const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=radio], [role=checkbox], [role=slider], [role=option], [role=menuitem]';

/** Visible interactive elements with geometry, excluding the map's own star hit-targets. */
export async function visibleControls(page, { includeMap = false } = {}) {
  return page.evaluate(({ selector, includeMap }) => {
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!includeMap && el.closest('[data-map]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      // Skip elements clipped away by a scroll container or [inert] parent.
      // checkVisibility also hides content of a closed <details>, which keeps a box.
      if (el.closest('[inert],[hidden]') || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      let outside = false;
      for (let clip = el.closest('[data-scroll]'); clip && !outside; clip = clip.parentElement?.closest('[data-scroll]')) {
        const c = clip.getBoundingClientRect();
        outside = r.bottom <= c.top || r.top >= c.bottom || r.right <= c.left || r.left >= c.right;
      }
      if (outside) continue;
      const name = (el.getAttribute('aria-label') || el.textContent || el.value || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
      out.push({ tag: el.tagName, name: name.slice(0, 60), x: r.x, y: r.y, w: r.width, h: r.height, primary: el.matches('[data-primary]') });
    }
    return out;
  }, { selector: INTERACTIVE, includeMap });
}

/** Pairs of visible controls whose boxes intersect by more than a hairline. */
export async function overlappingControls(page) {
  return page.evaluate(selector => {
    const shown = [...document.querySelectorAll(selector)].filter(el => {
      if (el.closest('[data-map],[hidden],[inert]') || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return r.width >= 2 && r.height >= 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
    });
    const label = el => `${el.tagName} "${(el.getAttribute('aria-label') || el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;
    const overlaps = [];
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i], b = shown[j];
      // A control nested in another (a button inside a label, say) is not an overlap.
      if (a.contains(b) || b.contains(a)) continue;
      // Only the part of a control its scroll container shows can overlap.
      const clipped = el => {
        // Intersect with every scroll container up the tree, not just the nearest.
        let box = el.getBoundingClientRect();
        box = { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        for (let c = el.parentElement?.closest('[data-scroll]'); c; c = c.parentElement?.closest('[data-scroll]')) {
          const r = c.getBoundingClientRect();
          box = { left: Math.max(box.left, r.left), right: Math.min(box.right, r.right), top: Math.max(box.top, r.top), bottom: Math.min(box.bottom, r.bottom) };
        }
        return box;
      };
      const ra = clipped(a), rb = clipped(b);
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 3 && h > 3) overlaps.push(`${label(a)} ⟷ ${label(b)}`);
    }
    return overlaps;
  }, INTERACTIVE);
}

/** Controls that have a box but no visible label: icon-less, text-less, or text the same colour as the fill. */
export async function blankControls(page) {
  return page.evaluate(selector => {
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      if (el.closest('[data-map]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0 || el.closest('[hidden],[inert]') || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) continue;
      const hasIcon = el.querySelector('svg, img');
      const text = (el.innerText || '').trim();
      const textVisible = text && (() => {
        const range = document.createRange(); range.selectNodeContents(el);
        const rect = range.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1 && cs.color !== cs.backgroundColor;
      })();
      if (!hasIcon && !textVisible) out.push(`${el.tagName}#${el.id} "${(el.getAttribute('aria-label') || text).slice(0, 50)}"`);
    }
    return out;
  }, INTERACTIVE);
}

/** Fraction of the viewport covered by the map, and whether it shows anything. */
export async function mapPresence(page) {
  const map = page.locator('[data-map]').first();
  if (!(await map.count()) || !(await map.isVisible())) return { coverage: 0, variance: 0 };
  const box = await map.boundingBox();
  const vp = page.viewportSize();
  const visW = Math.max(0, Math.min(box.x + box.width, vp.width) - Math.max(box.x, 0));
  const visH = Math.max(0, Math.min(box.y + box.height, vp.height) - Math.max(box.y, 0));
  const shot = await map.screenshot({ animations: 'disabled' });
  // Decode in the page so no PNG library is needed.
  const variance = await page.evaluate(async b64 => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = 96; c.height = Math.max(1, Math.round(96 * img.height / img.width));
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, sq = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += l; sq += l * l; n++; }
    const mean = sum / n; return sq / n - mean * mean;
  }, shot.toString('base64'));
  return { coverage: (visW * visH) / (vp.width * vp.height), variance };
}

export async function hasHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

/** Visible controls smaller than the minimum target size (WCAG 2.5.8 = 24px). */
export async function smallTargets(page, min = 24) {
  return (await visibleControls(page)).filter(c => (c.w < min || c.h < min) && c.tag !== 'A').map(c => `${c.tag} "${c.name}" ${Math.round(c.w)}×${Math.round(c.h)}`);
}

// Project and account names are the visitor's own data, not our vocabulary:
// a real repository may well be called "atlas". Strip them before checking.
const USER_NAMES = [
  ...Array.from({ length: 100 }, (_, i) => repository('x', i).name),
  ...Object.values(accounts).map(account => account.login),
  'your-universe',
].sort((a, b) => b.length - a.length);

export async function jargon(page) {
  let text = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  for (const name of USER_NAMES) text = text.split(name.toLowerCase()).join(' ');
  return BANNED_TERMS.filter(term => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`).test(text));
}

export async function axeViolations(page, { exclude = [] } = {}) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  for (const selector of exclude) builder = builder.exclude(selector);
  const { violations } = await builder.analyze();
  return violations.map(v => `${v.id}: ${v.help} (${v.nodes.length}) → ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
}

/** Every perception check at once, for a given screen. */
/** Wait for one-off animations (a dialog fading in) to end; endless ones (twinkles) are ignored. */
export async function settle(page) {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map((animation) => animation.finished.catch(() => {}))));
}

export async function expectPerceptibleScreen(page, { maxControls, minMap = 0, primary = 1 } = {}) {
  // Measure what a person sees once the screen is still, not mid-fade.
  await settle(page);
  expect.soft(await blankControls(page), 'controls with no visible label').toEqual([]);
  expect.soft(await overlappingControls(page), 'overlapping controls').toEqual([]);
  expect.soft(await hasHorizontalScroll(page), 'horizontal scroll').toBe(false);
  expect.soft(await jargon(page), 'jargon on screen').toEqual([]);
  const controls = await visibleControls(page);
  if (maxControls !== undefined) {
    expect.soft(controls.length, `visible controls (${controls.map(c => c.name).join(' | ')})`).toBeLessThanOrEqual(maxControls);
  }
  if (primary !== undefined) {
    expect.soft(controls.filter(c => c.primary).length, 'primary actions on screen').toBe(primary);
  }
  if (minMap) {
    const map = await mapPresence(page);
    expect.soft(map.coverage, 'map share of viewport').toBeGreaterThanOrEqual(minMap);
    expect.soft(map.variance, 'map is not blank').toBeGreaterThan(20);
  }
}

/** Test fixture: stubs GitHub, fails the test on console errors or failed same-origin requests. */
export const test = base.extend({
  // Projects can swap in a wider font: Linux browsers without Inter or Segoe UI
  // fall back to DejaVu Sans, and layouts must survive it on every OS.
  wideFont: [false, { option: true }],
  // Automatic: no journey may ever reach the real GitHub API.
  github: [async ({ page }, use) => {
    const log = await stubGitHub(page);
    await use({ log, mode: async mode => { await page.unroute('https://api.github.com/**'); await stubGitHub(page, { mode, log }); } });
  }, { auto: true }],
  page: async ({ page, wideFont }, use) => {
    if (wideFont) await page.addInitScript(() => {
      // Verdana has nearly the same widths as DejaVu Sans (both descend from Bitstream Vera).
      // Init scripts run before <html> exists, so add the style once it does.
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = 'html, body, button, input, select, textarea { font-family: Verdana, "DejaVu Sans", sans-serif !important; }';
        document.head.append(style);
      }, { once: true });
    });
    const problems = [];
    page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      // Chrome logs every failed GitHub response (401, 403, 404, offline) as a
      // console error. Those are expected answers the UI must explain, not bugs.
      const source = message.location()?.url || '';
      if (/api\.github\.com/.test(source) || /api\.github\.com|status of (401|403|404)/.test(message.text())) return;
      problems.push(`console: ${message.text()}`);
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.hostname === '127.0.0.1' && response.status() >= 400) problems.push(`HTTP ${response.status()} ${url.pathname}`);
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await use(page);
    expect(problems, 'console errors and failed requests').toEqual([]);
  },
});

export { expect };
