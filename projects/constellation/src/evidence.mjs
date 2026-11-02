// Scene Evidence v1 is a bounded, declarative explanation attachment. Facts
// are interned once and referenced by subjects to avoid repeating metadata.
export const EVIDENCE_VERSION = 1;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const safeEvidenceText = (value, max = 160) => typeof value === 'string' && value.length > 0 && value.length <= max && !/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|bearer\s+\S{16,})/i.test(value);
const safeText = safeEvidenceText;
const exactKeys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
export const dimensionName = value => ({ interface: 'Interface', services: 'Services', data: 'Data', systems: 'Systems', tooling: 'Tooling', automation: 'Automation' })[value] || value;

function safeValue(value) {
  if (typeof value === 'string') return safeText(value, 160) ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return null;
}

export function createSceneEvidence(nodes, profile, options = {}) {
  const facts = [], subjects = [], factIds = new Map();
  const add = (subjectId, kind, value, provenance, source) => {
    const safe = safeValue(value);
    if (safe === null || !safeText(subjectId, 4096) || !safeText(kind, 80) || (source !== undefined && !safeText(source, 80))) return;
    const key = JSON.stringify([kind, safe, provenance, source]);
    let factId = factIds.get(key);
    if (!factId) {
      if (facts.length >= 32768) return;
      factId = `fact:${facts.length.toString(36)}`;
      factIds.set(key, factId);
      facts.push({ id: factId, kind, value: safe, provenance, ...(source ? { source } : {}) });
    }
    let subject = subjects.find(item => item.id === subjectId);
    if (!subject) { subject = { kind: 'node', id: subjectId, facts: [] }; subjects.push(subject); }
    if (subject.facts.length < 64 && !subject.facts.includes(factId)) subject.facts.push(factId);
  };
  for (const node of nodes) {
    const metadata = node.metadata || {}, id = node.id;
    const source = safeText(metadata.pluginSource, 80) ? metadata.pluginSource : safeText(metadata.source, 80) ? metadata.source : 'github';
    add(id, 'primary-language', metadata.language, 'source', source);
    if (object(metadata.languages)) for (const [language, bytes] of Object.entries(metadata.languages).sort(([a], [b]) => a.localeCompare(b)).slice(0, 8)) {
      if (Number.isFinite(bytes) && bytes >= 0) add(id, `language-bytes:${language}`, bytes, 'source', source);
    }
    for (const topic of (Array.isArray(metadata.topics) ? metadata.topics : []).slice(0, 8)) add(id, 'topic', topic, 'source', source);
    if (Number.isFinite(metadata.stargazers_count)) add(id, 'stars', metadata.stargazers_count, 'source', source);
    if (typeof metadata.created_at === 'string') add(id, 'created-date', metadata.created_at.slice(0, 10), 'source', source);
    const role = options.projectShowcase?.[id]?.role || Object.entries(options.projectShowcase || {}).find(([key]) => key.toLowerCase() === id.toLowerCase())?.[1]?.role;
    if (['featured', 'supporting', 'experimental', 'historical'].includes(role)) add(id, 'showcase-role', role, 'user');
    if ((options.includeRepos || []).some(value => value.toLowerCase() === id.toLowerCase() || value.toLowerCase() === String(metadata.name || '').toLowerCase())) add(id, 'selected-project', true, 'user');
    if (Object.hasOwn(options.starPositions || {}, id)) add(id, 'manual-position', true, 'user');
    if (Object.hasOwn(options.nodeColors || {}, id)) add(id, 'manual-color', true, 'user');
    const emphasis = options.profileEmphasis;
    if (emphasis && emphasis !== 'automatic' && profile?.dimensions?.some(dimension => dimension.id === emphasis && dimension.evidence?.some(fact => fact.repository.toLowerCase() === id.toLowerCase()))) add(id, 'profile-emphasis', emphasis, 'user');
  }
  if (profile?.dimensions) for (const dimension of profile.dimensions) {
    for (const fact of (dimension.evidence || []).slice(0, 256)) {
      if (!nodes.some(node => node.id.toLowerCase() === String(fact.repository).toLowerCase())) continue;
      add(fact.repository, 'profile-evidence', `${dimension.id}: ${fact.reason}`, 'derived', 'constellation');
    }
  }
  return { version: EVIDENCE_VERSION, facts, subjects };
}

