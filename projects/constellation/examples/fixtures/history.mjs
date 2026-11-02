// Synthetic public data only. No API calls, wall-clock dependencies or real activity.
export const referenceDate = '2026-09-27T12:00:00.000Z';
const make = (name, language, created, pushed, extra = {}) => ({ name, full_name: `example/${name}`, private: false, language, languages: { [language]: 1000 }, created_at: `${created}T00:00:00Z`, pushed_at: `${pushed}T00:00:00Z`, updated_at: `${pushed}T00:00:00Z`, stargazers_count: 20, topics: ['space', 'tools'], ...extra });
export const repositories = [
  make('first-light', 'PHP', '2012-02-01', '2014-04-01'),
  make('lunar-pages', 'PHP', '2014-06-01', '2016-01-01'),
  make('web-observatory', 'JavaScript', '2016-03-01', '2020-05-01'),
  make('star-atlas', 'JavaScript', '2018-04-01', '2024-06-01'),
  make('typed-orbits', 'TypeScript', '2020-01-01', '2026-06-01'),
  make('sky-map', 'TypeScript', '2022-04-01', '2026-08-01'),
  make('orbital-engine', 'Rust', '2024-06-01', '2026-09-20'),
  make('newborn', 'Rust', '2026-09-01', '2026-09-25'),
  make('active', 'TypeScript', '2020-01-01', '2026-09-26'),
  make('mature', 'Rust', '2022-01-01', '2026-06-01'),
  make('quiet', 'JavaScript', '2019-01-01', '2026-01-01'),
  make('dormant', 'PHP', '2015-01-01', '2020-01-01'),
  make('archived', 'Python', '2017-01-01', '2024-01-01', { archived: true }),
];
const events = Array.from({ length: 52 }, (_, week) => Array.from({ length: week % 5 }, (_, i) => ({ id: `week-${week}-${i}`, public: true, type: 'PushEvent', repo: { name: 'example/orbital-engine' }, created_at: new Date(Date.parse(referenceDate) - (51 - week) * 7 * 86400000 - (i + 1) * 3600000).toISOString() }))).flat();
export const publicEvents = [...events, ...Array.from({ length: 8 }, (_, i) => ({ id: `external-${i}`, public: true, type: 'PullRequestEvent', repo: { name: `community-${i}/${['parser', 'renderer', 'docs', 'compiler'][i % 4]}` }, created_at: `2026-09-${String(10 + i).padStart(2, '0')}T12:00:00Z`, payload: { action: 'closed', pull_request: { merged: i % 2 === 0 } } }))];
export const coverageStart = '2025-09-29T00:00:00.000Z';
