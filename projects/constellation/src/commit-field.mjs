import { createRepositoryCommits } from './repository-commits.mjs';
import { seededRandom } from './seeded-random.mjs';

export const FIELD_COMMIT_LIMIT = 24;
export const FIELD_REPO_BATCH = 12;

export function createCommitFieldData(options) {
  const source = createRepositoryCommits(options), snapshots = {};
  return {
    snapshots,
    async load(repositories, { refresh = false, onProgress } = {}) {
      const access = options?.access || options?.fetchImpl?.access;
      if (access && !access.capabilities.commitActivity)
        return { snapshots, diagnostics: ['Sign in with GitHub to load commit activity.'] };
      const targets = repositories.filter(repo => repo.private !== true && (refresh || !snapshots[repo.full_name.toLowerCase()])).slice(0, FIELD_REPO_BATCH);
      const diagnostics = [];
      for (const [index, repo] of targets.entries()) {
        try { snapshots[repo.full_name.toLowerCase()] = await source.load(repo.full_name, { limit: FIELD_COMMIT_LIMIT, refresh }); }
        catch (error) { diagnostics.push(`${repo.full_name}: ${error.message}`); if (/limit reached/.test(error.message)) break; }
        onProgress?.(index + 1, targets.length);
      }
      return { snapshots, diagnostics };
    },
  };
}

export function sampleCommitField(repositories, reference) {
  return Object.fromEntries(repositories.filter(repo => repo.private !== true).map(repo => {
    const random = seededRandom(`commit-field:${repo.full_name}`);
    const commits = Array.from({ length: 5 + Math.floor(random() * 12) }, (_, i) => ({ sha: (i + 1).toString(16).padStart(40, '0'), author: ['Explorer', 'Navigator', 'Builder'][i % 3], login: null, date: new Date(reference - i * 86400000).toISOString(), subject: `Demo commit ${i + 1}` }));
    return [repo.full_name.toLowerCase(), { repository: repo.full_name, demo: true, commits }];
  }));
}
