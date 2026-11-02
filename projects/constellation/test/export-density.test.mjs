import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from '../src/core-api.mjs';
import { buildSemanticHierarchy, projectSemanticLevel } from '../src/semantic-groups.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { renderSceneHTML } from '../src/renderer-html.mjs';
import { aggregateEdgeStyle, applyStaticExportDensity, exportDensityPolicy, groupRadius, README_GROUP_THRESHOLD } from '../src/export-density.mjs';

function groupedScene(count = 45, groupCount = 9, options = {}) {
  const repositories = Array.from({ length: count }, (_, i) => ({
    full_name: `dense/project-${String(i).padStart(4, '0')}`,
    name: `project-${String(i).padStart(4, '0')}`,
    language: i % 2 ? 'Rust' : 'JavaScript',
    topics: ['dense-export', `topic-${i % 4}`],
    stargazers_count: count - i,
  }));
  const membersPerGroup = Math.ceil(count / groupCount);
  const projectFamilies = Object.fromEntries(Array.from({ length: groupCount }, (_, index) => {
    const members = repositories.slice(index * membersPerGroup, (index + 1) * membersPerGroup).map(repo => repo.full_name);
    return [`family-${String(index).padStart(2, '0')}`, { label: `Family ${String(index).padStart(2, '0')}`, members }];
  }).filter(([, family]) => family.members.length >= 2));
  const scene = createScene('dense', repositories, { exportProfile: 'readme', animate: false, maxRepos: count, nodeCap: count, projectFamilies, ...options });
  const hierarchy = buildSemanticHierarchy(scene, { projectFamilies });
  return { scene, hierarchy, grouped: projectSemanticLevel(scene, 'groups', { hierarchy }) };
}

test('README density policy responds deterministically to viewport width and node density', () => {
  assert.equal(README_GROUP_THRESHOLD, 30);
  const policies = [600, 720, 900].map(width => exportDensityPolicy({ profile: 'readme', width, nodeCount: 100, groupCount: 12 }));
  assert.deepEqual(policies.map(policy => policy.maxLabels), [18, 25, 36]);
  assert.ok(policies[0].maxLabels >= 12);
  assert.ok(policies[0].maxLabels <= policies[1].maxLabels && policies[1].maxLabels <= policies[2].maxLabels);
  assert.equal(exportDensityPolicy({ profile: 'custom', width: 600, nodeCount: 100 }).enabled, false);
  assert.deepEqual(exportDensityPolicy({ profile: 'readme', width: 720, nodeCount: 100 }), exportDensityPolicy({ profile: 'readme', width: 720, nodeCount: 100 }));
});

test('small and dense grouped export fixtures stay bounded and explicit project intent wins', () => {
  for (const [projects, groups] of [[12, 3], [256, 16]]) {
    const { scene, hierarchy } = groupedScene(projects, groups);
    const svg = renderSceneSVG(scene, { semanticLevel: 'groups' });
    assert.equal((svg.match(/<circle class="star"[^>]*data-kind="semantic-group"/g) || []).length, hierarchy.groups.length);
    assert.ok(svg.length < 2_000_000);
    assert.equal(svg, renderSceneSVG(scene, { semanticLevel: 'groups' }));
  }
  const belowThreshold = groupedScene(24, 6).scene;
  assert.doesNotMatch(renderSceneSVG(belowThreshold), /data-kind="semantic-group"/);
  const thresholdScene = groupedScene(README_GROUP_THRESHOLD, 6).scene;
  assert.match(renderSceneSVG(thresholdScene), /data-kind="semantic-group"/);
  const explicitConfig = groupedScene(45, 9, { semanticZoom: { mode: 'projects' } }).scene;
  assert.doesNotMatch(renderSceneSVG(explicitConfig), /data-kind="semantic-group"/);
});

