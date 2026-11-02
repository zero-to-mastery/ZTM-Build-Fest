import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createScene } from '../src/constellation.mjs';
import { semanticGraphFromScene } from '../src/semantic-graph.mjs';
import { generateStoryCandidates, generateBoundedProjectsFallback, recommendStoryCandidate, selectRepresentativeProjects, selectJourneyProjects, sceneQualityInput, sceneClarityInput } from '../src/story-candidates.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { evaluateGraphQuality, analyzeStoryClarity, STORY_CLARITY_VERSION } from '../src/engine.mjs';

const profiles = JSON.parse(await readFile(new URL('./fixtures/story-profiles.json', import.meta.url), 'utf8'));
function graphFor(profile) {
  const records = Array.from({ length: profile.projects }, (_, i) => ({
    full_name: `sample/repo-${String(i).padStart(2, '0')}`, name: `${profile.id} project ${i + 1}`,
    language: profile.languages.length ? profile.languages[i % profile.languages.length] : null,
    topics: profile.topics.length ? [profile.topics[i % profile.topics.length]] : [],
    created_at: profile.id === 'long-history' ? `${2010 + Math.floor(i / 6) * 4 + (i % 4)}-04-01T00:00:00Z` : null,
    ...(profile.id === 'long-history' ? { language: profile.languages[Math.floor(i / 6)] } : {}),
  }));
  return semanticGraphFromScene(createScene('sample', records, { seed: profile.id, showOther: true, nodeMode: 'repositories', referenceDate: '2026-01-01T00:00:00Z' }));
}

test('representative profile fixture inventory is deterministic and broad', () => {
  assert.equal(profiles.length, 10);
  assert.deepEqual(profiles.map(item => item.id), ['frontend-heavy','full-stack','polyglot-tooling','one-language-specialist','many-tiny-repos','sparse-metadata','long-history','mostly-forks','organization-contributor','small-portfolio']);
});

test('safe Projects fallback shares deterministic representatives and the hard export cap', () => {
  for (const count of [5, 30]) {
    const graph = graphFor({ id: `fallback-${count}`, projects: count, languages: ['Rust', 'JavaScript'], topics: ['tools'] });
    const before = JSON.stringify(graph);
    const fallbackOptions = { seed: 'stable', referenceDate: '2026-01-01T00:00:00Z' };
    const fallback = generateBoundedProjectsFallback(graph, fallbackOptions);
    const ids = fallback.scene.nodes.filter(node => node.metadata?.full_name && (!node.metadata?.nodeKind || node.metadata.nodeKind === 'repository')).map(node => node.id).sort();
    assert.ok(ids.length <= 12);
    assert.deepEqual(ids, selectRepresentativeProjects(graph.nodes.filter(node => node.kind === 'project')).map(node => node.id).sort());
    assert.equal(fallback.bounded, true);
    assert.equal(JSON.stringify(graph), before, 'projection does not mutate the semantic source');
    assert.equal(fallback.sceneFingerprint, generateBoundedProjectsFallback(graph, fallbackOptions).sceneFingerprint);
  }
});

test('one-language evidence keeps Projects as a safe recommendation', () => {
  const profile = profiles.find(item => item.id === 'one-language-specialist');
  const candidates = generateStoryCandidates(graphFor(profile), { seed: profile.id, referenceDate: '2026-01-01T00:00:00Z' });
  assert.equal(candidates.length, 3);
  assert.equal(recommendStoryCandidate(candidates).id, 'projects');
  assert.equal(candidates.find(item => item.id === 'technical-shape').available, false);
  assert.ok(candidates.find(item => item.id === 'technical-shape').quality.dimensions.differentiation < 0.25);
});

test('sparse metadata remains a usable Projects story and Journey is gated', () => {
  const profile = profiles.find(item => item.id === 'sparse-metadata');
  const candidates = generateStoryCandidates(graphFor(profile), { seed: profile.id, referenceDate: '2026-01-01T00:00:00Z' });
  assert.ok(candidates.find(item => item.id === 'projects').scene.nodes.length > 0);
  assert.equal(candidates.find(item => item.id === 'journey').available, false);
  assert.equal(recommendStoryCandidate(candidates).id, 'projects');
});

