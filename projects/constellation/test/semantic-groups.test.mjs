import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticHierarchy, projectSemanticLevel, expandGroup, collapseGroup, explainGroup, createScene, explainEdge, parseConfig, serializeConfig } from '../src/core-api.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { renderSceneHTML } from '../src/renderer-html.mjs';
import { validateScene, serializeScene, parseScene } from '../src/scene.mjs';
import { createSemanticZoomState, resolveSemanticZoomMode, SEMANTIC_ZOOM_POLICY } from '../src/semantic-zoom.mjs';

test('semantic zoom uses hysteresis, stable thresholds and bounded explicit modes', () => {
  const zoom = createSemanticZoomState('groups');
  assert.equal(zoom.update(SEMANTIC_ZOOM_POLICY.groupsToProjects + 0.001).current, 'projects');
  for (const scale of [1.79, 1.81, 1.80, 1.79, 1.81]) assert.equal(zoom.update(scale).changed, false);
  assert.equal(zoom.update(SEMANTIC_ZOOM_POLICY.projectsToGroups - 0.001).current, 'groups');
  for (const scale of [1.44, 1.46, 1.45, 1.44, 1.46]) assert.equal(zoom.update(scale).changed, false);
  assert.equal(zoom.update(SEMANTIC_ZOOM_POLICY.groupsToOverview - 0.001).current, 'overview');
  assert.equal(zoom.update(SEMANTIC_ZOOM_POLICY.overviewToGroups + 0.001).current, 'groups');
  assert.equal(zoom.update(2, { allowProjects: false }).current, 'groups');
  assert.equal(resolveSemanticZoomMode({ mode: 'auto' }), 'auto');
  assert.equal(resolveSemanticZoomMode({ enabled: true, level: 'groups' }), 'groups');
  assert.equal(resolveSemanticZoomMode({ enabled: false, level: 'groups' }), 'projects');
  assert.equal(resolveSemanticZoomMode({ enabled: true, level: 'overview' }), 'groups');
  assert.equal(parseConfig({ version: 7, account: 'journey', options: { semanticZoom: { mode: 'auto' } } }).version, 7);
  assert.equal(resolveSemanticZoomMode(parseConfig({ version: 7, account: 'journey', options: { semanticZoom: { enabled: true, level: 'groups' } } }).options.semanticZoom), 'groups');
  assert.equal(resolveSemanticZoomMode(parseConfig({ version: 7, account: 'journey', options: { semanticZoom: { enabled: false, level: 'groups' } } }).options.semanticZoom), 'projects');
  assert.throws(() => parseConfig({ version: 7, account: 'journey', options: { semanticZoom: { mode: 'invalid' } } }), /semanticZoom/);
  assert.throws(() => zoom.update(Infinity), /finite positive/);
});

const repositories = [
  { full_name: 'journey/demo-a', name: 'demo-a', language: 'Rust', topics: ['tools'] },
  { full_name: 'journey/demo-b', name: 'demo-b', language: 'Rust', topics: ['tools'] },
  { full_name: 'journey/demo-c', name: 'demo-c', language: 'Rust', topics: ['tools'] },
  { full_name: 'elsewhere/other', name: 'other', language: 'JavaScript', topics: ['web'] },
];

