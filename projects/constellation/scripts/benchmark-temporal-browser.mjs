import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createScene, renderSceneHTML, renderSceneSVG } from '../src/core-api.mjs';
import { browser, openBrowser } from './browser-harness.mjs';

test('measure offline temporal DOM projection', { skip: !browser, timeout: 120000 }, async t => {
  await mkdir('.dist', { recursive: true });
  const file = resolve('.dist/temporal-benchmark.html');
  const { evaluate, waitFor, cdp } = await openBrowser(t, 'about:blank');
  for (const [count, years] of [[25, 6], [100, 20], [200, 20]]) {
    const records = Array.from({ length: count }, (_, i) => ({ name: `project-${i}`, full_name: `demo/project-${i}`, language: ['Rust', 'JavaScript', 'Python'][i % 3], created_at: `${2000 + i % 24}-01-01`, stargazers_count: count - i }));
    const scene = createScene('developer-universe', records, { arrangement: 'temporal-stack', visualTheme: 'deep-space', maxRepos: count, nodeCap: count > 100 ? count : 100, referenceDate: '2026-09-01', temporalStack: { yearStart: 2027 - years } });
    await writeFile(file, renderSceneHTML(scene));
    await cdp('Page.navigate', { url: pathToFileURL(file).href });
    await waitFor(`Boolean(document.querySelector('main')?.constellation)`);
    console.log(JSON.stringify(await evaluate(`(() => { const api = document.querySelector('main').constellation; const times = []; for(let i=0;i<5;i++){ const start=performance.now(); api.setTemporalView({rotation:i*.1}); document.querySelector('svg').getBoundingClientRect(); times.push(performance.now()-start); } return {nodes:${count},years:${years},domElements:document.querySelectorAll('*').length,projectionMs:times}; })()`)));
    if (count === 25) {
      await evaluate(`document.querySelector('main').constellation.resetTemporalView()`);
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1200, deviceScaleFactor: 1, mobile: false });
      const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile('.dist/temporal-stack.png', Buffer.from(screenshot.data, 'base64'));
      await writeFile('.dist/temporal-stack.svg', renderSceneSVG(scene));
      await writeFile('.dist/temporal-stack.html', renderSceneHTML(scene));
    }
  }
});
