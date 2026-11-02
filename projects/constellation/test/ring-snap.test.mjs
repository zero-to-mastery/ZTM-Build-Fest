import test from 'node:test';
import assert from 'node:assert/strict';
import { identityPoints, identityGeometry } from '../src/engine.mjs';
import { snapPair } from '../src/label-editor.mjs';
import { renderConstellation } from '../src/constellation.mjs';

test('sparse ring layouts visit each ring before repeating a ring', () => {
  const radii = [0, 1, 2, 3].map(i => identityGeometry('sparse')[2 + i * 22]);
  const points = identityPoints('sparse', 256), counts = [0, 0, 0, 0];
  for (let i = 0; i < points.length; i += 3) {
    const radius = Math.hypot(points[i] - 240, points[i + 1] - 240);
    const ring = radii.findIndex(value => Math.abs(value - radius) < .002);
    assert.equal(counts[ring], Math.min(...counts)); counts[ring]++;
  }
  assert.deepEqual(counts, [64, 64, 64, 64]);
});

test('Rust adds ring capacity without changing existing identity points', () => {
  const original = identityPoints('octocat', 24);
  const expanded = identityPoints('octocat', 256);
  assert.equal(expanded.length, 256 * 3);
  assert.deepEqual(expanded.slice(0, 72), original);
  assert.deepEqual(identityPoints('octocat', 100), expanded.slice(0, 300));
  const radii = [0, 1, 2, 3].map(i => identityGeometry('octocat')[2 + i * 22]);
  const locations = new Set();
  for (let i = 0; i < expanded.length; i += 3) {
    const [x, y] = expanded.slice(i, i + 2);
    locations.add(`${x}:${y}`);
    assert.ok(radii.some(radius => Math.abs(Math.hypot(x - 240, y - 240) - radius) < .002));
  }
  assert.equal(locations.size, 256);
  for (const count of [0, 1, 2, 3, 6, 23, 24, 25, 100, 256]) {
    assert.equal(identityPoints('octocat', count).length, count * 3);
    assert.deepEqual(identityPoints('octocat', count), expanded.slice(0, count * 3));
  }
});