test('project families are stable, persisted in config and explain user provenance', () => {
  const options = { projectFamilies: { 'open-tooling': { label: 'Open Tooling', members: ['journey/demo-a', 'journey/demo-b', 'journey/demo-c'] } } };
  const config = parseConfig({ version: 7, account: 'journey', ...options });
  assert.deepEqual(parseConfig(serializeConfig(config.account, config.options)).options.projectFamilies, options.projectFamilies);
  const scene = createScene('journey', repositories, options);
  const hierarchy = buildSemanticHierarchy(scene);
  const group = hierarchy.groups[0];
  assert.equal(group.id, 'group:user:open-tooling');
  assert.equal(group.label, 'Open Tooling');
  assert.equal(group.provenance, 'user');
  assert.deepEqual(group.members, ['journey/demo-a', 'journey/demo-b', 'journey/demo-c']);
  assert.match(explainGroup(hierarchy, group.id).summary, /Defined by you/);
  assert.equal(buildSemanticHierarchy(scene).groups[0].id, group.id);
  assert.equal(buildSemanticHierarchy(scene, { projectFamilies: {}, derive: false }).groups.length, 0);
  assert.throws(() => parseConfig({ version: 7, account: 'journey', projectFamilies: { a: { label: 'A', members: ['journey/demo-a', 'journey/demo-b'] }, b: { label: 'B', members: ['journey/demo-a', 'journey/demo-c'] } } }), /multiple project families/);
  assert.throws(() => parseConfig({ version: 7, account: 'journey', projectFamilies: { a: { label: 'A', members: ['Owner/Repo', 'owner/repo'] } } }), /unique/);
  assert.throws(() => parseConfig({ version: 7, account: 'journey', projectFamilies: { a: { label: 'A', members: ['Owner/Repo', 'Owner/Other'] }, b: { label: 'B', members: ['owner/repo', 'Elsewhere/Repo'] } } }), /multiple project families/);
  assert.equal(parseConfig({ version: 7, account: 'journey', projectFamilies: { a: { label: 'A', members: ['Owner/Repo', 'Elsewhere/Repo'] } } }).options.projectFamilies.a.members[0], 'Owner/Repo');
  assert.equal(renderSceneSVG(scene, { semanticLevel: 'groups' }).includes('Open Tooling'), true);
  const html = renderSceneHTML(scene, { semanticLevel: 'groups' });
  assert.match(html, /Open Tooling/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.match(html, /"groupingReason":\{"kind":"project-family","summary":"Defined by you\."/);
  assert.match(html, /"memberExamplesTruncated":false/);
  assert.match(renderSceneSVG(scene, { semanticLevel: 'groups' }), /Open Tooling · user-defined project family · 3 projects/);
  assert.match(renderSceneSVG(scene, { semanticLevel: 'groups' }), /user-defined project family/);
  const explanation = explainGroup(hierarchy, group.id);
  assert.deepEqual(explanation.groupingReason, { kind: 'project-family', summary: 'Defined by you.', provenance: 'user', count: 3, total: 3, evidence: [] });
  assert.equal(explanation.memberSummary, 'This project family contains 3 visible projects.');
  assert.equal(explanation.memberCount, 3);
  assert.equal(explanation.members.length, 3);
  assert.ok(explanation.characteristics.every(item => item.provenance === 'derived' && item.total === 3));
  assert.ok(explanation.characteristics.some(item => item.kind === 'language' && item.value === 'Rust' && item.count === 3));
  assert.ok(explanation.characteristics.some(item => item.kind === 'topic' && item.value === 'tools' && item.count === 3));
  const grouped = projectSemanticLevel(scene, 'groups', { hierarchy });
  assert.equal(grouped.semanticGroups.groups[0].explanation.groupingReason.provenance, 'user');
  assert.equal(parseScene(serializeScene(grouped)).semanticGroups.groups[0].explanation.memberCount, 3);
  const forgedCount = structuredClone(grouped); forgedCount.semanticGroups.groups[0].explanation.groupingReason.count = 999; forgedCount.semanticGroups.groups[0].explanation.groupingReason.total = 1;
  assert.equal(validateScene(forgedCount).valid, false);
  assert.throws(() => parseScene(JSON.stringify(forgedCount)), /explanation/);
  const forgedProvenance = structuredClone(grouped); forgedProvenance.semanticGroups.groups[0].explanation.groupingReason.provenance = 'source';
  assert.equal(validateScene(forgedProvenance).valid, false);
  const forgedMember = structuredClone(grouped); forgedMember.semanticGroups.groups[0].explanation.members[0].id = 'not-a-member';
  assert.equal(validateScene(forgedMember).valid, false);
  const forgedCharacteristics = structuredClone(grouped); forgedCharacteristics.semanticGroups.groups[0].explanation.characteristics.push(...Array.from({ length: 14 }, (_, i) => ({ kind: 'topic', value: `forged-${i}`, count: 1, total: 3, provenance: 'derived' })));
  assert.equal(validateScene(forgedCharacteristics).valid, false);
});

test('repository-owner grouping has stable identity, truthful evidence, and remains conservative', () => {
  const scene = createScene('journey', repositories, {});
  const hierarchy = buildSemanticHierarchy(scene);
  assert.equal(hierarchy.groups.length, 1);
  const group = hierarchy.groups[0];
  assert.equal(group.kind, 'repository-owner');
  assert.match(group.id, /^group:owner:/);
  assert.equal(group.provenance, 'derived');
  assert.deepEqual(group.members, ['journey/demo-a', 'journey/demo-b', 'journey/demo-c']);
  assert.deepEqual(group.basis, ['repository-owner:journey']);
  assert.deepEqual(buildSemanticHierarchy({ ...scene, nodes: [...scene.nodes].reverse(), edges: [...scene.edges].reverse() }).groups, hierarchy.groups);
  const filtered = [repositories[0], repositories[1], repositories[3], { full_name: 'another/other', name: 'other-2', language: 'JavaScript', topics: ['web'] }];
  const filteredIds = [repositories.slice(0, 2), [repositories[1], repositories[2]], [repositories[2], repositories[0]]].map(visible => buildSemanticHierarchy(createScene('journey', [...visible, ...filtered.slice(2)], {})).groups.find(item => item.kind === 'repository-owner').id);
  assert.deepEqual(filteredIds, [group.id, group.id, group.id]);
  assert.notEqual(buildSemanticHierarchy(createScene('journey', [{ ...repositories[0], full_name: 'elsewhere/demo-a' }, { ...repositories[1], full_name: 'elsewhere/demo-b' }, { ...repositories[2], full_name: 'elsewhere/demo-c' }, { ...repositories[3], full_name: 'another/other' }], {})).groups[0].id, group.id);
  const explanation = explainGroup(hierarchy, group.id);
  assert.match(explanation.basis[0], /^repository-owner:/);
  assert.doesNotMatch(explanation.basis.join(' '), /organization/i);
  assert.equal(explanation.groupingReason.provenance, 'derived');
  assert.deepEqual(explanation.groupingReason.evidence[0], { kind: 'repository-owner', value: 'journey', count: 3, total: 3 });
  assert.match(explanation.limitation, /does not imply that the projects have the same purpose/);
  assert.equal(explanation.memberSummary, 'All 3 visible projects share the repository owner: journey.');
  const ownerProjection = projectSemanticLevel(scene, 'groups', { hierarchy });
  const forgedOwner = structuredClone(ownerProjection);
  forgedOwner.semanticGroups.groups[0].explanation.groupingReason.provenance = 'user';
  assert.equal(validateScene(forgedOwner).valid, false);
  const ownerSvg = renderSceneSVG(scene, { semanticLevel: 'groups' });
  assert.match(ownerSvg, /journey · grouped by shared repository owner · 3 projects/);
  assert.match(ownerSvg, /journey, 3 projects, grouped by shared repository owner/);
  assert.doesNotMatch(ownerSvg, /same organization|organization group/i);
  assert.equal(buildSemanticHierarchy(createScene('journey', repositories.slice(0, 2).concat(filtered.slice(2)), {})).groups[0].id, group.id);
  assert.equal(buildSemanticHierarchy(scene, { projectFamilies: { family: { label: 'Family', members: repositories.slice(0, 3).map(repo => repo.full_name) } } }).groups.length, 1);
});

test('projection is reversible and aggregated edges reference only actual source edges', () => {
  const repos = [...repositories, { full_name: 'elsewhere/second', name: 'second', language: 'Rust', topics: ['tools'] }];
  const scene = createScene('journey', repos, { connectionBasis: 'languages', bridges: true });
  const hierarchy = buildSemanticHierarchy(scene, { projectFamilies: { journey: { label: 'Journey', members: ['journey/demo-a', 'journey/demo-b', 'journey/demo-c'] } } });
  const groupId = hierarchy.groups[0].id;
  const grouped = projectSemanticLevel(scene, 'groups', { hierarchy });
  assert.equal(validateScene(grouped).valid, true);
  assert.equal(grouped.nodes.some(node => node.id === groupId), true);
  assert.ok(grouped.evidence.subjects.some(subject => subject.kind === 'group' && subject.id === groupId));
  const edge = grouped.edges.find(item => item.metadata.aggregated);
  if (edge) {
    assert.ok(edge.metadata.memberEdges.every(id => scene.edges.some(source => source.id === id)));
    assert.equal(explainEdge(grouped, edge.id).summary, `${edge.metadata.relationshipCount} underlying relationships.`);
    assert.equal(explainEdge(grouped, edge.id).truncated, false);
  }
  const expanded = expandGroup(grouped, hierarchy, groupId);
  assert.equal(expanded.nodes.some(node => node.id === 'journey/demo-a'), true);
  assert.equal(expanded.nodes.some(node => node.id === groupId), false);
  assert.ok(expanded.evidence.subjects.some(subject => subject.kind === 'node' && subject.id === 'journey/demo-a'));
  assert.equal(expanded.edges.every(item => scene.edges.some(source => source.id === item.id) || item.metadata.aggregated), true);
  const collapsed = collapseGroup(expanded, hierarchy, groupId);
  assert.deepEqual(collapsed.nodes.map(node => node.id), grouped.nodes.map(node => node.id));
  const noRelationships = projectSemanticLevel({ ...scene, edges: [] }, 'groups', { hierarchy: buildSemanticHierarchy(scene, { projectFamilies: { journey: { label: 'Journey', members: ['journey/demo-a', 'journey/demo-b', 'journey/demo-c'] } } }) });
  assert.equal(noRelationships.edges.length, 0);
  assert.equal(parseSceneRoundTrip(grouped).semanticGroups.level, 'groups');
});

test('aggregate edge references cap at 256 while counts and truncation stay truthful', () => {
  const repos = [...Array.from({ length: 18 }, (_, i) => ({ full_name: `left/project-${i}`, name: `left-${i}`, language: 'Rust' })), ...Array.from({ length: 18 }, (_, i) => ({ full_name: `right/project-${i}`, name: `right-${i}`, language: 'Rust' }))];
  const families = { left: { label: 'Left', members: repos.slice(0, 18).map(repo => repo.full_name) }, right: { label: 'Right', members: repos.slice(18).map(repo => repo.full_name) } };
  const source = createScene('benchmark', repos, { projectFamilies: families });
  const cases = [12, 256, 900];
  for (const total of cases) {
    const edges = Array.from({ length: total }, (_, i) => ({ id: `real-edge:${i}`, from: repos[i % 18].full_name, to: repos[18 + (Math.floor(i / 18) % 18)].full_name, metadata: { sharedLanguages: ['Rust'], sharedTopics: i % 2 ? ['webassembly'] : [] }, geometry: { distance: 1 }, style: { primary: false } }));
    const scene = { ...source, edges };
    const hierarchy = buildSemanticHierarchy(scene, { derive: false });
    const grouped = projectSemanticLevel(scene, 'groups', { hierarchy });
    const aggregate = grouped.edges[0];
    const explanation = explainEdge(grouped, aggregate.id);
    assert.equal(aggregate.metadata.relationshipCount, total);
    assert.equal(aggregate.metadata.memberEdges.length, Math.min(total, 256));
    assert.ok(aggregate.metadata.memberEdges.every(id => edges.some(edge => edge.id === id)));
    assert.equal(explanation.relationshipCount, total);
    assert.equal(explanation.retainedEdgeCount, Math.min(total, 256));
    assert.equal(explanation.truncated, total > 256);
    assert.equal(explanation.examples.length, Math.min(total, 5));
    assert.ok(explanation.examples.every(example => edges.some(sourceEdge => sourceEdge.id === example.edgeId && sourceEdge.from === example.from && sourceEdge.to === example.to)));
    assert.deepEqual(explanation.universal.map(item => [item.kind, item.count, item.total]), [['language', total, total]]);
    assert.deepEqual(explanation.partial.map(item => [item.kind, item.value, item.count, item.total]), [['topic', 'webassembly', Math.floor(total / 2), total]]);
    assert.equal(validateScene(grouped).valid, true);
    if (total === 900) {
      assert.equal(parseScene(serializeScene(grouped)).edges[0].metadata.relationshipCount, 900);
      const mutate = fn => { const invalid = structuredClone(grouped); fn(invalid.edges.find(item => item.metadata.aggregated).metadata); return invalid; };
      const badCount = mutate(metadata => { metadata.relationshipEvidence[0].count = metadata.relationshipCount + 1; });
      const badRelationshipCount = mutate(metadata => { metadata.relationshipCount = -1; });
      const badMemberRefs = mutate(metadata => { metadata.memberEdges = Array.from({ length: 257 }, (_, i) => `forged:${i}`); });
      const badBound = mutate(metadata => { metadata.relationshipEvidence = Array.from({ length: 14 }, (_, i) => ({ kind: 'language', value: `Language ${i}`, normalized: `language ${i}`, count: 1, total: metadata.relationshipCount })); });
      const badExamples = mutate(metadata => { metadata.examples.push({ edgeId: 'extra-edge', from: 'left/project', to: 'right/project' }); });
      const badKind = mutate(metadata => { metadata.relationshipEvidence[0].kind = 'contributor'; });
      const badSecret = mutate(metadata => { metadata.relationshipEvidence[0].value = `ghp_${'A'.repeat(24)}`; metadata.relationshipEvidence[0].normalized = metadata.relationshipEvidence[0].value.toLowerCase(); });
      const badLong = mutate(metadata => { metadata.relationshipEvidence[0].value = 'x'.repeat(161); metadata.relationshipEvidence[0].normalized = metadata.relationshipEvidence[0].value.toLowerCase(); });
      for (const invalid of [badCount, badRelationshipCount, badMemberRefs, badBound, badExamples, badKind, badSecret, badLong]) assert.equal(validateScene(invalid).valid, false);
    }
  }
});

test('group characteristics are unique per project, exact, sorted, bounded and input-order independent', () => {
  const manyTopics = Array.from({ length: 10 }, (_, i) => `topic-${i}`);
  const records = Array.from({ length: 10 }, (_, i) => ({ full_name: `owner/p${i}`, name: `p${i}`, language: i === 9 ? undefined : i < 8 ? 'Rust' : 'JavaScript', languages: i === 9 ? undefined : { Rust: 20, ...(i === 0 ? { rust: 10 } : {}) }, topics: i === 9 ? undefined : [...manyTopics.slice(0, i < 7 ? 8 : 6), ...(i === 0 ? ['Rust'] : [])] }));
  const options = { projectFamilies: { family: { label: 'Family', members: records.map(item => item.full_name) } } };
  const first = buildSemanticHierarchy(createScene('x', records, options));
  const second = buildSemanticHierarchy(createScene('x', [...records].reverse(), options));
  const a = explainGroup(first, first.groups[0].id), b = explainGroup(second, second.groups[0].id);
  assert.deepEqual(a, b);
  assert.equal(a.characteristics.filter(item => item.kind === 'language').length, 2);
  assert.equal(a.characteristics.filter(item => item.kind === 'topic').length, 8);
  assert.equal(a.characteristics.find(item => item.value.toLowerCase() === 'rust' && item.kind === 'language').count, 9);
  assert.equal(a.characteristics.find(item => item.value === 'topic-0').count, 9);
  assert.ok(a.characteristics.every(item => item.total === a.memberCount));
  assert.deepEqual(a.characteristics.filter(item => item.kind === 'language').map(item => item.count), [9, 1]);
  const order = [...a.characteristics].sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind) || left.value.toLocaleLowerCase('en-US').localeCompare(right.value.toLocaleLowerCase('en-US')));
  assert.deepEqual(a.characteristics, order);
  assert.equal(a.memberCount, 9);
  assert.equal(a.members.length, 8);
  assert.equal(a.memberExamplesTruncated, true);
});

