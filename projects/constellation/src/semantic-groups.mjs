import { assertScene } from './scene.mjs';
import { attachGroupEvidence, safeEvidenceText } from './evidence.mjs';
import { fitSceneViewport } from './scene-framing.mjs';

export const SEMANTIC_GROUP_VERSION = 1;
export const SEMANTIC_LEVELS = Object.freeze(['overview', 'groups', 'projects']);
export const MAX_SEMANTIC_GROUPS = 256;
export const MAX_GROUP_MEMBERS = 2048;
const MAX_GROUPS_PER_SCENE = 256;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const stableHash = text => {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (const ch of text) { const c = ch.codePointAt(0); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x85ebca6b) >>> 0; }
  return `${a.toString(36)}${b.toString(36)}`;
};
const displayName = node => node.metadata.name || node.id.split('/').at(-1) || node.id;

function normalizeFamilies(families, nodeIds) {
  if (families === undefined) return [];
  if (!object(families) || Object.keys(families).length > MAX_SEMANTIC_GROUPS) throw new Error('projectFamilies must be an object with at most 256 families.');
  const result = [];
  const canonicalIds = new Map([...nodeIds].map(id => [id.toLowerCase(), id]));
  for (const [authoredId, family] of Object.entries(families).sort(([a], [b]) => a.localeCompare(b))) {
    if (!safeId(authoredId) || !object(family) || !safeId(family.label) || !Array.isArray(family.members) || family.members.length < 2 || family.members.length > MAX_GROUP_MEMBERS) throw new Error(`Invalid project family: ${authoredId}`);
    if (family.members.some(id => typeof id !== 'string' || id.length > 4096)) throw new Error(`Project family ${authoredId} contains an invalid member ID.`);
    const members = family.members.map(id => canonicalIds.get(id.toLowerCase())).filter(Boolean);
    if (new Set(members).size !== members.length) throw new Error(`Project family ${authoredId} contains duplicate members.`);
    if (members.length < 2) continue;
    result.push({ version: 1, id: `group:user:${authoredId}`, authoredId, kind: 'project-family', label: family.label, provenance: 'user', basis: [], members: members.sort() });
  }
  return result;
}

export function buildSemanticHierarchy(scene, { projectFamilies = scene?.presentation?.options?.projectFamilies, derive = true } = {}) {
  assertScene(scene);
  if (scene.nodes.length > MAX_GROUP_MEMBERS) throw new Error('Semantic grouping supports at most 2048 projects per scene.');
  const byId = new Map(scene.nodes.map(node => [node.id, node]));
  const authored = normalizeFamilies(projectFamilies, new Set(byId.keys()));
  const claimed = new Set();
  for (const group of authored) for (const id of group.members) {
    if (claimed.has(id)) throw new Error(`Project ${id} belongs to more than one project family.`);
    claimed.add(id);
  }
  const groups = [...authored];
  if (derive && scene.nodes.length <= 256) {
    const owners = new Map();
    for (const node of scene.nodes) {
      const owner = node.id.split('/')[0]?.toLowerCase();
      if (!owner || claimed.has(node.id)) continue;
      if (!owners.has(owner)) owners.set(owner, []);
      owners.get(owner).push(node.id);
    }
    for (const [owner, members] of [...owners].sort(([a], [b]) => a.localeCompare(b))) {
      if (members.length < 2 || members.length > MAX_GROUP_MEMBERS || members.length > scene.nodes.length * .75 || groups.length >= MAX_GROUPS_PER_SCENE) continue;
      const sorted = members.sort();
      // Group identity belongs to the normalized owner namespace, not the current filtered membership.
      groups.push({ version: 1, id: `group:owner:${stableHash(owner)}`, kind: 'repository-owner', label: owner, provenance: 'derived', basis: [`repository-owner:${owner}`], members: sorted });
    }
  }
  const manualPositions = scene.presentation.options.starPositions || {};
  const stableGroups = groups.slice(0, MAX_GROUPS_PER_SCENE).map(group => {
    const position = manualPositions[group.id];
    return position && Number.isFinite(position.x) && Number.isFinite(position.y) ? { ...group, manualPosition: { x: position.x, y: position.y } } : group;
  });
  return { version: SEMANTIC_GROUP_VERSION, levels: [...SEMANTIC_LEVELS], groups: stableGroups, projectIds: scene.nodes.map(node => node.id), source: scene };
}

