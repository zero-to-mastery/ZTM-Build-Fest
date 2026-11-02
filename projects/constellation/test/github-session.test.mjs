import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubSession } from '../src/github-session.mjs';
import { createPreviewFetch, createPinnedFetch } from '../src/preview-data.mjs';

test('session validates identity, confines credentials to GitHub and clears rejected credentials', async () => {
  const calls = [], changes = []; let reject = false;
  const session = createGitHubSession({ onChange: value => changes.push(value), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ login: 'alice' }, { status: reject ? 401 : 200 });
  } });
  assert.deepEqual(await session.signIn('  test-token  '), { login: 'alice' });
  const preview = createPreviewFetch({ proxyBase: '/api/github', session });
  await preview('https://api.github.com/users/alice');
  assert.equal(calls.at(-1).options.headers.get('Authorization'), 'Bearer test-token');
  assert.equal(calls.at(-1).options.redirect, 'error');
  await session.fetch('https://example.com/data', { headers: { Authorization: 'Bearer test-token' } });
  assert.equal(calls.at(-1).options.headers.get('Authorization'), null);
  reject = true;
  await session.fetch('https://api.github.com/user');
  assert.equal(session.token, ''); assert.equal(session.profile, null);
  assert.deepEqual(changes, [{ login: 'alice' }, null]);
  await assert.rejects(session.signIn('bad-token'), /rejected/);
  assert.equal(session.token, '');
  await session.fetch('https://api.github.com/graphql', { headers: { Authorization: 'Bearer stale-token' } });
  assert.equal(calls.at(-1).options.headers.get('Authorization'), null);
});

test('sign-out and cancellation cannot be undone by a pending sign-in', async () => {
  for (const action of ['signOut', 'cancelSignIn']) {
    let resolve;
    const session = createGitHubSession({ fetchImpl: () => new Promise(done => { resolve = done; }) });
    const pending = session.signIn('test-token'); session[action]();
    resolve(Response.json({ login: 'alice' }));
    assert.equal(await pending, null); assert.equal(session.token, '');
  }
});

test('hosted pinned previews use the signed-in session without a local proxy', async () => {
  const calls = [];
  const session = createGitHubSession({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/user') ? { login: 'alice' } : { data: { repositoryOwner: { pinnedItems: { nodes: [], pageInfo: { hasNextPage: false } } } } });
  } });
  await session.signIn('test-token');
  assert.deepEqual(await createPinnedFetch({ session })('alice'), []);
  assert.equal(calls.at(-1).url, 'https://api.github.com/graphql');
  assert.equal(calls.at(-1).options.headers.get('Authorization'), 'Bearer test-token');
  session.signOut();
  await assert.rejects(createPinnedFetch({ session })('alice'), /Continue with GitHub/);
});
