import { sanitizeActivityEvents } from '../activity.mjs';
import { DAY } from './historical-snapshot.mjs';
export function contributionHistory(snapshot, reference) {
  if (!snapshot || snapshot.diagnostic) return null;
  const date = new Date(reference); date.setUTCHours(0, 0, 0, 0);
  const current = date.getTime() - (date.getUTCDay() + 6) % 7 * DAY;
  const start = current - 51 * 7 * DAY;
  const events = sanitizeActivityEvents(snapshot.events).filter(e => !['watch', 'fork'].includes(e.kind) && Date.parse(e.createdAt) <= reference);
  const coverageStart = Date.parse(snapshot.coverageStart);
  const coverageEnd = Date.parse(snapshot.asOf);
  const weeks = Array.from({ length: 52 }, (_, i) => ({ start: start + i * 7 * DAY, count: 0, level: 0, observed: false }));
  for (const week of weeks) week.observed = Number.isFinite(coverageStart) && week.start >= coverageStart && Math.min(week.start + 7 * DAY - 1, reference) <= coverageEnd;
  for (const event of events) {
    const i = Math.floor((Date.parse(event.createdAt) - start) / (7 * DAY));
    if (i >= 0 && i < 52) weeks[i].count++;
  }
  for (const week of weeks) week.level = week.count === 0 ? 0 : Math.min(4, 1 + Math.floor(Math.log2(week.count)));
  return { weeks, reference, source: 'public-events', partial: true };
}
