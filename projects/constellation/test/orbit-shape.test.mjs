import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from '../src/constellation.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { parseConfig } from '../src/config-schema.mjs';
import { presetOptions } from '../src/studio-presets.mjs';

const repositories = Array.from({ length: 16 }, (_, i) => ({
  name: `p${i}`, full_name: `octo/p${i}`, language: ['Rust', 'Go', 'TypeScript'][i % 3], topics: [],
  stargazers_count: 50 - i, created_at: `${2018 + (i % 6)}-01-01T00:00:00Z`, pushed_at: '2026-01-01T00:00:00Z',
}));
const draw = (options) => {
  const scene = createScene('octo', repositories, { ...presetOptions('project-map'), generatedAt: '2026-10-22T00:00:00Z', ...options });
  return { scene, svg: renderSceneSVG(scene) };
};
const ringScale = (svg) => svg.match(/class="identity-ring"[^>]*scale\(([\d.]+) ([\d.]+)\)/).slice(1).map(Number);
const spans = (scene) => {
  const xs = scene.nodes.map((n) => n.geometry.x), ys = scene.nodes.map((n) => n.geometry.y);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
};

test('orbits stay wide unless round is asked for, so existing images are unchanged', () => {
  for (const arrangement of ['rings', 'galaxy', 'orbital', 'solar-system', 'field']) {
    const unset = draw({ arrangement }).svg;
    assert.equal(draw({ arrangement, orbitShape: 'wide' }).svg, unset, `${arrangement}: wide is the default`);
    const [sx, sy] = ringScale(unset);
    assert.ok(sx > sy * 1.8, `${arrangement}: wide orbits are stretched`);
  }
});

test('round orbits are true circles in every orbit layout', () => {
  for (const arrangement of ['rings', 'galaxy', 'orbital', 'solar-system', 'field']) {
    const { scene, svg } = draw({ arrangement, orbitShape: 'round' });
    const [sx, sy] = ringScale(svg);
    assert.equal(sx, sy, `${arrangement}: ring scale is uniform`);
    const [w, h] = spans(scene);
    const [ww] = spans(draw({ arrangement }).scene);
    assert.ok(w < ww * 0.7, `${arrangement}: round is narrower than wide (${w} vs ${ww})`);
    assert.ok(w < h * 1.4, `${arrangement}: round is not stretched sideways (${w} x ${h})`);
  }
});

test('orbitShape is part of the configuration and is validated', () => {
  assert.equal(parseConfig({ version: 7, account: 'octo', orbitShape: 'round' }).options.orbitShape, 'round');
  assert.throws(() => parseConfig({ version: 7, account: 'octo', orbitShape: 'oval' }), /orbitShape/);
});
