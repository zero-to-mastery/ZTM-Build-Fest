export const eventWeights = Object.freeze({ push: 1, 'pull-request': 1.2, release: 1.5, create: 1.25, issue: .4, comment: .2, watch: .1, fork: .25 });
const eventKinds = { PushEvent: 'push', PullRequestEvent: 'pull-request', ReleaseEvent: 'release', CreateEvent: 'create', IssuesEvent: 'issue', IssueCommentEvent: 'comment', WatchEvent: 'watch', ForkEvent: 'fork' };
const repoPattern = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;
const windows = { '1d': 24, '7d': 168, '30d': 720 };

export function activityOptions(options = {}) {
  const { activityEffect = 'off', activityWindow = '7d', activityDetail = 'simple', activityConnections = false, activityMetricDate } = options;
  if (!['off', 'glow', 'pulse', 'comet', 'ripple', 'asteroids'].includes(activityEffect) || !['1d', '7d', '30d', 'auto'].includes(activityWindow) || !['simple', 'event-types'].includes(activityDetail) || typeof activityConnections !== 'boolean') throw new Error('Invalid recent activity settings.');
  if (activityMetricDate !== undefined && (typeof activityMetricDate !== 'string' || !Number.isFinite(Date.parse(activityMetricDate)))) throw new Error('activityMetricDate must be an ISO date.');
  return { activityEffect, activityWindow, activityDetail, activityConnections, activityMetricDate };
}

// Persist only these fields, never event payloads, actors, messages or titles.
export function normalizePublicEvents(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input.flatMap(event => {
    if (!event || event.public !== true || !Object.hasOwn(eventKinds, event.type) || typeof event.repo?.name !== 'string' || !repoPattern.test(event.repo.name) || typeof event.created_at !== 'string' || !Number.isFinite(Date.parse(event.created_at))) return [];
    const id = typeof event.id === 'string' ? event.id.slice(0, 80) : `${event.type}:${event.repo.name}:${event.created_at}`;
    if (seen.has(id)) return []; seen.add(id);
    return [{ id, repository: event.repo.name, kind: eventKinds[event.type], createdAt: new Date(event.created_at).toISOString(), newRepository: event.type === 'CreateEvent' && event.payload?.ref_type === 'repository', ...(event.type === 'PullRequestEvent' && event.payload?.action === 'closed' && event.payload?.pull_request?.merged === true ? { merged: true } : {}) }];
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 300);
}

export function sanitizeActivityEvents(input) {
  if (!Array.isArray(input)) return [];
  return normalizePublicEvents(input.filter(event => event?.public !== false && event?.private !== true).map(event => ({ id: event?.id, public: true, type: Object.keys(eventKinds).find(key => eventKinds[key] === event?.kind), repo: { name: event?.repository }, created_at: event?.createdAt, payload: { ref_type: event?.newRepository ? 'repository' : '', action: event?.merged ? 'closed' : '', pull_request: { merged: event?.merged === true } } })));
}

export function recencyDecay(ageHours) {
  return Number.isFinite(ageHours) && ageHours >= 0 ? Math.exp(-Math.LN2 * ageHours / 72) : 0;
}

export function aggregateActivity(input, repositories, options = {}, asOf) {
  const settings = activityOptions(options);
  const date = settings.activityMetricDate || asOf;
  if (!Number.isFinite(Date.parse(date))) throw new Error('Activity aggregation needs an explicit reference date.');
  const reference = Date.parse(date);
  const names = new Map(repositories.filter(repo => repo.private !== true).map(repo => [repo.full_name.toLowerCase(), repo.full_name]));
  const events = sanitizeActivityEvents(input).filter(event => names.has(event.repository.toLowerCase()) && Date.parse(event.createdAt) <= reference);
  const youngest = events.length ? Math.min(...events.map(event => (reference - Date.parse(event.createdAt)) / 3600000)) : Infinity;
  const window = settings.activityWindow === 'auto' ? youngest <= 24 ? '1d' : youngest <= 168 ? '7d' : '30d' : settings.activityWindow;
  const byRepo = new Map();
  for (const event of events) {
    const ageHours = (reference - Date.parse(event.createdAt)) / 3600000;
    if (ageHours > windows[window]) continue;
    const name = names.get(event.repository.toLowerCase());
    if (!byRepo.has(name)) byRepo.set(name, { score: 0, eventCount: 0, pushCount: 0, pullRequestCount: 0, releaseCount: 0, latestEventAt: event.createdAt, ageHours, dominantEvent: event.kind, weights: {}, newRepository: false });
    const value = byRepo.get(name);
    value.eventCount++; value.pushCount += Number(event.kind === 'push'); value.pullRequestCount += Number(event.kind === 'pull-request'); value.releaseCount += Number(event.kind === 'release');
    value.newRepository ||= event.newRepository;
    value.weights[event.kind] = Math.min(6, (value.weights[event.kind] || 0) + eventWeights[event.kind] * recencyDecay(ageHours));
  }
  return { asOf: new Date(reference).toISOString(), window, repositories: Object.fromEntries([...byRepo].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
    const ranked = Object.entries(value.weights).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const { weights, ...data } = value;
    return [name, { ...data, score: Math.min(.98, 1 - Math.exp(-Math.min(12, ranked.reduce((sum, [, weight]) => sum + weight, 0)) / 3)), dominantEvent: ranked[0][0] }];
  })) };
}

export function activityForNode(id, snapshot) {
  const value = snapshot?.repositories?.[id];
  if (!value || !Number.isFinite(value.score) || value.score <= 0 || value.score > 1 || !Number.isInteger(value.eventCount) || value.eventCount < 1 || value.eventCount > 300 || !Number.isFinite(Date.parse(value.latestEventAt))) return null;
  return { score: value.score, eventCount: value.eventCount, latestEventAt: new Date(value.latestEventAt).toISOString(), dominantEvent: Object.hasOwn(eventWeights, value.dominantEvent) ? value.dominantEvent : 'push', newRepository: value.newRepository === true };
}
