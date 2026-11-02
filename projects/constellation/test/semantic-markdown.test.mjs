import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from '../src/constellation.mjs';
import { createProjectConstellation } from '../src/project-constellation.mjs';
import { semanticGraphFromProjectConstellation, semanticGraphFromScene, parseSemanticGraph, serializeSemanticGraph, semanticGraphFingerprint, validateSemanticGraph } from '../src/semantic-graph.mjs';
import { renderSemanticMarkdown, SEMANTIC_MARKDOWN_VERSION, SEMANTIC_MARKDOWN_LIMITS } from '../src/semantic-markdown.mjs';
import { repositories } from './fixtures/recruiter.mjs';

test('developer projection preserves ownership, group provenance and factual relationships', () => {
  const owned = repositories.filter(repo => repo.full_name === 'alice/atlas' || repo.full_name === 'alice/atlas-mobile');
  const external = repositories.find(repo => repo.full_name === 'community/query-engine');
  const graph = semanticGraphFromScene(createScene('alice', [...owned, external, { full_name: 'outside/one', name: 'one' }, { full_name: 'outside/two', name: 'two' }], {
    projectFamilies: { Studio: { label: 'Studio', members: ['alice/atlas', 'alice/atlas-mobile'] } },
    projectRelationships: [['alice/atlas', 'alice/atlas-mobile']],
    maxRepos: 45,
  }));
  const before = structuredClone(graph);
  const markdown = renderSemanticMarkdown(graph);
  assert.match(markdown, /^# alice/m);
  assert.match(markdown, /`community\/query-engine`/);
  assert.doesNotMatch(markdown, /Projects owned by alice/);
  assert.match(markdown, /Defined by you\./);
  assert.match(markdown, /Primary language:/);
  assert.match(markdown, /Topics:/);
  assert.match(markdown, /`alice\/atlas` ↔ `alice\/atlas-mobile`/);
  assert.doesNotMatch(markdown, /geometry|viewport|camera|glow|animation/i);
  assert.deepEqual(graph, before);
  const derived = renderSemanticMarkdown(semanticGraphFromScene(createScene('alice', [...owned, { ...owned[0], full_name: 'outside/one', name: 'one' }, { ...owned[0], full_name: 'outside/two', name: 'two' }])));
  assert.match(derived, /Grouped by shared repository owner\./);
  const selectedGraph = semanticGraphFromScene(createScene('alice', owned, { includeRepos: ['alice/atlas'] }));
  const detailed = renderSemanticMarkdown(selectedGraph, { detail: 'detailed' });
  assert.match(detailed, /Evidence and provenance/);
  assert.match(detailed, /selected by user/);
});

test('project projection reports repository identity, structural evidence, private visibility and truncation', () => {
  const model = createProjectConstellation({
    projectId: 'owner/repo', ref: 'main', commit: 'abcdef1234567', visibility: 'private',
    tree: [
      { path: 'package.json', type: 'blob' }, { path: 'packages', type: 'tree' },
      { path: 'packages/core', type: 'tree' }, { path: 'packages/core/package.json', type: 'blob' },
      { path: 'packages/core/src', type: 'tree' }, { path: 'packages/core/src/index.mjs', type: 'blob' },
      { path: 'packages/core/src/other.mjs', type: 'blob' },
    ],
    contents: {
      'package.json': '{"workspaces":["packages/*"]}',
      'packages/core/package.json': '{"name":"@example/core","main":"src/index.mjs"}',
      'packages/core/src/index.mjs': "import './other.mjs';",
      'packages/core/src/other.mjs': 'export const x = 1;',
    },
  });
  const graph = semanticGraphFromProjectConstellation(model);
  const markdown = renderSemanticMarkdown(graph);
  assert.match(markdown, /# owner\/repo/);
  assert.match(markdown, /Ref: `main`/);
  assert.match(markdown, /Commit: `abcdef1234567`/);
  assert.match(markdown, /Visibility: private/);
  assert.match(markdown, /derived from a private repository/);
  assert.match(markdown, /`packages\/core` is declared as a workspace member by `package\.json`/);
  assert.doesNotMatch(markdown, /`owner\/repo` is declared as a workspace member/);
  assert.match(markdown, /`packages\/core\/src\/index\.mjs` is declared as an entry point/);
  assert.match(markdown, /`packages\/core\/src\/index\.mjs` imports `\.\/other\.mjs` → `packages\/core\/src\/other\.mjs`/);
  const bounded = createProjectConstellation({ projectId: 'owner/bounded', tree: Array.from({ length: 130 }, (_, i) => ({ path: `src/file-${i}.js`, type: 'blob' })) }, { nodes: 32 });
  const incomplete = renderSemanticMarkdown(semanticGraphFromProjectConstellation(bounded));
  assert.match(incomplete, /truncated; this is an incomplete bounded view/);
  assert.match(incomplete, /of \d+ files entered inspection/);
  assert.match(incomplete, /of \d+ supported source files read/);
});

test('projection is deterministic over order and graph round trips; details are distinct', () => {
  const graph = semanticGraphFromScene(createScene('alice', repositories.slice(0, 12), { projectFamilies: { studio: { label: 'Studio', members: repositories.slice(0, 4).map(repo => repo.full_name) } } }));
  const baseline = renderSemanticMarkdown(graph);
  const reversed = structuredClone(graph);
  reversed.nodes.reverse(); reversed.edges.reverse(); reversed.groups.reverse();
  assert.equal(renderSemanticMarkdown(reversed), baseline);
  assert.equal(renderSemanticMarkdown(parseSemanticGraph(serializeSemanticGraph(graph))), baseline);
  assert.equal(semanticGraphFingerprint(graph), semanticGraphFingerprint(parseSemanticGraph(serializeSemanticGraph(graph))));
  const summary = renderSemanticMarkdown(graph, { detail: 'summary' });
  const detailed = renderSemanticMarkdown(graph, { detail: 'detailed' });
  assert.notEqual(summary, baseline);
  assert.notEqual(detailed, baseline);
  assert.equal(summary, renderSemanticMarkdown(graph, { detail: 'summary' }));
  assert.equal(SEMANTIC_MARKDOWN_VERSION, 1);
});

test('projection safely escapes hostile labels and rejects invalid graphs and unknown options', () => {
  const graph = semanticGraphFromScene(createScene('alice', [{ full_name: 'alice/name`with`ticks', name: '# heading * bullet [link](javascript:alert(1)) <script>alert(1)</script>', language: 'Rust' }]));
  const markdown = renderSemanticMarkdown(graph);
  assert.match(markdown, /``alice\/name`with`ticks``/);
  assert.ok(markdown.includes('\\# heading \\* bullet'));
  assert.doesNotMatch(markdown, /<script>/);
  assert.doesNotMatch(markdown, /\]\(javascript:/);
  assert.throws(() => renderSemanticMarkdown({}), /Invalid semantic graph/);
  const secret = structuredClone(graph);
  secret.nodes.find(node => node.kind === 'project').properties.description = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  assert.throws(() => renderSemanticMarkdown(secret), /Invalid semantic graph/);
  assert.throws(() => renderSemanticMarkdown(graph, { detail: 'all' }), /detail must be/);
  assert.throws(() => renderSemanticMarkdown(graph, { html: true }), /only detail/);
});

test('language wording distinguishes explicit primary metadata from generic usage edges', () => {
  const generic = semanticGraphFromScene(createScene('alice', [{ full_name: 'alice/langs', name: 'langs', language: 'Rust' }]));
  const project = generic.nodes.find(node => node.kind === 'project');
  const languageNode = { id: 'language:typescript-extra', kind: 'language', label: 'TypeScript', properties: {}, provenance: [{ category: 'source', source: 'test' }], evidenceIds: [] };
  generic.nodes.push(languageNode);
  generic.edges.push({ id: 'uses-language:test-typescript', kind: 'uses-language', from: project.id, to: languageNode.id, provenance: [{ category: 'source', source: 'test' }], evidence: [] });
  generic.statistics.nodeCount = generic.nodes.length;
  generic.statistics.edgeCount = generic.edges.length;
  delete generic.nodes.find(node => node.kind === 'project').properties.language;
  assert.equal(validateSemanticGraph(generic).valid, true);
  const output = renderSemanticMarkdown(generic);
  assert.match(output, /Languages: Rust, TypeScript/);
  assert.doesNotMatch(output, /Primary language:/);

  const explicit = semanticGraphFromScene(createScene('alice', [{ full_name: 'alice/explicit', name: 'explicit', language: 'JavaScript' }]));
  const explicitProject = explicit.nodes.find(node => node.kind === 'project');
  explicit.nodes.push({ ...languageNode, id: 'language:typescript', label: 'TypeScript' });
  explicit.edges.push({ id: 'uses-language:explicit-typescript', kind: 'uses-language', from: explicitProject.id, to: 'language:typescript', provenance: [{ category: 'source', source: 'test' }], evidence: [] });
  explicit.statistics.nodeCount = explicit.nodes.length;
  explicit.statistics.edgeCount = explicit.edges.length;
  assert.equal(validateSemanticGraph(explicit).valid, true);
  const primary = renderSemanticMarkdown(explicit);
  assert.match(primary, /Primary language: JavaScript/);
  assert.match(primary, /Additional languages: TypeScript/);
});

test('language and topic inventories have explicit deterministic omission counts', () => {
  const seed = repositories.find(repo => repo.full_name === 'alice/atlas');
  const graph = semanticGraphFromScene(createScene('alice', [seed]));
  const project = graph.nodes.find(node => node.kind === 'project');
  for (let index = 0; index < 140; index++) {
    const suffix = String(index).padStart(3, '0');
    const topicId = `topic:limit-${suffix}`;
    graph.nodes.push({ id: topicId, kind: 'topic', label: `Topic-${suffix}`, properties: {}, provenance: [{ category: 'source', source: 'test' }], evidenceIds: [] });
    graph.edges.push({ id: `has-topic:limit-${suffix}`, kind: 'has-topic', from: project.id, to: topicId, provenance: [{ category: 'source', source: 'test' }], evidence: [] });
    if (index < 70) {
      const languageId = `language:limit-${suffix}`;
      graph.nodes.push({ id: languageId, kind: 'language', label: `Language-${suffix}`, properties: {}, provenance: [{ category: 'source', source: 'test' }], evidenceIds: [] });
      graph.edges.push({ id: `uses-language:limit-${suffix}`, kind: 'uses-language', from: project.id, to: languageId, provenance: [{ category: 'source', source: 'test' }], evidence: [] });
    }
  }
  graph.statistics.nodeCount = graph.nodes.length;
  graph.statistics.edgeCount = graph.edges.length;
  assert.equal(validateSemanticGraph(graph).valid, true);
  const output = renderSemanticMarkdown(graph);
  assert.match(output, /Showing 8 of 71 languages for `alice\/atlas`; 63 additional languages for `alice\/atlas` omitted/);
  assert.match(output, /Showing 16 of 141 topics for `alice\/atlas`; 125 additional topics for `alice\/atlas` omitted/);
  assert.match(output, /Showing 64 of 71 languages; 7 additional languages omitted/);
  assert.match(output, /Showing 128 of 141 topics; 13 additional topics omitted/);
});

test('multiline graph values remain inline and cannot inject Markdown structure', () => {
  const graph = semanticGraphFromScene(createScene('alice', [{ full_name: 'alice/normal', name: 'normal', language: 'Rust' }]));
  const project = graph.nodes.find(node => node.kind === 'project');
  const originalId = project.id;
  const multilineId = 'alice/name``with``ticks\nsecond line';
  project.id = multilineId;
  for (const edge of graph.edges) {
    if (edge.from === originalId) edge.from = multilineId;
    if (edge.to === originalId) edge.to = multilineId;
  }
  for (const subject of graph.evidence.subjects) if (subject.id === originalId) subject.id = multilineId;
  project.label = 'Hello\n# Injected heading';
  project.properties.description = 'hello\r\n> injected quote\n- injected item';
  graph.subject.id = 'alice\n# Subject heading';
  graph.statistics.truncated = true;
  graph.statistics.limitations = ['first\n> injected limitation\r\n- injected list'];
  assert.equal(validateSemanticGraph(graph).valid, true);
  const output = renderSemanticMarkdown(graph, { detail: 'detailed' });
  assert.ok(output.includes('### Hello \\# Injected heading'));
  assert.ok(output.includes('# alice \\# Subject heading'));
  assert.ok(output.includes('- Description: hello &gt; injected quote \\- injected item'), output);
  assert.ok(output.includes('- first &gt; injected limitation \\- injected list'));
  assert.ok(output.includes('```alice/name``with``ticks second line```'));
  assert.doesNotMatch(output, /\n# Injected heading/);
  assert.doesNotMatch(output, /\n> injected/);
  assert.doesNotMatch(output, /\n- injected/);
  assert.equal(renderSemanticMarkdown(graph, { detail: 'detailed' }), output);

  const repositoriesForFamily = repositories.filter(repo => ['alice/atlas', 'alice/atlas-mobile'].includes(repo.full_name));
  const familyGraph = semanticGraphFromScene(createScene('alice', repositoriesForFamily, { projectFamilies: { family: { label: 'Family', members: repositoriesForFamily.map(repo => repo.full_name) } } }));
  familyGraph.groups[0].label = 'Family\n# Group heading';
  familyGraph.nodes.find(node => node.id === familyGraph.groups[0].id).label = familyGraph.groups[0].label;
  assert.equal(validateSemanticGraph(familyGraph).valid, true);
  const familyOutput = renderSemanticMarkdown(familyGraph);
  assert.ok(familyOutput.includes('### Family \\# Group heading'));
  assert.doesNotMatch(familyOutput, /\n# Group heading/);
});

test('source coverage and bounded limitations survive simultaneous Markdown byte truncation', () => {
  const seed = repositories[0];
  const items = Array.from({ length: 32 }, (_, index) => ({ ...seed, full_name: `owner/${String(index).padStart(2, '0')}-${'p'.repeat(270)}`, name: `project-${index}` }));
  const graph = semanticGraphFromScene(createScene('owner', items, { maxRepos: 45 }));
  const projects = graph.nodes.filter(node => node.kind === 'project');
  const originalIds = projects.map(node => node.id);
  const longIds = originalIds.map((_, index) => `owner/${String(index).padStart(2, '0')}-${'p'.repeat(270)}`);
  const idMap = new Map(originalIds.map((id, index) => [id, longIds[index]]));
  for (const project of projects) project.id = idMap.get(project.id);
  for (const edge of graph.edges) {
    if (idMap.has(edge.from)) edge.from = idMap.get(edge.from);
    if (idMap.has(edge.to)) edge.to = idMap.get(edge.to);
  }
  for (const subject of graph.evidence.subjects) if (idMap.has(subject.id)) subject.id = idMap.get(subject.id);

  const oldGroupIds = new Set(graph.nodes.filter(node => node.kind === 'semantic-group').map(node => node.id));
  graph.nodes = graph.nodes.filter(node => !oldGroupIds.has(node.id));
  graph.edges = graph.edges.filter(edge => edge.kind !== 'member-of' || !oldGroupIds.has(edge.to));
  const members = [...longIds];
  graph.groups = [];
  for (let index = 0; index < 64; index++) {
    const id = `family:${String(index).padStart(2, '0')}`;
    const group = { id, kind: 'project-family', label: `Family ${index}`, provenance: 'user', basis: [], members };
    graph.groups.push(group);
    graph.nodes.push({ id, kind: 'semantic-group', label: group.label, properties: { groupKind: group.kind, members, basis: [] }, provenance: [{ category: 'user', source: 'user-project-family' }], evidenceIds: [] });
    members.forEach((member, memberIndex) => graph.edges.push({ id: `member:${index}:${memberIndex}`, kind: 'member-of', from: member, to: id, provenance: [{ category: 'user', source: 'user-project-family' }], evidence: [] }));
  }
  graph.statistics.nodeCount = graph.nodes.length;
  graph.statistics.edgeCount = graph.edges.length;
  graph.statistics.truncated = true;
  graph.statistics.limitations = Array.from({ length: 12 }, (_, index) => `Source limitation ${String(index).padStart(2, '0')} ${'x'.repeat(500)}`);
  assert.equal(validateSemanticGraph(graph).valid, true);

  const output = renderSemanticMarkdown(graph);
  const bytes = Buffer.from(output, 'utf8');
  assert.ok(bytes.byteLength <= SEMANTIC_MARKDOWN_LIMITS.bytes);
  assert.ok(output.split('\n').length - 1 <= SEMANTIC_MARKDOWN_LIMITS.lines);
  assert.equal(bytes.toString('utf8'), output);
  assert.ok(output.endsWith('\n'));
  assert.match(output, /Developer graph coverage is incomplete because its source pipeline was bounded/);
  assert.match(output, /Showing 8 of 12 source limitations; 4 additional source limitations omitted/);
  assert.match(output, /Additional content was omitted from this Markdown projection because its output limit was reached/);
  assert.ok(Buffer.byteLength(output) > SEMANTIC_MARKDOWN_LIMITS.bytes - 1024);
});

test('presentation truncation is disclosed and stays within byte bounds', () => {
  const seed = repositories[0];
  const graph = semanticGraphFromScene(createScene('alice', Array.from({ length: 100 }, (_, index) => ({ ...seed, full_name: `alice/project-${String(index).padStart(3, '0')}`, name: `project-${index}`, description: 'bounded description' })), { maxRepos: 100 }));
  const before = structuredClone(graph);
  const markdown = renderSemanticMarkdown(graph);
  assert.match(markdown, /Showing 64 of 100 projects/);
  assert.ok(Buffer.byteLength(markdown) <= SEMANTIC_MARKDOWN_LIMITS.bytes);
  assert.deepEqual(graph, before);
});
