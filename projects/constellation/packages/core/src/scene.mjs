import { layerDefinitions, validateLayerOptions, validateLayerOrder } from './scene-layers.mjs';
import { historyOptions } from './history/settings.mjs';
import { validateHierarchy } from './hierarchy-model.mjs';
import { validateStory } from './story-model.mjs';
import { validateTemporalStack } from './temporal-stack-model.mjs';
import { safeEvidenceText, validateEvidence } from './evidence.mjs';
// Stable Scene API v1; independently versioned from package/config releases.
export const SCENE_VERSION = 1;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const fail = (path, message) => { throw new Error(`Scene ${path}: ${message}`); };
const exactKeys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const safeList = (value, max, maxText = 160) => Array.isArray(value) && value.length <= max && value.every(item => safeEvidenceText(item, maxText));
const nonNegativeInteger = value => Number.isInteger(value) && value >= 0;

function validGroupExplanation(explanation, group, sourceNodeIds) {
  const optional = ['limitation', 'position'];
  if (!object(explanation) || Object.keys(explanation).some(key => !['version', 'groupId', 'provenance', 'summary', 'basis', 'groupingReason', 'memberSummary', 'characteristics', 'members', 'memberCount', 'memberExamplesTruncated', ...optional].includes(key))
    || explanation.version !== 1 || explanation.groupId !== group.id || explanation.provenance !== group.provenance
    || !safeEvidenceText(explanation.summary) || !safeList(explanation.basis, 16)
    || !safeEvidenceText(explanation.memberSummary) || !Array.isArray(explanation.characteristics)
    || explanation.characteristics.length > 13 || !Array.isArray(explanation.members) || explanation.members.length > 8
    || explanation.memberCount !== group.members.length || explanation.memberExamplesTruncated !== (explanation.memberCount > explanation.members.length)
    || explanation.members.length !== Math.min(explanation.memberCount, 8)) return false;
  if ((group.kind === 'project-family' && group.provenance !== 'user') || (group.kind === 'repository-owner' && group.provenance !== 'derived')) return false;
  const reason = explanation.groupingReason;
  const reasonKeys = group.kind === 'repository-owner' && reason?.basis !== undefined
    ? ['kind', 'summary', 'provenance', 'basis', 'count', 'total', 'evidence']
    : ['kind', 'summary', 'provenance', 'count', 'total', 'evidence'];
  if (!exactKeys(reason, reasonKeys) || reason.kind !== group.kind || reason.provenance !== group.provenance
    || !safeEvidenceText(reason.summary) || reason.summary !== explanation.summary
    || !nonNegativeInteger(reason.count) || !nonNegativeInteger(reason.total) || reason.count > reason.total
    || reason.count !== group.members.length || reason.total !== group.members.length || !Array.isArray(reason.evidence) || reason.evidence.length > 1) return false;
  if (group.kind === 'project-family') {
    if (reason.summary !== 'Defined by you.' || reason.evidence.length || reason.basis !== undefined) return false;
  } else {
    if (reason.summary !== 'Shared repository owner' || JSON.stringify(explanation.basis) !== JSON.stringify(group.basis.filter(value => safeEvidenceText(value)))) return false;
    if (reason.basis !== undefined && JSON.stringify(reason.basis) !== JSON.stringify(explanation.basis)) return false;
    const ownerSafe = safeEvidenceText(group.label);
    if (ownerSafe !== (reason.evidence.length === 1)) return false;
    if (ownerSafe) {
      const item = reason.evidence[0];
      if (!exactKeys(item, ['kind', 'value', 'count', 'total']) || item.kind !== 'repository-owner' || item.value !== group.label || item.count !== group.members.length || item.total !== group.members.length) return false;
    }
    if (!safeEvidenceText(explanation.limitation) || explanation.limitation !== 'This grouping describes repository ownership. It does not imply that the projects have the same purpose.') return false;
  }
  if (explanation.limitation !== undefined && group.kind !== 'repository-owner') return false;
  if (explanation.position !== undefined && (!exactKeys(explanation.position, ['provenance', 'summary']) || explanation.position.provenance !== 'user' || !safeEvidenceText(explanation.position.summary))) return false;
  const memberIds = new Set();
  for (const member of explanation.members) {
    if (!exactKeys(member, ['id', 'name']) || !id(member.id) || !group.members.includes(member.id) || !sourceNodeIds.has(member.id) || memberIds.has(member.id) || !safeEvidenceText(member.name)) return false;
    memberIds.add(member.id);
  }
  const characteristics = new Set(); let languages = 0, topics = 0, previous = null;
  for (const item of explanation.characteristics) {
    if (!exactKeys(item, ['kind', 'value', 'count', 'total', 'provenance']) || !['language', 'topic'].includes(item.kind) || !safeEvidenceText(item.value)
      || !nonNegativeInteger(item.count) || !Number.isInteger(item.total) || item.total < 1 || item.count > item.total || item.total !== group.members.length || item.provenance !== 'derived') return false;
    if (item.kind === 'language') languages++; else topics++;
    const normalized = item.value.toLocaleLowerCase('en-US'), key = `${item.kind}:${normalized}`;
    if (characteristics.has(key)) return false;
    characteristics.add(key);
    if (previous && (previous.count < item.count || previous.count === item.count && (previous.kind > item.kind || previous.kind === item.kind && previous.normalized > normalized))) return false;
    previous = { count: item.count, kind: item.kind, normalized };
  }
  return languages <= 5 && topics <= 8;
}

