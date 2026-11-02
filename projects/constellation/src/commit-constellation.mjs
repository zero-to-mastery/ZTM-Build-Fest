import { repositoryName } from './repository-commits.mjs';
import { commitGraph } from './commit-graph.mjs';

export function commitHistoryOptions(options = {}) {
  const value = options.commitHistory;
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['repository', 'branch', 'author'].includes(key))) throw Error('Invalid commit history settings.');
  const repository = repositoryName(value.repository), branch = value.branch ?? '', author = value.author ?? '';
  if (typeof branch !== 'string' || branch.length > 200 || /[\x00-\x1f]/.test(branch) || typeof author !== 'string' || author.length > 100 || /[\x00-\x1f]/.test(author)) throw Error('Invalid commit branch or author.');
  return { repository, branch, author };
}

export function commitConstellation(options = {}) {
  const settings = commitHistoryOptions(options), snapshot = options.commitHistoryData;
  const empty = { nodes: [], edges: [], total: 0, repositoryCount: settings ? 1 : 0, commits: true };
  if (!settings || !snapshot || snapshot.repository.toLowerCase() !== settings.repository.toLowerCase() || (settings.branch && snapshot.branch !== settings.branch)) return { ...empty, emptyMessage: 'Choose a repository and show its commits as a constellation.' };
  const graph = commitGraph(snapshot);
  const highlighted = graph.contributors.some(person => person.key === settings.author) ? settings.author : '';
  const limit = Math.min(options.nodeCap ?? 256, 256);
  const chosen = graph.nodes.slice(0, limit), ids = new Set(chosen.map(commit => commit.sha));
  const id = sha => `commit:${snapshot.repository.toLowerCase()}:${sha}`;
  const nodes = chosen.map(commit => ({ full_name: id(commit.sha), name: commit.sha.slice(0, 7), nodeKind: 'commit',
    language: commit.author, members: [snapshot.repository], stargazers_count: 1, commitColor: commit.color,
    commit: { repository: snapshot.repository, sha: commit.sha, author: commit.author, login: commit.login, subject: commit.subject, date: commit.date, parents: commit.parents.length, key: commit.key },
    commitOpacity: highlighted && highlighted !== commit.key ? .2 : 1,
  }));
  const edges = chosen.flatMap(commit => commit.parents.filter(parent => ids.has(parent)).map(parent => ({ from: id(commit.sha), to: id(parent), members: ['Commit ancestry'], strength: 1 })));
  const boundary = chosen.reduce((count, commit) => count + commit.parents.filter(parent => !ids.has(parent)).length, 0);
  const note = `${snapshot.repository} · ${snapshot.branch} · ${nodes.length} of ${graph.nodes.length} loaded commits · ${new Set(chosen.map(commit => commit.key)).size} authors. Each star is a commit; lines connect commits to their parents, including merges. Colors identify authors.${snapshot.partial || boundary || chosen.length < graph.nodes.length ? ` Partial view; ${boundary} parent connections continue beyond these stars.` : ''}${settings.author ? ' One author is highlighted.' : ''}${snapshot.diagnostic ? ' ' + snapshot.diagnostic : ''}`;
  return { nodes, edges, total: graph.nodes.length, repositoryCount: 1, commits: true, note, emptyMessage: nodes.length ? undefined : 'This repository has no commits in the selected history.' };
}
