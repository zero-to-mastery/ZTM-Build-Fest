import { DAY } from './historical-snapshot.mjs';
import { historyDefaults } from './settings.mjs';
import { sanitizeActivityEvents } from '../activity.mjs';
export function projectLifecycle(repo, reference, thresholds = historyDefaults.stellarAges.thresholds, events = []) {
  if (!Number.isFinite(reference)) throw new Error('Lifecycle requires an explicit reference date.');
  if (repo.archived) return 'archived';
  const created = Date.parse(repo.created_at);
  if (!Number.isFinite(created) || created > reference) return 'unknown';
  const age = (reference - created) / DAY;
  if (age < thresholds.newborn) return 'newborn';
  const known = [repo.pushed_at, repo.updated_at, ...sanitizeActivityEvents(events).filter(e => !['watch', 'fork'].includes(e.kind) && e.repository.toLowerCase() === repo.full_name.toLowerCase()).map(e => e.createdAt)].map(Date.parse).filter(time => Number.isFinite(time) && time <= reference && time >= created);
  // Future latest timestamps cannot reveal past maintenance. Do not call it dormant.
  if (!known.length) return 'unknown';
  const idle = (reference - Math.max(...known)) / DAY;
  if (idle < thresholds.active) return 'active';
  if (age >= thresholds.mature && idle < thresholds.quiet) return 'mature';
  if (idle < thresholds.dormant) return 'quiet';
  return 'dormant';
}