test('dated long history can produce a bounded Journey view', () => {
  const profile = profiles.find(item => item.id === 'long-history');
  const candidates = generateStoryCandidates(graphFor(profile), { seed: profile.id, referenceDate: '2026-01-01T00:00:00Z' });
  const journey = candidates.find(item => item.id === 'journey');
  assert.equal(journey.available, true);
  assert.equal(journey.scene.temporalStack.axis, 'year');
  assert.ok(journey.scene.temporalStack.layers.length <= 20);
});

test('small portfolios do not require thematic groups', () => {
  const profile = profiles.find(item => item.id === 'small-portfolio');
  const candidates = generateStoryCandidates(graphFor(profile), { seed: profile.id, referenceDate: '2026-01-01T00:00:00Z' });
  const projects = candidates.find(item => item.id === 'projects');
  assert.equal(projects.scene.nodes.filter(node => node.metadata?.full_name).length, 4);
  assert.equal(candidates.find(item => item.id === 'technical-shape').available, false);
  assert.equal(recommendStoryCandidate(candidates).id, 'projects');
});

test('Story Clarity is a deterministic final-scene diagnostic at compact and wide targets', () => {
  const graph = graphFor(profiles.find(item => item.id === 'full-stack'));
  const candidate = generateStoryCandidates(graph, { seed: 'clarity', referenceDate: '2026-01-01T00:00:00Z' }).find(item => item.id === 'projects');
  assert.equal(candidate.clarity.version, STORY_CLARITY_VERSION);
  assert.deepEqual(candidate.clarity, analyzeStoryClarity(sceneClarityInput(candidate.scene)));
  const compact = sceneClarityInput(candidate.scene);
  compact.width = 480;
  const wide = sceneClarityInput(candidate.scene);
  wide.width = 900;
  for (const input of [compact, wide]) {
    const first = analyzeStoryClarity(input);
    assert.deepEqual(first, analyzeStoryClarity(input));
    assert.ok(first.diagnostics.every(item => typeof item.code === 'string' && Array.isArray(item.ids)));
  }
  assert.deepEqual(candidate.clarity, generateStoryCandidates(graph, { seed: 'clarity', referenceDate: '2026-01-01T00:00:00Z' }).find(item => item.id === 'projects').clarity);
});

test('adaptive Profile Story SVG keeps the same projects at 480px and 900px', () => {
  const showcase = { 'sample/readme-0': { role: 'featured', priority: 1 }, 'sample/readme-1': { role: 'supporting', priority: 1 } };
  const records = Array.from({ length: 12 }, (_, index) => ({ full_name: `sample/readme-${index}`, name: `Long project name ${index}`, language: ['Rust', 'JavaScript', 'Python'][index % 3], topics: [`area-${index % 3}`] }));
  const graph = semanticGraphFromScene(createScene('sample', records, { nodeMode: 'repositories', showOther: true, projectShowcase: showcase, seed: 'adaptive-readme' }));
  const candidate = generateStoryCandidates(graph, { projectShowcase: showcase, seed: 'adaptive-readme' }).find(item => item.id === 'projects');
  const readmeScene = { ...candidate.scene, presentation: { ...candidate.scene.presentation, options: { ...candidate.scene.presentation.options, exportProfile: 'readme' } } };
  const compact = renderSceneSVG(readmeScene, { targetWidth: 480 });
  const wide = renderSceneSVG(readmeScene, { targetWidth: 900 });
  const projectIds = svg => [...new Set([...svg.matchAll(/class="star[^\"]*"[^>]*data-repo="([^\"]+)"/g)].map(match => match[1]))].sort();
  assert.match(compact, /<svg[^>]*width="480"/);
  assert.match(wide, /<svg[^>]*width="900"/);
  assert.deepEqual(projectIds(compact), projectIds(wide));
  assert.ok((compact.match(/class="repo-label"/g) || []).length <= 8);
  assert.match(compact, /data-role="featured"/);
  assert.match(wide, /data-relationship-type=/);
});

