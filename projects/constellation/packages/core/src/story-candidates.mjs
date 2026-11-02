import { composeStory as composeStoryRust, evaluateGraphQuality, analyzeStoryClarity } from './engine.mjs';
import { sceneClarityInput } from './story-clarity.mjs';
export { sceneClarityInput };
import { createScene } from './constellation.mjs';
import { projectSemanticGraphToScene } from './semantic-graph.mjs';
import { semanticActive } from './semantic-studio.mjs';

export const STORY_CANDIDATE_LIMIT = 3;
export const STORY_TYPES = Object.freeze(['projects', 'technical-shape', 'journey']);
export const STORY_PROJECT_LIMIT = 12;

function storySceneFingerprint(scene) {
  const serialized = JSON.stringify(scene);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `story-scene-v1:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function curatedPriority(node) {
  return ({ featured: 4, supporting: 3, include: 2 }[node.properties.curatedRole] || (node.properties.pinned === true ? 3 : 0));
}

function evidenceValues(node) {
  return [node.properties.language, ...(node.properties.topics || [])].filter(Boolean);
}

function marginalEvidence(node, chosen) {
  const represented = new Set(chosen.flatMap(evidenceValues));
  return evidenceValues(node).filter(value => !represented.has(value)).length;
}

function stablePick(pool, chosen) {
  return [...pool].sort((a, b) => curatedPriority(b) - curatedPriority(a)
    || marginalEvidence(b, chosen) - marginalEvidence(a, chosen)
    || a.id.localeCompare(b.id))[0];
}

export function selectRepresentativeProjects(projects, limit = STORY_PROJECT_LIMIT) {
  const pending = [...projects];
  const chosen = [];
  const targetCount = Math.min(limit, pending.length);
  while (chosen.length < targetCount && pending.length) {
    const next = stablePick(pending, chosen);
    chosen.push(next);
    pending.splice(pending.indexOf(next), 1);
  }
  return chosen;
}

export function selectJourneyProjects(projects, limit = STORY_PROJECT_LIMIT, referenceDate = new Date().toISOString()) {
  const currentYear = new Date(referenceDate).getUTCFullYear();
  const dated = projects.filter(node => /^\d{4}-\d{2}-\d{2}/.test(node.properties?.createdAt || '')
    && Number(node.properties.createdAt.slice(0, 4)) <= currentYear);
  const years = dated.map(node => Number(node.properties.createdAt.slice(0, 4)));
  const minYear = Math.min(...years), maxYear = Math.max(...years);
  const span = Math.max(1, maxYear - minYear + 1);
  const buckets = new Map();
  for (const node of dated) {
    const bucket = Math.min(2, Math.floor((Number(node.properties.createdAt.slice(0, 4)) - minYear) * 3 / span));
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(node);
  }
  const chosen = [];
  const pending = new Map([...buckets].map(([bucket, nodes]) => [bucket, [...nodes]]));
  const bucketIds = [...pending.keys()].sort((a, b) => a - b);
  // Reserve a representative from each era before filling the remaining slots.
  for (const bucket of bucketIds) {
    if (chosen.length >= limit) break;
    const pool = pending.get(bucket);
    const next = stablePick(pool, chosen);
    chosen.push(next);
    pool.splice(pool.indexOf(next), 1);
  }
  while (chosen.length < Math.min(limit, dated.length)) {
    let added = false;
    for (const bucket of bucketIds) {
      const pool = pending.get(bucket);
      if (!pool.length || chosen.length >= limit) continue;
      const next = stablePick(pool, chosen);
      chosen.push(next);
      pool.splice(pool.indexOf(next), 1);
      added = true;
    }
    if (!added) break;
  }
  return chosen;
}

function projectCandidate(graph, options, runtime, mode, representativeProjects = null, compositionSink = null, compositionState = null) {
  const copy = structuredClone(graph);
  let selectedTechnicalCategories = null;
  const projects = copy.nodes.filter(node => node.kind === 'project');
  const chosen = representativeProjects || selectRepresentativeProjects(projects);
  if (projects.length > chosen.length) {
    const ids = new Set(chosen.map(node => node.id));
    const groupIds = new Set(copy.groups.filter(group => group.members.filter(id => ids.has(id)).length >= 2).map(group => group.id));
    for (const group of copy.groups) if (groupIds.has(group.id)) group.members = group.members.filter(id => ids.has(id));
    for (const node of copy.nodes) if (node.kind === 'semantic-group' && groupIds.has(node.id)) {
      const group = copy.groups.find(item => item.id === node.id);
      node.properties.members = [...group.members];
    }
    const retainedIds = new Set([...ids, ...copy.nodes.filter(node => node.kind === 'developer').map(node => node.id), ...copy.nodes.filter(node => node.kind === 'semantic-group' && groupIds.has(node.id)).map(node => node.id)]);
    copy.nodes = copy.nodes.filter(node => retainedIds.has(node.id));
    copy.groups = copy.groups.filter(group => groupIds.has(group.id));
    copy.edges = copy.edges.filter(edge => retainedIds.has(edge.from) && retainedIds.has(edge.to));
  }
  if (mode === 'technical-shape') {
    const selectedProjects = copy.nodes.filter(node => node.kind === 'project');
    const counts = new Map();
    for (const node of selectedProjects) for (const [kind, value] of [['language', node.properties.language], ...(node.properties.topics || []).map(topic => ['topic', topic])]) {
      if (value) counts.set(`${kind}:${value}`, (counts.get(`${kind}:${value}`) || 0) + 1);
    }
    const meaningful = [...counts].filter(([, count]) => count >= 2 && count < selectedProjects.length)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([key]) => key);
    const selected = selectedTechnicalCategories = new Set(meaningful);
    for (const node of selectedProjects) {
      if (!selected.has(`language:${node.properties.language}`)) delete node.properties.language;
      node.properties.topics = (node.properties.topics || []).filter(topic => selected.has(`topic:${topic}`));
      if (!node.properties.topics.length) delete node.properties.topics;
    }
    const categoryIds = new Set(copy.nodes.filter(node => node.kind === 'language' || node.kind === 'topic')
      .filter(node => selected.has(`${node.kind}:${node.label}`)).map(node => node.id));
    copy.nodes = copy.nodes.filter(node => !['language', 'topic'].includes(node.kind) || categoryIds.has(node.id));
    copy.edges = copy.edges.filter(edge => !['uses-language', 'has-topic'].includes(edge.kind) || categoryIds.has(edge.to));
  }
  if (mode === 'projects') {
    const authored = new Set(copy.groups.filter(group => group.provenance === 'user').map(group => group.id));
    copy.groups = copy.groups.filter(group => authored.has(group.id));
    copy.nodes = copy.nodes.filter(node => node.kind !== 'semantic-group' || authored.has(node.id));
    copy.edges = copy.edges.filter(edge => edge.kind !== 'member-of' || authored.has(edge.to));
  }
  copy.statistics = { ...copy.statistics, nodeCount: copy.nodes.length, edgeCount: copy.edges.length };
  const scene = projectSemanticGraphToScene(copy, {
    ...options,
    temporalStack: options.temporalStack ? { ...options.temporalStack } : options.temporalStack,
    nodeMode: mode === 'technical-shape' ? 'combined' : 'repositories',
    showOther: true,
    languages: undefined,
    topics: undefined,
    maxRepos: Math.max(1, chosen.length),
    includeRepos: chosen.map(node => node.id),
  }, runtime, { preserveProjects: true });
  if (selectedTechnicalCategories) {
    const remove = new Set(scene.nodes.filter(node => ['language', 'topic'].includes(node.metadata?.nodeKind)
      && !selectedTechnicalCategories.has(`${node.metadata.nodeKind}:${node.metadata.name}`)).map(node => node.id));
    scene.nodes = scene.nodes.filter(node => !remove.has(node.id));
    scene.edges = scene.edges.filter(edge => !remove.has(edge.from) && !remove.has(edge.to));
    scene.labels = scene.labels.filter(label => !remove.has(label.id));
    scene.total = scene.nodes.length;
    scene.presentation.graph.nodeCount = scene.nodes.length;
  }
  if (compositionSink) compositionSink.value = composeCandidateRelationships(scene, copy, options, runtime, compositionState);
  if (scene.evidence) {
    const ids = new Set([...(scene.nodes || []).map(node => node.id), ...(scene.semanticGroups?.sourceNodeIds || [])]);
    const subjects = scene.evidence.subjects.filter(subject => ids.has(subject.id));
    const factIds = new Set(subjects.flatMap(subject => subject.facts));
    scene.evidence = { version: scene.evidence.version, facts: scene.evidence.facts.filter(fact => factIds.has(fact.id)), subjects: subjects.map(subject => ({ ...subject, facts: subject.facts.filter(id => factIds.has(id)) })) };
    if (scene.semanticGroups?.canonical) scene.semanticGroups.canonical.evidence = structuredClone(scene.evidence);
  }
  return scene;
}

function composeCandidateRelationships(scene, graph, options, runtime = {}, compositionState = null) {
  const projectNodes = (scene.nodes || []).filter(node => node.metadata?.nodeKind === 'repository' || (node.metadata?.full_name && !node.metadata?.nodeKind));
  const positions = new Map(projectNodes.map(node => [node.id, node.geometry]));
  const projects = graph.nodes.filter(node => node.kind === 'project' && positions.has(node.id)).map(node => ({
    id: node.id,
    languages: node.properties.language ? [node.properties.language] : [],
    topics: node.properties.topics || [],
    featured: node.properties.curatedRole === 'featured',
    position: [positions.get(node.id).x, positions.get(node.id).y],
  }));
  if (!projects.length) return null;
  const ids = new Set(projects.map(node => node.id));
  const families = graph.groups.filter(group => group.provenance === 'user').map(group => ({
    id: group.id,
    members: group.members.filter(id => ids.has(id)),
  }));
  const allProjectIds = new Set(graph.nodes.filter(node => node.kind === 'project').map(node => node.id));
  const authoredRelationships = graph.edges.filter(edge => edge.kind === 'project-relationship' && allProjectIds.has(edge.from) && allProjectIds.has(edge.to));
  const relationships = authoredRelationships.filter(edge => ids.has(edge.from) && ids.has(edge.to)).map(edge => ({ id: edge.id, from: edge.from, to: edge.to }));
  try {
    // The optional compositor can be replaced by a throwing stub in tests.
    const composition = (runtime.composeStory || composeStoryRust)({ projects, families, relationships, edge_budget: Math.min(4096, Math.max(1, projects.length)) });
    if (!composition || composition.version !== 1 || !Array.isArray(composition.relationships) || !Array.isArray(composition.diagnostics)
      || !Number.isSafeInteger(composition.suppressed_count) || composition.suppressed_count < 0
      || !Number.isSafeInteger(composition.candidate_count) || composition.candidate_count < 0) throw new Error('Invalid Story Composition result');
    const diagnostics = [...composition.diagnostics];
    const invisible = authoredRelationships.filter(edge => !ids.has(edge.from) || !ids.has(edge.to));
    if (invisible.length) diagnostics.push(...invisible.slice(0, 256).map(edge => ({ relationship_id: edge.id, reason: 'endpoint-not-visible-in-this-story-view' })));
    const retained = (scene.edges || []).filter(edge => !(ids.has(edge.from) && ids.has(edge.to)));
    for (const relationship of composition.relationships) {
      if (!relationship || typeof relationship.id !== 'string' || !ids.has(relationship.from) || !ids.has(relationship.to)
        || !['shared-language', 'shared-topic', 'authored-family', 'explicit-relationship'].includes(relationship.type)
        || !Array.isArray(relationship.evidence) || !relationship.evidence.length || relationship.evidence.some(value => typeof value !== 'string')) throw new Error('Invalid Story Composition relationship');
      const from = positions.get(relationship.from), to = positions.get(relationship.to);
      if (!from || !to) throw new Error('Story Composition endpoint has no position');
      const evidence = relationship.evidence;
      const sharedLanguages = evidence.filter(value => value.startsWith('language:')).map(value => value.slice(9));
      const sharedTopics = evidence.filter(value => value.startsWith('topic:')).map(value => value.slice(6));
      const shared = [...sharedLanguages, ...sharedTopics.map(value => `#${value}`), ...evidence.filter(value => !value.startsWith('language:') && !value.startsWith('topic:')).map(value => relationship.type === 'authored-family' ? 'project family' : 'user-authored relationship')];
      retained.push({
        id: relationship.id, from: relationship.from, to: relationship.to,
        metadata: { key: relationship.id, shared, sharedLanguages, sharedTopics, sharedRepositories: [], strength: evidence.length, relationshipType: relationship.type, relationshipTypes: relationship.types, relationshipEvidence: evidence },
        geometry: { distance: (from.x - to.x) ** 2 + (from.y - to.y) ** 2 },
        style: { primary: relationship.type === 'authored-family' || relationship.type === 'explicit-relationship' },
      });
    }
    const suppressedCount = composition.suppressed_count + invisible.length;
    if (!Number.isSafeInteger(suppressedCount)) throw new Error('Invalid Story Composition diagnostics');
    composition.diagnostics = diagnostics;
    composition.suppressed_count = suppressedCount;
    scene.edges = retained;
    if (scene.presentation) scene.presentation.totalConnections = retained.length;
    return composition;
  } catch {
    if (compositionState) compositionState.failed = true;
    return null;
  }
}

