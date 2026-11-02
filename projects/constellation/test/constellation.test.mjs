import test from 'node:test';
import assert from 'node:assert/strict';
import { username, fetchRepositories, renderConstellation } from '../src/constellation.mjs';
const repo = { name: 'hello', full_name: 'octocat/hello', language: 'JavaScript', stargazers_count: 8 };
test('moving stars updates connections and bridges while retaining manually placed labels', () => {
  const repos = [repo, { ...repo, name: 'world', full_name: 'octocat/world', language: 'CSS', languages: { JavaScript: 10, CSS: 20 } }];
  for (const layout of ['atlas', 'compact']) {
    const options = { layout, bridges: true, starPositions: { 'octocat/hello': { x: 200, y: 100 }, 'octocat/world': { x: 700, y: 180 } }, labelPositions: { 'octocat/hello': { x: 300, y: 50 } } };
    const svg = renderConstellation('octocat', repos, options);
    assert.equal(svg, renderConstellation('octocat', [...repos].reverse(), options));
    assert.match(svg, /class="star" cx="200.0" cy="100.0"/);
    assert.match(svg, /class="star" cx="700.0" cy="180.0"/);
    const edge = [...svg.matchAll(/class="shared-language"[^>]* d="M([\d.]+) ([\d.]+)Q[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/g)];
    assert.equal(edge.length, 1);
    assert.deepEqual(new Set([edge[0].slice(1, 3).join(','), edge[0].slice(3, 5).join(',')]), new Set(['200.0,100.0', '700.0,180.0']));
    assert.match(svg, /d="M(?:200.0 100.0L700.0 180.0|700.0 180.0L200.0 100.0)"><title>Visual bridge/);
    assert.match(svg, /data-repo="octocat\/hello" x="300.0" y="50.0"/);
    const bounded = renderConstellation('octocat', [repo], { layout, starPositions: { 'octocat/hello': { x: -500, y: 10000 } } });
    assert.match(bounded, new RegExp(`class="star" cx="32.0" cy="${layout === 'compact' ? 220 : 500}.0"`));
  }
  for (const starPositions of [[], 'bad', { 'octocat/hello': null }, { 'octocat/hello': { x: NaN, y: 2 } }]) {
    assert.throws(() => renderConstellation('octocat', [repo], { starPositions }), /starPositions/);
  }
});

test('manual label positions survive repository ordering and are validated and bounded', () => {
  const other = { ...repo, name: 'world', full_name: 'octocat/world' };
  for (const layout of ['atlas', 'compact']) {
    const options = { layout, labelPositions: { 'octocat/hello': { x: 120.5, y: 100 } } };
    const svg = renderConstellation('octocat', [repo, other], options);
    assert.match(svg, /data-repo="octocat\/hello" x="120.5" y="100.0"/);
    assert.equal(svg, renderConstellation('octocat', [other, repo], options));
    const bounded = renderConstellation('octocat', [repo], { layout, labelPositions: { 'octocat/hello': { x: -100, y: 10000 } } });
    assert.match(bounded, new RegExp(`data-repo="octocat/hello" x="48.0" y="${layout === 'compact' ? 237 : 517}.0"`));
  }
  for (const labelPositions of [[], 'bad', { 'octocat/hello': null }, { 'octocat/hello': { x: Infinity, y: 2 } }]) {
    assert.throws(() => renderConstellation('octocat', [repo], { labelPositions }), /labelPositions/);
  }
});
test('accepts usernames and profile URLs, rejects paths and markup', () => {
  assert.equal(username(' https://github.com/octocat/ '), 'octocat');
  assert.equal(username('@octocat'), 'octocat');
  for (const input of ['', 'octocat/repo', '<script>', 'https://evil.test/a']) assert.throws(() => username(input));
});
test('paginates public data and forwards token only in the header', async () => {
  const calls = [];
  const result = await fetchRepositories('octocat', { token: 'secret', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => calls.length === 1 ? Array(100).fill(repo) : [{ ...repo, private: true }] };
  }});
  assert.equal(result.length, 100);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /page=2/);
  assert.ok(!calls[0].url.includes('secret'));
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
});
test('API failures fail generation instead of replacing it with empty data', async () => {
  for (const status of [404, 403, 429, 500]) await assert.rejects(fetchRepositories('octocat', { fetchImpl: async () => ({ status, ok: false }) }));
});
test('SVG is deterministic, escapes content, and respects styling and reduced motion', () => {
  const malicious = { ...repo, name: '<script>&', full_name: 'octocat/<script>', language: '<x>' };
  const svg = renderConstellation('octocat', [malicious], { css: '</style><script>x</script>' });
  assert.ok(!svg.includes('<script>'));
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /prefers-reduced-motion/);
  assert.equal(renderConstellation('octocat', [repo]), renderConstellation('octocat', [repo]));
  assert.ok(!renderConstellation('octocat', [repo], { animate: false }).includes('animation:twinkle'));
  assert.throws(() => renderConstellation('octocat', [repo], { colors: { accent: 'red;}</style>' } }));
});
test('filters private repos and forks and handles empty accounts', () => {
  const svg = renderConstellation('octocat', [{ ...repo, private: true }, { ...repo, fork: true }], { includeForks: false });
  assert.match(svg, /No projects match these filters or historical year/);
  assert.match(svg, /0 public repositories/);
  assert.match(renderConstellation('octocat', []), /No public repositories to show yet/);
  assert.match(renderConstellation('octocat', [{ ...repo, private: true }]), /No public repositories to show yet/);
});

