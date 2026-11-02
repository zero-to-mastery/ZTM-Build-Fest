/**
 * Developer Atlas is navigation state over Semantic Graph v1. It never writes
 * to the graph and deliberately contains no camera or rendering state.
 */
export const ATLAS_STATE_VERSION = 1;
export const ATLAS_LEVELS = Object.freeze(['developer', 'group', 'project', 'structure']);
export const ATLAS_HISTORY_LIMIT = 32;

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const nodeFor = (graph, id, kind) => graph?.nodes?.find(node => node.id === id && (!kind || node.kind === kind)) || null;
const groupFor = (graph, id) => graph?.groups?.find(group => group.id === id) || null;
const membership = (graph, projectId, groupId) => graph?.edges?.some(edge => edge.kind === 'member-of' && edge.from === projectId && edge.to === groupId) === true;
const state = (level, developerId, groupId = null, projectId = null, structuralNodeId = null, viaGroupId = null) => Object.freeze({
  version: ATLAS_STATE_VERSION, level, developerId, groupId, projectId, structuralNodeId, viaGroupId,
});

export function createAtlasState(graph) {
  if (graph?.subject?.kind !== 'developer' || !text(graph.subject.id)) throw new Error('Developer Atlas requires a developer Semantic Graph.');
  return state('developer', graph.subject.id);
}

export function validateAtlasState(value, graph) {
  const errors = [];
  const fail = message => errors.push(message);
  if (!value || value.version !== ATLAS_STATE_VERSION || !ATLAS_LEVELS.includes(value.level)) return { valid: false, errors: ['Invalid Atlas state version or level.'] };
  if (!Array.isArray(graph?.nodes) || graph.nodes.length > 4096 || !Array.isArray(graph.edges) || graph.edges.length > 16384 || graph.groups !== undefined && (!Array.isArray(graph.groups) || graph.groups.length > 256)) return { valid: false, errors: ['Active Semantic Graph is unavailable or exceeds Atlas bounds.'] };
  if (graph?.subject?.kind !== 'developer' || value.developerId !== graph.subject.id) fail('Atlas developer does not match the active Semantic Graph.');
  const none = key => value[key] === null || value[key] === undefined;
  if (value.level === 'developer' && (!none('groupId') || !none('projectId') || !none('structuralNodeId') || !none('viaGroupId'))) fail('Developer state cannot contain child identities.');
  if (value.level === 'group') {
    if (!text(value.groupId) || !groupFor(graph, value.groupId)) fail('Atlas group is unavailable.');
    if (!none('projectId') || !none('structuralNodeId') || !none('viaGroupId')) fail('Group state cannot contain project identities.');
  }
  if (value.level === 'project') {
    if (!nodeFor(graph, value.projectId, 'project')) fail('Atlas project is unavailable.');
    if (!none('structuralNodeId')) fail('Project state cannot contain a structural node.');
    if (!none('groupId') && (!groupFor(graph, value.groupId) || !membership(graph, value.projectId, value.groupId))) fail('Atlas project is not a member of its entered group.');
    if (!none('viaGroupId') && (!groupFor(graph, value.viaGroupId) || !membership(graph, value.projectId, value.viaGroupId) || value.groupId !== value.viaGroupId)) fail('Atlas project route is invalid.');
  }
  if (value.level === 'structure') {
    if (!nodeFor(graph, value.projectId, 'project') || !text(value.structuralNodeId)) fail('Atlas structure requires an available project and node.');
    if (!none('groupId') && (!groupFor(graph, value.groupId) || !membership(graph, value.projectId, value.groupId))) fail('Atlas structural route is invalid.');
  }
  return { valid: errors.length === 0, errors };
}

function assertValid(next, graph) {
  const result = validateAtlasState(next, graph);
  if (!result.valid) throw new Error(result.errors.join(' '));
  return next;
}

export function navigateAtlasToGroup(current, graph, groupId) {
  assertValid(current, graph);
  if (current.level !== 'developer' || !groupFor(graph, groupId)) throw new Error('Group is unavailable from the current Atlas context.');
  return assertValid(state('group', current.developerId, groupId), graph);
}