// Recovery path for a failed multi-candidate evaluation. It uses the same
// curated representative selection and scene projection as normal Projects.
export function generateBoundedProjectsFallback(graph, options = {}, runtime = {}) {
  if (graph?.subject?.kind !== 'developer') throw new Error('Story candidates require a developer Semantic Graph.');
  const scene = projectCandidate(graph, options, runtime, 'projects', selectRepresentativeProjects(graph.nodes.filter(node => node.kind === 'project')));
  const projectIds = scene.nodes.filter(node => node.metadata?.nodeKind === 'repository' || (node.metadata?.full_name && !node.metadata?.nodeKind));
  if (projectIds.length > STORY_PROJECT_LIMIT) throw new Error('Projects fallback exceeded the profile story limit.');
  const fingerprint = storySceneFingerprint(scene);
  return Object.freeze({ id: 'projects', label: 'Projects', question: 'What does this person build?', available: true, bounded: true, scene, sceneFingerprint: fingerprint, quality: null });
}

export function sceneQualityInput(scene, name) {
  const semanticGroups = scene.semanticGroups?.groups || [];
  const categoryGroups = (scene.nodes || []).filter(node => ['language', 'topic'].includes(node.metadata?.nodeKind)).map(node => ({ id: node.id, members: node.metadata.members || [], evidence: [`category:${node.metadata.nodeKind}:${node.metadata.name || node.id}`] }));
  const isProject = node => node.metadata?.nodeKind === 'repository' || (node.metadata?.full_name && !node.metadata?.nodeKind);
  const temporalGroups = scene.timeline?.frames?.length
    ? scene.timeline.frames.map(frame => ({ id: `period:${frame.date}`, members: (frame.scene?.nodes || []).filter(isProject).map(node => node.id), evidence: ['created-at-period'] }))
    : [];
  const groups = [...semanticGroups, ...categoryGroups, ...temporalGroups];
  const sourceNodes = scene.nodes || [];
  const nodes = sourceNodes.map(node => ({
    id: node.id, label: node.label || '',
    kind: isProject(node) ? 'project' : node.metadata?.nodeKind || 'other',
    x: Number(node.geometry?.x ?? node.x ?? 0), y: Number(node.geometry?.y ?? node.y ?? 0),
    evidence: [...(node.metadata?.language ? [`language:${node.metadata.language}`] : []), ...(node.metadata?.topics || []).map(topic => `topic:${topic}`), ...(['language','topic'].includes(node.metadata?.nodeKind) ? [`category:${node.metadata.nodeKind}:${node.metadata.name || node.id}`] : [])],
    curated: node.metadata?.curatedRole === 'featured' || node.metadata?.curatedRole === 'supporting',
  }));
  return { name, nodes, edges: (scene.edges || []).map(edge => ({ from: edge.from, to: edge.to })), groups: groups.map(group => ({ id: group.id, members: group.members || [], evidence: group.basis || [] })) };
}

