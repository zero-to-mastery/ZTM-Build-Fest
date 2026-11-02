export function repositoryFilterOptions(options = {}) {
  const { minStars = 0, includeArchived = true, updatedWithin = 0, repoQuery = '', sortBy = 'stars' } = options;
  if (!Number.isFinite(minStars) || minStars < 0 || minStars > 1e9) throw new Error('Minimum stars must be between 0 and 1 billion.');
  if (typeof includeArchived !== 'boolean' || ![0, 1, 2, 5].includes(updatedWithin) || typeof repoQuery !== 'string' || repoQuery.length > 200 || !['stars', 'updated', 'name'].includes(sortBy)) throw new Error('Invalid repository filters.');
  return { minStars, includeArchived, updatedWithin, repoQuery, sortBy };
}

export const updatedTime = repo => Date.parse(repo.pushed_at || repo.updated_at) || 0;

export function filterRepositoryMetadata(repos, options = {}, now) {
  const { minStars, includeArchived, updatedWithin, repoQuery } = repositoryFilterOptions(options);
  if (updatedWithin && !Number.isFinite(now)) throw new Error('Temporal filtering requires a reference date.');
  const query = repoQuery.trim().toLowerCase();
  return repos.filter(repo => (repo.stargazers_count || 0) >= minStars && (includeArchived || !repo.archived)
    && (!updatedWithin || updatedTime(repo) >= now - updatedWithin * 365.25 * 86400000)
    && (!query || `${repo.name} ${repo.full_name}`.toLowerCase().includes(query)));
}

export function compareRepositories(a, b, sortBy = 'stars') {
  return (sortBy === 'updated' ? updatedTime(b) - updatedTime(a) : sortBy === 'name' ? 0 : (b.stargazers_count || 0) - (a.stargazers_count || 0))
    || a.full_name.localeCompare(b.full_name);
}
