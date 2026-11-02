// Test-only copy of the pre-Rust Recruiter Evidence implementation.
import { sanitizeActivityEvents } from '../../src/activity.mjs';

const DAY = 86400000;
const role = (repo, options) => options.projectShowcase?.[repo.full_name] || options.projectShowcase?.[repo.name] || {};
const key = value => String(value || '').toLowerCase();
const lookup = (values, id) => Object.entries(values || {}).find(([name]) => key(name) === key(id))?.[1];

export function oracleProjectEvidence(repo, options, account, reference) {
  const snapshot = key(options.commitHistoryData?.repository) === key(repo.full_name)
    ? options.commitHistoryData : lookup(options.commitFieldData, repo.full_name);
  const events = sanitizeActivityEvents(options.historyData?.events).filter(event => key(event.repository) === key(repo.full_name) && ['push', 'pull-request', 'release'].includes(event.kind) && Date.parse(event.createdAt) <= reference);
  const commits = (snapshot?.commits || []).filter(commit => Number.isFinite(Date.parse(commit.date)) && Date.parse(commit.date) <= reference);
  const dates = [...commits.map(commit => commit.date), ...events.map(event => event.createdAt)];
  const months = [...new Set(dates.map(date => new Date(date).toISOString().slice(0, 7)))].sort();
  const complete = snapshot?.partial === false && !snapshot.diagnostic;
  const push = Date.parse(repo.pushed_at);
  const latest = Math.max(Number.isFinite(push) && push <= reference ? push : 0, ...dates.map(Date.parse));
  const age = latest ? (reference - latest) / DAY : null;
  const band = age === null ? 2 : age < 30 ? 0 : age < 183 ? 1 : 2;
  const rows = lookup(options.organizationData?.records, repo.full_name);
  const logins = Array.isArray(rows) ? new Set(rows.map(row => key(row.login)).filter(Boolean)) : null;
  const others = logins ? [...logins].filter(login => login !== key(account)).length : null;
  const external = key(repo.full_name.split('/')[0]) !== key(account);
  const contributed = external && (logins?.has(key(account)) || commits.some(commit => key(commit.login) === key(account)) || events.some(event => ['push', 'pull-request'].includes(event.kind)));
  const quarter = date => new Date(date).getUTCFullYear() * 4 + Math.floor(new Date(date).getUTCMonth() / 3);
  const current = quarter(reference);
  const active = new Set(commits.map(commit => quarter(commit.date)));
  return { months: months.length, complete, band, latest, unknownRecency: age === null,
    radius: ({ featured: 29, supporting: 18, experimental: 11, historical: 11 })[role(repo, options).role] ?? 14,
    role: role(repo, options).role || 'unassigned',
    others, contributorPartial: others !== null && options.organizationData?.complete !== true,
    external, contributed, quarters: complete && commits.length ? Array.from({ length: 12 }, (_, i) => active.has(current - 11 + i)) : [],
    featured: role(repo, options).role === 'featured',
  };
}

export function oracleCompareRecruiterProjects(a, b, options) {
  const ranks = { featured: 0, supporting: 1, experimental: 2, historical: 3 };
  return (ranks[role(a, options).role] ?? 4) - (ranks[role(b, options).role] ?? 4)
    || (role(a, options).priority ?? 9999) - (role(b, options).priority ?? 9999)
    || (Date.parse(b.pushed_at) || 0) - (Date.parse(a.pushed_at) || 0)
    || a.full_name.localeCompare(b.full_name);
}

export function oracleAnalyzeRecruiterEvidence(repositories, options, account, reference) {
  return {
    projects: repositories.map(repo => oracleProjectEvidence(repo, options, account, reference)),
    order: [...repositories].sort((a, b) => oracleCompareRecruiterProjects(a, b, options)).map(repo => repo.full_name),
  };
}
