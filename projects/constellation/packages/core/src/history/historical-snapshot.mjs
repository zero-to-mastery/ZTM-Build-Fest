import { historyOptions } from './settings.mjs';
export const DAY = 86400000;
export function referenceDate(options = {}, fallback) {
  const { history } = historyOptions(options);
  const value = options.referenceDate || options.generatedAt || options.activityMetricDate || options.metricDate || fallback;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('History calculations require an explicit reference date.');
  return history.mode === 'historical' ? Math.min(time, Date.UTC(history.year + 1, 0, 1) - 1) : time;
}
export function historicalSnapshot(repositories, reference) {
  return repositories.filter(repo => repo.private !== true && Number.isFinite(Date.parse(repo.created_at)) && Date.parse(repo.created_at) <= reference).map(repo => {
    const copy = { ...repo };
    for (const key of ['updated_at', 'pushed_at']) if (Date.parse(copy[key]) > reference) copy[key] = undefined;
    // Archive timestamps are not available: current archive status is not historical evidence.
    if (repo.archived && !(Date.parse(repo.archived_at) <= reference)) copy.archived = false;
    return copy;
  });
}
export function historyYears(repositories, reference, limit = 8) {
  const end = new Date(reference).getUTCFullYear();
  const years = repositories.filter(repo => repo.private !== true).map(repo => Date.parse(repo.created_at)).filter(time => Number.isFinite(time) && time <= reference).map(time => new Date(time).getUTCFullYear());
  const start = Math.max(1970, Math.min(end, ...years));
  const count = Math.min(Math.max(2, Math.min(8, limit)), end - start + 1);
  return Array.from({ length: count }, (_, i) => count === 1 ? end : start + Math.round(i * (end - start) / (count - 1)));
}