test('three nodes have three corresponding points, and hidden nodes hide their own point', () => {
  const repos = ['a', 'b', 'c'].map(name => ({ name, full_name: `o/${name}`, language: 'Rust' }));
  const svg = renderConstellation('octocat', repos);
  const points = [...svg.matchAll(/class="identity-point" data-node="([^"]+)"[^>]*data-snap-x="([\d.]+)" data-snap-y="([\d.]+)"/g)];
  assert.equal(points.length, 3);
  for (const [, id, x, y] of points) {
    assert.ok(svg.includes(`class="star" cx="${Number(x).toFixed(1)}" cy="${Number(y).toFixed(1)}"`));
    assert.ok(repos.some(repo => repo.full_name === id));
  }
  const hidden = renderConstellation('octocat', repos, { hiddenNodes: ['o/b'] });
  assert.match(hidden, /class="identity-point" data-node="o\/b" style="display:none"/);
  assert.equal((hidden.match(/class="identity-point" data-node="[^"]+" cx=/g) || []).length, 2);
  assert.ok(!renderConstellation('octocat', []).includes('class="identity-point"'));
});

test('ring rotation preserves count and radii and keeps default nodes on their points', () => {
  const base = identityPoints('octocat', 3);
  const rotated = identityPoints('octocat', 3, 90);
  assert.equal(rotated.length, base.length);
  for (let i = 0; i < base.length; i += 3) {
    assert.ok(Math.abs(rotated[i] - (480 - base[i + 1])) < .002);
    assert.ok(Math.abs(rotated[i + 1] - base[i]) < .002);
  }
  assert.deepEqual(identityPoints('octocat', 3, 360), base);
  const repos = ['a', 'b', 'c'].map(name => ({ name, full_name: `o/${name}`, language: 'Rust' }));
  for (const layout of ['atlas', 'compact']) {
    const svg = renderConstellation('octocat', repos, { ringRotation: 137, layout });
    const anchors = [...svg.matchAll(/data-snap-x="([\d.]+)" data-snap-y="([\d.]+)"/g)];
    assert.equal(anchors.length, 3);
    for (const [, x, y] of anchors) assert.ok(svg.includes(`class="star" cx="${Number(x).toFixed(1)}" cy="${Number(y).toFixed(1)}"`));
  }
  for (const ringRotation of [-1, 361, '90', NaN]) assert.throws(() => renderConstellation('octocat', repos, { ringRotation }), /ringRotation/);
});

test('independent sliders change only points belonging to their ring, including added points', () => {
  const base = identityPoints('octocat', 256);
  const radii = [0, 1, 2, 3].map(i => identityGeometry('octocat')[2 + i * 22]);
  for (let ring = 0; ring < 4; ring++) {
    const rotations = [0, 0, 0, 0]; rotations[ring] = 90;
    const shifted = identityPoints('octocat', 256, rotations);
    let changed = 0;
    for (let i = 0; i < base.length; i += 3) {
      const belongs = Math.abs(Math.hypot(base[i] - 240, base[i + 1] - 240) - radii[ring]) < .002;
      if (belongs) { assert.notDeepEqual(shifted.slice(i, i + 3), base.slice(i, i + 3)); changed++; }
      else assert.deepEqual(shifted.slice(i, i + 3), base.slice(i, i + 3));
    }
    assert.ok(changed > 6);
  }
  for (const ringRotations of [[], [0, 0, 0], [0, 0, 0, 361], [0, 0, 0, '90']]) {
    assert.throws(() => renderConstellation('octocat', [], { ringRotations }), /ringRotations/);
  }
});

test('ring arcs rotate independently and connection paths and gradients track node endpoints', () => {
  const repos = Array.from({ length: 30 }, (_, i) => ({ name: `r${i}`, full_name: `o/r${i}`, language: 'Rust' }));
  const base = renderConstellation('octocat', repos, { colorConnections: true });
  const rotations = [0, 73, 0, 0];
  const rotated = renderConstellation('octocat', repos, { ringRotations: rotations, colorConnections: true });
  const arcs = svg => [...svg.matchAll(/class="identity-arc" data-ring="(\d)"[^>]*rotate\(([\d.]+)/g)].map(match => Number(match[2]));
  assert.deepEqual(arcs(rotated), arcs(base).map((angle, i) => (angle + rotations[i]) % 360));
  assert.notEqual(rotated, base);
  const nodes = new Map([...rotated.matchAll(/class="star" cx="([\d.]+)" cy="([\d.]+)"[^>]*data-repo="([^"]+)"/g)].map(([, x, y, id]) => [id, [x, y]]));
  const edges = [...rotated.matchAll(/<path class="shared-language"[^>]*data-from="([^"]+)" data-to="([^"]+)"[^>]* d="M([\d.]+) ([\d.]+)Q[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/g)];
  assert.ok(edges.length > 0);
  for (const [, from, to, x1, y1, x2, y2] of edges) {
    assert.deepEqual([x1, y1], nodes.get(from));
    assert.deepEqual([x2, y2], nodes.get(to));
    assert.ok(rotated.includes(`x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`));
  }
});

test('snapping reserves occupied points and preserves the node-label offset', () => {
  const origin = { x: 100, y: 100 }, label = { x: 100, y: 117, halfWidth: 20 };
  const points = [{ x: 200, y: 150, occupied: ['other'] }, { x: 210, y: 150, occupied: [] }];
  const pair = snapPair(origin, { x: 201, y: 151 }, label, 560, points, 'self');
  assert.deepEqual(pair, { star: { x: 210, y: 150 }, label: { x: 210, y: 167 } });
  assert.deepEqual(snapPair(origin, { x: 300, y: 300 }, label, 560, points, 'self').star, { x: 210, y: 150 });
  assert.deepEqual(snapPair(origin, { x: 201, y: 151 }, label, 560, points, 'other').star, { x: 200, y: 150 });
});

test('rendered ring points grow with nodes and hidden nodes keep their reservation', () => {
  const repos = Array.from({ length: 45 }, (_, i) => ({ name: `r${i}`, full_name: `o/r${i}`, language: 'Rust' }));
  const svg = renderConstellation('octocat', repos, { arrangement: 'field' });
  assert.equal((svg.match(/class="identity-point"/g) || []).length, 45);
  const point = svg.match(/data-snap-x="([\d.]+)" data-snap-y="([\d.]+)"/);
  const hidden = renderConstellation('octocat', repos, { arrangement: 'field', hiddenNodes: ['o/r0'], starPositions: { 'o/r0': { x: Number(point[1]), y: Number(point[2]) } }, snapToRings: true });
  assert.match(hidden, /data-occupied="\[&quot;o\/r0&quot;\]"/);
});

test('default arrangement assigns every node its own exact ring point in both formats', () => {
  const repos = Array.from({ length: 100 }, (_, i) => ({ name: `r${i}`, full_name: `o/r${i}`, language: `L${i}`, topics: [`t${i}`] }));
  for (const layout of ['atlas', 'compact']) {
    const options = { maxRepos: 100, nodeMode: 'combined', layout };
    const svg = renderConstellation('octocat', repos, options);
    const anchors = new Set([...svg.matchAll(/data-snap-x="([\d.]+)" data-snap-y="([\d.]+)"/g)].map(match => `${match[1]}:${match[2]}`));
    const positions = [...svg.matchAll(/class="star" cx="([\d.]+)" cy="([\d.]+)"/g)].map(match => `${Number(match[1])}:${Number(match[2])}`);
    assert.equal(positions.length, 256);
    assert.equal(new Set(positions).size, 256);
    assert.ok(positions.every(position => anchors.has(position)));
    assert.equal(svg, renderConstellation('octocat', repos, { ...options, arrangement: 'rings' }));
    const moved = renderConstellation('octocat', repos, { ...options, starPositions: { 'o/r0': { x: 333, y: 155 } } });
    assert.match(moved, /class="star" cx="333.0" cy="155.0"[^>]*data-repo="o\/r0"/);
  }
});
