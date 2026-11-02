import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene, renderConstellation } from '../src/constellation.mjs';
import { loadAccountAvatar } from '../src/account-sun.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
import { encodeShare, decodeShare } from '../src/share-link.mjs';
import { renderWorkflow } from '../src/export.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
const repos = Array.from({ length: 10 }, (_, i) => ({ name: `r${i}`, full_name: `example/r${i}`, language: 'JavaScript' }));

test('account sun is decoration and never takes a node or reserved ring point', () => {
  for (const layout of ['atlas', 'compact']) {
    const options = { arrangement: 'rings', layout, hiddenNodes: ['example/r1'], ringRotations: [45, 90, 135, 180] };
    const base = createScene('example', repos, options);
    assert.doesNotMatch(renderConstellation('example', repos, options), /class="account-sun"/);
    for (const accountSun of ['sun', 'avatar']) {
      const settings = { ...options, accountSun, accountData: { avatarData: `data:image/png;base64,${png}` } };
      const scene = createScene('example', repos, settings);
      assert.deepEqual(scene.nodes, base.nodes);
      assert.deepEqual(scene.geometry.ringPoints, base.geometry.ringPoints);
      const svg = renderConstellation('example', repos, settings);
      assert.match(svg, new RegExp(`class="account-sun" data-mode="${accountSun}" transform="translate\\(450 ${layout === 'compact' ? 126 : 270}\\)"`));
      assert.match(svg, />@example<\/text>/);
      assert.equal(svg.includes('class="account-sun-avatar"'), accountSun === 'avatar');
    }
  }
});

test('sun choice survives configs, share links and workflow exports; avatar bytes stay out of config', () => {
  for (const accountSun of ['off', 'sun', 'avatar']) {
    const options = { accountSun, accountData: { avatarData: `data:image/png;base64,${png}` } };
    const json = serializeConfig('example', options);
    assert.equal(parseConfig(json).options.accountSun, accountSun);
    assert.doesNotMatch(json, /avatarData/);
    assert.equal(decodeShare(encodeShare('https://example.com/', 'example', options)).options.accountSun, accountSun);
    const workflow = renderWorkflow('example', options);
    assert.match(workflow, new RegExp(`"accountSun": "${accountSun}"`));
    assert.doesNotMatch(workflow, /avatarData/);
  }
  assert.throws(() => parseConfig({ accountSun: 'unknown' }), /accountSun/);
  assert.throws(() => createScene('example', repos, { accountSun: true }), /accountSun/);
});

test('avatars load once from the image CDN without credentials and fail to initials safely', async () => {
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(url, 'https://avatars.githubusercontent.com/sun-test?s=96');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers, undefined);
    return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
  };
  assert.equal(await loadAccountAvatar('Sun-test', { fetcher }), `data:image/png;base64,${png}`);
  await loadAccountAvatar('sun-test', { fetcher });
  assert.equal(calls, 1);
  assert.equal(await loadAccountAvatar('sun-failure', { fetcher: async () => { throw Error('offline'); } }), null);
  assert.equal(await loadAccountAvatar('sun-invalid', { fetcher: async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }) }), null);
  for (const avatarData of [undefined, 'https://example.com/avatar.png', 'data:image/svg+xml;base64,PHN2Zy8+']) {
    const svg = renderConstellation('example', repos, { accountSun: 'avatar', accountData: { avatarData } });
    assert.match(svg, /class="account-sun-initials"/);
    assert.doesNotMatch(svg, /class="account-sun-avatar"/);
  }
});