function groupNode(group, members) {
  const x = group.manualPosition?.x ?? members.reduce((sum, node) => sum + node.geometry.x, 0) / members.length;
  const y = group.manualPosition?.y ?? members.reduce((sum, node) => sum + node.geometry.y, 0) / members.length;
  return { id: group.id, geometry: { x, y, radius: Math.min(34, 14 + Math.log2(members.length + 1) * 3) }, metadata: { ...safeMetadata(members[0].metadata), full_name: group.id, name: group.label, description: `${members.length} projects · ${group.provenance === 'user' ? 'project family' : 'derived group'}`, nodeKind: 'semantic-group', groupKind: group.kind, memberCount: members.length }, style: { color: null, glow: null, opacity: 1, shape: 'hexagon' }, interaction: { hidden: false, labelHidden: false }, semanticGroup: { id: group.id, provenance: group.provenance, members: [...group.members] } };
}

function safeMetadata(metadata) {
  const result = structuredClone(metadata || {});
  if (typeof result.language === 'string' && !safeEvidenceText(result.language)) delete result.language;
  if (result.languages && typeof result.languages === 'object' && !Array.isArray(result.languages)) {
    for (const language of Object.keys(result.languages)) if (!safeEvidenceText(language)) delete result.languages[language];
  }
  if (Array.isArray(result.topics)) result.topics = result.topics.filter(value => safeEvidenceText(value));
  return result;
}

function safeProjectedNode(node) {
  const result = structuredClone(node);
  result.metadata = safeMetadata(node.metadata);
  return result;
}

