// Deterministic GitHub API fixtures. Every account shape a first-time visitor
// can hit is modelled here so journeys never depend on the live network.

const LANGUAGES = ['TypeScript', 'Rust', 'JavaScript', 'Python', 'Go', 'HTML', 'CSS', 'Shell'];
const TOPICS = [['web', 'ui'], ['cli', 'tools'], ['graphics'], ['data', 'ml'], ['game'], ['docs'], [], ['api']];
const NAMES = [
  'aurora-ui', 'comet-cli', 'nebula-db', 'orbit-router', 'pulsar-charts', 'quasar-api',
  'stellar-docs', 'meteor-game', 'galaxy-notes', 'lunar-shell', 'solar-kit', 'cosmos-ml',
  'zenith-forms', 'vega-maps', 'nova-blog', 'aster-sync',
];

export function repository(owner, index, overrides = {}) {
  const name = overrides.name || (index < NAMES.length ? NAMES[index] : `project-${index + 1}`);
  const year = 2018 + (index % 8);
  return {
    id: 1000 + index,
    name,
    full_name: `${owner}/${name}`,
    html_url: `https://github.com/${owner}/${name}`,
    description: `A fixture project about ${name.replace(/-/g, ' ')}.`,
    language: LANGUAGES[index % LANGUAGES.length],
    topics: TOPICS[index % TOPICS.length],
    stargazers_count: Math.max(0, 120 - index * 7),
    forks_count: index % 5,
    watchers_count: index % 9,
    open_issues_count: index % 4,
    size: 400 + index * 30,
    fork: false,
    archived: index === 11,
    private: false,
    owner: { login: owner, type: 'User' },
    created_at: `${year}-0${(index % 9) + 1}-15T12:00:00Z`,
    updated_at: `2026-0${(index % 9) + 1}-20T12:00:00Z`,
    pushed_at: `2026-0${(index % 9) + 1}-20T12:00:00Z`,
    default_branch: 'main',
    homepage: index % 3 === 0 ? `https://${name}.example.com` : null,
    ...overrides,
  };
}

export const accounts = {
  typical: { login: 'octo-sky', type: 'User', repos: 16 },
  tiny: { login: 'tiny-sky', type: 'User', repos: 2 },
  large: { login: 'big-sky', type: 'User', repos: 100 },
  empty: { login: 'empty-sky', type: 'User', repos: 0 },
  org: { login: 'sky-org', type: 'Organization', repos: 24 },
};

const profile = account => ({
  login: account.login,
  id: 42,
  type: account.type,
  name: account.type === 'User' ? 'Octo Sky' : 'Sky Org',
  avatar_url: '',
  html_url: `https://github.com/${account.login}`,
  public_repos: account.repos,
  followers: 12,
  following: 3,
  created_at: '2017-04-01T00:00:00Z',
});

const json = (route, status, body, headers = {}) => route.fulfill({
  status,
  contentType: 'application/json',
  headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '55', 'x-ratelimit-reset': '4102444800', ...headers },
  body: JSON.stringify(body),
});

/**
 * Stub every api.github.com request for the page.
 * mode: 'ok' | 'rate-limited' | 'offline'
 * Unknown logins return 404 so "user not found" is exercisable.
 */
export async function stubGitHub(page, { mode = 'ok', log = [] } = {}) {
  await page.route('https://api.github.com/**', async route => {
    const url = new URL(route.request().url());
    log.push(url.pathname + url.search);
    if (mode === 'offline') return route.abort('internetdisconnected');
    if (mode === 'rate-limited') {
      return json(route, 403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
    }
    const match = /^\/(users|orgs)\/([^/]+)(\/repos|\/events(?:\/public)?)?$/.exec(url.pathname);
    const account = match && Object.values(accounts).find(a => a.login.toLowerCase() === match[2].toLowerCase());
    if (match && !account) return json(route, 404, { message: 'Not Found' });
    if (match && !match[3]) return json(route, 200, profile(account));
    if (match && match[3] === '/repos') {
      const page = Number(url.searchParams.get('page') || 1);
      const per = Number(url.searchParams.get('per_page') || 30);
      const all = Array.from({ length: account.repos }, (_, i) => repository(account.login, i));
      return json(route, 200, all.slice((page - 1) * per, page * per));
    }
    if (match) return json(route, 200, []);
    const repo = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (repo && repo[3] === '/languages') return json(route, 200, { TypeScript: 6000, CSS: 900 });
    if (repo && !repo[3]) return json(route, 200, repository(repo[1], 0, { name: repo[2] }));
    return json(route, 200, []);
  });
  // Avatars never hit the network. Page navigations to github.com (sign-in,
  // "Open on GitHub") are left alone so tests can observe them.
  await page.route(/https:\/\/avatars\.githubusercontent\.com\/.*/, route => route.fulfill({ status: 204, body: '' }));
  await page.route(/https:\/\/github\.com\/.*/, route => route.request().isNavigationRequest() ? route.abort('aborted') : route.fulfill({ status: 204, body: '' }));
  return log;
}
