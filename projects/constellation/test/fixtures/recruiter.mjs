// Explicit offline demonstration data, never used by production loaders.
export const referenceDate = '2026-10-01T00:00:00.000Z';
const names = ['atlas', 'atlas-mobile', 'tiny-experiment', 'automation-kit', 'query-engine', 'old-notebook', 'visual-lab', 'api-tools', 'archive-reader', 'cli-helper', 'data-pipeline', 'weekend-game', 'extra-one', 'extra-two', 'extra-three'];
export const repositories = names.map((name, index) => ({ name, full_name: `${index === 4 ? 'community' : 'alice'}/${name}`, private: false, language: ['TypeScript', 'Python', 'JavaScript'][index % 3], pushed_at: ['2026-09-28', '2026-07-01', '2026-09-30', '2026-05-10', '2026-09-01', '2021-02-01'][index % 6], created_at: '2020-01-01', updated_at: '2026-10-01', stargazers_count: index * 100, topics: ['visualization'] }));
export const options = {
  readmePresentation: 'recruiter', referenceDate, theme: 'midnight', showOther: true,
  accountData: { name: 'Alice Chen' },
  projectShowcase: { 'alice/atlas': { role: 'featured', priority: 1 }, 'community/query-engine': { role: 'featured', priority: 2 }, 'alice/atlas-mobile': { role: 'supporting' }, 'alice/old-notebook': { role: 'historical' } },
  projectRelationships: [['alice/atlas', 'alice/atlas-mobile']],
  organizationData: { complete: true, records: Object.fromEntries(repositories.map((repo, index) => [repo.full_name, Array.from({ length: index === 0 ? 15 : index === 2 ? 1 : 3 }, (_, i) => ({ login: i ? `person${i}` : 'alice', contributions: i + 1 }))])) },
  commitFieldData: Object.fromEntries(repositories.map((repo, index) => [repo.full_name, { repository: repo.full_name, partial: false, commits: Array.from({ length: index === 0 ? 30 : index === 2 ? 1 : 8 }, (_, i) => ({ date: new Date(Date.parse(repo.pushed_at) - i * 32 * 86400000).toISOString(), login: 'alice', sha: String(i).padStart(40, '0') })) }])),
};