export function generateStoryCandidates(graph, options = {}, runtime = {}) {
  if (graph?.subject?.kind !== 'developer') throw new Error('Story candidates require a developer Semantic Graph.');
  const allProjects = graph.nodes.filter(node => node.kind === 'project');
  const representativeProjects = selectRepresentativeProjects(allProjects);
  const referenceDate = options.referenceDate || options.generatedAt || new Date().toISOString();
  const journeyProjects = selectJourneyProjects(allProjects, STORY_PROJECT_LIMIT, referenceDate);
  const projectsComposition = {};
  const compositionState = { failed: false };
  const candidates = [
    { id: 'projects', label: 'Projects', question: 'What does this person build?', scene: projectCandidate(graph, options, runtime, 'projects', representativeProjects, projectsComposition, compositionState), composition: projectsComposition.value },
  ];
  const selectedProjects = representativeProjects;
  const featureCounts = new Map();
  for (const node of selectedProjects) for (const [kind, value] of [['language', node.properties.language], ...(node.properties.topics || []).map(topic => ['topic', topic])]) {
    if (value) featureCounts.set(`${kind}:${value}`, (featureCounts.get(`${kind}:${value}`) || 0) + 1);
  }
  const meaningfulFeatures = [...featureCounts].filter(([, count]) => count >= 2 && count < selectedProjects.length);
  const semanticLayoutActive = semanticActive(options);
  const technicalAvailable = selectedProjects.length >= 6 && meaningfulFeatures.length >= 2 && !semanticLayoutActive;
  const technicalComposition = {};
  candidates.push({ id: 'technical-shape', label: 'Technical Shape', question: 'What technical areas connect this work?', available: technicalAvailable, ...(technicalAvailable ? {} : { reason: semanticLayoutActive ? 'The current semantic ring presentation takes priority over category nodes.' : selectedProjects.length < 6 ? 'At least six representative projects are needed to form useful technical areas.' : 'The available language and topic evidence does not distinguish multiple project areas.' }), scene: projectCandidate(graph, options, runtime, 'technical-shape', representativeProjects, technicalComposition, compositionState), composition: technicalComposition.value });
  const projects = journeyProjects;
  const dated = projects.filter(node => /^\d{4}-\d{2}-\d{2}/.test(node.properties?.createdAt || ''));
  const years = new Set(dated.map(node => Number(node.properties.createdAt.slice(0, 4))));
  const firstYear = Math.min(...years);
  const periods = new Map();
  for (const node of dated) {
    const period = Math.floor((Number(node.properties.createdAt.slice(0, 4)) - firstYear) / 4);
    if (!periods.has(period)) periods.set(period, []);
    periods.get(period).push(node);
  }
  const periodEvidence = [...periods.values()].map(items => {
    const values = items.flatMap(node => [node.properties.language, ...(node.properties.topics || [])]).filter(Boolean);
    return [...new Set(values)].sort().join('|');
  });
  const temporalChange = periods.size >= 3 && [...periods.values()].every(items => items.length >= 2)
    && new Set(periodEvidence).size >= 2 && periodEvidence.every(Boolean);
  if (dated.length >= 6 && years.size >= 3 && temporalChange) {
    const records = projects.map(node => ({ full_name: node.id, name: node.label, description: node.properties.description || '', language: node.properties.language || null, topics: node.properties.topics || [], created_at: node.properties.createdAt || null }));
    const currentYear = new Date(referenceDate).getUTCFullYear();
    const start = Math.min(...[...years].filter(year => year <= currentYear));
    const end = Math.min(Math.max(...years), currentYear);
    const yearStep = Math.max(1, Math.ceil((end - start + 1) / 20));
    if (!Number.isFinite(start) || end - start < 2) {
      candidates.push({ id: 'journey', label: 'Journey', question: 'How has the visible work changed over time?', available: false, reason: 'Temporal evidence is too sparse to show a reliable progression.' });
    } else {
    const scene = createScene(graph.subject.id, records, { ...options, nodeMode: 'repositories', showOther: true, languages: undefined, topics: undefined, referenceDate, arrangement: 'temporal-stack', maxRepos: records.length, includeRepos: records.map(item => item.full_name), temporalStack: { enabled: true, axis: 'year', yearStart: start, yearEnd: end, yearStep, connections: 'none', innerArrangement: 'rings' } }, runtime);
    const journeyGraph = { nodes: projects, groups: graph.groups, edges: graph.edges };
    for (const frame of scene.timeline?.frames || scene.temporalStack?.frames || []) {
      composeCandidateRelationships(frame.scene, journeyGraph, options, runtime, compositionState);
    }
    const journeyComposition = composeCandidateRelationships(scene, journeyGraph, options, runtime, compositionState);
    candidates.push({ id: 'journey', label: 'Journey', question: 'How has the visible work changed over time?', available: true, scene, composition: journeyComposition });
    }
  } else candidates.push({ id: 'journey', label: 'Journey', question: 'How has the visible work changed over time?', available: false, reason: 'Dates and evidence do not show enough distinct project periods.' });
  return candidates.slice(0, STORY_CANDIDATE_LIMIT).map(candidate => {
    if (!candidate.scene) return Object.freeze({ ...candidate, quality: null });
    const qualityInput = sceneQualityInput(candidate.scene, candidate.id);
    const quality = evaluateGraphQuality(qualityInput);
    const fingerprint = storySceneFingerprint(candidate.scene);
    // Keep a small structural trace so callers and tests can verify which
    // project nodes entered scoring without exposing the full quality input.
    quality.evaluatedProjectIds = qualityInput.nodes.filter(node => node.kind === 'project').map(node => node.id).sort();
    quality.sceneFingerprint = fingerprint;
    let clarity = null;
    try { clarity = analyzeStoryClarity(sceneClarityInput(candidate.scene)); } catch { /* Keep existing candidates available if optional diagnostics fail. */ }
    return Object.freeze({ ...candidate, bounded: true, compositionFailed: compositionState.failed, sceneFingerprint: fingerprint, clarity: clarity ? Object.freeze(clarity) : null, quality: Object.freeze(quality) });
  });
}

export function recommendStoryCandidate(candidates) {
  const available = candidates.filter(candidate => STORY_TYPES.includes(candidate.id) && candidate.available !== false);
  const projects = available.find(candidate => candidate.id === 'projects');
  const technical = available.find(candidate => candidate.id === 'technical-shape');
  const journey = available.find(candidate => candidate.id === 'journey');
  if (journey && journey.quality.dimensions.narrativeStructure >= 0.65
    && journey.quality.dimensions.differentiation >= 0.5
    && journey.quality.score > Math.max(projects?.quality.score ?? 0, technical?.quality.score ?? 0) + 0.08) return journey;
  if (technical && technical.quality.dimensions.differentiation >= 0.25 && technical.quality.score > (projects?.quality.score ?? 0)) return technical;
  return projects || available[0] || null;
}
