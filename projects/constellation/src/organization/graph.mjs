import { artifactPositions } from '../artifact-layouts.mjs';
import { organizationOptions, organizationNodeMode } from './settings.mjs';
import { groupRepository, normalizeContributors } from './model.mjs';
export function organizationGraph(all, selected, options) {
  const settings = organizationOptions(options), mode = organizationNodeMode(options);
  const pool = all.filter(repo => repo.private !== true);
  const ids = new Set(selected.map(repo => repo.full_name));
  const people = options.organizationData?.records ? normalizeContributors(options.organizationData.records, selected) : (options.organizationData?.contributors || []).map(person => ({ ...person, repositories: person.repositories.filter(id => ids.has(id)) })).filter(person => person.repositories.length);
  let emptyMessage;
  if (mode === 'contributors' && selected.length && !people.length) {
    const snapshot = options.organizationData;
    emptyMessage = !settings.contributors.enabled || settings.contributors.strategy === 'off' ? 'Contributor discovery is off. Enable it and load contributor data.'
      : !snapshot ? 'Contributor data has not been loaded. Load contributor data to show this view.'
        : snapshot.diagnostic ? 'Contributor data is unavailable or incomplete. Retry loading contributor data.'
          : selected.some(repo => !Object.hasOwn(snapshot.records || {}, repo.full_name)) ? 'Contributors have not been loaded for all selected repositories. Load contributor data or expand the scan.'
            : 'No attributed contributors were found in the loaded results.';
  }
  const focus = options.organizationUser?.toLowerCase();
  const focalPerson = people.find(person => person.login.toLowerCase() === focus);
  const focalProjects = new Set(focalPerson?.repositories || []);
  if (focus) people.sort((a, b) => Number(b.login.toLowerCase() === focus) - Number(a.login.toLowerCase() === focus) || b.repositories.filter(id => focalProjects.has(id)).length - a.repositories.filter(id => focalProjects.has(id)).length || b.repositoryCount - a.repositoryCount || a.login.localeCompare(b.login));
  const categories = new Map();
  const add = (kind, label, repo) => {
    const id = `${kind}:${label}`;
    if (!categories.has(id)) categories.set(id, { full_name: id, name: label, nodeKind: kind, members: [], language: kind === 'language' ? label : 'Other' });
    categories.get(id).members.push(repo.full_name);
  };
  const projects = !['contributors', 'technology', 'dependencies', 'eras', 'languages', 'topics'].includes(mode);
  if (['ecosystem', 'technology', 'dependencies', 'languages', 'topics', 'combined'].includes(mode)) for (const repo of selected) {
    if (mode !== 'dependencies' && mode !== 'topics') for (const language of repo.languages ? Object.keys(repo.languages).filter(key => repo.languages[key] > 0) : repo.language ? [repo.language] : []) add('language', language, repo);
    if (['ecosystem', 'topics', 'combined'].includes(mode)) for (const topic of repo.topics || []) add('topic', topic, repo);
    if (['ecosystem', 'technology', 'dependencies'].includes(mode)) for (const dependency of repo.dependencies || []) if (typeof dependency === 'string') add('dependency', dependency, repo);
  }
  if (mode === 'eras') for (const repo of pool) add('era', groupRepository(repo, settings.grouping).key, repo);
  else if (projects) for (const repo of pool) if (!ids.has(repo.full_name)) add('era', groupRepository(repo, settings.grouping).key, repo);
  const community = ['contributors', 'organization-community', 'ecosystem'].includes(mode);
  const repositoryNodes = projects ? selected.slice(0, 100).map(repo => ({ ...repo, nodeKind: 'repository', organizationGroup: groupRepository(repo, settings.grouping).key })) : [];
  const contributorNodes = community ? people.slice(0, 120).map(person => ({ ...person, full_name: `contributor:${person.login.toLowerCase()}`, name: person.login, nodeKind: 'contributor', members: person.repositories, stargazers_count: person.repositories.length, language: 'Contributors' })) : [];
  for (const node of categories.values()) node.members.sort();
  const ranked = [...categories.values()].sort((a, b) => b.members.length - a.members.length || a.full_name.localeCompare(b.full_name));
  const categoryNodes = ranked.slice(0, Math.min(60, 256 - repositoryNodes.length - contributorNodes.length)).map(node => ({ ...node, stargazers_count: node.members.length }));
  const nodes = [...repositoryNodes, ...contributorNodes, ...categoryNodes].map(node => ({ ...node, organizationFocal: Boolean(focus && node.login?.toLowerCase() === focus), organizationFocus: Boolean(focus && (node.login?.toLowerCase() === focus || focalProjects.has(node.full_name) || node.members?.some(id => focalProjects.has(id)))) })), edges = [];
  const rendered = new Set(nodes.map(node => node.full_name));
  // Bipartite membership only. Never enumerate contributor pairs.
  const linked = [...contributorNodes, ...categoryNodes].map(node => ({ ...node, links: node.members.filter(member => rendered.has(member)) }));
  for (let round = 0; round < 100 && edges.length < 2048; round++) for (const node of linked) {
    const member = node.links[round];
    if (member && edges.length < 2048) edges.push({ from: node.full_name, to: member, members: [member], strength: 1 });
  }
  if (mode === 'repositories') {
    const regions = new Map(), pairs = new Map();
    for (const repo of repositoryNodes) {
      const tags = [...(options.connectionBasis === 'topics' ? [] : repo.languages ? Object.keys(repo.languages) : repo.language ? [repo.language] : []), ...(options.connectionBasis === 'languages' || !options.connectionBasis ? [] : (repo.topics || []).map(topic => `#${topic}`))];
      for (const tag of tags) { if (!regions.has(tag)) regions.set(tag, []); regions.get(tag).push(repo.full_name); }
    }
    for (const [tag, names] of regions) {
      names.sort();
      for (let i = 1; i < names.length; i++) {
        const key = `${names[i - 1]}\n${names[i]}`;
        if (!pairs.has(key)) pairs.set(key, { from: names[i - 1], to: names[i], members: [], strength: 1 });
        pairs.get(key).members.push(tag);
      }
    }
    edges.push(...[...pairs.values()].slice(0, 2048 - edges.length));
  }
  if (!projects) {
    const memberships = new Map(), pairs = new Map();
    for (const node of nodes) for (const member of node.members || []) { if (!memberships.has(member)) memberships.set(member, []); memberships.get(member).push(node.full_name); }
    // A bounded chain within each project, not every possible contributor pair.
    for (const [member, names] of memberships) {
      names.sort();
      for (let i = 1; i < names.length && pairs.size < 2048; i++) {
        const key = `${names[i - 1]}\n${names[i]}`;
        if (!pairs.has(key)) pairs.set(key, { from: names[i - 1], to: names[i], members: [], strength: 0 });
        const edge = pairs.get(key); edge.members.push(member); edge.strength = Math.min(4, edge.members.length);
      }
    }
    edges.push(...pairs.values());
  }
  const aggregateCount = categoryNodes.filter(node => node.nodeKind === 'era').reduce((sum, node) => sum + node.members.length, 0);
  const omitted = Math.max(0, pool.length - repositoryNodes.length - aggregateCount);
  const coverage = options.organizationData;
  const note = `${coverage?.discovered ?? pool.length} repositories discovered${coverage?.metadataComplete === false ? ' (partial metadata)' : ''}; ${pool.length} matching filters; ${repositoryNodes.length} represented directly; ${aggregateCount} through era systems; ${omitted} omitted. Contributor visualization represents the selected organization scope${coverage ? `: ${coverage.scanned || 0}/${coverage.selected || 0} repositories scanned, up to ${coverage.perRepositoryLimit || 25} contributors per repository` : ''}.${focus ? focalPerson ? ` @${options.organizationUser} contributed to ${focalProjects.size} represented projects; highlighted contributors share these projects.` : ` @${options.organizationUser} was not found in this scan. This does not establish absence of contributions; expand the scan or project scope.` : ''}`;
  // Keep aggregate tooltips/inspector payloads bounded even for 100k repositories.
  for (const node of nodes) if (node.members?.length > 100) { node.representedCount = node.members.length; node.members = node.members.slice(0, 100); }
  return { nodes, edges, emptyMessage, focus: nodes.find(node => node.organizationFocal)?.full_name, focusProjects: [...focalProjects].sort(), total: repositoryNodes.length + (community ? people.length : 0) + ranked.length, repositoryCount: selected.length, note: note + ' Contributor totals are current; historical views filter project creation dates, not contributor tenure.', organization: true };
}
export function organizationPositions(graph, arrangement, compact, seed = '', metric = 'stars') {
  const ordered = [...graph.nodes].sort((a, b) => a.full_name.localeCompare(b.full_name));
  const centerY = compact ? 126 : 270, scaleY = compact ? 85 : 190;
  const positions = artifactPositions(ordered, 'galaxy', seed, compact, metric, node => node.nodeKind === 'repository' ? node.organizationGroup || node.language || 'Other' : node.nodeKind);
  if (arrangement === 'era-rings') {
    const eras = [...new Set(ordered.map(node => node.organizationGroup || node.name))].sort();
    eras.forEach((era, j) => {
      const members = ordered.filter(node => (node.organizationGroup || node.name) === era);
      members.forEach((node, i) => { const angle = i * Math.PI * 2 / members.length + j; const radius = (j + 1) / (eras.length + 1); positions[node.full_name] = { x: 450 + Math.cos(angle) * 365 * radius, y: centerY + Math.sin(angle) * scaleY * radius }; });
    });
    return positions;
  }
  if (arrangement === 'collaboration-gravity') {
    // Settle a bounded sparse graph once. A spatial grid provides local repulsion.
    for (let iteration = 0; iteration < 80; iteration++) {
      for (const edge of graph.edges) {
        const a = positions[edge.from], b = positions[edge.to]; if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy) || 1;
        const force = Math.max(-2, Math.min(2, (distance - 42) * .025));
        a.x += dx / distance * force; a.y += dy / distance * force; b.x -= dx / distance * force; b.y -= dy / distance * force;
      }
      const grid = new Map();
      for (const node of ordered) {
        const point = positions[node.full_name], gx = Math.floor(point.x / 20), gy = Math.floor(point.y / 20);
        for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (const other of grid.get(`${x}:${y}`) || []) {
          const dx = point.x - other.x || .1, dy = point.y - other.y || .1, distance = Math.hypot(dx, dy);
          if (distance < 18) { point.x += dx / distance; point.y += dy / distance; other.x -= dx / distance; other.y -= dy / distance; }
        }
        const key = `${gx}:${gy}`; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(point);
        point.x = Math.max(38, Math.min(862, point.x)); point.y = Math.max(35, Math.min(compact ? 215 : 495, point.y));
      }
    }
  }
  if (graph.focus) {
    positions[graph.focus] = { x: 450, y: centerY };
    const projects = ordered.filter(node => graph.focusProjects.includes(node.full_name));
    const neighbors = ordered.filter(node => node.full_name !== graph.focus && node.organizationFocus && !graph.focusProjects.includes(node.full_name));
    const background = ordered.filter(node => !node.organizationFocus);
    for (const [nodes, radius] of [[projects, .48], [neighbors, .82], [background, 1]]) nodes.forEach((node, i) => {
      const angle = -Math.PI / 2 + i * Math.PI * 2 / Math.max(1, nodes.length);
      positions[node.full_name] = { x: 450 + Math.cos(angle) * 350 * radius, y: centerY + Math.sin(angle) * scaleY * radius };
    });
  }
  return positions;
}
