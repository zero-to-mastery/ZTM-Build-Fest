import { validateSemanticGraph } from './semantic-graph.mjs';

export const SEMANTIC_MARKDOWN_VERSION = 1;
export const SEMANTIC_MARKDOWN_LIMITS = Object.freeze({
  bytes: 512 * 1024,
  lines: 12000,
  projects: 64,
  groups: 128,
  groupMembers: 32,
  relationships: 512,
  structureNodes: 256,
  evidenceItems: 64,
  descriptionCharacters: 300,
  languages: 64,
  topics: 128,
  projectLanguages: 8,
  projectTopics: 16,
  sourceLimitations: 8,
});

const encoder = new TextEncoder();
const cmp = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const normalizeInline = value => String(value).replace(/[ \t]*(?:(?:\r\n|\r|\n)[ \t]*)+/g, ' ');
const esc = value => normalizeInline(value).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
function code(value) {
  const text = normalizeInline(value);
  const ticks = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length)) + 1;
  const fence = '`'.repeat(ticks);
  return `${fence}${/[`\s]$|^[`\s]/.test(text) ? ` ${text} ` : text}${fence}`;
}
const bounded = (value, max = 300) => {
  const text = normalizeInline(value);
  return [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;
};
const nodeMap = graph => new Map(graph.nodes.map(node => [node.id, node]));
const edgeSort = (a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind) || cmp(a.id, b.id);

function createWriter() {
  const lines = [];
  let bytes = 0;
  let omitted = false;
  return {
    add(line = '') {
      if (omitted) return false;
      if (lines.length >= SEMANTIC_MARKDOWN_LIMITS.lines - 1 || bytes + encoder.encode(`${line}\n`).length > SEMANTIC_MARKDOWN_LIMITS.bytes - 256) {
        omitted = true;
        return false;
      }
      lines.push(line);
      bytes += encoder.encode(`${line}\n`).length;
      return true;
    },
    finish() {
      if (omitted) {
        const note = '> Additional content was omitted from this Markdown projection because its output limit was reached.';
        if (lines.length < SEMANTIC_MARKDOWN_LIMITS.lines && bytes + encoder.encode(`${note}\n`).length <= SEMANTIC_MARKDOWN_LIMITS.bytes) lines.push(note);
      }
      const output = `${lines.join('\n').replace(/\n+$/, '')}\n`;
      if (encoder.encode(output).length > SEMANTIC_MARKDOWN_LIMITS.bytes) throw new Error('Semantic Markdown exceeded its byte limit.');
      return output;
    },
  };
}

function addLimit(writer, label, shown, total) {
  if (shown < total) writer.add(`Showing ${shown} of ${total} ${label}; ${total - shown} additional ${label} omitted from this Markdown projection.`);
}

function addSourceCoverage(graph, writer) {
  const sourceTruncated = graph.statistics.truncated || (graph.subject.kind === 'project' && graph.project.statistics.truncated);
  if (sourceTruncated) {
    writer.add('## Source coverage');
    writer.add('');
    writer.add(graph.subject.kind === 'developer'
      ? 'Developer graph coverage is incomplete because its source pipeline was bounded.'
      : 'Project structure is truncated; this is an incomplete bounded view.');
    writer.add('');
  }
  const limitations = new Set(graph.statistics.limitations || []);
  if (graph.subject.kind === 'project' && graph.project.statistics.limitation) limitations.add(graph.project.statistics.limitation);
  const ordered = [...limitations].sort(cmp);
  if (ordered.length) {
    writer.add('## Source limitations');
    writer.add('');
    for (const limitation of ordered.slice(0, SEMANTIC_MARKDOWN_LIMITS.sourceLimitations)) writer.add(`- ${esc(bounded(limitation))}`);
    if (ordered.length > SEMANTIC_MARKDOWN_LIMITS.sourceLimitations) writer.add(`Showing ${SEMANTIC_MARKDOWN_LIMITS.sourceLimitations} of ${ordered.length} source limitations; ${ordered.length - SEMANTIC_MARKDOWN_LIMITS.sourceLimitations} additional source limitations omitted.`);
    writer.add('');
  }
}

function renderDeveloper(graph, detail, writer) {
  const nodes = nodeMap(graph);
  const projects = graph.nodes.filter(node => node.kind === 'project').sort((a, b) => cmp(a.id, b.id));
  const groups = [...(graph.groups || [])].sort((a, b) => (a.provenance === 'user' ? 0 : 1) - (b.provenance === 'user' ? 0 : 1) || cmp(a.label, b.label) || cmp(a.id, b.id));
  const relationships = graph.edges.filter(edge => edge.kind === 'project-relationship').sort(edgeSort);
  const languages = [...new Set(graph.edges.filter(edge => edge.kind === 'uses-language').map(edge => nodes.get(edge.to)?.label).filter(Boolean))].sort(cmp);
  const topics = [...new Set(graph.edges.filter(edge => edge.kind === 'has-topic').map(edge => nodes.get(edge.to)?.label).filter(Boolean))].sort(cmp);
  const projectLimit = detail === 'summary' ? 40 : SEMANTIC_MARKDOWN_LIMITS.projects;
  const groupLimit = detail === 'summary' ? 24 : SEMANTIC_MARKDOWN_LIMITS.groups;
  const projectLanguages = new Map();
  const projectTopics = new Map();
  for (const edge of graph.edges) {
    if (edge.kind === 'uses-language' || edge.kind === 'has-topic') {
      const target = nodes.get(edge.to)?.label;
      if (!target) continue;
      const index = edge.kind === 'uses-language' ? projectLanguages : projectTopics;
      if (!index.has(edge.from)) index.set(edge.from, []);
      index.get(edge.from).push(target);
    }
  }
  for (const [id, values] of projectLanguages) projectLanguages.set(id, [...new Set(values)].sort(cmp));
  for (const [id, values] of projectTopics) projectTopics.set(id, [...new Set(values)].sort(cmp));

  writer.add(`# ${esc(bounded(graph.subject.id))}`);
  addSourceCoverage(graph, writer);
  writer.add('');
  writer.add('## Projects');
  writer.add('');
  for (const project of projects.slice(0, projectLimit)) {
    writer.add(`### ${esc(bounded(project.label))}`);
    writer.add('');
    writer.add(`- Repository: ${code(bounded(project.id))}`);
    const language = projectLanguages.get(project.id) || [];
    const topicsForProject = projectTopics.get(project.id) || [];
    const primaryLanguage = typeof project.properties.language === 'string' && language.includes(project.properties.language) ? project.properties.language : null;
    const shownLanguages = primaryLanguage
      ? [primaryLanguage, ...language.filter(value => value !== primaryLanguage).slice(0, SEMANTIC_MARKDOWN_LIMITS.projectLanguages - 1)]
      : language.slice(0, SEMANTIC_MARKDOWN_LIMITS.projectLanguages);
    if (primaryLanguage) writer.add(`- Primary language: ${esc(bounded(primaryLanguage, 120))}`);
    const otherLanguages = shownLanguages.filter(value => value !== primaryLanguage);
    if (otherLanguages.length) writer.add(`- ${primaryLanguage ? 'Additional languages' : 'Languages'}: ${otherLanguages.map(value => esc(bounded(value, 120))).join(', ')}`);
    addLimit(writer, `languages for ${code(bounded(project.id))}`, shownLanguages.length, language.length);
    const shownTopics = topicsForProject.slice(0, SEMANTIC_MARKDOWN_LIMITS.projectTopics);
    if (shownTopics.length) writer.add(`- Topics: ${shownTopics.map(value => esc(bounded(value, 120))).join(', ')}`);
    addLimit(writer, `topics for ${code(bounded(project.id))}`, shownTopics.length, topicsForProject.length);
    if (detail === 'detailed' && project.properties.url) writer.add(`- Repository URL: ${code(bounded(project.properties.url, 300))}`);
    if (detail === 'detailed' && project.properties.description) writer.add(`- Description: ${esc(bounded(project.properties.description, SEMANTIC_MARKDOWN_LIMITS.descriptionCharacters))}`);
    writer.add('');
  }
  addLimit(writer, 'projects', Math.min(projects.length, projectLimit), projects.length);

  if (groups.length) {
    writer.add(''); writer.add('## Project families and groups'); writer.add('');
    for (const group of groups.slice(0, groupLimit)) {
      writer.add(`### ${esc(bounded(group.label))}`);
      writer.add(group.provenance === 'user' ? 'Defined by you.' : group.kind === 'repository-owner' ? 'Grouped by shared repository owner.' : 'Derived semantic group.');
      if (detail === 'detailed' && group.basis.length) writer.add(`Basis: ${[...group.basis].sort(cmp).map(value => esc(bounded(value, 160))).join('; ')}`);
      const members = [...group.members].sort(cmp);
      for (const id of members.slice(0, SEMANTIC_MARKDOWN_LIMITS.groupMembers)) writer.add(`- ${code(bounded(id))}`);
      addLimit(writer, 'group members', Math.min(members.length, SEMANTIC_MARKDOWN_LIMITS.groupMembers), members.length);
      writer.add('');
    }
    addLimit(writer, 'groups', Math.min(groups.length, groupLimit), groups.length);
  }
  if (detail !== 'summary' && (languages.length || topics.length)) {
    writer.add(''); writer.add('## Languages and topics'); writer.add('');
    const shownLanguages = languages.slice(0, SEMANTIC_MARKDOWN_LIMITS.languages);
    const shownTopics = topics.slice(0, SEMANTIC_MARKDOWN_LIMITS.topics);
    if (shownLanguages.length) writer.add(`- Languages: ${shownLanguages.map(value => esc(bounded(value, 120))).join(', ')}`);
    addLimit(writer, 'languages', shownLanguages.length, languages.length);
    if (shownTopics.length) writer.add(`- Topics: ${shownTopics.map(value => esc(bounded(value, 120))).join(', ')}`);
    addLimit(writer, 'topics', shownTopics.length, topics.length);
  }
  if (relationships.length) {
    const shown = relationships.slice(0, SEMANTIC_MARKDOWN_LIMITS.relationships);
    writer.add(''); writer.add('## Explicit project relationships'); writer.add('');
    for (const edge of shown) writer.add(`- ${code(bounded(edge.from))} ↔ ${code(bounded(edge.to))}`);
    addLimit(writer, 'relationships', shown.length, relationships.length);
  }
  if (detail === 'detailed' && graph.evidence?.facts?.length) {
    const facts = [...graph.evidence.facts].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.value, b.value) || cmp(a.id, b.id));
    writer.add(''); writer.add('## Evidence and provenance'); writer.add('');
    for (const fact of facts.slice(0, SEMANTIC_MARKDOWN_LIMITS.evidenceItems)) writer.add(`- ${esc(bounded(fact.kind, 100))}: ${esc(bounded(fact.value, 200))} (${esc(fact.provenance === 'user' ? 'selected by user' : fact.provenance === 'derived' ? 'derived' : bounded(fact.source || 'source evidence', 100))})`);
    addLimit(writer, 'evidence items', Math.min(facts.length, SEMANTIC_MARKDOWN_LIMITS.evidenceItems), facts.length);
  }
  writer.add(''); writer.add('## Coverage'); writer.add('');
  writer.add(`Portable graph contains ${projects.length} ${projects.length === 1 ? 'project' : 'projects'} and ${groups.length} ${groups.length === 1 ? 'semantic group' : 'semantic groups'}.`);
}