export function navigateAtlasToProject(current, graph, projectId) {
  assertValid(current, graph);
  if (!nodeFor(graph, projectId, 'project')) throw new Error('Project is unavailable in the active Semantic Graph.');
  if (!['developer', 'group'].includes(current.level)) throw new Error('Projects can only be entered from Developer or Group context.');
  const via = current.level === 'group' ? current.groupId : null;
  if (via && !membership(graph, projectId, via)) throw new Error('Project is not a member of the current group.');
  return assertValid(state('project', current.developerId, via, projectId, null, via), graph);
}

/** Structural IDs are validated against the separate, already-loaded project graph. */
export function navigateAtlasToStructure(current, graph, projectGraph, structuralNodeId) {
  assertValid(current, graph);
  if (!['project', 'structure'].includes(current.level) || projectGraph?.subject?.kind !== 'project' || projectGraph.subject.id !== current.projectId) throw new Error('Project structure is unavailable in the current context.');
  const node = nodeFor(projectGraph, structuralNodeId);
  if (!node || !['project-root', 'package', 'directory', 'module', 'entry-point'].includes(node.kind)) throw new Error('Structural node is unavailable.');
  return state('structure', current.developerId, current.groupId, current.projectId, structuralNodeId, current.viaGroupId);
}

export function parentAtlasState(current, graph, projectGraph = null) {
  assertValid(current, graph);
  if (current.level === 'developer') return current;
  if (current.level === 'structure') {
    if (projectGraph?.subject?.kind !== 'project' || projectGraph.subject.id !== current.projectId || !nodeFor(projectGraph, current.structuralNodeId)) return state('project', current.developerId, current.groupId, current.projectId, null, current.viaGroupId);
    const parentId = nodeFor(projectGraph, current.structuralNodeId).properties?.parent;
    if (parentId && nodeFor(projectGraph, parentId)) return state('structure', current.developerId, current.groupId, current.projectId, parentId, current.viaGroupId);
    return state('project', current.developerId, current.groupId, current.projectId, null, current.viaGroupId);
  }
  if (current.level === 'project') return current.viaGroupId ? state('group', current.developerId, current.viaGroupId) : createAtlasState(graph);
  return createAtlasState(graph);
}

export function atlasBreadcrumbs(current, graph, projectGraph = null) {
  assertValid(current, graph);
  const developer = nodeFor(graph, `developer:${current.developerId}`, 'developer') || { label: current.developerId };
  const crumbs = [{ level: 'developer', id: current.developerId, label: developer.label }];
  if (current.level === 'group' || current.groupId) {
    const group = groupFor(graph, current.level === 'group' ? current.groupId : current.groupId);
    if (group) crumbs.push({ level: 'group', id: group.id, label: group.label });
  }
  if (current.projectId) {
    const project = nodeFor(graph, current.projectId, 'project');
    if (project) crumbs.push({ level: 'project', id: project.id, label: project.label });
  }
  if (current.level === 'structure' && projectGraph?.subject?.id === current.projectId) {
    const chain = [];
    let node = nodeFor(projectGraph, current.structuralNodeId);
    const seen = new Set();
    while (node && !seen.has(node.id) && chain.length < 16) {
      seen.add(node.id); chain.push(node);
      node = node.properties?.parent ? nodeFor(projectGraph, node.properties.parent) : null;
    }
    for (const item of chain.reverse()) if (item.kind !== 'project-root') crumbs.push({ level: 'structure', id: item.id, label: item.properties?.path || item.label });
  }
  return crumbs.map(crumb => Object.freeze(crumb));
}

