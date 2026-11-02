export const organizationFields = ['accountType', 'organizationScope', 'organizationView', 'organization', 'contributorStrategy', 'organizationUser'];
export const organizationModes = ['contributors', 'ecosystem', 'organization-community', 'dependencies'];
export const organizationLayouts = ['community-galaxy', 'collaboration-gravity', 'era-rings'];
const choice = (value, values, name) => { if (!values.includes(value)) throw Error(`Invalid ${name}.`); return value; };
const limit = (value, max, name) => { if (!Number.isInteger(value) || value < 1 || value > max) throw Error(`${name} must be between 1 and ${max}.`); return value; };
export function organizationOptions(options = {}) {
  if (options.organizationUser !== undefined && !/^[a-z\d][a-z\d-]{0,38}$/i.test(options.organizationUser)) throw Error('organizationUser must be a GitHub username.');
  const org = options.organization ?? {};
  if (!org || typeof org !== 'object' || Array.isArray(org)) throw Error('organization must be an object.');
  const contributors = org.contributors ?? {}, grouping = org.grouping ?? {};
  for (const [value, fields] of [[org, ['contributors', 'grouping']], [contributors, ['enabled', 'strategy', 'maxRepositories', 'maxContributorsPerRepo']], [grouping, ['mode', 'pattern']]]) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw Error('Invalid organization settings.');
  }
  if (contributors.enabled !== undefined && typeof contributors.enabled !== 'boolean') throw Error('Contributors enabled must be boolean.');
  const result = {
    accountType: choice(options.accountType ?? 'auto', ['auto', 'user', 'organization'], 'accountType'),
    scope: choice(options.organizationScope ?? 'active', ['featured', 'recent', 'active', 'sample', 'all-metadata'], 'organizationScope'),
    view: choice(options.organizationView ?? 'projects', ['projects', 'community', 'collaboration', 'technology', 'history'], 'organizationView'),
    contributors: { enabled: contributors.enabled ?? true, strategy: choice(options.contributorStrategy ?? contributors.strategy ?? 'representative', ['off', 'featured', 'active', 'representative', 'deep'], 'contributor strategy'), maxRepositories: limit(contributors.maxRepositories ?? 100, 2000, 'maxRepositories'), maxContributorsPerRepo: limit(contributors.maxContributorsPerRepo ?? 25, 100, 'maxContributorsPerRepo') },
    grouping: { mode: choice(grouping.mode ?? 'auto', ['auto', 'year', 'prefix', 'topic', 'language', 'regex', 'none'], 'grouping mode'), pattern: grouping.pattern ?? '' },
  };
  if (result.grouping.mode === 'regex') groupingRegex(result.grouping.pattern);
  return result;
}
// A deliberately small, linear subset: anchored literals, named captures,
// character classes, and single-character repetitions. No nested expressions.
export function groupingRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 180 || !pattern.startsWith('^')) throw Error('Grouping pattern must start with ^ and be at most 180 characters.');
  const stripped = pattern.replace(/\(\?<([a-zA-Z][a-zA-Z0-9_]*)>([^()]*)\)/g, '$2');
  if (/[()|]/.test(stripped) || /\\[1-9]|\.\*|\.\+|[+*?}]\s*[+*?{]/.test(stripped) || /\{/.test(stripped)) throw Error('Use simple named captures and character classes for grouping.');
  if ((stripped.match(/[+*?]/g) || []).length > 6 || /[+*?](?![-_. /:$]|$)/.test(stripped)) throw Error('Separate repeated captures with literal delimiters.');
  try { return new RegExp(pattern); } catch { throw Error('Invalid grouping pattern.'); }
}
export function organizationEnabled(options = {}) { return options.accountType === 'organization' || (options.accountType !== 'user' && options.accountData?.type === 'Organization'); }
export function needsContributorData(options = {}) { return options.nodeMode !== 'commits' && (organizationEnabled(options) || ['contributors', 'ecosystem', 'organization-community'].includes(options.nodeMode)); }
export function organizationNodeMode(options) {
  if (organizationModes.includes(options.nodeMode)) return options.nodeMode;
  return ({ community: 'contributors', collaboration: 'ecosystem', technology: 'technology', history: 'eras' })[organizationOptions(options).view] || options.nodeMode || 'repositories';
}
