// Shared Profile Story fixture for compact label ownership regressions.
export const labelOwnershipRecords = Array.from({ length: 16 }, (_, index) => ({
  full_name: `owner/project-${String(index).padStart(2, '0')}`,
  name: `${['Featured', 'Featured', 'Featured', 'Featured', 'Supporting', 'Supporting', 'Supporting', 'Supporting', 'Supporting'][index] || 'Ordinary'} repository with a deliberately long descriptive name ${index}`,
  description: `Project ${index}`,
  language: ['Rust', 'JavaScript', 'Rust', 'TypeScript'][index % 4],
  topics: ['tooling', `area-${index % 3}`, `layer-${index % 2}`],
  stargazers_count: 40 - index,
  created_at: `${2016 + (index % 8)}-03-01T00:00:00Z`,
  pushed_at: '2026-09-01T00:00:00Z',
}));

export const labelOwnershipShowcase = Object.fromEntries(labelOwnershipRecords.slice(0, 9)
  .map((repo, index) => [repo.full_name, { role: index < 4 ? 'featured' : 'supporting', priority: index + 1 }]));