test('unsafe and oversized language/topic values are excluded from group and aggregate evidence', () => {
  const source = createScene('journey', repositories, {});
  const unsafe = structuredClone(source);
  const gh = `ghp_${'A'.repeat(24)}`, pat = `github_pat_${'B'.repeat(24)}`, bearer = `Bearer ${'C'.repeat(20)}`, long = 'L'.repeat(161);
  unsafe.nodes[0].metadata.language = gh;
  unsafe.nodes[0].metadata.languages = { [pat]: 12, Rust: 10, [long]: 4 };
  unsafe.nodes[0].metadata.topics = [bearer, long, 'safe-topic'];
  const ids = unsafe.nodes.map(item => item.id);
  unsafe.edges = [{ id: 'privacy-edge', from: ids[0], to: ids[2], metadata: { sharedLanguages: [gh, 'Rust'], sharedTopics: [bearer, long, 'safe-topic'] }, geometry: { distance: 1 }, style: { primary: false } }];
  const options = { projectFamilies: { first: { label: 'First', members: ids.slice(0, 2) }, second: { label: 'Second', members: ids.slice(2) } } };
  const hierarchy = buildSemanticHierarchy(unsafe, options);
  const grouped = projectSemanticLevel(unsafe, 'groups', { hierarchy });
  const groupEvidence = grouped.semanticGroups.groups.map(item => item.explanation);
  const aggregate = grouped.edges.find(item => item.metadata.aggregated);
  const evidenceText = JSON.stringify({ groupEvidence, relationshipEvidence: aggregate.metadata.relationshipEvidence, evidence: grouped.evidence });
  for (const value of [gh, pat, bearer, long]) assert.equal(evidenceText.includes(value), false);
  const projectedJson = serializeScene(grouped);
  for (const value of [gh, pat, bearer, long]) assert.equal(projectedJson.includes(value), false);
  assert.ok(groupEvidence.some(item => item.characteristics.some(value => value.value === 'Rust')));
  assert.ok(groupEvidence.some(item => item.characteristics.some(value => value.value === 'safe-topic')));
  assert.deepEqual(aggregate.metadata.relationshipEvidence.map(item => item.value), ['Rust', 'safe-topic']);
  const html = renderSceneHTML(unsafe, { semanticLevel: 'groups' });
  for (const value of [gh, pat, bearer, long]) assert.equal(html.includes(value), false);
});