function renderProject(graph, detail, writer) {
  const stats = graph.project.statistics;
  const edges = [...graph.edges].sort(edgeSort);
  const nodes = graph.nodes.filter(node => ['project-root', 'package', 'directory', 'module', 'entry-point'].includes(node.kind));
  const parentById = new Map(edges.filter(edge => edge.kind === 'contains').map(edge => [edge.to, edge.from]));
  const depthById = new Map();
  for (const node of nodes) {
    let depth = 0, parent = parentById.get(node.id);
    const seen = new Set([node.id]);
    while (parent && !seen.has(parent) && depth < 4) {
      seen.add(parent); depth++; parent = parentById.get(parent);
    }
    depthById.set(node.id, depth);
  }
  nodes.sort((a, b) => depthById.get(a.id) - depthById.get(b.id) || cmp(a.properties.path, b.properties.path) || cmp(a.kind, b.kind));
  const byId = nodeMap(graph);
  const nodeLimit = detail === 'summary' ? 40 : SEMANTIC_MARKDOWN_LIMITS.structureNodes;
  const identity = graph.subject.id;
  writer.add(`# ${esc(bounded(identity))}`);
  addSourceCoverage(graph, writer);
  writer.add(''); writer.add('## Repository'); writer.add('');
  if (graph.project.provenance.ref) writer.add(`- Ref: ${code(bounded(graph.project.provenance.ref, 300))}`);
  if (graph.project.provenance.commit) writer.add(`- Commit: ${code(graph.project.provenance.commit)}`);
  if (graph.project.provenance.visibility) writer.add(`- Visibility: ${esc(graph.project.provenance.visibility)}`);
  if (graph.project.provenance.visibility === 'private') {
    writer.add(''); writer.add('> This semantic graph was derived from a private repository. Exporting this Markdown may disclose repository names, paths, and structure.');
  }
  writer.add(''); writer.add('## Structure'); writer.add('');
  for (const node of nodes.slice(0, nodeLimit)) {
    const path = node.properties.path || identity;
    const depth = Math.min(depthById.get(node.id) || 0, 3);
    writer.add(`${'  '.repeat(depth)}- ${code(bounded(path))} — ${esc(node.kind)}`);
  }
  addLimit(writer, 'structure nodes', Math.min(nodes.length, nodeLimit), nodes.length);
  const workspace = edges.filter(edge => edge.kind === 'workspace-member');
  const entries = edges.filter(edge => edge.kind === 'entry-of');
  const imports = edges.filter(edge => edge.kind === 'imports');
  if (workspace.length || entries.length || imports.length) {
    writer.add(''); writer.add('## Verified relationships'); writer.add('');
    const rels = [...workspace, ...entries, ...imports];
    const relLimit = detail === 'summary' ? 20 : SEMANTIC_MARKDOWN_LIMITS.relationships;
    for (const edge of rels.slice(0, relLimit)) {
      const source = byId.get(edge.from)?.properties.path || edge.from;
      const target = byId.get(edge.to)?.properties.path || edge.to;
      const evidence = edge.evidence;
      if (edge.kind === 'workspace-member') writer.add(`- ${code(bounded(target))} is declared as a workspace member by ${code(bounded(evidence.path))}${evidence.declaration ? ` (${code(bounded(evidence.declaration))})` : ''}.`);
      if (edge.kind === 'entry-of') writer.add(`- ${code(bounded(target))} is declared as an entry point by ${code(bounded(evidence.path))}${evidence.declaration ? ` (${code(bounded(evidence.declaration))})` : ''}.`);
      if (edge.kind === 'imports') writer.add(`- ${code(bounded(source))} imports ${code(bounded(evidence.specifier || target))} → ${code(bounded(target))} (static import evidence).`);
    }
    addLimit(writer, 'relationships', Math.min(rels.length, relLimit), rels.length);
  }
  writer.add(''); writer.add('## Coverage'); writer.add('');
  const metrics = [
    ['filesInspected', 'filesAvailable', count => `${count} of ${stats.filesAvailable} files entered inspection.`],
    ['manifestsRead', 'manifestsAvailable', count => `${count} of ${stats.manifestsAvailable} manifests read.`],
    ['sourceFilesRead', 'sourceFilesAvailable', count => `${count} of ${stats.sourceFilesAvailable} supported source files read.`],
    ['directoriesIncluded', 'directoriesAvailable', count => `${count} of ${stats.directoriesAvailable} directories represented.`],
  ];
  for (const [countKey, availableKey, format] of metrics) if (Number.isInteger(stats[countKey]) && Number.isInteger(stats[availableKey])) writer.add(`- ${format(stats[countKey])}`);
  if (Number.isInteger(stats.nodeCount)) writer.add(`- ${stats.nodeCount} structural nodes represented.`);
  if (Number.isInteger(stats.edgeCount)) writer.add(`- ${stats.edgeCount} structural relationships represented.`);
  if (detail === 'detailed') {
    writer.add(''); writer.add('## Provenance'); writer.add('');
    writer.add(`- Repository structure from ${esc(bounded(graph.project.provenance.source || 'repository data'))}${graph.project.provenance.ref ? ` at ${code(bounded(graph.project.provenance.ref))}` : ''}${graph.project.provenance.commit ? ` (${code(graph.project.provenance.commit)})` : ''}.`);
    writer.add('- Manifest declarations and static relative imports are structural evidence; they do not establish runtime behavior.');
  }
}

/** Render a validated Semantic Graph v1 as bounded, deterministic Markdown. */
export function renderSemanticMarkdown(graph, options = {}) {
  const validation = validateSemanticGraph(graph);
  if (!validation.valid) throw new Error(`Invalid semantic graph: ${validation.errors.join(' ')}`);
  if (options === null || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'detail')) throw new Error('Semantic Markdown options may contain only detail.');
  const detail = options.detail ?? 'standard';
  if (!['summary', 'standard', 'detailed'].includes(detail)) throw new Error('Semantic Markdown detail must be summary, standard, or detailed.');
  const writer = createWriter();
  if (graph.subject.kind === 'developer') renderDeveloper(graph, detail, writer);
  else renderProject(graph, detail, writer);
  return writer.finish();
}
