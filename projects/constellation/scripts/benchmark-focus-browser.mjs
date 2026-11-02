import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createScene, renderSceneHTML } from '../src/core-api.mjs';
import { browser, openBrowser } from './browser-harness.mjs';

// Interaction responsiveness of evidence focus in a standalone export: time from
// the focus call to a forced layout, including Rust navigation, highlight, and
// inspector rendering. Run with node --test scripts/benchmark-focus-browser.mjs.
test('measure interactive focus responsiveness', { skip: !browser, timeout: 240000 }, async t => {
  await mkdir('.dist', { recursive: true });
  const file = resolve('.dist/focus-benchmark.html');
  const { evaluate, waitFor, cdp } = await openBrowser(t, 'about:blank');
  for (const count of [12, 100, 256]) {
    const languages = ['Rust', 'TypeScript', 'Go', 'Python'], topics = ['wasm', 'cli', 'web', 'data', 'graphics', 'tools'];
    const records = Array.from({ length: count }, (_, i) => ({
      name: `project-${i}`, full_name: `demo/project-${i}`, language: languages[i % languages.length],
      topics: [topics[i % topics.length], topics[(i * 5 + 1) % topics.length]], stargazers_count: count - i,
    }));
    const families = Object.fromEntries(Array.from({ length: Math.ceil(count / 8) }, (_, f) => [`family-${f}`, { label: `Family ${f}`, members: records.slice(f * 8, f * 8 + 4).map(r => r.full_name) }]).filter(([, family]) => family.members.length >= 2));
    const scene = createScene('demo', records, { maxRepos: count, nodeCap: count > 100 ? count : 100, animate: false, referenceDate: '2026-09-01', projectFamilies: families });
    await writeFile(file, renderSceneHTML(scene));
    const start = Date.now();
    await cdp('Page.navigate', { url: pathToFileURL(file).href });
    await waitFor(`Boolean(document.querySelector('main')?.constellation)`);
    const loadMs = Date.now() - start;
    console.log(JSON.stringify({ projects: count, loadToInteractiveMs: loadMs, ...(await evaluate(`(() => {
      const api = document.querySelector('main').constellation, ids = ${JSON.stringify(records.map(r => r.full_name))};
      const measure = run => { const start = performance.now(); run(); document.querySelector('[data-details]').getBoundingClientRect(); return performance.now() - start; };
      const project = [], relationship = [], overview = [], second = [];
      for (let i = 0; i < 12; i++) {
        const id = ids[(i * 7) % ids.length];
        project.push(measure(() => api.focusProject(id)));
        const other = api.focusState.connections[0];
        if (other) relationship.push(measure(() => api.focusRelationship(id, other)));
        api.focusProject(id);
        const disclosure = document.querySelector('[data-second-degree]');
        if (disclosure) second.push(measure(() => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')); }));
        overview.push(measure(() => api.returnToOverview()));
      }
      const stats = values => values.length ? { mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2), max: +Math.max(...values).toFixed(2) } : null;
      return { projectFocusMs: stats(project.slice(1)), relationshipFocusMs: stats(relationship.slice(1)), secondDegreeMs: stats(second.slice(1)), overviewMs: stats(overview.slice(1)), domElements: document.querySelectorAll('*').length };
    })()`)) }));
  }
});