test('all shared-language edges include secondary languages across primary groups', () => {
  const repos = [
    { ...repo, name: 'js-app', full_name: 'octocat/js-app', language: 'JavaScript', languages: { JavaScript: 100, HTML: 40, CSS: 20 } },
    { ...repo, name: 'html-site', full_name: 'octocat/html-site', language: 'HTML', languages: { HTML: 100, CSS: 50, JavaScript: 10 } },
    { ...repo, name: 'css-kit', full_name: 'octocat/css-kit', language: 'CSS', languages: { CSS: 100 } },
    { ...repo, name: 'rust-app', full_name: 'octocat/rust-app', language: 'Rust', languages: { Rust: 100 } },
    { ...repo, name: 'empty', full_name: 'octocat/empty', language: 'JavaScript', languages: {} },
  ];
  const svg = renderConstellation('octocat', repos, { connectionDensity: 'all' });
  assert.equal(svg, renderConstellation('octocat', [...repos].reverse(), { connectionDensity: 'all' }));
  const edges = [...svg.matchAll(/class="shared-language" data-from="([^"]+)" data-to="([^"]+)" data-languages="([^"]+)"/g)];
  assert.equal(edges.length, 3);
  assert.ok(edges.some(([, , , shared]) => shared === 'CSS, HTML, JavaScript'));
  for (const [, from, to, shared] of edges) {
    assert.ok(![from, to].some(name => name.endsWith('/empty') || name.endsWith('/rust-app')));
    const a = repos.find(repo => repo.full_name === from), b = repos.find(repo => repo.full_name === to);
    assert.deepEqual(shared.split(', '), Object.keys(a.languages).filter(language => b.languages[language] > 0).sort());
  }
  assert.ok(!svg.includes('<title>Visual bridge:'));
});

test('balanced connections are bounded while all mode includes every real pair', () => {
  const repos = Array.from({ length: 30 }, (_, i) => ({ ...repo, name: `repo-${i}`, full_name: `octocat/repo-${i}`, languages: { JavaScript: 100, CSS: 10 } }));
  const count = options => [...renderConstellation('octocat', repos, options).matchAll(/class="shared-language"/g)].length;
  assert.equal(count({ connectionDensity: 'all' }), 30 * 29 / 2);
  assert.ok(count({}) <= 30 * 4);
  assert.throws(() => renderConstellation('octocat', repos, { connectionDensity: 'invalid' }));
});

