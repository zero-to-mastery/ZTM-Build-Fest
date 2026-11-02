import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

test('public URL paths support IDNA without deprecated Node APIs', () => {
  const code = `
    import assert from 'node:assert/strict';
    import { jsonFeedSource } from './src/json-feed-source.mjs';
    import { username } from './src/constellation.mjs';
    import { repositoryName } from './src/repository-commits.mjs';
    let requested;
    const fetchImpl = async url => { requested = url; return Response.json([]); };
    await jsonFeedSource.load({ options: {url:'https://bücher.example/projects?q=space'}, fetchImpl });
    assert.equal(requested, 'https://xn--bcher-kva.example/projects?q=space');
    for (const url of ['https://[broken', 'javascript:alert(1)', 'not a URL'])
      await assert.rejects(jsonFeedSource.load({options:{url},fetchImpl}));
    assert.equal(username('https://github.com/octocat/'), 'octocat');
    assert.equal(repositoryName('https://github.com/octocat/hello-world/'), 'octocat/hello-world');
    for (const url of ['https://github.com.evil/octocat','https://github.com@evil/octocat','https://gíthub.com/octocat']) assert.throws(()=>username(url));
    assert.throws(()=>repositoryName('https://github.com/a/b/c'));
  `;
  const result = spawnSync(process.execPath, ['--throw-deprecation', '--trace-deprecation', '--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /DEP0040|punycode/i);
});

test('owned Actions and generated workflows use maintained action runtimes', async () => {
  for (const file of ['action.yml', '.github/workflows/test.yml', '.github/workflows/constellation.yml', 'src/export.mjs']) {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /actions\/(?:setup-node|checkout)@v[1-4]\b/);
    assert.doesNotMatch(source, /no-deprecation|NODE_NO_WARNINGS/);
  }
});
