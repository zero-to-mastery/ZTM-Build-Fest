import { createScene } from '../constellation.mjs';
import { createHierarchy } from '../hierarchy.mjs';
import { normalizeRecords, toGraphRecords } from '../data-pipeline.mjs';

// Consumes already-loaded metadata; it makes no additional API requests.
export function createOrganizationHierarchy(account, repositories, options = {}, { maxProjects = 24, ...runtime } = {}) {
  if (!Number.isInteger(maxProjects) || maxProjects < 1 || maxProjects > 63) throw new Error('Hierarchy maxProjects must be between 1 and 63.');
  const records = toGraphRecords(normalizeRecords(repositories, { deferIdentityCheck: true, signal: runtime.signal }).records).filter(record => record.private !== true);
  const ids = new Set(records.map(record => record.full_name));
  const loaded = options.organizationData;
  const safeData = loaded && { ...loaded,
    records: loaded.records && Object.fromEntries(Object.entries(loaded.records).filter(([id]) => ids.has(id)).map(([id, rows]) => [id, rows.map(({ login, contributions, pullRequestCount, avatar_url }) => ({ login, contributions, pullRequestCount, avatar_url }))])),
    contributors: loaded.contributors?.map(person => ({ ...person, repositories: person.repositories.filter(id => ids.has(id)) })).filter(person => person.repositories.length),
  };
  const settings = { ...options, organizationData: safeData, accountType: 'organization', organizationView: 'projects', nodeMode: 'repositories', timeline: undefined };
  const root = createScene(account, records, settings, runtime);
  const byId = new Map(records.map(record => [record.full_name, record]));
  const selected = root.nodes.filter(node => node.metadata.nodeKind === 'repository' && byId.has(node.id)).slice(0, maxProjects);
  const scenes = [{ id: 'organization', title: account, scene: root, links: [] }];
  for (const node of selected) {
    runtime.signal?.throwIfAborted();
    const repo = byId.get(node.id), id = `repository:${node.id}`;
    const source = safeData;
    const organizationData = source ? { ...source, records: source.records ? { [node.id]: source.records[node.id] || [] } : undefined,
      contributors: source.contributors?.filter(person => person.repositories.includes(node.id)).map(person => ({ ...person, repositories: [node.id] })),
    } : undefined;
    const scene = createScene(account, [repo], { ...settings, organizationData, organizationView: 'collaboration', nodeMode: 'ecosystem', includeRepos: [repo.full_name], maxRepos: 100, showOther: true }, runtime);
    scene.presentation.graph.note += ' This child view uses already-loaded repository, technology and contributor metadata; it does not infer internal architecture or complete contributor history.';
    scenes.push({ id, title: repo.name, scene });
    scenes[0].links.push({ nodeId: node.id, target: id });
  }
  root.presentation.graph.note += ` ${selected.length} repository detail scenes compiled from the loaded scope; other projects remain available in the overview.`;
  return createHierarchy({ root: 'organization', scenes }, runtime);
}
