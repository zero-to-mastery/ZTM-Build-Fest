import { selectRepositoryPool, selectRepositories, graphNodes } from './constellation.mjs';
import { referenceDate } from './history/historical-snapshot.mjs';
import { updatedTime } from './repository-filters.mjs';

export function explainFilters(repositories, options = {}) {
  const pool = selectRepositoryPool(repositories, options);
  const selected = selectRepositories(repositories, options);
  const graph = graphNodes(repositories, options);
  const hidden = new Set(options.hiddenNodes || []);
  const poolIds = new Set(pool.map(repo => repo.full_name));
  const selectedIds = new Set(selected.map(repo => repo.full_name));
  const now = referenceDate(options, new Date().toISOString());
  const excluded = repositories.filter(repo => !selectedIds.has(repo.full_name)).map(repo => {
    const reasons = [];
    if (repo.private === true) reasons.push('private');
    if (options.repoSource === 'pinned' && !repo.pinned) reasons.push('not-pinned');
    if (options.includeForks === false && repo.fork) reasons.push('fork');
    if (options.includeArchived === false && repo.archived) reasons.push('archived');
    if ((repo.stargazers_count || 0) < (options.minStars || 0)) reasons.push('minimum-stars');
    if (options.updatedWithin && updatedTime(repo) < now - options.updatedWithin * 365.25 * 86400000) reasons.push('updated-within');
    if (options.repoQuery && !`${repo.name} ${repo.full_name}`.toLowerCase().includes(options.repoQuery.trim().toLowerCase())) reasons.push('query');
    if (options.includeRepos && !options.includeRepos.includes(repo.name) && !options.includeRepos.includes(repo.full_name)) reasons.push('repository-selection');
    if (!reasons.length) reasons.push(poolIds.has(repo.full_name) ? 'language-or-topic-selection' : 'scope-or-project-limit');
    return { node: repo.full_name, reasons };
  });
  return {
    loaded: repositories.length, pool: pool.length, included: selected.length,
    rendered: graph.nodes.filter(node => !hidden.has(node.full_name)).length,
    omittedByGraphLimit: Math.max(0, graph.total - graph.nodes.length),
    excludedBeforeCategories: repositories.filter(repo => !poolIds.has(repo.full_name)).map(repo => repo.full_name),
    excludedByCategories: pool.filter(repo => !selectedIds.has(repo.full_name)).map(repo => repo.full_name),
    hidden: graph.nodes.filter(node => hidden.has(node.full_name)).map(node => node.full_name),
    excluded,
  };
}
