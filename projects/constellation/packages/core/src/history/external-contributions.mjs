import { sanitizeActivityEvents } from '../activity.mjs';
const ranks = { 'merged-pr': 5, 'pull-request': 4, push: 3, release: 2, issue: 1, comment: .5 };
export function externalContributions(account, snapshot, reference, settings) {
  if (!snapshot || snapshot.diagnostic) return [];
  const groups = new Map();
  for (const event of sanitizeActivityEvents(snapshot.events)) {
    if (event.repository.split('/')[0].toLowerCase() === account.toLowerCase() || Date.parse(event.createdAt) > reference) continue;
    const kind = event.kind === 'pull-request' && event.merged ? 'merged-pr' : event.kind;
    if (!ranks[kind]) continue;
    const minimum = settings.minimumContribution;
    if (minimum === 'merged-pr' && kind !== minimum || minimum === 'pr' && !['merged-pr', 'pull-request'].includes(kind) || minimum === 'code' && !['merged-pr', 'pull-request', 'push', 'release'].includes(kind) || minimum === 'issue' && kind === 'comment') continue;
    const key = event.repository.toLowerCase();
    const value = groups.get(key) || { repository: key, count: 0, weight: 0, kinds: new Set(), latest: event.createdAt };
    value.count++; value.weight = Math.min(20, value.weight + ranks[kind]); value.kinds.add(kind);
    groups.set(key, value);
  }
  return [...groups.values()].sort((a, b) => b.weight - a.weight || b.latest.localeCompare(a.latest) || a.repository.localeCompare(b.repository)).slice(0, settings.limit).map(value => ({ ...value, kinds: [...value.kinds].sort() }));
}
