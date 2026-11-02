import { sanitizeActivityEvents } from './activity.mjs';
import { mappedColor } from './visual-mapping.mjs';
import { analyzeRecruiterEvidence, RECRUITER_EVIDENCE_VERSION } from './engine.mjs';

const role = (repo, options) => options.projectShowcase?.[repo.full_name] || options.projectShowcase?.[repo.name] || {};
const key = value => String(value || '').toLowerCase();
const lookup = (values, id) => Object.entries(values || {}).find(([name]) => key(name) === key(id))?.[1];
export const recruiterBands = ['NOW', 'RECENT', 'EARLIER'];
export const recruiterRadii = [225, 275, 325];
export const recruiterProjectLimit = 7;
export function validateProjectRelationships(value = []) {
  if (!Array.isArray(value) || value.length > 6 || value.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(id => typeof id !== 'string' || !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(id)) || key(pair[0]) === key(pair[1])))
    throw Error('projectRelationships must contain up to six pairs of distinct owner/repository IDs.');
}

const date = value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function recruiterInput(repositories, options, account, reference) {
  const sanitizedEvents = sanitizeActivityEvents(options.historyData?.events);
  return { version: RECRUITER_EVIDENCE_VERSION, reference, account, repositories: repositories.map((repo, index) => {
  const snapshot = key(options.commitHistoryData?.repository) === key(repo.full_name)
    ? options.commitHistoryData : lookup(options.commitFieldData, repo.full_name);
  const rows = lookup(options.organizationData?.records, repo.full_name);
  const showcase = role(repo, options);
  return {
    id: String(index), fullName: repo.full_name, pushedAt: date(repo.pushed_at),
    role: showcase.role || '', priority: showcase.priority ?? 9999,
    ...(snapshot ? { snapshot: { partial: snapshot.partial, diagnostic: Boolean(snapshot.diagnostic) } } : {}),
    commits: (snapshot?.commits || []).flatMap(commit => date(commit.date) === null ? [] : [{ date: date(commit.date), login: key(commit.login) }]),
    events: sanitizedEvents.flatMap(event => key(event.repository) === key(repo.full_name) && ['push', 'pull-request', 'release'].includes(event.kind)
      ? [{ date: date(event.createdAt), kind: event.kind }] : []),
    ...(Array.isArray(rows) ? { organization: { complete: options.organizationData?.complete === true, logins: rows.map(row => key(row.login)).filter(Boolean) } } : {}),
  };
  }) };
}

export function analyzeRecruiterProjects(repositories, options = {}, account = '', reference = 0) {
  const result = analyzeRecruiterEvidence(recruiterInput(repositories, options, account, reference));
  const projects = result.projects.map(({ id, ...evidence }, index) => ({ ...evidence,
    radius: ({ featured: 29, supporting: 18, experimental: 11, historical: 11 })[evidence.role] ?? 14,
    repository: repositories[index],
  }));
  const byId = new Map(projects.map((project, index) => [result.projects[index].id, project]));
  return { projects, ordered: result.order.map(id => byId.get(id)) };
}

export function projectEvidence(repo, options, account, reference) {
  const { repository, ...evidence } = analyzeRecruiterProjects([repo], options, account, reference).projects[0];
  return evidence;
}

export function orderRecruiterProjects(repositories, options = {}) {
  const result = analyzeRecruiterEvidence({ version: RECRUITER_EVIDENCE_VERSION, orderingOnly: true, repositories: repositories.map((repo, index) => {
    const showcase = role(repo, options);
    return { id: String(index), fullName: repo.full_name, pushedAt: date(repo.pushed_at), role: showcase.role || '', priority: showcase.priority ?? 9999 };
  }) });
  return result.order.map(id => repositories[Number(id)]);
}

// Finalize the existing scene so exported SVG and Studio hit targets agree.
export function prepareRecruiterScene(scene, loadedCount) {
  if (scene.presentation.options.readmePresentation !== 'recruiter') return scene;
  const options = scene.presentation.options;
  validateProjectRelationships(options.projectRelationships);
  const visible = scene.nodes.filter(node => !node.interaction.hidden);
  const reference = Date.parse(scene.metadata.referenceDate);
  const analyzed = analyzeRecruiterProjects(visible.map(node => node.metadata), options, scene.metadata.account, reference);
  const nodes = new Map(visible.map(node => [node.metadata, node]));
  scene.nodes = analyzed.ordered.slice(0, recruiterProjectLimit).map(item => nodes.get(item.repository));
  const evidence = new Map(analyzed.projects.map(item => [item.repository, item]));
  scene.nodes.forEach(node => {
    const { repository, ...project } = evidence.get(node.metadata);
    node.recruiter = project;
    node.style.color = mappedColor({ ...node.metadata, language: node.metadata.language || 'Unknown' }, 'language');
  });
  // Fixed label columns keep names still and readable even when one band is full.
  for (const side of [0, 1]) {
    const group = scene.nodes.filter((_, index) => index % 2 === side);
    group.forEach((node, index) => {
      const angle = (-75 + (index + .5) * 150 / Math.max(1, group.length)) * Math.PI / 180;
      const radius = recruiterRadii[node.recruiter.band];
      node.geometry = { x: 600 + (side ? -1 : 1) * Math.cos(angle) * radius, y: 380 + Math.sin(angle) * radius, radius: node.recruiter.radius };
    });
    group.sort((a, b) => a.geometry.y - b.geometry.y).forEach((node, index) => {
      node.recruiter.label = { x: side ? 32 : 955, y: node.geometry.y + (node.recruiter.featured ? -20 : 6), side };
    });
  }
  const ids = new Map(scene.nodes.map(node => [key(node.id), node]));
  const seen = new Set();
  scene.edges = (options.projectRelationships || []).flatMap(pair => {
    const [from, to] = pair.map(id => ids.get(key(id)));
    const id = pair.map(key).sort().join(':');
    if (!from || !to || seen.has(id)) return [];
    seen.add(id);
    return [{ id, from: from.id, to: to.id, metadata: { shared: ['Curated project relationship'] }, geometry: { distance: Math.hypot(from.geometry.x - to.geometry.x, from.geometry.y - to.geometry.y) }, style: { primary: false } }];
  });
  scene.labels = scene.nodes.map(node => ({ id: node.id, ...node.recruiter.label, text: node.metadata.name, hidden: node.interaction.labelHidden, focal: node.recruiter.featured }));
  scene.viewport = { width: 1200, height: 840, viewBox: [0, 0, 1200, 840] };
  scene.presentation.totalConnections = scene.edges.length;
  scene.presentation.recruiterOmitted = Math.max(0, loadedCount - scene.nodes.length);
  delete scene.semantic;
  delete scene.developerProfile;
  scene.annotations = [];
  return scene;
}
