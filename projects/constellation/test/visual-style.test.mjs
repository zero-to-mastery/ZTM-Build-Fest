import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultVisualStyle, visualCSS } from '../src/visual-style.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import { renderWorkflow } from '../src/export.mjs';

test('labels remain available above 18 projects and visibility survives export', () => {
  for (const layout of ['atlas', 'compact']) {
    for (const count of [18, 19, 45, 100]) {
      const repos = Array.from({ length: count }, (_, i) => ({ name: `repo-${i}`, full_name: `octocat/repo-${i}`, language: 'JavaScript' }));
      for (const labels of [true, false]) {
        const options = { layout, maxRepos: 100, css: visualCSS({ ...defaultVisualStyle(), labels }) };
        const svg = renderConstellation('octocat', repos, options);
        assert.match(svg, /<text class="repo-label"/);
        assert.match(svg, new RegExp(`\\.language, \\.repo-label \\{ display: ${labels ? 'inline' : 'none'}; \\}`));
        const workflow = renderWorkflow('octocat', options);
        const restored = JSON.parse(workflow.split('          config-json: |\n')[1].split('      - name:')[0]);
        assert.equal(renderConstellation('octocat', repos, restored), svg);
      }
    }
  }
});

test('visual edits and both palettes survive workflow export unchanged', () => {
  const style = defaultVisualStyle();
  style.dark.star = '#abcdef'; style.light.background = '#fffafa';
  style.lineWidth = 2.5; style.glow = 0; style.labels = false;
  const css = visualCSS(style);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /--sky-star: #abcdef/);
  assert.match(css, /stroke-width: 2.5/);
  assert.match(css, /filter: none/);
  assert.match(css, /display: none/);
  const options = { theme: 'auto', css: `${css}\n.credit{opacity:.5}` };
  const workflow = renderWorkflow('octocat', options);
  const restored = JSON.parse(workflow.split('          config-json: |\n')[1].split('      - name:')[0]);
  assert.deepEqual(restored, { ...options, version: 7 });
  assert.equal(renderConstellation('octocat', [], restored), renderConstellation('octocat', [], options));
  assert.throws(() => visualCSS({ ...style, glow: 'none;}' }));
  assert.throws(() => visualCSS({ ...style, dark: { star: 'red;}' } }));
  assert.equal(defaultVisualStyle().dark.star, '#f6d99b');
});

test('default SVG is adaptive and has only repository credit as visible chrome', () => {
  for (const layout of ['atlas', 'compact']) {
    const svg = renderConstellation('octocat', [], { layout });
    assert.match(svg, /@media\(prefers-color-scheme:dark\)/);
    assert.match(svg, /--sky-background:#f7f8fc/);
    assert.match(svg, /--sky-background:#080e20/);
    assert.ok(!svg.includes('<text class="heading"'));
    assert.ok(!svg.includes('<text class="caption"'));
    assert.match(svg, /class="credit" x="868".*>mnichols08\/constellation<\/text>/);
    assert.match(svg, /<title id="title">octocat/);
  }
  assert.ok(!renderConstellation('octocat', [], { theme: 'midnight' }).includes('prefers-color-scheme:dark'));
});