export function validateEvidence(value, nodeIds = null) {
  if (!exactKeys(value, ['version', 'facts', 'subjects']) || value.version !== EVIDENCE_VERSION || !Array.isArray(value.facts) || value.facts.length > 32768 || !Array.isArray(value.subjects) || value.subjects.length > 2048) return false;
  const factIds = new Set();
  for (const fact of value.facts) {
    if (!object(fact) || !exactKeys(fact, fact.source === undefined ? ['id', 'kind', 'value', 'provenance'] : ['id', 'kind', 'value', 'provenance', 'source']) || !/^fact:[0-9a-z]+$/.test(fact.id || '') || factIds.has(fact.id) || !safeText(fact.kind, 80) || safeValue(fact.value) === null || !['source', 'user', 'derived'].includes(fact.provenance) || (fact.provenance === 'source' && !safeText(fact.source, 80)) || (fact.provenance === 'derived' && !safeText(fact.source, 80)) || (fact.provenance === 'user' && fact.source !== undefined)) return false;
    factIds.add(fact.id);
  }
  const subjects = new Set(); let links = 0;
  for (const subject of value.subjects) {
    if (!exactKeys(subject, ['kind', 'id', 'facts']) || !['node', 'group'].includes(subject.kind) || !safeText(subject.id, 4096) || subjects.has(`${subject.kind}:${subject.id}`) || !Array.isArray(subject.facts) || subject.facts.length > 64 || subject.facts.some(id => !factIds.has(id)) || (subject.kind === 'node' && nodeIds && !nodeIds.has(subject.id))) return false;
    subjects.add(`${subject.kind}:${subject.id}`); links += subject.facts.length;
    if (links > 32768) return false;
  }
  return true;
}

export function retainEvidenceSubjects(attachment, nodeIds) {
  if (!attachment || !validateEvidence(attachment)) return { version: EVIDENCE_VERSION, facts: [], subjects: [] };
  const subjects = attachment.subjects.filter(item => nodeIds.has(item.id));
  const used = new Set(subjects.flatMap(item => item.facts));
  return { version: EVIDENCE_VERSION, facts: attachment.facts.filter(item => used.has(item.id)), subjects };
}

export function evidenceForNode(scene, nodeId) {
  const attachment = scene?.evidence;
  if (!attachment || !validateEvidence(attachment)) return [];
  const subject = attachment.subjects.find(item => item.id === nodeId && (item.kind === 'node' || item.kind === 'group'));
  if (!subject) return [];
  const facts = new Map(attachment.facts.map(item => [item.id, item]));
  return subject.facts.map(id => facts.get(id)).filter(Boolean).map(fact => ({ id: `evidence:${encodeURIComponent(nodeId).slice(0, 160)}:${fact.id}`, subject: { kind: subject.kind, id: nodeId }, claim: { kind: fact.kind, value: fact.value }, provenance: fact.provenance, ...(fact.source ? { source: fact.source } : {}) }));
}

