import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene, renderConstellation } from '../src/constellation.mjs';
import { renderWorkflow } from '../src/export.mjs';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';
import { renderConstellation as renderPackaged } from '../packages/core/src/core-api.mjs';

const roles = ['featured', 'supporting', 'experimental', 'historical'];
const ringRepositories = count => Array.from({ length: count }, (_, i) => ({
  name: `r${i}`, full_name: `example/r${i}`, language: `L${i}`, languages: { [`L${i}`]: 100 },
  topics: [`t${i}`], private: false, created_at: '2020-01-01',
}));
const ringRoles = repos => Object.fromEntries(repos.map((repo, i) => [repo.full_name, { role: roles[i % roles.length] }]));

test('rings preserve each assigned point across counts, views, rotations, hidden nodes and editing snap settings', () => {
  for (const count of [3, 10, 100]) for (const nodeMode of ['repositories', 'combined', 'languages', 'topics'])
    for (const layout of ['atlas', 'compact']) for (const snapToRings of [undefined, true, false]) {
      const repos = ringRepositories(count);
      const options = { arrangement: 'rings', maxRepos: count, nodeMode, layout, snapToRings,
        ringRotations: [17, 73, 191, 309], projectShowcase: ringRoles(repos),
        hiddenNodes: ['example/r1', 'language:L1', 'topic:t1'],
      };
      const scene = createScene('example', repos, options);
      assert.equal(scene.geometry.ringPoints.length, scene.nodes.length * 3);
      scene.nodes.forEach((node, index) => {
        const points = scene.geometry.ringPoints;
        const x = 450 + (points[index * 3] - 240) * 368 / 172;
        const y = (layout === 'compact' ? 126 : 270) + (points[index * 3 + 1] - 240) * (layout === 'compact' ? 88 : 192) / 172;
        assert.ok(Math.abs(node.geometry.x - x) < 1e-6 && Math.abs(node.geometry.y - y) < 1e-6,
          `${count}/${nodeMode}/${layout}: ${node.id} must occupy its own point, including hidden reservations`);
      });
      const changed = createScene('example', repos, { ...options, nodeColors: { 'example/r0': '#ffffff' } });
      assert.deepEqual(changed.nodes.map(node => node.geometry), scene.nodes.map(node => node.geometry));
    }
});

test('animated showcase nodes stay on their points in screen coordinates', { skip: !browser, timeout: 120000 }, async t => {
  const { evaluate } = await openBrowser(t, 'about:blank');
  const repos = ringRepositories(10);
  for (const mode of ['spin', 'sway']) for (const [layout, exportProfile] of [
    ['atlas', 'custom'], ['compact', 'custom'], ['atlas', 'square'], ['compact', 'wide'],
  ]) {
    const svg = renderConstellation('example', repos, {
      arrangement: 'rings', layout, exportProfile, projectShowcase: ringRoles(repos),
      ringRotations: [17, 73, 191, 309], hiddenNodes: ['example/r1'],
      perspective: { enabled: true, horizontal: 30, vertical: 45, zoom: 90 },
      ringAnimation: { enabled: true, modes: [mode, mode, mode, mode],
        speeds: [1, 2, 3, 4], directions: ['clockwise', 'counterclockwise', 'clockwise', 'counterclockwise'] },
    });
    await evaluate(`document.body.innerHTML = ${JSON.stringify(svg)}`);
    for (const seconds of [0, 7, 15]) {
      const distances = await evaluate(`(async () => {
        const svg = document.querySelector('svg');
        svg.pauseAnimations(); svg.setCurrentTime(${seconds});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const screen = el => new DOMPoint(el.cx.animVal.value, el.cy.animVal.value).matrixTransform(el.getScreenCTM());
        return [...document.querySelectorAll('.identity-point')].filter(point => point.dataset.node !== 'example/r1').map(point => {
          const node = [...document.querySelectorAll('.star')].find(node => node.dataset.repo === point.dataset.node);
          const a = screen(node), b = screen(point);
          return { id: point.dataset.node, distance: Math.hypot(a.x - b.x, a.y - b.y) };
        });
      })()`);
      assert.equal(distances.length, 9);
      for (const { id, distance } of distances) assert.ok(distance < .2,
        `${mode}/${layout}/${exportProfile}/${seconds}s: ${id} is ${distance}px from its point`);
    }
  }
});

test('rings manual override and reset agree with SVG and workflow export', () => {
  const repos = ringRepositories(10);
  const options = { arrangement: 'rings', ringRotation: 137, snapToRings: true, projectShowcase: ringRoles(repos) };
  const base = createScene('example', repos, options);
  const moved = createScene('example', repos, { ...options, starPositions: { 'example/r0': { x: 333, y: 155 } } });
  assert.equal(moved.nodes.find(node => node.id === 'example/r0').geometry.x, 333);
  assert.equal(moved.nodes.find(node => node.id === 'example/r0').geometry.y, 155);
  assert.deepEqual(createScene('example', repos, { ...options, starPositions: {}, labelOffsets: {} }).nodes.map(node => node.geometry), base.nodes.map(node => node.geometry));
  const animated = { ...options, ringAnimation: { enabled: true } };
  const svg = renderConstellation('example', repos, animated);
  assert.equal(renderPackaged('example', repos, animated), svg, 'the CLI/core package must carry the same fix');
  const restored = JSON.parse(renderWorkflow('example', animated).split('          config-json: |\n')[1]);
  assert.equal(renderConstellation('example', repos, restored), svg);
  const groups = [...svg.matchAll(/<g class="repository(?: [^"]*)?"[^>]*>[\s\S]*?<\/g>/g)];
  assert.equal(groups.length, 10);
  for (const [group] of groups) {
    assert.match(group, /attributeName="cx"/, 'role classes must not exclude nodes from ring motion');
    assert.match(group, /attributeName="cy"/);
  }
});
