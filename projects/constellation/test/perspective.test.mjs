import test from 'node:test';
import assert from 'node:assert/strict';
import { perspectiveOptions, perspectiveMarkup } from '../src/perspective.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import { renderWorkflow } from '../src/export.mjs';

test('perspective settings are bounded and static transforms remain invertible', () => {
  for (const horizontal of [-55, 0, 55]) {
    const markup = perspectiveMarkup(perspectiveOptions({ enabled: true, horizontal, vertical: 65 }), 270, 560);
    const scales = markup.start.match(/scale\(([\d.]+) ([\d.]+)\)/);
    assert.ok(Number(scales[1]) > 0 && Number(scales[2]) > 0);
    assert.ok(!markup.start.includes('<animate'));
  }
  for (const options of [{ horizontal: 90 }, { vertical: -1 }, { zoom: 0 }, { duration: 0 }, { enabled: 'yes' }]) assert.throws(() => perspectiveOptions(options));
});

test('animated perspective works alone, exports, and has a genuinely static reduced-motion fallback', () => {
  const repos = [{ name: 'a', full_name: 'o/a', language: 'Rust' }];
  const options = { perspective: { enabled: true, animate: true, horizontal: 15, duration: 12 } };
  const svg = renderConstellation('octocat', repos, options);
  assert.match(svg, /class="perspective-scene"/);
  assert.match(svg, /data-perspective="true"/);
  assert.match(svg, /dur="12s"/);
  assert.match(svg, /class="ring-motion-still"/);
  const fallback = decodeURIComponent(svg.match(/href="data:image\/svg\+xml,([^"]+)"/)[1]);
  assert.ok(!fallback.includes('<animateTransform'));
  const restored = JSON.parse(renderWorkflow('octocat', options).split('          config-json: |\n')[1]);
  assert.equal(renderConstellation('octocat', repos, restored), svg);
});