test('group radii and aggregate-edge weights scale monotonically within documented caps', () => {
  const radii = [2, 8, 64, 2048].map(value => groupRadius(value));
  assert.ok(radii[0] < radii[1] && radii[1] < radii[2] && radii[2] <= radii[3]);
  assert.equal(radii[0], 14.1);
  assert.equal(radii.at(-1), 22);
  const weights = [1, 8, 128, 100000].map(value => aggregateEdgeStyle(value));
  assert.ok(weights[0].width < weights[1].width && weights[1].width < weights[2].width && weights[2].width <= weights[3].width);
  assert.ok(weights.every(item => item.width >= .65 && item.width <= 2.2 && item.opacity >= .22 && item.opacity <= .68));
  assert.deepEqual(weights[0], aggregateEdgeStyle(1));
});

test('static label selection keeps groups and user-curated labels ahead of projects', () => {
  const { scene, hierarchy } = groupedScene(45, 9, { projectShowcase: { 'dense/project-0000': { role: 'featured', priority: 1 } } });
  const grouped = projectSemanticLevel(scene, 'groups', { hierarchy, expanded: [hierarchy.groups[0].id] });
  const policy = exportDensityPolicy({ profile: 'readme', width: 600, nodeCount: grouped.nodes.length, groupCount: 8 });
  policy.maxLabels = 10;
  const prioritized = applyStaticExportDensity(grouped, policy);
  const visible = prioritized.labels.filter(label => !label.hidden);
  assert.equal(visible.filter(label => prioritized.nodes.find(node => node.id === label.id)?.metadata.nodeKind === 'semantic-group').length, 8);
  assert.ok(visible.some(label => label.id === 'dense/project-0000'));
  assert.ok(visible.length <= 10);
  assert.equal(new Set(visible.map(label => label.id)).size, visible.length);
  assert.equal(prioritized.labels.filter(label => label.hidden).length > 0, true);
});

test('group-only export refinement reduces label collisions without changing group identity or membership', () => {
  const { grouped } = groupedScene(100, 12);
  const before = grouped.semanticGroups.groups.map(group => [group.id, group.members]);
  const styled = applyStaticExportDensity(grouped, exportDensityPolicy({ profile: 'readme', width: 600, nodeCount: grouped.nodes.length, groupCount: 12 }));
  const groupLabels = styled.labels.filter(label => styled.nodes.find(node => node.id === label.id)?.metadata.nodeKind === 'semantic-group');
  const bounds = label => ({ left: label.x - label.text.length * 2.85 - 4, right: label.x + label.text.length * 2.85 + 4, top: label.y - 10, bottom: label.y + 3 });
  for (let i = 0; i < groupLabels.length; i++) for (let j = i + 1; j < groupLabels.length; j++) {
    const a = bounds(groupLabels[i]), b = bounds(groupLabels[j]);
    assert.equal(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top, false, `${groupLabels[i].text} overlaps ${groupLabels[j].text}`);
  }
  assert.deepEqual(styled.semanticGroups.groups.map(group => [group.id, group.members]), before);
});

