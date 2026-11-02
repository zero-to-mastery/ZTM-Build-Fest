import test from 'node:test';
import assert from 'node:assert/strict';
import { ringAnimationOptions, floatingAnimationOptions } from '../src/ring-animation.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import { renderWorkflow } from '../src/export.mjs';

const repos = Array.from({ length: 30 }, (_, i) => ({ name: `r${i}`, full_name: `o/r${i}`, language: i % 2 ? 'Rust' : 'CSS', languages: { Rust: 10, CSS: 20 } }));
test('ring animation validates speeds and directions and resolves linked settings', () => {
  const input = { enabled: true, linked: true, speeds: [2, 1, 0, 4], directions: ['counterclockwise', 'clockwise', 'clockwise', 'clockwise'] };
  assert.deepEqual(ringAnimationOptions(input).speeds, [2, 2, 2, 2]);
  assert.deepEqual(ringAnimationOptions(input).directions, Array(4).fill('counterclockwise'));
  assert.equal(input.speeds[1], 1);
  for (const bad of [{ speeds: [7, 0, 0, 0] }, { speeds: [1] }, { directions: ['bad', 'clockwise', 'clockwise', 'clockwise'] }, { enabled: 'yes' }]) assert.throws(() => ringAnimationOptions(bad), /Invalid ringAnimation/);
});

test('animated SVG carries independent motion, static reduced-motion fallback and export settings', () => {
  const options = { colorConnections: true, bridges: true, ringAnimation: { enabled: true, speeds: [1, 2, 0, 3], directions: ['clockwise', 'counterclockwise', 'clockwise', 'clockwise'] } };
  const svg = renderConstellation('octocat', repos, options);
  assert.match(svg, /dur="60s"/);
  assert.match(svg, /dur="30s"/);
  assert.match(svg, /to="-360 240 240"/);
  assert.match(svg, /<path class="shared-language"/);
  assert.match(svg, /attributeName="x1"/);
  assert.match(svg, /attributeName="x2"/);
  assert.match(svg, /class="ring-motion-still"/);
  assert.match(svg, /prefers-reduced-motion:reduce/);
  assert.ok(!svg.includes('<script'));
  const restored = JSON.parse(renderWorkflow('octocat', options).split('          config-json: |\n')[1]);
  assert.equal(renderConstellation('octocat', repos, restored), svg);
  const off = renderConstellation('octocat', repos, { ringAnimation: { enabled: false } });
  assert.ok(!off.includes('<animate'));
});

test('floating animation works without ring motion and follows free nodes rather than ring points', () => {
  const options = { arrangement: 'rings', starPositions: { 'o/r0': { x: 450, y: 270 } }, floatingAnimation: { enabled: true, mode: 'bob', amplitude: 12, duration: 8 }, colorConnections: true };
  const svg = renderConstellation('octocat', repos, options);
  assert.match(svg, /dur="8s"/);
  assert.ok(!svg.includes('<animateTransform'));
  const group = [...svg.matchAll(/<g class="repository"[^>]*>[\s\S]*?<\/g>/g)].find(match => match[0].includes('data-repo="o/r0"'))[0];
  assert.match(group, /attributeName="cy"/);
  const xValues = group.match(/attributeName="cx" values="([^"]+)"/)[1].split(';').map(Number);
  assert.ok(xValues.every(x => x === 450));
  const restored = JSON.parse(renderWorkflow('octocat', options).split('          config-json: |\n')[1]);
  assert.equal(renderConstellation('octocat', repos, restored), svg);
  for (const config of [{ amplitude: 25 }, { duration: 0 }, { mode: 'unknown' }]) assert.throws(() => floatingAnimationOptions(config), /floatingAnimation/);
});

test('custom ring sway and easing are exported as closed synchronized animation cycles', () => {
  const svg = renderConstellation('octocat', repos, { ringAnimation: { enabled: true, modes: ['sway', 'spin', 'spin', 'spin'], amplitudes: [45, 30, 30, 30], easing: ['smooth', 'linear', 'linear', 'linear'] } });
  const arc = svg.match(/class="identity-arc" data-ring="0"[\s\S]*?<\/circle>/)[0];
  const values = arc.match(/values="([^"]+)"/)[1].split(';').map(value => Number(value.split(' ')[0]));
  assert.equal(values[0], 0);
  assert.ok(Math.abs(values.at(-1)) < .001);
  assert.ok(Math.max(...values) <= 45 && Math.min(...values) >= -45);
  assert.ok(Math.max(...values) > 40 && Math.min(...values) < -40);
});

test('reduced-motion fallback covers exactly the fitted view, so it is not zoomed', () => {
  const svg = renderConstellation('octocat', repos, { ringAnimation: { enabled: true, speeds: [1, 1, 1, 1] } });
  const viewBox = svg.match(/^<svg[^>]* viewBox="([^"]+)"/)[1].split(' ').map(Number);
  assert.notDeepEqual(viewBox.slice(0, 2), [0, 0], 'the fixture uses a fitted, non-origin view');
  const still = svg.match(/<image class="ring-motion-still"([^>]*)\/>/)[1];
  const attr = (name) => Number(still.match(new RegExp(` ${name}="([^"]+)"`))?.[1] ?? 0);
  assert.deepEqual([attr('x'), attr('y'), attr('width'), attr('height')], viewBox);
});