test('aggregate relationship evidence separates universal from partial exact coverage', () => {
  const repos = [...Array.from({ length: 3 }, (_, i) => ({ full_name: `journey/a${i}`, name: `a${i}`, language: 'Rust', topics: ['webassembly'] })), ...Array.from({ length: 3 }, (_, i) => ({ full_name: `journey/b${i}`, name: `b${i}`, language: 'Rust', topics: ['webassembly'] }))];
  const source = createScene('journey', repos, {});
  const ids = source.nodes.map(item => item.id);
  const edges = Array.from({ length: 12 }, (_, i) => ({ id: `edge:${String(i).padStart(2, '0')}`, from: ids[i % 3], to: ids[3 + (i % 3)], metadata: { sharedLanguages: ['Rust'], sharedTopics: i < 8 ? ['webassembly'] : [] }, geometry: { distance: 1 }, style: { primary: false } }));
  const sceneWithEdges = { ...source, edges };
  const hierarchy = buildSemanticHierarchy(sceneWithEdges, { derive: false, projectFamilies: { left: { label: 'Left', members: ids.slice(0, 3) }, right: { label: 'Right', members: ids.slice(3) } } });
  const grouped = projectSemanticLevel(sceneWithEdges, 'groups', { hierarchy });
  const edge = grouped.edges[0], detail = explainEdge(grouped, edge.id);
  assert.equal(detail.relationshipCount, 12);
  assert.deepEqual(detail.universal.map(item => [item.kind, item.value, item.count, item.total]), [['language', 'Rust', 12, 12]]);
  assert.deepEqual(detail.partial.map(item => [item.kind, item.value, item.count, item.total]), [['topic', 'webassembly', 8, 12]]);
  assert.deepEqual(detail.examples.map(item => item.edgeId), edges.slice(0, 5).map(item => item.id));
  const reversedScene = { ...source, edges: [...edges].reverse() };
  const reordered = projectSemanticLevel(reversedScene, 'groups', { hierarchy: buildSemanticHierarchy(reversedScene, { derive: false, projectFamilies: { left: { label: 'Left', members: ids.slice(0, 3) }, right: { label: 'Right', members: ids.slice(3) } } }) });
  assert.deepEqual(explainEdge(reordered, reordered.edges[0].id), detail);
});

function parseSceneRoundTrip(scene) { return JSON.parse(serializeScene(scene)); }