test('representative projects are capped at twelve and preserve featured intent', () => {
  const profile = profiles.find(item => item.id === 'many-tiny-repos');
  const showcase = { 'sample/repo-49': { role: 'featured', priority: 1 } };
  const records = Array.from({ length: profile.projects }, (_, i) => ({ full_name: `sample/repo-${i}`, name: `Repo ${i}`, language: 'JavaScript', topics: [] }));
  const graph = semanticGraphFromScene(createScene('sample', records, { nodeMode: 'repositories', showOther: true, projectShowcase: showcase, seed: 'many-tiny-repos' }));
  const candidates = generateStoryCandidates(graph, { projectShowcase: showcase, seed: 'many-tiny-repos' });
  const projects = candidates.find(item => item.id === 'projects').scene.nodes.filter(node => node.metadata?.full_name);
  assert.equal(projects.length, 12);
  assert.ok(projects.some(node => node.id === 'sample/repo-49'));
});

test('Technical Shape eligibility uses the same representatives as its scored scene', () => {
  const records = Array.from({ length: 24 }, (_, i) => {
    const category = i < 12 ? ['JavaScript', 'shared'] : i < 18 ? ['Rust', 'systems'] : ['Python', 'data'];
    return { full_name: `sample/repo-${String(i).padStart(2, '0')}`, name: `Repo ${i}`, language: category[0], topics: [category[1]] };
  });
  const graph = semanticGraphFromScene(createScene('sample', records, { nodeMode: 'repositories', showOther: true }));
  const selected = selectRepresentativeProjects(graph.nodes.filter(node => node.kind === 'project')).map(node => node.id).sort();
  const candidates = generateStoryCandidates(graph);
  const projects = candidates.find(item => item.id === 'projects');
  const technical = candidates.find(item => item.id === 'technical-shape');
  const projectIds = candidate => candidate.scene.nodes.filter(node => node.metadata?.full_name && (!node.metadata?.nodeKind || node.metadata.nodeKind === 'repository')).map(node => node.id).sort();
  assert.deepEqual(projectIds(projects), selected);
  assert.deepEqual(projectIds(technical), selected);
  assert.equal(technical.available, true);
});

test('Journey is capped at twelve and represents early, middle, and recent periods', () => {
  const profile = profiles.find(item => item.id === 'long-history');
  const candidates = generateStoryCandidates(graphFor(profile), { seed: profile.id, referenceDate: '2026-01-01T00:00:00Z' });
  const journey = candidates.find(item => item.id === 'journey');
  const projects = journey.scene.nodes.filter(node => node.metadata?.full_name && (!node.metadata?.nodeKind || node.metadata.nodeKind === 'repository'));
  const years = projects.map(node => Number(node.metadata.created_at.slice(0, 4)));
  const allYears = graphFor(profile).nodes.filter(node => node.kind === 'project').map(node => Number(node.properties.createdAt.slice(0, 4))).filter(year => year <= 2026);
  const minYear = Math.min(...allYears), span = Math.max(...allYears) - minYear + 1;
  assert.ok(projects.length <= 12);
  assert.deepEqual(new Set(years.map(year => Math.min(2, Math.floor((year - minYear) * 3 / span)))), new Set([0, 1, 2]));
});

test('Journey reserves each available period even when the portfolio is already under the cap', () => {
  const projects = [2010, 2012, 2013, 2014, 2016, 2017, 2019, 2020, 2022].map((year, index) => ({
    id: `sample/repo-${index}`,
    properties: { createdAt: `${year}-04-01T00:00:00Z` },
  }));
  const selected = selectJourneyProjects(projects, 12, '2026-01-01T00:00:00Z');
  const years = selected.map(node => Number(node.properties.createdAt.slice(0, 4)));
  const span = Math.max(...years) - Math.min(...years) + 1;
  assert.deepEqual(new Set(years.map(year => Math.min(2, Math.floor((year - Math.min(...years)) * 3 / span)))), new Set([0, 1, 2]));
});

