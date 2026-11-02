import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from '../src/constellation.mjs';
import { semanticGraphFromScene } from '../src/semantic-graph.mjs';
import { generateStoryCandidates } from '../src/story-candidates.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { labelOwnershipRecords, labelOwnershipShowcase as showcase } from './fixtures/story-label-ownership.mjs';

const referenceDate = '2026-10-01T00:00:00Z';
const manual = { 'owner/project-01': { x: 300, y: 300 }, 'owner/project-02': { x: 600, y: 120 }, 'owner/project-10': { x: 150, y: 420 } };

function storyScene(records, extra = {}) {
  const graph = semanticGraphFromScene(createScene('owner', records, { nodeMode: 'repositories', showOther: true, projectShowcase: showcase, seed: 'ownership', theme: 'light', referenceDate }));
  return generateStoryCandidates(graph, { projectShowcase: showcase, seed: 'ownership', referenceDate, ...extra }).find(item => item.id === 'projects');
}
const withProfile = (scene, exportProfile) => ({ ...scene, presentation: { ...scene.presentation, options: { ...scene.presentation.options, exportProfile } } });
const projectIds = svg => [...new Set([...svg.matchAll(/<circle class="star[^"]*"[^>]*data-repo="([^"]+)"/g)].map(match => match[1]))].sort();
const labels = svg => new Map([...svg.matchAll(/<text class="repo-label[^"]*" data-repo="([^"]+)"[^>]*>/g)].map(match => [match[1], /display:none/.test(match[0])]));
const shown = svg => [...labels(svg)].filter(([, hidden]) => !hidden).map(([id]) => id).sort();

test('compact budget ranks automatic labels and never spends capacity on manual labels', () => {
  const candidate = storyScene(labelOwnershipRecords, { labelPositions: manual });
  // The default profile has no Story Clarity pass, isolating the budget policy.
  const svg = renderSceneSVG(withProfile(candidate.scene, 'default'), { targetWidth: 480 });
  const visible = shown(svg);
  for (const id of Object.keys(manual)) assert.ok(visible.includes(id), `manual label ${id} is protected`);
  const automatic = visible.filter(id => !Object.hasOwn(manual, id));
  assert.equal(automatic.length, 8, 'protected labels do not consume the eight automatic slots');
  for (const [id, { role }] of Object.entries(showcase)) {
    if (!Object.hasOwn(manual, id)) assert.ok(visible.includes(id), `${role} label ${id} outranks ordinary labels`);
  }
  assert.deepEqual(automatic.filter(id => !showcase[id]), ['owner/project-09'], 'ordinary labels fill remaining slots by stable ID');
  assert.equal(projectIds(svg).length, 12, 'label budget never removes project nodes');
});

test('Story Clarity never suppresses manual or explicitly hidden label choices', () => {
  const hiddenLabels = ['owner/project-00', 'owner/project-11'];
  const overlap = { 'owner/project-05': { x: 300, y: 300 }, 'owner/project-10': { x: 306, y: 301 } };
  const candidate = storyScene(labelOwnershipRecords, { labelPositions: overlap, hiddenLabels });
  for (const width of [480, 900]) {
    const svg = renderSceneSVG(withProfile(candidate.scene, 'readme'), { targetWidth: width });
    const rendered = labels(svg);
    for (const id of Object.keys(overlap)) assert.equal(rendered.get(id), false, `${width}px keeps overlapping manual label ${id}`);
    for (const id of hiddenLabels) assert.notEqual(rendered.get(id), false, `${width}px keeps ${id} hidden`);
    assert.match(svg, /data-label-limitation="manual-labels-overlap"/, 'overcrowded manual labels are reported, not changed');
    assert.equal(projectIds(svg).length, 12);
  }
  const unmanaged = renderSceneSVG(withProfile(storyScene(labelOwnershipRecords).scene, 'readme'), { targetWidth: 480 });
  assert.doesNotMatch(unmanaged, /data-label-limitation/);
});

test('compact and wide exports share project identities and the source-scene fingerprint', () => {
  const candidate = storyScene(labelOwnershipRecords, { labelPositions: manual });
  const reordered = storyScene([...labelOwnershipRecords].reverse(), { labelPositions: manual });
  assert.equal(reordered.sceneFingerprint, candidate.sceneFingerprint, 'input order does not change the selected story');
  const outputs = [480, 900].map(width => renderSceneSVG(withProfile(candidate.scene, 'readme'), { targetWidth: width }));
  assert.equal(projectIds(outputs[0]).length, 12, 'the 12-project Profile Story cap is retained');
  assert.deepEqual(projectIds(outputs[0]), projectIds(outputs[1]));
  assert.notEqual(outputs[0], outputs[1], 'SVG output is width-specific even though the source scene is shared');
  for (const width of [480, 900]) {
    assert.equal(renderSceneSVG(withProfile(reordered.scene, 'readme'), { targetWidth: width }),
      renderSceneSVG(withProfile(candidate.scene, 'readme'), { targetWidth: width }), `${width}px export is independent of input order`);
  }
});