export function projectSemanticLevel(scene, level = 'groups', { hierarchy = null, expanded = [] } = {}) {
  if (!SEMANTIC_LEVELS.includes(level)) throw new Error(`Unknown semantic level: ${level}`);
  assertScene(scene);
  if (level === 'projects') return structuredClone(scene);
  hierarchy ||= buildSemanticHierarchy(scene);
  const expandedIds = new Set(expanded);
  if ([...expandedIds].some(id => !hierarchy.groups.some(group => group.id === id))) throw new Error('Expanded state contains an unknown semantic group.');
  const groupByMember = new Map();
  for (const group of hierarchy.groups) if (!expandedIds.has(group.id)) for (const id of group.members) groupByMember.set(id, group);
  const nodes = [], represented = new Map();
  for (const node of scene.nodes) {
    const group = groupByMember.get(node.id);
    if (!group) { nodes.push(safeProjectedNode(node)); represented.set(node.id, node.id); continue; }
    represented.set(node.id, group.id);
    if (!nodes.some(item => item.id === group.id)) nodes.push(groupNode(group, group.members.map(id => scene.nodes.find(node => node.id === id)).filter(Boolean)));
  }
  const edgeBuckets = new Map();
  for (const edge of scene.edges) {
    const from = represented.get(edge.from), to = represented.get(edge.to);
    if (!from || !to || from === to) continue;
    const endpoints = [from, to].sort();
    const key = JSON.stringify(endpoints);
    if (!edgeBuckets.has(key)) edgeBuckets.set(key, { from: endpoints[0], to: endpoints[1], members: [], source: [] });
    const bucket = edgeBuckets.get(key);
    bucket.members.push(edge.id); bucket.source.push(edge);
  }
  const projectedNodes = new Map(nodes.map(node => [node.id, node]));
  const edges = [...edgeBuckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, bucket]) => {
    bucket.members.sort();
    const from = projectedNodes.get(bucket.from), to = projectedNodes.get(bucket.to);
    const sharedLanguages = common(bucket.source, 'sharedLanguages'), sharedTopics = common(bucket.source, 'sharedTopics'), sharedRepositories = common(bucket.source, 'sharedRepositories');
    const relationshipEvidence = ['sharedLanguages', 'sharedTopics'].flatMap(field => {
      const counts = new Map();
      for (const edge of bucket.source) {
        const unique = new Map();
        for (const value of (Array.isArray(edge.metadata?.[field]) ? edge.metadata[field] : []).filter(value => typeof value === 'string' && safeEvidenceText(value.trim())).map(value => value.trim()).sort(compareText)) {
          const normalized = value.toLocaleLowerCase('en-US');
          if (!unique.has(normalized)) unique.set(normalized, value);
        }
        for (const [normalized, value] of unique) {
          if (!counts.has(normalized)) counts.set(normalized, { value, count: 0 });
          else if (compareText(value, counts.get(normalized).value) < 0) counts.get(normalized).value = value;
          counts.get(normalized).count++;
        }
      }
      return [...counts.entries()].sort(([a, x], [b, y]) => y.count - x.count || compareText(a, b)).slice(0, field === 'sharedLanguages' ? 5 : 8).map(([normalized, item]) => ({ kind: field === 'sharedLanguages' ? 'language' : 'topic', value: item.value, normalized, count: item.count, total: bucket.source.length }));
    });
    const examples = [...bucket.source].sort((a, b) => compareText(a.id, b.id)).slice(0, 5).map(edge => ({ edgeId: edge.id, from: edge.from, to: edge.to }));
    return { id: `group-edge:${stableHash(key)}`, from: bucket.from, to: bucket.to, metadata: { key, shared: [...sharedLanguages, ...sharedTopics.map(value => `#${value}`)], strength: bucket.members.length, aggregated: true, memberEdges: bucket.members.slice(0, 256), relationshipCount: bucket.members.length, sharedLanguages, sharedTopics, sharedRepositories, relationshipEvidence, examples }, geometry: { distance: Math.hypot(from.geometry.x - to.geometry.x, from.geometry.y - to.geometry.y) }, style: { primary: bucket.source.some(edge => edge.style.primary) } };
  });
  const labels = nodes.map(node => ({ id: node.id, x: node.geometry.x, y: node.geometry.y + node.geometry.radius + 8, text: displayName(node), hidden: false, focal: false }));
  const groupRecords = hierarchy.groups.map(group => ({ ...group, members: [...group.members], explanation: explainGroup(hierarchy, group.id) }));
  const collapsedGroups = groupRecords.filter(group => !expandedIds.has(group.id));
  const source = hierarchy.source;
  const safeOptional = (value, max = 160) => safeEvidenceText(value, max) ? value : undefined;
  const sourceProjects = source.nodes.map(node => {
    const metadata = node.metadata || {};
    const optional = { name: safeOptional(metadata.name), description: safeOptional(metadata.description), url: safeOptional(metadata.html_url), language: safeOptional(metadata.language), source: safeOptional(metadata.pluginSource || metadata.source, 80), family: safeOptional(metadata.projectFamily) };
    const topics = (Array.isArray(metadata.topics) ? metadata.topics : []).filter(value => safeEvidenceText(value, 160)).slice(0, 32);
    return { id: node.id, ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)), ...(safeOptional(metadata.created_at) ? { created_at: safeOptional(metadata.created_at) } : {}), ...(safeOptional(metadata.updated_at) ? { updated_at: safeOptional(metadata.updated_at) } : {}), ...(topics.length ? { topics } : {}) };
  });
  const projectIds = new Set(sourceProjects.map(project => project.id));
  const canonical = {
    account: source.metadata?.account || 'unknown',
    projects: sourceProjects,
    groups: hierarchy.groups.map(group => ({ id: group.id, kind: group.kind, label: safeOptional(group.label) || null, provenance: group.provenance, basis: group.basis.filter(value => safeEvidenceText(value, 160)).slice(0, 16), members: [...group.members] })),
    evidence: structuredClone(source.evidence || { version: 1, facts: [], subjects: [] }),
    projectRelationships: (source.presentation?.options?.projectRelationships || []).filter(pair => Array.isArray(pair) && pair.length === 2 && pair.every(id => projectIds.has(id))).map(pair => [...pair]),
    truncated: source.presentation?.pipeline?.truncated === true,
  };
  const projected = { ...structuredClone(scene), nodes, edges, labels, evidence: attachGroupEvidence(scene.evidence, collapsedGroups), semanticGroups: { version: 1, level, expanded: [...expandedIds], groups: groupRecords, sourceNodeIds: source.nodes.map(node => node.id), canonical } };
  const fixedExport = ['readme', 'repository', 'compact', 'wide'].includes(scene.presentation?.options?.exportProfile);
  return fixedExport || scene.profile || scene.presentation?.graph?.organization || scene.presentation?.options?.perspective?.enabled ? projected : fitSceneViewport(projected);
}

