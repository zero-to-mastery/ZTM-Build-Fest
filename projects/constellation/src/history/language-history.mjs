import { mappedColor } from '../visual-mapping.mjs';
export function languageHistory(repositories, reference, buckets = 'automatic') {
  const repos = repositories.filter(repo => repo.private !== true && Date.parse(repo.created_at) <= reference).sort((a, b) => a.full_name.localeCompare(b.full_name));
  const end = new Date(reference).getUTCFullYear();
  const start = Math.max(1970, Math.min(end, ...repos.map(repo => new Date(repo.created_at).getUTCFullYear())));
  const step = buckets === 'yearly' ? 1 : buckets === '2-year' ? 2 : Math.max(1, Math.ceil((end - start + 1) / 6));
  const eras = [];
  for (let year = start; year <= end; year += step) {
    const last = Math.min(end, year + step - 1), weights = new Map();
    for (const repo of repos) {
      const born = new Date(repo.created_at).getUTCFullYear();
      // Creation cohorts describe changing project choices, not historical byte percentages.
      if (born < year || born > last) continue;
      const entries = repo.languages ? Object.entries(repo.languages).filter(([, bytes]) => Number.isFinite(bytes) && bytes > 0) : repo.language ? [[repo.language, 1]] : [];
      const total = entries.reduce((sum, [, bytes]) => sum + Math.log1p(Math.min(bytes, 1e9)), 0);
      for (const [language, bytes] of entries) weights.set(language, (weights.get(language) || 0) + Math.log1p(Math.min(bytes, 1e9)) / total);
    }
    const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
    eras.push({ start: year, end: last, inferred: true, languages: [...weights].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, weight]) => ({ name, prominence: weight / total, color: mappedColor({ language: name }, 'language') })) });
  }
  return eras;
}
