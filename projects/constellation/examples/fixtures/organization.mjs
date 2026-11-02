// Synthetic community, never a claim about a real organization's contributors.
export const repositories = Array.from({ length: 48 }, (_, i) => {
  const language = ['TypeScript', 'Python', 'Rust', 'JavaScript'][i % 4];
  const name = `v${40 + Math.floor(i / 8)}-tier${1 + i % 3}-team-${String(i).padStart(2, '0')}`;
  return { name, full_name: `example-community/${name}`, private: false, language, languages: { [language]: 100 }, topics: [i % 2 ? 'web' : 'tools'], dependencies: i % 2 ? ['npm:react'] : [], stargazers_count: 80 - i, created_at: `${2020 + Math.floor(i / 8)}-02-01T00:00:00Z`, updated_at: '2026-08-01T00:00:00Z', pushed_at: '2026-08-01T00:00:00Z', contributors: Array.from({ length: 3 }, (_, j) => ({ login: j === 0 && i % 7 === 0 ? 'alice' : `builder-${(i + j * 3) % 24}`, contributions: 12 + i + j })) };
});
export const organizationData = { records: Object.fromEntries(repositories.map(repo => [repo.full_name, repo.contributors])), scanned: 48, selected: 48, perRepositoryLimit: 25, metadataComplete: true };