/** Resolve the active Atlas entity and its existing Evidence v1 references. */
export function resolveAtlasContext(current, graph, projectGraph = null) {
  assertValid(current, graph);
  const facts = new Map((graph.evidence?.facts || []).map(fact => [fact.id, fact]));
  if (current.level === 'developer') {
    const subject = nodeFor(graph, `developer:${current.developerId}`, 'developer');
    return Object.freeze({ level: 'developer', subject, evidence: (subject?.evidenceIds || []).map(id => facts.get(id)).filter(Boolean), groups: [...(graph.groups || [])], projects: graph.nodes.filter(node => node.kind === 'project') });
  }
  if (current.level === 'group') {
    const group = groupFor(graph, current.groupId);
    const node = nodeFor(graph, group.id, 'semantic-group');
    const members = group.members.map(id => nodeFor(graph, id, 'project')).filter(Boolean);
    const memberIds = new Set(group.members);
    const relationships = graph.edges.filter(edge => edge.kind === 'project-relationship' && memberIds.has(edge.from) && memberIds.has(edge.to));
    return Object.freeze({ level: 'group', subject: node, provenance: group.provenance, basis: [...group.basis], members, relationships, evidence: (node?.evidenceIds || []).map(id => facts.get(id)).filter(Boolean) });
  }
  if (current.level === 'project') {
    const project = nodeFor(graph, current.projectId, 'project');
    const groups = (graph.groups || []).filter(group => group.members.includes(project.id));
    const relationships = graph.edges.filter(edge => edge.kind === 'project-relationship' && (edge.from === project.id || edge.to === project.id));
    return Object.freeze({ level: 'project', subject: project, groups, relationships, owner: graph.edges.find(edge => edge.kind === 'repository-owner' && edge.from === project.id) || null, evidence: (project.evidenceIds || []).map(id => facts.get(id)).filter(Boolean), structureAvailable: projectGraph?.subject?.kind === 'project' && projectGraph.subject.id === project.id });
  }
  if (projectGraph?.subject?.id !== current.projectId) return Object.freeze({ level: 'structure', subject: null, evidence: [], structureAvailable: false });
  const subject = nodeFor(projectGraph, current.structuralNodeId);
  const projectFacts = new Map((projectGraph.evidence?.facts || []).map(fact => [fact.id, fact]));
  const edgeEvidence = projectGraph.edges.filter(edge => edge.from === subject?.id || edge.to === subject?.id);
  const children = projectGraph.edges.filter(edge => edge.kind === 'contains' && edge.from === subject?.id).map(edge => nodeFor(projectGraph, edge.to)).filter(Boolean);
  return Object.freeze({ level: 'structure', subject, relationships: edgeEvidence, children, evidence: (subject?.evidenceIds || []).map(id => projectFacts.get(id)).filter(Boolean), structureAvailable: true });
}

export function createAtlasHistory(initial, limit = ATLAS_HISTORY_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > ATLAS_HISTORY_LIMIT) throw new Error(`Atlas history limit must be between 1 and ${ATLAS_HISTORY_LIMIT}.`);
  let entries = [initial];
  let index = 0;
  return Object.freeze({
    get current() { return entries[index]; },
    get canBack() { return index > 0; },
    get canForward() { return index < entries.length - 1; },
    get length() { return entries.length; },
    push(next) { entries = [...entries.slice(0, index + 1), next].slice(-limit); index = entries.length - 1; return next; },
    reconcile(current, graph, projectGraph = null) {
      const usable = candidate => validateAtlasState(candidate, graph).valid
        && (candidate.level !== 'structure' || projectGraph?.subject?.kind === 'project'
          && projectGraph.subject.id === candidate.projectId
          && nodeFor(projectGraph, candidate.structuralNodeId));
      if (!usable(current)) {
        const recovered = parseAtlasState(serializeAtlasState(current), graph, projectGraph);
        entries = [recovered]; index = 0;
        return recovered;
      }
      const oldIndex = index;
      const retained = [];
      let retainedIndex = -1;
      for (let i = 0; i < entries.length; i++) {
        if (!usable(entries[i])) continue;
        if (i === oldIndex && JSON.stringify(entries[i]) === JSON.stringify(current)) retainedIndex = retained.length;
        retained.push(entries[i]);
      }
      if (retainedIndex < 0) {
        retained.push(current);
        retainedIndex = retained.length - 1;
      }
      entries = retained.slice(-limit);
      index = Math.max(0, retainedIndex - Math.max(0, retained.length - limit));
      entries[index] = current;
      return current;
    },
    transact(direction, render) {
      const target = direction === 'back' ? index - 1 : direction === 'forward' ? index + 1 : index;
      if (target < 0 || target >= entries.length || typeof render !== 'function') return false;
      try { if (render(entries[target]) === false) return false; }
      catch { return false; }
      index = target;
      return entries[index];
    },
    snapshot() { return Object.freeze({ entries: [...entries], index }); },
  });
}