test('README grouped SVG is stable at common widths, bounded, accessible and PNG-source ready', () => {
  const { scene, hierarchy, grouped } = groupedScene();
  const before = JSON.stringify(grouped);
  for (const width of [600, 720, 900]) {
    const widthScene = structuredClone(grouped);
    widthScene.viewport.width = width;
    const svg = renderSceneSVG(widthScene, { semanticLevel: 'projects' });
    assert.match(svg, new RegExp(`<svg[^>]*width="${width}"`));
    assert.match(svg, /Group size reflects member count within a bounded visual range/);
    assert.match(svg, /Aggregate edge visual weight reflects the number of represented source relationships/);
    assert.match(svg, /weight = represented relationships/);
    assert.match(svg, /static-export-legend/);
    assert.match(svg, /data-kind="semantic-group"/);
    assert.match(svg, /clip-path:polygon\(50% 0%/);
    assert.match(svg, /viewBox="0 0 900 \d+"/);
    const visibleLabels = [...svg.matchAll(/<text class="repo-label"([^>]*)>(.*?)<\/text>/g)].filter(([, attrs]) => !attrs.includes('display:none'));
    const groupLabels = visibleLabels.filter(([, attrs]) => grouped.nodes.find(node => attrs.includes(`data-repo="${node.id}"`))?.metadata.nodeKind === 'semantic-group');
    assert.equal(groupLabels.length, hierarchy.groups.length);
    assert.ok(visibleLabels.length <= 36);
    const renderedGroupRadii = [...svg.matchAll(/<circle class="star"([^>]*)>/g)].filter(([, attrs]) => attrs.includes('data-kind="semantic-group"')).map(([, attrs]) => Number(attrs.match(/\br="([\d.]+)"/)?.[1]));
    assert.ok(renderedGroupRadii.every(radius => radius >= 12 && radius <= 22));
    const aggregateStyles = [...svg.matchAll(/<path class="shared-language" style="([^"]+)"[^>]*data-from="group:/g)].map(([, style]) => Number(style.match(/stroke-width:([\d.]+)/)?.[1]));
    assert.ok(aggregateStyles.every(value => value >= .65 && value <= 2.2));
    assert.equal(svg, renderSceneSVG(widthScene, { semanticLevel: 'projects' }));
    const mixed = projectSemanticLevel(scene, 'groups', { hierarchy, expanded: [hierarchy.groups[0].id] });
    mixed.viewport.width = width;
    const mixedSvg = renderSceneSVG(mixed, { semanticLevel: 'projects' });
    assert.match(mixedSvg, /data-kind="repository"/);
    const projectRadii = [...mixedSvg.matchAll(/<circle class="star"([^>]*)>/g)].filter(([, attrs]) => attrs.includes('data-kind="repository"')).map(([, attrs]) => Number(attrs.match(/\br="([\d.]+)"/)?.[1]));
    assert.ok(projectRadii.length > 0 && projectRadii.every(radius => radius <= 4.2));
    assert.match(mixedSvg, /<title>dense\/project-/);
  }
  assert.equal(JSON.stringify(grouped), before, 'static export styling must not mutate the canonical projection');
  const interactiveSvg = renderSceneSVG(grouped, { semanticLevel: 'projects', interactive: true });
  assert.doesNotMatch(interactiveSvg, /static-export-legend/);
  assert.doesNotMatch(interactiveSvg, /Group size reflects member count within a bounded visual range/);
  const offline = renderSceneHTML(scene, { semanticLevel: 'groups' });
  assert.doesNotMatch(offline, /static-export-legend/);
  assert.match(offline, /Content-Security-Policy/);
  assert.match(offline, /data-semantic-expand/);
  const automatic = renderSceneSVG(scene);
  assert.match(automatic, /data-kind="semantic-group"/);
  const explicitProjects = renderSceneSVG(scene, { semanticLevel: 'projects' });
  assert.doesNotMatch(explicitProjects, /data-kind="semantic-group"/);
});

test('large authored grouped export keeps node, label and SVG bounds without quadratic label work', () => {
  const { grouped } = groupedScene(2048, 32);
  grouped.viewport.width = 600;
  const started = performance.now();
  const svg = renderSceneSVG(grouped, { semanticLevel: 'projects' });
  const elapsed = performance.now() - started;
  const labels = [...svg.matchAll(/<text class="repo-label"([^>]*)>/g)].filter(([, attrs]) => !attrs.includes('display:none'));
  assert.equal((svg.match(/class="star"/g) || []).length, grouped.nodes.length);
  assert.ok(labels.length <= 18);
  for (const node of grouped.nodes.filter(node => node.metadata.nodeKind === 'semantic-group')) assert.ok(svg.includes(`<title>${node.metadata.name} ·`), `accessible title retained for ${node.metadata.name}`);
  assert.ok(svg.length < 2_000_000);
  assert.ok(elapsed < 5000, `dense export took ${elapsed.toFixed(1)} ms`);
});