test('scored project IDs match candidate scenes and their rendered SVGs', () => {
  for (const profile of profiles.filter(item => ['long-history', 'full-stack', 'organization-contributor'].includes(item.id))) {
    const candidates = generateStoryCandidates(graphFor(profile), { seed: profile.id, referenceDate: '2026-01-01T00:00:00Z' });
    for (const candidate of candidates.filter(item => item.scene)) {
      const sourceIds = candidate.scene.nodes
        .filter(node => node.metadata?.full_name && (!node.metadata?.nodeKind || node.metadata.nodeKind === 'repository'))
        .map(node => node.id).sort();
      const scoredInput = sceneQualityInput(candidate.scene, candidate.id);
      const scoredIds = scoredInput.nodes.filter(node => node.kind === 'project').map(node => node.id).sort();
      const renderedIds = [...new Set([...renderSceneSVG(candidate.scene).matchAll(/<circle\b(?=[^>]*class="star\b)(?=[^>]*data-kind="repository")[^>]*data-repo="([^"]+)"/g)].map(match => match[1]))].sort();
      assert.ok(sourceIds.length <= 12, `${candidate.id} scene stays bounded`);
      assert.equal(candidate.quality.sceneFingerprint, candidate.sceneFingerprint, `${candidate.id} score trace identifies the candidate scene`);
      assert.deepEqual(candidate.quality.evaluatedProjectIds, scoredIds, `${candidate.id} score trace`);
      assert.deepEqual(scoredIds, sourceIds, `${candidate.id} score input and scene`);
      assert.deepEqual(renderedIds, sourceIds, `${candidate.id} SVG and scene`);
      assert.ok(Math.abs(candidate.quality.score - evaluateGraphQuality(scoredInput).score) < 1e-12, `${candidate.id} score comes from the exposed structural projection`);
    }
  }
});

test('Story Composition preserves authored relationships and exposes evidence in static SVG', () => {
  const records = Array.from({ length: 6 }, (_, index) => ({
    full_name: `sample/story-${index}`,
    name: `Story Project ${index}`,
    language: index < 4 ? 'Rust' : 'JavaScript',
    topics: index < 3 ? ['wasm', 'tooling'] : index < 5 ? ['web'] : ['cli'],
  }));
  const options = {
    nodeMode: 'repositories', showOther: true,
    projectShowcase: { 'sample/story-0': { role: 'featured', priority: 1 } },
    projectFamilies: {
      tooling: { label: 'Tooling family', members: ['sample/story-0', 'sample/story-1', 'sample/story-2'] },
      maintainers: { label: 'Maintainers family', members: ['sample/story-3', 'sample/story-4', 'sample/story-5'] },
    },
    projectRelationships: [['sample/story-3', 'sample/story-4'], ['sample/story-0', 'sample/story-5']], seed: 'story-composition',
  };
  const graph = semanticGraphFromScene(createScene('sample', records, options));
  const candidates = generateStoryCandidates(graph, options);
  assert.deepEqual(candidates.map(candidate => candidate.id), ['projects', 'technical-shape', 'journey']);
  const projects = candidates.find(candidate => candidate.id === 'projects');
  const visibleProjectIds = projects.scene.nodes.filter(node => node.metadata?.nodeKind === 'repository' || (node.metadata?.full_name && !node.metadata?.nodeKind)).map(node => node.id).sort();
  assert.equal(projects.composition.version, 1);
  assert.ok(projects.composition.relationships.some(edge => edge.type === 'explicit-relationship' && edge.evidence.some(item => item.startsWith('relationship:'))));
  assert.ok(projects.composition.relationships.every(edge => visibleProjectIds.includes(edge.from) && visibleProjectIds.includes(edge.to)), 'composed relationships resolve to visible project identities');
  assert.ok(projects.composition.relationships.some(edge => edge.type === 'authored-family' && edge.evidence.some(value => value.includes('tooling'))));
  assert.deepEqual(visibleProjectIds, records.map(record => record.full_name).sort(), 'authored families do not hide the bounded story project identities');
  assert.ok(projects.composition.relationships.some(edge => edge.type === 'authored-family'));
  assert.ok(projects.composition.relationships.length <= 12);
  const edgeIds = new Set(projects.scene.edges.map(edge => edge.id));
  assert.ok(projects.composition.relationships.every(edge => edgeIds.has(edge.id)));
  const svg = renderSceneSVG(projects.scene);
  assert.deepEqual([...new Set([...svg.matchAll(/<circle\b(?=[^>]*class="star\b)(?=[^>]*data-kind="repository")[^>]*data-repo="([^"]+)"/g)].map(match => match[1]))].sort(), visibleProjectIds, 'static SVG retains the selected project identities');
  assert.match(svg, /data-relationship-type="explicit-relationship"/);
  assert.match(svg, /Project connection types/);
  assert.match(svg, /shared language/);
  assert.ok(projects.composition.relationships.every(edge => edge.evidence.length > 0), 'every composed connection has evidence');
  assert.ok([...svg.matchAll(/class="relationship-evidence-label"/g)].length <= 3, 'visible evidence labels are bounded to avoid collisions');
  const reordered = semanticGraphFromScene(createScene('sample', [...records].reverse(), options));
  const reorderedProjects = generateStoryCandidates(reordered, options).find(candidate => candidate.id === 'projects');
  assert.deepEqual(reorderedProjects.composition.relationships, projects.composition.relationships);
  assert.deepEqual(reorderedProjects.scene.edges.map(edge => edge.id).sort(), projects.scene.edges.map(edge => edge.id).sort());
});

test('composition failures leave a bounded, evidence-derived scene and recover on the next render', async () => {
  const records = Array.from({ length: 18 }, (_, index) => ({
    full_name: `sample/failure-${index}`,
    name: `Failure Project ${index}`,
    language: index % 2 ? 'Rust' : 'JavaScript',
    topics: [index % 3 ? 'tooling' : 'visualization'],
  }));
  const options = { nodeMode: 'repositories', showOther: true, seed: 'compose-failure' };
  const graph = semanticGraphFromScene(createScene('sample', records, options));
  const canonicalBefore = JSON.stringify(graph);
  const injectedFailures = [
    { composeStory() { throw new Error('internal binding detail must not reach the user'); } },
    { composeStory(input) { return { version: 1, relationships: [
      { id: 'partial-edge', from: input.projects[0].id, to: input.projects[1].id, type: 'explicit-relationship', evidence: ['relationship:test'] },
      { id: 'invalid-edge', from: input.projects[0].id, to: 'missing-project', type: 'shared-topic', evidence: ['topic:test'] },
    ], diagnostics: [], suppressed_count: 0, candidate_count: 2 }; } },
  ];
  for (const runtime of injectedFailures) {
    const candidates = generateStoryCandidates(graph, options, runtime);
    const projects = candidates.find(candidate => candidate.id === 'projects');
    const projectIds = projects.scene.nodes.filter(node => node.metadata?.nodeKind === 'repository').map(node => node.id);
    assert.ok(projectIds.length <= 12);
    assert.equal(projects.composition, null);
    assert.ok(candidates.filter(candidate => candidate.scene).every(candidate => candidate.compositionFailed));
    assert.equal(JSON.stringify(graph), canonicalBefore, 'failed optional composition never mutates the canonical graph');
    assert.ok(projects.scene.edges.every(edge => !edge.id.includes('partial-edge') && !edge.metadata?.relationshipType), 'no partially composed relationship reaches the scene');
    assert.doesNotMatch(renderSceneSVG(projects.scene), /internal binding detail/);
  }
  const recovered = generateStoryCandidates(graph, options).find(candidate => candidate.id === 'projects');
  assert.ok(recovered.composition.relationships.length > 0);
  assert.ok(recovered.composition.relationships.every(edge => recovered.scene.edges.some(sceneEdge => sceneEdge.id === edge.id)));
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), JSON.parse(canonicalBefore));
});

test('frontend, full-stack, and tooling fixtures produce bounded candidates', () => {
  for (const id of ['frontend-heavy', 'full-stack', 'polyglot-tooling', 'mostly-forks', 'organization-contributor']) {
    const profile = profiles.find(item => item.id === id);
    const candidates = generateStoryCandidates(graphFor(profile), { seed: id, referenceDate: '2026-01-01T00:00:00Z' });
    assert.equal(candidates.length, 3, id);
    assert.ok(candidates.every(item => !item.scene || item.scene.nodes.filter(node => node.metadata?.nodeKind === 'repository' || (node.metadata?.full_name && !node.metadata?.nodeKind)).length <= 12), id);
    const technical = candidates.find(item => item.id === 'technical-shape');
    if (technical.available) assert.ok(technical.scene.nodes.filter(node => ['language','topic'].includes(node.metadata?.nodeKind)).length <= 5, id);
  }
});
