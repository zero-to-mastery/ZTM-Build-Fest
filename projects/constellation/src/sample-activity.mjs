export const sampleActivityDate = '2026-01-08T12:00:00.000Z';
export function sampleActivity(repositories, asOf = sampleActivityDate) {
  return { asOf, coverageStart: new Date(Date.parse(asOf) - 5 * 86400000).toISOString(), diagnostic: '', events: repositories.slice(0, 5).flatMap((repo, i) => Array.from({ length: 5 - i }, (_, j) => ({ id: `sample-${i}-${j}`, repository: repo.full_name, kind: ['push', 'pull-request', 'release', 'create', 'comment'][i], createdAt: new Date(Date.parse(asOf) - (i * 20 + j * 3 + 1) * 3600000).toISOString(), newRepository: i === 3 }))) };
}