function common(edges, key) {
  if (!edges.length) return [];
  const sets = edges.map(edge => new Set((Array.isArray(edge.metadata?.[key]) ? edge.metadata[key] : []).filter(value => safeEvidenceText(value))));
  return [...sets[0]].filter(value => sets.every(set => set.has(value))).sort().slice(0, 16);
}

export function expandGroup(scene, hierarchy, groupId) {
  const group = hierarchy?.groups?.find(item => item.id === groupId);
  if (!group) throw new Error(`Unknown semantic group: ${groupId}`);
  const current = scene?.semanticGroups?.expanded || [];
  return projectSemanticLevel(hierarchy.source, 'groups', { hierarchy, expanded: [...new Set([...current, groupId])] });
}

export function collapseGroup(scene, hierarchy, groupId) {
  if (!hierarchy?.groups?.some(item => item.id === groupId)) throw new Error(`Unknown semantic group: ${groupId}`);
  const current = scene?.semanticGroups?.expanded || [];
  return projectSemanticLevel(hierarchy.source, 'groups', { hierarchy, expanded: current.filter(id => id !== groupId) });
}

export function explainGroup(hierarchy, groupId) {
  const group = hierarchy?.groups?.find(item => item.id === groupId);
  if (!group) return null;
  const projects = new Map(hierarchy.source.nodes.map(node => [node.id, node]));
  const total = group.members.length;
  const counts = new Map();
  for (const id of group.members) {
    const metadata = projects.get(id)?.metadata || {};
    const values = [
      ['language', [metadata.language, ...Object.keys(metadata.languages || {}).sort(compareText)]],
      ['topic', Array.isArray(metadata.topics) ? metadata.topics : []],
    ];
    for (const [kind, entries] of values) for (const [normalized, value] of new Map(entries.filter(value => typeof value === 'string' && safeEvidenceText(value.trim())).map(value => value.trim()).sort(compareText).map(value => [value.toLocaleLowerCase('en-US'), value]))) {
      const key = `${kind}:${normalized}`;
      if (!counts.has(key)) counts.set(key, { kind, value, normalized, count: 0 });
      counts.get(key).count++;
    }
  }
  const bounded = ['language', 'topic'].flatMap(kind => [...counts.values()].filter(item => item.kind === kind).sort((a, b) => b.count - a.count || compareText(a.normalized, b.normalized)).slice(0, kind === 'language' ? 5 : 8));
  const characteristics = bounded.sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0)).map(({ kind, value, count }) => ({ kind, value, count, total, provenance: 'derived' }));
  const safeBasis = group.basis.filter(value => safeEvidenceText(value));
  const ownerIsSafe = group.kind !== 'repository-owner' || safeEvidenceText(group.label);
  const reason = group.provenance === 'user'
    ? { kind: group.kind, summary: 'Defined by you.', provenance: 'user', count: total, total, evidence: [] }
    : { kind: group.kind, summary: 'Shared repository owner', provenance: 'derived', basis: safeBasis, count: total, total, evidence: ownerIsSafe ? [{ kind: 'repository-owner', value: group.label, count: total, total }] : [] };
  return {
    version: 1, groupId, provenance: group.provenance, summary: reason.summary, basis: safeBasis,
    groupingReason: reason,
    memberSummary: group.kind === 'repository-owner' ? ownerIsSafe ? `All ${total} visible projects share the repository owner: ${group.label}.` : `All ${total} visible projects share a repository owner.` : `This project family contains ${total} visible projects.`,
    characteristics,
    ...(group.kind === 'repository-owner' ? { limitation: 'This grouping describes repository ownership. It does not imply that the projects have the same purpose.' } : {}),
    ...(group.manualPosition ? { position: { provenance: 'user', summary: 'Placed manually by you.' } } : {}),
    members: group.members.slice(0, 8).map(id => ({ id, name: safeEvidenceText(projects.get(id)?.metadata.name) ? projects.get(id).metadata.name : 'Project' })),
    memberCount: total, memberExamplesTruncated: total > 8,
  };
}