export function serializeAtlasState(value) {
  if (!value || value.version !== ATLAS_STATE_VERSION || !ATLAS_LEVELS.includes(value.level) || !text(value.developerId)) throw new Error('Cannot serialize invalid Atlas state.');
  const present = key => value[key] !== null && value[key] !== undefined;
  if (value.level === 'developer' && ['groupId', 'projectId', 'structuralNodeId', 'viaGroupId'].some(present)
    || value.level === 'group' && (!text(value.groupId) || present('projectId') || present('structuralNodeId') || present('viaGroupId'))
    || value.level === 'project' && (!text(value.projectId) || present('structuralNodeId'))
    || value.level === 'structure' && (!text(value.projectId) || !text(value.structuralNodeId))) throw new Error('Cannot serialize an inconsistent Atlas state.');
  const params = new URLSearchParams({ v: String(ATLAS_STATE_VERSION), d: value.developerId, l: value.level });
  if (value.groupId) params.set('g', value.groupId);
  if (value.projectId) params.set('p', value.projectId);
  if (value.structuralNodeId) params.set('n', value.structuralNodeId);
  if (value.viaGroupId) params.set('r', value.viaGroupId);
  const result = params.toString();
  if (result.length > 8192) throw new Error('Atlas share state exceeds its size bound.');
  return result;
}

function nearestValidAtlasParent(candidate, graph, projectGraph) {
  const project = nodeFor(graph, candidate.projectId, 'project');
  if (project) {
    const enteredGroupId = [candidate.viaGroupId, candidate.groupId].find(id =>
      groupFor(graph, id) && membership(graph, candidate.projectId, id));
    const projectState = state('project', graph.subject.id, enteredGroupId || null, candidate.projectId, null, enteredGroupId || null);
    if (candidate.level !== 'structure' || projectGraph?.subject?.id === candidate.projectId
      && nodeFor(projectGraph, candidate.structuralNodeId)) return candidate;
    return projectState;
  }

  // Preserve the entered route even when its project has disappeared. For a
  // direct Project route both fields are null, so recovery goes to Developer.
  const enteredGroupId = ['structure', 'project', 'group'].includes(candidate.level)
    ? [candidate.viaGroupId, candidate.groupId].find(id => groupFor(graph, id))
    : null;
  if (enteredGroupId) return state('group', graph.subject.id, enteredGroupId);
  return createAtlasState(graph);
}

export function parseAtlasState(serialized, graph, projectGraph = null) {
  if (typeof serialized !== 'string' || serialized.length > 8192) throw new Error('Atlas share state is invalid or oversized.');
  const params = new URLSearchParams(serialized);
  const keys = new Set();
  for (const [key] of params) {
    if (!['v', 'd', 'l', 'g', 'p', 'n', 'r'].includes(key) || keys.has(key)) throw new Error('Atlas share state contains unknown or repeated fields.');
    keys.add(key);
  }
  if (params.size > 7 || params.get('v') !== String(ATLAS_STATE_VERSION)) throw new Error('Unsupported Atlas share state.');
  const level = params.get('l'), developerId = params.get('d');
  let candidate = state(level, developerId, params.get('g'), params.get('p'), params.get('n'), params.get('r'));
  if (candidate.developerId !== graph?.subject?.id || graph?.subject?.kind !== 'developer') return createAtlasState(graph);
  if (validateAtlasState(candidate, graph).valid) {
    if (candidate.level !== 'structure' || projectGraph?.subject?.id === candidate.projectId
      && nodeFor(projectGraph, candidate.structuralNodeId)) return candidate;
  }
  return nearestValidAtlasParent(candidate, graph, projectGraph);
}