test('dense charts keep every star inside the chart bounds', () => {
  for (const languageCount of [1, 2, 5, 20, 100]) {
    const repos = Array.from({ length: 100 }, (_, i) => ({ ...repo, name: `repo-${i}`, full_name: `octocat/repo-${i}`, language: `Language-${i % languageCount}` }));
    const svg = renderConstellation('octocat', repos, { maxRepos: 100 });
    const stars = [...svg.matchAll(/class="star" cx="([\d.]+)" cy="([\d.]+)"/g)];
    assert.equal(stars.length, 100);
    for (const [, x, y] of stars) assert.ok(+x >= 32 && +x <= 868 && +y >= 30 && +y <= 490);
    assert.ok(!/NaN|Infinity/.test(svg));
  }
});

test('compact selection stays private-safe and escapes custom titles', () => {
  const repositories = [repo, { ...repo, name: 'private', private: true }, { ...repo, name: 'fork', fork: true }, { ...repo, name: 'unselected' }];
  const svg = renderConstellation('octocat', repositories, { layout: 'compact', title: '<my & sky>', includeRepos: ['hello', 'private', 'fork'], includeForks: false });
  assert.match(svg, /viewBox="0 0 900 280"/);
  assert.match(svg, /1 public repositories/);
  assert.match(svg, /&lt;my &amp; sky&gt;/);
  assert.equal([...svg.matchAll(/<g class="repository">/g)].length, 1);
  assert.ok(svg.includes('<text class="repo-label"'));
  assert.ok(!svg.includes('unselected'));
  const empty = renderConstellation('octocat', [], { layout: 'compact' });
  assert.match(empty, /y="140" text-anchor="middle">No public/);
  assert.ok(!empty.includes('${'));
  assert.throws(() => renderConstellation('octocat', [], { layout: 'invalid' }));
  assert.throws(() => renderConstellation('octocat', [], { includeRepos: 'hello' }));
});

test('compact charts place stars and language labels within the chart at every density', () => {
  for (const languageCount of [1, 4, 12, 100]) {
    const repositories = Array.from({ length: 100 }, (_, i) => ({ ...repo, name: `repo-${i}`, full_name: `octocat/repo-${i}`, language: `L${i % languageCount}` }));
    const svg = renderConstellation('octocat', repositories, { layout: 'compact', maxRepos: 100 });
    for (const [, x, y] of svg.matchAll(/class="star" cx="([\d.]+)" cy="([\d.]+)"/g)) assert.ok(+x >= 32 && +x <= 868 && +y >= 20 && +y < 242);
    for (const [, x, y] of svg.matchAll(/class="language"><text x="([\d.]+)" y="([\d.]+)"/g)) assert.ok(+x >= 32 && +x <= 868 && +y >= 20 && +y < 242);
  }
});

test('visual bridges join all language regions using actual repository endpoints', () => {
  const repositories = Array.from({ length: 16 }, (_, i) => ({ ...repo, name: `repo-${i}`, full_name: `octocat/repo-${i}`, language: `L${i % 4}` }));
  const svg = renderConstellation('octocat', repositories, { layout: 'compact', bridges: true });
  const stars = new Map([...svg.matchAll(/<g class="repository"><title>(.*?) ·.*?<circle class="star" cx="([\d.]+)" cy="([\d.]+)"/g)].map(([, name, x, y]) => [`${x},${y}`, repositories.find(repo => repo.full_name === name).language]));
  const parent = new Map(['L0', 'L1', 'L2', 'L3'].map(language => [language, language]));
  const root = language => parent.get(language) === language ? language : root(parent.get(language));
  const bridges = [...svg.matchAll(/<path d="M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)"><title>Visual bridge/g)];
  assert.equal(bridges.length, 3);
  for (const [, x1, y1, x2, y2] of bridges) {
    const from = stars.get(`${x1},${y1}`), to = stars.get(`${x2},${y2}`);
    assert.ok(from && to);
    assert.notEqual(root(from), root(to));
    parent.set(root(from), root(to));
  }
  assert.equal(new Set([...parent.keys()].map(root)).size, 1);
  assert.match(svg, /dotted bridges join nearby groups/);
  const unbridged = renderConstellation('octocat', repositories, { bridges: false });
  assert.ok(!unbridged.includes('<title>Visual bridge:'));
  assert.ok(!unbridged.includes('dotted: visual bridge'));
});
