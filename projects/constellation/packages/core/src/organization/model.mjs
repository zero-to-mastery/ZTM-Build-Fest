import { organizationOptions, groupingRegex } from './settings.mjs';
const cmp = (a, b) => a.full_name.localeCompare(b.full_name);
const date = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
export function groupRepository(repo, grouping) {
  const year = /^\d{4}/.exec(repo.created_at || '')?.[0] || 'Unknown era';
  const prefix = repo.name?.split(/[-_.]/)[0] || 'Other';
  if (grouping.mode === 'regex') { const groups = groupingRegex(grouping.pattern).exec(repo.name?.slice(0, 100) || '')?.groups; return { key: groups ? Object.entries(groups).map(([key, value]) => `${key} ${value}`).join(' · ') : 'Other', metadata: { ...groups } }; }
  return { key: ({ year, prefix, topic: [...(repo.topics || [])].sort()[0] || 'Other', language: repo.language || 'Other', none: 'Organization', auto: `${year} · ${prefix}` })[grouping.mode], metadata: { year } };
}
export function representativeRepositories(repos, count) {
  const years = new Map();
  for (const repo of [...repos].sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0) || date(b.pushed_at) - date(a.pushed_at) || cmp(a, b))) {
    const year = (repo.created_at || '').slice(0, 4) || 'Unknown', language = repo.language || 'Other', family = repo.name.split(/[-_.]/)[0];
    if (!years.has(year)) years.set(year, new Map());
    const languages = years.get(year);
    if (!languages.has(language)) languages.set(language, new Map());
    const families = languages.get(language);
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(repo);
  }
  const ordered = map => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  const interleave = groups => {
    const result = [], seen = new Set();
    for (let round = 0; result.length < count; round++) {
      let added = false;
      for (const group of groups) if (group[round] && result.length < count) { added = true; if (!seen.has(group[round].full_name)) { seen.add(group[round].full_name); result.push(group[round]); } }
      if (!added) break;
    }
    return result;
  };
  const activityMix = family => interleave([family, [...family].sort((a, b) => date(b.pushed_at) - date(a.pushed_at) || cmp(a, b)), [...family].sort((a, b) => date(a.pushed_at) - date(b.pushed_at) || cmp(a, b))]);
  return interleave(ordered(years).map(languages => interleave(ordered(languages).map(families => interleave(ordered(families).map(activityMix))))));
}
export function scopeRepositories(repos, options, count = options.maxRepos ?? 100) {
  const { scope } = organizationOptions(options);
  if (scope === 'sample' || scope === 'all-metadata') return representativeRepositories(repos, count);
  return [...repos].sort((a, b) => scope === 'featured' ? Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.stargazers_count || 0) - (a.stargazers_count || 0) || cmp(a, b) : date(scope === 'active' ? b.pushed_at : b.updated_at) - date(scope === 'active' ? a.pushed_at : a.updated_at) || cmp(a, b)).slice(0, count);
}
export function normalizeContributors(records, repos) {
  const byId = new Map(), repoMap = new Map(repos.map(repo => [repo.full_name, repo]));
  for (const [fullName, rows] of Object.entries(records)) {
    const repo = repoMap.get(fullName); if (!repo) continue;
    const seen = new Set();
    for (const row of rows) {
      if (!/^[a-z\d][a-z\d-]{0,38}(?:\[bot\])?$/i.test(row.login || '')) continue;
      const key = row.login.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
      if (!byId.has(key)) byId.set(key, { login: row.login, avatar_url: /^https:\/\//.test(row.avatar_url || '') ? row.avatar_url : '', html_url: `https://github.com/${encodeURIComponent(row.login)}`, repositoryCount: 0, contributionCount: 0, pullRequestCount: 0, repositories: [], firstSeen: null, lastSeen: null });
      const person = byId.get(key); person.repositories.push(fullName); person.repositoryCount++;
      person.contributionCount += Math.max(0, Number(row.contributions) || 0);
      person.pullRequestCount += Math.max(0, Number(row.pullRequestCount) || 0);
      // Contributor totals do not contain commit dates: never infer tenure from repo dates.
    }
  }
  return [...byId.values()].map(person => ({ ...person, repositories: person.repositories.sort() })).sort((a, b) => b.repositoryCount - a.repositoryCount || b.contributionCount - a.contributionCount || a.login.localeCompare(b.login));
}