function validAggregateEvidence(edge) {
  const metadata = edge.metadata;
  if (!object(metadata) || !Number.isInteger(metadata.relationshipCount) || metadata.relationshipCount < 1
    || !Array.isArray(metadata.memberEdges) || metadata.memberEdges.length > 256 || metadata.memberEdges.length > metadata.relationshipCount
    || metadata.memberEdges.some(value => !id(value)) || new Set(metadata.memberEdges).size !== metadata.memberEdges.length) return false;
  const hasEvidence = Object.hasOwn(metadata, 'relationshipEvidence'), hasExamples = Object.hasOwn(metadata, 'examples');
  if (!hasEvidence && !hasExamples) return true;
  if (!hasEvidence || !hasExamples || !Array.isArray(metadata.relationshipEvidence) || metadata.relationshipEvidence.length > 13
    || !Array.isArray(metadata.examples) || metadata.examples.length > 5 || metadata.examples.length > metadata.relationshipCount) return false;
  let languages = 0, topics = 0; const seen = new Set();
  for (const item of metadata.relationshipEvidence) {
    if (!exactKeys(item, ['kind', 'value', 'normalized', 'count', 'total']) || !['language', 'topic'].includes(item.kind)
      || !safeEvidenceText(item.value) || !safeEvidenceText(item.normalized) || item.normalized !== item.value.toLocaleLowerCase('en-US')
      || !nonNegativeInteger(item.count) || item.count < 1 || item.count > item.total || item.total !== metadata.relationshipCount) return false;
    if (item.kind === 'language') languages++; else topics++;
    const key = `${item.kind}:${item.normalized}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  if (languages > 5 || topics > 8) return false;
  const examples = new Set();
  for (const item of metadata.examples) {
    if (!exactKeys(item, ['edgeId', 'from', 'to']) || !id(item.edgeId) || !id(item.from) || !id(item.to) || item.from === item.to || examples.has(item.edgeId)) return false;
    examples.add(item.edgeId);
  }
  return true;
}

function inspect(value, path, seen, depth = 0) {
  if (depth > 32) fail(path, 'nesting exceeds 32 levels');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value)) return;
  if (typeof value !== 'object') fail(path, 'expected JSON data with finite numbers');
  if (seen.has(value)) fail(path, 'cyclic data');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'expected a plain record');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(path, 'unsafe record key');
    inspect(child, `${path}.${key}`, seen, depth + 1);
  }
  seen.delete(value);
}

function record(scene, path = '$') {
  if (!object(scene) || scene.version !== SCENE_VERSION) fail(path, 'unsupported scene version');
  if (!object(scene.metadata) || !id(scene.metadata.account) || !id(scene.metadata.seed) || !Number.isFinite(Date.parse(scene.metadata.referenceDate))) fail(path, 'invalid metadata');
  if (!object(scene.presentation)) fail(path, 'missing presentation data');
  const options = scene.presentation.options;
  if (!object(options)) fail(path, 'missing presentation options');
  historyOptions(options);
  if (options.colors !== undefined && (!object(options.colors) || Object.entries(options.colors).some(([key, color]) => !['background', 'foreground', 'accent', 'line', 'star'].includes(key) || typeof color !== 'string' || !/^#[a-f\d]{3}(?:[a-f\d]{3})?$/i.test(color)))) fail(path, 'invalid palette');
  if (options.theme !== undefined && !['auto', 'midnight', 'light'].includes(options.theme)) fail(path, 'invalid theme');
  if (scene.kind === 'time-lapse') {
    if (!Array.isArray(scene.frames) || scene.frames.length > 7 || scene.latest?.kind !== 'scene') fail(path, 'invalid temporal frames');
    record(scene.latest, `${path}.latest`);
    let previous = -Infinity;
    for (const frame of scene.frames) {
      if (!Number.isInteger(frame.year) || frame.year <= previous || frame.scene?.kind !== 'scene') fail(path, 'frames must have unique ascending years');
      previous = frame.year;
      record(frame.scene, `${path}.frames.${frame.year}`);
    }
    return;
  }
  if (scene.kind !== 'scene') fail(path, 'unknown scene kind');
  if (scene.semantic !== undefined) {
    const semantic = scene.semantic;
    const point = p => Array.isArray(p) && p.length === 2 && p.every(v => finite(v) && Math.abs(v) <= 10000);
    if (!object(semantic) || !['identity','capability','showcase','activity','era'].includes(semantic.mode)
      || !Array.isArray(semantic.radii) || semantic.radii.length > 6 || semantic.radii.some(r => !finite(r) || r < 0 || r > 1)
      || !Array.isArray(semantic.bands) || semantic.bands.length !== semantic.radii.length || semantic.bands.some(b => typeof b !== 'string' || b.length > 100)
      || !Array.isArray(semantic.guides) || semantic.guides.length > 12 || semantic.guides.some(g => !point(g.position) || typeof g.text !== 'string')
      || !Array.isArray(semantic.rays) || semantic.rays.length !== 6 || semantic.rays.some(r => !['interface','services','data','systems','tooling','automation'].includes(r.dimension) || !point(r.start) || !point(r.end) || !point(r.label))
      || !Array.isArray(semantic.placements) || semantic.placements.length > 256 || semantic.placements.some(p => typeof p.repository !== 'string' || typeof p.category !== 'string' || !Number.isInteger(p.band) || p.band < 0 || p.band >= semantic.bands.length || !point(p.position))
      || !object(semantic.profile) || !Array.isArray(semantic.profile.dimensions) || semantic.profile.dimensions.length !== 6
      || semantic.profile.dimensions.some(d => !finite(d.score) || d.score < 0 || d.score > 1 || !Array.isArray(d.evidence) || d.evidence.length > 256 || d.evidence.some(e => typeof e.repository !== 'string' || typeof e.reason !== 'string'))) fail(path, 'invalid semantic geometry or evidence');
  }
  const graph = scene.presentation.graph;
  if (!object(graph) || !['repositories', 'languages', 'topics', 'combined', 'contributors', 'ecosystem', 'organization-community', 'dependencies', 'technology', 'eras', 'commits'].includes(scene.presentation.nodeMode)) fail(path, 'invalid graph presentation');
  for (const key of ['repositoryCount', 'total', 'nodeCount']) if (graph[key] !== undefined && (!Number.isInteger(graph[key]) || graph[key] < 0)) fail(path, 'invalid graph count');
  if (!Number.isInteger(scene.presentation.totalConnections) || scene.presentation.totalConnections < 0) fail(path, 'invalid connection count');
  if (graph.focusProjects !== undefined && (!Array.isArray(graph.focusProjects) || graph.focusProjects.some(value => typeof value !== 'string'))) fail(path, 'invalid focused project list');
  const viewport = scene.viewport;
  if (!object(viewport) || !finite(viewport.width) || !finite(viewport.height) || viewport.width <= 0 || viewport.height <= 0 || viewport.width > 100000 || viewport.height > 100000 || !Array.isArray(viewport.viewBox) || viewport.viewBox.length !== 4 || !viewport.viewBox.every(value => finite(value) && Math.abs(value) <= 100000) || viewport.viewBox[2] <= 0 || viewport.viewBox[3] <= 0) fail(path, 'invalid viewport');
  for (const key of ['nodes', 'edges', 'labels', 'layers']) if (!Array.isArray(scene[key])) fail(`${path}.${key}`, 'expected array');
  if (scene.nodes.length > 2048 || scene.edges.length > 100000) fail(path, 'scene exceeds graph bounds');
  const nodes = new Set(), edges = new Set(), layers = new Set();
  for (const node of scene.nodes) {
    if (!id(node?.id) || nodes.has(node.id)) fail(`${path}.nodes`, 'missing or duplicate node ID');
    nodes.add(node.id);
    if (!object(node.geometry) || !['x', 'y', 'radius'].every(key => finite(node.geometry[key])) || node.geometry.radius < 0) fail(`${path}.nodes.${node.id}`, 'invalid geometry');
    if (!object(node.metadata) || node.metadata.full_name !== node.id || typeof node.metadata.name !== 'string') fail(`${path}.nodes.${node.id}`, 'invalid metadata');
    if (!object(node.style) || !(node.style.color === null || /^#[a-f\d]{6}$/i.test(node.style.color)) || !(node.style.glow === null || finite(node.style.glow)) || !['circle', 'diamond', 'square', 'hexagon', 'star'].includes(node.style.shape)) fail(`${path}.nodes.${node.id}`, 'invalid style');
    if (!object(node.interaction) || typeof node.interaction.hidden !== 'boolean' || typeof node.interaction.labelHidden !== 'boolean') fail(`${path}.nodes.${node.id}`, 'invalid interaction metadata');
    if (node.style.opacity !== undefined && (!finite(node.style.opacity) || node.style.opacity < 0 || node.style.opacity > 1)) fail(`${path}.nodes.${node.id}`, 'invalid opacity');
  }
  if (scene.evidence !== undefined) {
    const evidenceNodeIds = new Set(nodes);
    for (const sourceId of scene.semanticGroups?.sourceNodeIds || []) evidenceNodeIds.add(sourceId);
    for (const frame of [...(scene.timeline?.frames || []), ...(scene.temporalStack?.frames || [])]) {
      for (const node of frame.scene?.nodes || []) {
        if (evidenceNodeIds.size >= 16384) break;
        evidenceNodeIds.add(node.id);
      }
    }
    if (!validateEvidence(scene.evidence, evidenceNodeIds)) fail(`${path}.evidence`, 'invalid or out-of-bounds evidence attachment');
  }
  if (scene.semanticGroups !== undefined) {
    const semantic = scene.semanticGroups;
    if (!object(semantic) || semantic.version !== 1 || !['overview', 'groups', 'projects'].includes(semantic.level) || !Array.isArray(semantic.groups) || semantic.groups.length > 256 || !Array.isArray(semantic.sourceNodeIds) || semantic.sourceNodeIds.length > 2048 || semantic.sourceNodeIds.some(value => !id(value)) || new Set(semantic.sourceNodeIds).size !== semantic.sourceNodeIds.length || !Array.isArray(semantic.expanded) || semantic.expanded.length > 256 || new Set(semantic.expanded).size !== semantic.expanded.length) fail(`${path}.semanticGroups`, 'invalid hierarchy projection');
    const groupIds = new Set(), sourceNodeIds = new Set(semantic.sourceNodeIds); let members = 0;
    for (const group of semantic.groups) {
      if (!object(group) || group.version !== 1 || !id(group.id) || groupIds.has(group.id) || !['project-family', 'repository-owner'].includes(group.kind) || !['user', 'derived'].includes(group.provenance) || (group.kind === 'project-family') !== (group.provenance === 'user') || !id(group.label) || !Array.isArray(group.members) || group.members.length < 2 || group.members.length > 2048 || new Set(group.members).size !== group.members.length || !Array.isArray(group.basis) || group.basis.length > 16 || group.basis.some(value => typeof value !== 'string' || value.length > 160) || group.members.some(value => !sourceNodeIds.has(value))) fail(`${path}.semanticGroups`, 'invalid group');
      if (Object.hasOwn(group, 'explanation') && !validGroupExplanation(group.explanation, group, sourceNodeIds)) fail(`${path}.semanticGroups.${group.id}.explanation`, 'invalid group explanation');
      members += group.members.length; groupIds.add(group.id);
    }
    if (members > 32768 || semantic.expanded.some(value => !groupIds.has(value))) fail(`${path}.semanticGroups`, 'hierarchy exceeds bounds or has unknown expanded groups');
    if (semantic.canonical !== undefined) {
      const canonical = semantic.canonical, projectIds = new Set();
      if (!object(canonical) || !id(canonical.account) || canonical.account.length > 160 || !Array.isArray(canonical.projects) || canonical.projects.length > 2048 || !Array.isArray(canonical.groups) || canonical.groups.length > 256 || typeof canonical.truncated !== 'boolean' || !Array.isArray(canonical.projectRelationships) || canonical.projectRelationships.length > 6 || !validateEvidence(canonical.evidence, new Set([...(canonical.projects || []).map(item => item?.id), ...(canonical.groups || []).map(item => item?.id)]))) fail(`${path}.semanticGroups.canonical`, 'invalid canonical semantic source');
      for (const project of canonical.projects || []) {
        if (!object(project) || !id(project.id) || projectIds.has(project.id) || !sourceNodeIds.has(project.id) || Object.keys(project).some(key => !['id', 'name', 'description', 'url', 'created_at', 'updated_at', 'language', 'topics', 'source', 'family'].includes(key)) || ['name', 'description', 'url', 'created_at', 'updated_at', 'language', 'source', 'family'].some(key => project[key] !== undefined && !safeEvidenceText(project[key], key === 'source' ? 80 : 160)) || project.topics !== undefined && !safeList(project.topics, 32)) fail(`${path}.semanticGroups.canonical.projects`, 'invalid bounded project metadata');
        projectIds.add(project.id);
      }
      const canonicalGroups = new Map((canonical.groups || []).map(group => [group?.id, group]));
      if (canonicalGroups.size !== groupIds.size || [...groupIds].some(groupId => !canonicalGroups.has(groupId))) fail(`${path}.semanticGroups.canonical.groups`, 'canonical groups disagree with the projection');
      for (const group of canonical.groups || []) {
        const projected = semantic.groups.find(item => item.id === group?.id);
        if (!object(group) || !projected || !(group.label === null || safeEvidenceText(group.label, 160)) || group.kind !== projected.kind || group.label !== null && group.label !== projected.label || group.provenance !== projected.provenance || JSON.stringify(group.members) !== JSON.stringify(projected.members) || JSON.stringify(group.basis) !== JSON.stringify(projected.basis) || !group.members.every(member => projectIds.has(member))) fail(`${path}.semanticGroups.canonical.groups`, 'invalid or contradictory canonical group');
      }
      for (const pair of canonical.projectRelationships || []) if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === pair[1] || pair.some(projectId => !projectIds.has(projectId))) fail(`${path}.semanticGroups.canonical.projectRelationships`, 'invalid canonical project relationship');
    }
  }
  for (const edge of scene.edges) {
    if (!id(edge?.id) || edges.has(edge.id) || !nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to) fail(`${path}.edges`, 'invalid ID or endpoints');
    edges.add(edge.id);
    if (!object(edge.geometry) || !finite(edge.geometry.distance) || edge.geometry.distance < 0 || typeof edge.style?.primary !== 'boolean') fail(`${path}.edges.${edge.id}`, 'invalid geometry or style');
    if (edge.metadata?.aggregated === true && !validAggregateEvidence(edge)) fail(`${path}.edges.${edge.id}.metadata`, 'invalid aggregate evidence');
  }
  const labels = new Set();
  for (const label of scene.labels) {
    if (!nodes.has(label?.id) || labels.has(label.id) || !finite(label.x) || !finite(label.y) || typeof label.text !== 'string' || typeof label.hidden !== 'boolean' || typeof label.focal !== 'boolean') fail(`${path}.labels`, 'invalid label');
    labels.add(label.id);
  }
  let order = -Infinity;
  for (const layer of scene.layers) {
    if (!id(layer?.id) || layers.has(layer.id) || !Number.isInteger(layer.order) || layer.order <= order) fail(`${path}.layers`, 'IDs and order must be unique and ascending');
    layers.add(layer.id); order = layer.order;
    validateLayerOptions({ [layer.id]: { visible: layer.visible, opacity: layer.opacity, order: layer.order } });
    const definition = layerDefinitions.find(value => value.id === layer.id);
    if (!definition || layer.type !== definition.type || JSON.stringify(layer.phases) !== JSON.stringify(definition.phases)) fail(`${path}.layers`, 'invalid layer type or phases');
  }
  if (layers.size !== layerDefinitions.length) fail(`${path}.layers`, 'missing required layer');
  validateLayerOrder(scene.layers);
  if (scene.annotations !== undefined && (!Array.isArray(scene.annotations) || scene.annotations.length > 32 || scene.annotations.some(annotation => !object(annotation) || typeof annotation.text !== 'string' || annotation.text.length > 2000 || !finite(annotation.x) || !finite(annotation.y) || Math.abs(annotation.x) > 100000 || Math.abs(annotation.y) > 100000))) fail(path, 'invalid annotations');
  if (scene.story !== undefined) validateStory(scene.story, record);
  if (scene.hierarchy !== undefined) validateHierarchy(scene.hierarchy, record);
  if (scene.timeline !== undefined) {
    const timeline = scene.timeline;
    if (!object(timeline) || timeline.version !== 1 || !Array.isArray(timeline.frames) || timeline.frames.length < 1 || timeline.frames.length > 64 || timeline.referenceDate !== scene.metadata.referenceDate) fail(path, 'invalid timeline');
    let previous = '', totalNodes = 0;
    for (const frame of timeline.frames) {
      if (frame.scene?.temporalStack !== undefined) fail(path, 'timeline frames cannot nest temporal stacks');
      if (typeof frame.date !== 'string' || !Number.isFinite(Date.parse(frame.date)) || new Date(frame.date).toISOString() !== frame.date || frame.date <= previous || frame.date > timeline.referenceDate || frame.id !== frame.date || !['snapshot', 'current', 'current-metadata'].includes(frame.evidence) || frame.scene?.kind !== 'scene' || frame.scene.timeline !== undefined || frame.scene.hierarchy !== undefined || frame.scene.story !== undefined || frame.scene.metadata.referenceDate !== frame.date) fail(path, 'invalid timeline frame');
      record(frame.scene, `${path}.timeline.${frame.id}`); previous = frame.date;
      totalNodes += frame.scene.nodes.length;
      if (totalNodes > 16384) fail(path, 'timeline exceeds aggregate node bounds');
    }
    if (previous !== timeline.referenceDate) fail(path, 'timeline must end at the reference date');
  }
  if (scene.temporalStack !== undefined) validateTemporalStack(scene, frame => record(frame, path + '.temporalStack.frame'));
  if (!object(scene.geometry) || !(scene.geometry.identity === null || Array.isArray(scene.geometry.identity) && scene.geometry.identity.length === 90 && scene.geometry.identity.every(finite)) || !Array.isArray(scene.geometry.ringPoints) || scene.geometry.ringPoints.length > 6144 || scene.geometry.ringPoints.length % 3 || !scene.geometry.ringPoints.every(finite)) fail(path, 'invalid ring geometry');
}

export function assertScene(scene) {
  inspect(scene, '$', new WeakSet());
  record(scene);
  return scene;
}

export function validateScene(scene) {
  try { assertScene(scene); return { valid: true, errors: [] }; }
  catch (error) { return { valid: false, errors: [error.message] }; }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function serializeScene(scene) {
  const json = JSON.stringify(canonical(assertScene(scene)), null, 2) + '\n';
  if (new TextEncoder().encode(json).length > 32 * 1024 * 1024) throw new Error('Scene JSON exceeds 32 MiB.');
  return json;
}

export function parseScene(json) {
  if (typeof json !== 'string' || json.length > 32 * 1024 * 1024 || new TextEncoder().encode(json).length > 32 * 1024 * 1024) throw new Error('Scene JSON must be text no larger than 32 MiB.');
  return assertScene(JSON.parse(json));
}

export function sceneStatistics(scene) {
  assertScene(scene);
  const current = scene.kind === 'time-lapse' ? scene.latest : scene;
  const visible = id => current.layers.some(layer => layer.id === id && layer.visible !== false && layer.opacity !== 0);
  return {
    version: scene.version, kind: scene.kind,
    nodes: current.nodes.length,
    visibleNodes: visible('nodes') ? current.nodes.filter(node => !node.interaction.hidden && node.style.opacity !== 0).length : 0,
    edges: current.edges.length,
    labels: current.labels.length,
    visibleLabels: visible('labels') ? current.labels.filter(label => !label.hidden).length : 0,
    layers: current.layers.map(layer => layer.id),
    frames: scene.temporalStack?.frames?.length || scene.timeline?.frames.length || (scene.kind === 'time-lapse' ? scene.frames.length + 1 : 1),
    referenceDate: scene.metadata.referenceDate,
    pipeline: structuredClone(current.presentation.pipeline),
  };
}