export function attachGroupEvidence(attachment, groups) {
  const value = attachment && validateEvidence(attachment) ? structuredClone(attachment) : { version: EVIDENCE_VERSION, facts: [], subjects: [] };
  const groupedMembers = new Set(groups.flatMap(group => group.members));
  value.subjects = value.subjects.filter(subject => subject.kind !== 'node' || !groupedMembers.has(subject.id));
  const ids = new Set(value.facts.map(fact => fact.id));
  let sequence = 0;
  for (const group of groups.slice(0, 256)) {
    const facts = group.provenance === 'user'
      ? [{ kind: 'group-provenance', value: 'Defined by you.', provenance: 'user' }]
      : group.basis.slice(0, 16).map(basis => ({ kind: 'group-basis', value: basis, provenance: 'derived', source: 'constellation' }));
    if (group.manualPosition) facts.push({ kind: 'manual-position', value: true, provenance: 'user' });
    const references = [];
    for (const fact of facts) {
      if (value.facts.length >= 32768) break;
      let id;
      do { id = `fact:${(sequence++).toString(36)}`; } while (ids.has(id));
      ids.add(id); value.facts.push({ id, ...fact }); references.push(id);
    }
    value.subjects = value.subjects.filter(item => !(item.kind === 'group' && item.id === group.id));
    value.subjects.push({ kind: 'group', id: group.id, facts: references });
  }
  return value;
}

