import { updatedTime } from './repository-filters.mjs';

export const sizingModes = ['legacy', 'uniform', 'stars', 'activity', 'age', 'languages', 'topics', 'membership'];

// Absolute logarithmic bounds keep a single outlier from shrinking every other node.
export function boundedSize(value, ceiling = 10000) {
  return 2.7 + 3.3 * Math.min(1, Math.log1p(Math.max(0, Number.isFinite(value) ? value : 0)) / Math.log1p(ceiling));
}

export function nodeRadius(node, mode = 'legacy', now) {
  if (!sizingModes.includes(mode)) throw new Error('Invalid node sizing mode.');
  if (['age', 'activity'].includes(mode) && !Number.isFinite(now)) throw new Error('Temporal node sizing requires a reference date.');
  if (mode === 'legacy') return 2.7 + Math.min(3.3, Math.log2((node.stargazers_count || 0) + 1) / 2);
  if (mode === 'uniform') return 4;
  const category = node.nodeKind && node.nodeKind !== 'repository';
  if (category) return boundedSize(node.members?.length || 0, 100);
  if (mode === 'stars') return boundedSize(node.stargazers_count || 0);
  if (mode === 'activity') {
    const timestamp = updatedTime(node);
    return timestamp ? 2.7 + 3.3 / (1 + Math.max(0, now - timestamp) / (180 * 86400000)) : 2.7;
  }
  if (mode === 'age') return boundedSize(node.created_at ? Math.max(0, now - (Date.parse(node.created_at) || now)) / 86400000 : 0, 3652.5);
  if (mode === 'languages') return boundedSize(node.languages ? Object.values(node.languages).filter(bytes => bytes > 0).length : node.language ? 1 : 0, 15);
  if (mode === 'topics') return boundedSize(node.topics?.length || 0, 20);
  return 4;
}
