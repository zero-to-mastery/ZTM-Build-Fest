import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScene, renderSceneSVG, renderSceneHTML } from '../src/core-api.mjs';
import { temporalGeometryDrawing } from '../src/temporal-geometry-drawing.mjs';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';

const records = ['atlas', 'beacon', 'compiler'].map(name => ({ name, full_name: `universe/${name}`, language: 'Rust', created_at: '2018-01-01', stargazers_count: 100 }));
const sceneFor = (mode, shape = 'sphere', extra = {}) => createScene('universe', records, {
  arrangement: 'temporal-stack', referenceDate: '2026-09-01', theme: 'midnight', animate: false,
  temporalGeometry: { shape, surface: 'translucent' }, starfield: { mode }, ...extra,
});
const modes = ['space', 'milky-way', 'classic', 'off'];

test('all temporal forms retain the established sky phases across themes and transparent exports', () => {
  for (const shape of ['stack', 'sphere', 'cylinder', 'cone', 'dome', 'hourglass', 'helix']) {
    for (const mode of modes) for (const extra of [{ theme: 'light' }, { theme: 'midnight' }, { theme: 'auto' }, { exportProfile: 'transparent' }, { transparentTheme: true }]) {
      const scene = sceneFor(mode, shape, extra), svg = renderSceneSVG(scene);
      assert.match(svg, /data-temporal-world/);
      assert.match(svg, /class="repository"/);
      if (['space', 'milky-way'].includes(mode)) {
        assert.match(svg, /class="starfield-point/);
        assert.ok(svg.indexOf('data-starfield-backdrop') < svg.indexOf('data-temporal-world'));
        assert.ok(svg.indexOf('class="starfield-point') < svg.indexOf('class="repository"'));
        assert.doesNotMatch(svg.slice(svg.indexOf('data-temporal-world')), /class="starfield-point/);
      } else if (mode === 'classic') {
        assert.match(svg, /data-geometry-key="starfield:classic"/);
        assert.ok(svg.indexOf('data-temporal-world') < svg.indexOf('class="dust"'));
        assert.ok(svg.indexOf('class="dust"') < svg.indexOf('class="repository"'));
        assert.doesNotMatch(svg, /data-starfield-backdrop/);
      } else assert.doesNotMatch(svg, /class="dust|class="starfield-point/);
      if (extra.exportProfile === 'transparent' || extra.transparentTheme) {
        assert.doesNotMatch(svg, /<rect class="background"|id="starfield-haze"/);
        assert.match(svg, /background:transparent/);
      }
      assert.doesNotMatch(svg, /<mask|clip-path="/);
      const surfaces = temporalGeometryDrawing(scene).items.filter(item => item.kind === 'surface');
      assert.ok(surfaces.length > 0);
      assert.ok(surfaces.every(item => item.opacity > 0 && item.opacity <= .022));
      assert.match(svg, /\.temporal-surface\{fill:var\(--sky-accent\);stroke:none/);
    }
  }
});

test('starfield controls preserve phase boundaries, opacity, deterministic output and world ordering', () => {
  for (const mode of modes.slice(0, 3)) {
    for (const control of [{ visible: false }, { opacity: 0 }]) {
      assert.doesNotMatch(renderSceneSVG(sceneFor(mode, 'sphere', { layers: { starfield: control } })), /class="dust|class="starfield-point/);
    }
    const scene = sceneFor(mode, 'sphere', { layers: { starfield: { opacity: .4, order: 50 } } });
    const svg = renderSceneSVG(scene);
    assert.equal(svg, renderSceneSVG(scene));
    assert.match(svg, /data-scene-layer="starfield" opacity="0.4"/);
    if (mode !== 'classic') assert.ok(svg.indexOf('data-starfield-backdrop') < svg.indexOf('data-temporal-world'));
    else {
      assert.ok(svg.indexOf('class="dust"') > svg.lastIndexOf('class="repository"'));
      assert.ok(svg.indexOf('class="dust"') > svg.lastIndexOf('class="repo-label"'));
    }
  }
  const early = renderSceneSVG(sceneFor('classic', 'sphere', { layers: { starfield: { order: 1 } } }));
  assert.ok(early.indexOf('class="dust"') < early.indexOf('class="temporal-ring"'));
  for (const shape of ['sphere', 'cylinder']) {
    const scene = sceneFor('space', shape, { temporalGeometry: { shape } });
    assert.equal(temporalGeometryDrawing(scene).items.some(item => item.kind === 'surface'), false);
  }
});

test('legacy temporal planes retain background and world dust without opaque fills', () => {
  for (const mode of modes) {
    const scene = sceneFor(mode, 'stack');
    delete scene.temporalStack.geometry;
    const svg = renderSceneSVG(scene);
    assert.match(svg, /fill-opacity:\.035/);
    if (mode === 'off') assert.doesNotMatch(svg, /class="dust/);
    else assert.ok(svg.indexOf('class="dust') < svg.indexOf('class="temporal-plane"'));
  }
});

test('browser sky stays visible behind temporal geometry through camera and form changes', { skip: !browser, timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-sky-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const mode of modes) await writeFile(join(directory, `${mode}.html`), renderSceneHTML(sceneFor(mode, 'sphere', { animate: true })));
  const { evaluate, waitFor, cdp, errors } = await openBrowser(t, pathToFileURL(join(directory, 'space.html')).href);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  for (const mode of modes) {
    await cdp('Page.navigate', { url: pathToFileURL(join(directory, `${mode}.html`)).href });
    await waitFor(`Boolean(document.querySelector('main')?.constellation)`);
    for (const shape of ['sphere', 'cylinder', 'cone', 'dome', 'hourglass', 'helix', 'stack']) {
      await evaluate(`document.querySelector('main').constellation.setTemporalView({shape:'${shape}',rotation:.7,surface:'translucent'})`);
      const result = await evaluate(`(() => {
        const svg = document.querySelector('[data-canvas] > svg'), world = svg.querySelector('[data-temporal-world]');
        const dust = svg.querySelector('.dust'), point = dust?.querySelector('circle'), node = world.querySelector('.repository');
        let opacity = 1, clipped = false;
        for (let el = point; el && el !== svg; el = el.parentElement) {
          const css = getComputedStyle(el); opacity *= Number(css.opacity);
          if (css.display === 'none' || css.visibility === 'hidden') opacity = 0;
          clipped ||= css.clipPath !== 'none' || css.maskImage !== 'none';
        }
        const surface = svg.querySelector('.temporal-surface');
        const rect = point?.getBoundingClientRect(), bounds = svg.getBoundingClientRect();
        return { stars: dust?.querySelectorAll('circle').length || 0, opacity, clipped,
          before: !!dust && !!(dust.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
          worldDust: !!dust?.closest('[data-temporal-world]'),
          inBounds: !!rect && rect.x >= bounds.x && rect.right <= bounds.right && rect.y >= bounds.y && rect.bottom <= bounds.bottom,
          nodes: world.querySelectorAll('.repository').length, surface: Number(getComputedStyle(surface).opacity),
          animations: svg.getAnimations({subtree:true}).length };
      })()`);
      assert.ok(result.nodes > 0); assert.ok(result.surface > 0 && result.surface <= .022);
      assert.equal(result.animations, 0);
      if (mode === 'off') assert.equal(result.stars, 0);
      else {
        assert.ok(result.stars > 0); assert.ok(result.opacity > 0);
        assert.equal(result.clipped, false); assert.equal(result.before, true);
        assert.equal(result.worldDust, mode === 'classic');
        if (mode !== 'classic') assert.equal(result.inBounds, true);
      }
    }
  }
  assert.deepEqual(errors, []);
});