export function createExplanationHelpers(EVIDENCE_VERSION, dimensionName, layoutSummary) {
const evidenceForNode = (scene, nodeId) => {
  const attachment = scene?.evidence;
  if (!attachment || attachment.version !== EVIDENCE_VERSION || !Array.isArray(attachment.facts) || attachment.facts.length > 32768 || !Array.isArray(attachment.subjects) || attachment.subjects.length > 2048) return [];
  const subject = attachment.subjects.find(item => item.id === nodeId);
  if (!subject) return [];
  const facts = new Map(attachment.facts.map(item => [item.id, item]));
  return subject.facts.map(id => facts.get(id)).filter(Boolean).map(fact => ({ id: `evidence:${encodeURIComponent(nodeId).slice(0, 160)}:${fact.id}`, subject: { kind: 'node', id: nodeId }, claim: { kind: fact.kind, value: fact.value }, provenance: fact.provenance, ...(fact.source ? { source: fact.source } : {}) }));
};
const explainVisual = (scene, nodeId) => {
  const node = scene?.nodes?.find(item => item.id === nodeId) || scene?.timeline?.frames?.flatMap(frame => frame.scene?.nodes || []).find(item => item.id === nodeId) || scene?.temporalStack?.frames?.flatMap(frame => frame.scene?.nodes || []).find(item => item.id === nodeId);
  if (!node) return null;
  const options = scene.presentation?.options || {}, metadata = node.metadata || {}, mappings = options.mappings || {}, role = options.projectShowcase?.[nodeId]?.role || metadata.projectRole;
  const result = {};
  for (const channel of ['size', 'color', 'glow', 'opacity', 'shape']) {
    const mapping = mappings[channel];
    if ((channel === 'size' || channel === 'glow') && role && ['featured', 'experimental', 'historical'].includes(role)) {
      const field = mappings[channel]?.field;
      result[channel] = { provenance: 'user', summary: channel === 'size' ? `${role[0].toUpperCase() + role.slice(1)} role chosen by you adjusts size${field ? ` after mapping from ${field}` : ''}.` : `${role[0].toUpperCase() + role.slice(1)} role chosen by you sets a glow floor${field ? ` alongside mapping from ${field}` : ''}.` };
    } else if (channel === 'color' && Object.hasOwn(options.nodeColors || {}, nodeId)) result[channel] = { provenance: 'user', summary: 'Manual color chosen by you.' };
    else if (mapping) { const path = mapping.field || ''; const key = path.startsWith('attributes.') ? path.slice(11) : path.startsWith('metrics.') ? ({ stars: 'stargazers_count' }[path.slice(8)] || path.slice(8)) : path; let input = metadata[key]; if (path === 'metrics.age' && Number.isFinite(Date.parse(metadata.created_at))) input = Math.max(0, Date.parse(scene.metadata.referenceDate) - Date.parse(metadata.created_at)) / 86400000; const missing = input === undefined; result[channel] = { provenance: 'derived', summary: `Mapped from ${mapping.field || 'configured expression'}.${missing ? ` Input is unavailable in this scene.${mapping.fallback !== undefined ? ` Fallback ${mapping.fallback} is configured.` : ''}` : ''}`, ...(missing ? {} : { input }), ...(mapping.fallback === undefined ? {} : { fallback: mapping.fallback }), scale: mapping.scale || (channel === 'color' ? mapping.palette || 'categories' : 'linear'), rendered: channel === 'size' ? node.geometry.radius : node.style[channel] }; }
    else if (channel === 'color' && (options.nodeColorMode || 'custom') === 'language') result[channel] = { provenance: 'derived', summary: 'Color represents primary language.', input: metadata.language || 'No detected language', palette: 'Language' };
    else if (channel === 'color' && (options.nodeColorMode || 'custom') === 'category') result[channel] = { provenance: 'derived', summary: 'Color uses the first topic, or primary language when no topic is present.', input: metadata.topics?.[0] || metadata.language || 'Other', palette: 'Category' };
    else if (channel === 'color' && (options.nodeColorMode || 'custom') === 'seeded') result[channel] = { provenance: 'derived', summary: 'Color is assigned deterministically from the project identity and scene seed.' };
    else if (channel === 'size') result[channel] = { provenance: 'derived', summary: 'Deterministic default project size.' };
    else if (channel === 'glow' && node.style.glow != null) result[channel] = { provenance: 'derived', summary: `Glow uses ${options.nodeGlowMode || 'uniform'} styling.`, input: options.nodeGlowMode === 'stars' ? metadata.stargazers_count : options.nodeGlowMode === 'activity' ? metadata.updated_at : undefined };
    else if (channel === 'opacity' && node.style.opacity !== undefined && node.style.opacity !== 1) result[channel] = { provenance: 'derived', summary: 'Opacity is set by the scene style.' };
    else if (channel === 'shape' && options.nodeShape && options.nodeShape !== 'circle') result[channel] = { provenance: 'user', summary: options.nodeShape === 'mixed' ? `Shape follows the configured mixed mapping; this node is ${node.style.shape}.` : `Node shape explicitly set to ${node.style.shape} in Studio.` };
    else if (channel === 'shape' && node.style.shape !== 'circle') result[channel] = { provenance: 'derived', summary: `Shape is ${node.style.shape}.` };
  }
  return result;
};
const explainEdge = (scene, edgeId) => {
  const edge = scene?.edges?.find(item => item.id === edgeId);
  if (!edge) return null;
  const metadata = edge.metadata || {};
  if (metadata.aggregated === true && Number.isInteger(metadata.relationshipCount) && Array.isArray(metadata.memberEdges)) {
    const coverage = Array.isArray(metadata.relationshipEvidence) ? metadata.relationshipEvidence.slice(0, 13).map(item => ({ ...item })) : [];
    const universal = coverage.filter(item => item.count === item.total);
    const partial = coverage.filter(item => item.count < item.total);
    const evidence = [...universal.map(item => `${item.kind}: ${item.value}`)];
    const memberEdges = metadata.memberEdges.slice(0, 256);
    return { version: EVIDENCE_VERSION, edgeId, provenance: 'derived', summary: `${metadata.relationshipCount} underlying relationships.`, evidence, universal, partial, examples: Array.isArray(metadata.examples) ? metadata.examples.slice(0, 5).map(item => ({ edgeId: item.edgeId, from: item.from, to: item.to })) : [], memberEdges, relationshipCount: metadata.relationshipCount, retainedEdgeCount: memberEdges.length, truncated: metadata.relationshipCount > memberEdges.length, examplesShown: Math.min(Array.isArray(metadata.examples) ? metadata.examples.length : 0, 5) };
  }
  const shared = [...(Array.isArray(metadata.sharedLanguages) ? metadata.sharedLanguages.slice(0, 16).map(value => `language: ${value}`) : []), ...(Array.isArray(metadata.sharedTopics) ? metadata.sharedTopics.slice(0, 16).map(value => `topic: ${value}`) : []), ...(Array.isArray(metadata.sharedRepositories) ? metadata.sharedRepositories.slice(0, 16).map(value => `repository: ${value}`) : [])];
  return shared.length ? { version: EVIDENCE_VERSION, edgeId, provenance: 'derived', summary: 'Connection reflects shared project metadata.', evidence: shared } : { version: EVIDENCE_VERSION, edgeId, provenance: 'derived', summary: 'Explanation unavailable for this connection type.', evidence: [] };
};
const explainNode = (scene, nodeId) => {
  const node = scene?.nodes?.find(item => item.id === nodeId) || scene?.timeline?.frames?.flatMap(frame => frame.scene?.nodes || []).find(item => item.id === nodeId) || scene?.temporalStack?.frames?.flatMap(frame => frame.scene?.nodes || []).find(item => item.id === nodeId);
  if (!node) return null;
  const items = evidenceForNode(scene, nodeId), role = items.find(item => item.claim.kind === 'showcase-role')?.claim.value;
  const position = items.filter(item => item.claim.kind === 'profile-evidence');
  const emphasis = items.find(item => item.claim.kind === 'profile-emphasis')?.claim.value;
  const stack = scene.temporalStack, createdDate = node.metadata?.created_at;
  const temporalPosition = stack?.axis === 'year' && typeof createdDate === 'string' && Number.isFinite(Date.parse(createdDate))
    ? { provenance: 'source', summary: `Created in ${new Date(createdDate).getUTCFullYear()}. This layer uses repository creation date and current metadata; it does not reconstruct historical language, stars, or activity.` }
    : stack ? { provenance: 'derived', summary: `Position follows current ${stack.axis} membership in this universe layer.` } : null;
  return {
    version: EVIDENCE_VERSION,
    nodeId,
    included: items.some(item => item.claim.kind === 'selected-project') ? { provenance: 'user', summary: 'Selected by you for this constellation.' } : { provenance: 'derived', summary: 'Included by the current scene selection and filters.' },
    role: role ? { provenance: 'user', summary: `${role[0].toUpperCase() + role.slice(1)} by you. This role affects presentation; repository selection controls inclusion.` } : null,
    position: items.some(item => item.claim.kind === 'manual-position') ? { provenance: 'user', summary: 'Placed manually by you.' } : temporalPosition || (position.length ? { provenance: 'derived', summary: `Technical focus → ${[...new Set(position.map(item => dimensionName(item.claim.value.split(': ')[0])))].join(', ')}.${emphasis ? ` Manual ${dimensionName(emphasis)} emphasis changes placement only; it does not change the evidence.` : ''}`, evidence: position.map(item => item.claim.value.split(': ').slice(1).join(': ')) } : { provenance: 'derived', summary: layoutSummary(scene.presentation?.options?.arrangement || 'rings') }),
    evidence: items,
    appearance: explainVisual(scene, nodeId),
  };
};
return { explainNode, explainVisual, explainEdge };
}

const canonical = createExplanationHelpers(EVIDENCE_VERSION, dimensionName, layoutSummary);
export const explainNode = (...args) => canonical.explainNode(...args);
export const explainVisual = (...args) => canonical.explainVisual(...args);
export const explainEdge = (...args) => canonical.explainEdge(...args);

export function layoutSummary(arrangement) {
  if (arrangement === 'profile') return 'Position comes from the Developer Topology layout.';
  if (arrangement === 'temporal-stack') return 'Position follows the current temporal layout.';
  if (arrangement === 'rings' || arrangement === 'identity') return 'Identity Rings. Position comes from deterministic account identity ring geometry. It does not indicate project importance.';
  if (arrangement === 'orbital') return 'Identity Orbits. Position comes from deterministic account identity orbit geometry. It does not indicate project importance or shared technology.';
  return 'Position comes from the selected deterministic layout.';
}
