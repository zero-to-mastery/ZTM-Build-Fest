import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function worker({ failPath, offline = false, release = '0.38.2' } = {}) {
  const listeners = new Map(); const stored = new Map([['kin-static-v0.38.1', new Map([['/index.html', new Response('old')]])]]);
  const clients = [{ postMessage() {} }];
  const claims = [];
  const cacheApi = {
    async open(name) { if (!stored.has(name)) stored.set(name, new Map()); const entries = stored.get(name); return { async put(key, value) { entries.set(key, value); }, async match(key) { return entries.get(key); }, async delete(key) { return entries.delete(key); } }; },
    async keys() { return [...stored.keys()]; }, async delete(name) { return stored.delete(name); },
  };
  const self = { registration: { active: true }, clients: { async matchAll() { return clients; }, async claim() { claims.push(Date.now()); } }, location: { origin: 'https://kin.test', href: `https://kin.test/service-worker.js?v=${encodeURIComponent(release)}` }, addEventListener(type, callback) { listeners.set(type, callback); }, async skipWaiting() {} };
  const context = { self, caches: cacheApi, URL, Response, Promise, crypto, File, Date, fetch: async (request) => { const path = typeof request === 'string' ? request : new URL(request.url).pathname; if (offline || path === failPath) throw new Error('offline'); return new Response(`asset:${path}`); } };
  vm.runInNewContext(await readFile(new URL('./service-worker.js', import.meta.url), 'utf8'), context);
  return { listeners, stored, claims };
}

test('complete new shell stages all assets while retaining prior cache until activation', async () => {
  const { listeners, stored } = await worker(); let install;
  listeners.get('install')({ waitUntil(value) { install = value; } }); await install;
  const next = stored.get('kin-static-v0.38.2'); assert.ok(next.has('/reminders.js')); assert.ok(next.has('/wasm/kin_engine.wasm'));
  assert.ok(next.has('/components/kin-quick-add.js'), 'the complete imported application shell is cached');
  assert.ok(stored.has('kin-static-v0.38.1'));
  let activation; listeners.get('activate')({ waitUntil(value) { activation = value; } }); await activation;
  assert.deepEqual([...stored.keys()], ['kin-static-v0.38.2']);
});

test('the shell caches every module statically imported from the app entry point', async () => {
  const { listeners, stored } = await worker(); let install;
  listeners.get('install')({ waitUntil(value) { install = value; } }); await install;
  const cached = stored.get('kin-static-v0.38.2');
  const root = new URL('./', import.meta.url);
  const pending = ['/components/kin-app.js'], seen = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    assert.ok(cached.has(path), `${path} is imported by the app but missing from the offline shell`);
    const source = await readFile(new URL(`.${path}`, root), 'utf8');
    for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']|^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm).map((match) => [match[0], match[1] ?? match[2]])) {
      pending.push(new URL(specifier, `https://kin.test${path}`).pathname);
    }
  }
  assert.ok(seen.has('/recurrence.js'), 'repeating-task presentation is part of the shell');
  assert.ok(seen.size > 20);
});

test('failed shell staging leaves the known-good cache available', async () => {
  const { listeners, stored } = await worker({ failPath: '/index.html' }); let install;
  listeners.get('install')({ waitUntil(value) { install = value; } }); await assert.rejects(install);
  assert.ok(stored.has('kin-static-v0.38.1'));
  assert.ok(!stored.has('kin-static-v0.38.2'));
});

test('manifest declares an installable local app shell', async () => {
  const manifest = JSON.parse(await readFile(new URL('./manifest.webmanifest', import.meta.url), 'utf8'));
  for (const key of ['name', 'short_name', 'description', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'icons']) assert.ok(manifest[key], key);
  assert.ok(manifest.icons.every(icon => icon.src.startsWith('/')));
});

test('offline navigation falls back to the shell and API requests bypass the worker', async () => {
  const { listeners, stored } = await worker({ offline: true });
  stored.set('kin-static-v0.38.2', new Map([['/index.html', new Response('offline-shell')]]));
  let response; let called = false;
  listeners.get('fetch')({ request: { method: 'GET', url: 'https://kin.test/', mode: 'navigate' }, respondWith(value) { called = true; response = value; } });
  assert.equal((await response).status, 200); assert.equal(await (await response).text(), 'offline-shell');
  called = false;
  listeners.get('fetch')({ request: { method: 'GET', url: 'https://kin.test/api/status', mode: 'cors' }, respondWith() { called = true; } });
  assert.equal(called, false);
});

test('a fingerprinted release stages its own cache and rejects malformed metadata', async () => {
  const { listeners, stored } = await worker({ release: '0.38.2+abc123def456' }); let install;
  await listeners.get('install')({ waitUntil(promise) { install = promise; } }); await install;
  assert.ok(stored.has('kin-static-v0.38.2+abc123def456'), 'cache name carries the build fingerprint');
  await assert.rejects(worker({ release: '0.38.2+not valid!' }), /release is missing/);
  await assert.rejects(worker({ release: '0.38.2-rc1' }), /release is missing/);
});

test('the manifest and install icons are never cached and always come from the network (#78)', async () => {
  const { listeners, stored } = await worker(); let install;
  listeners.get('install')({ waitUntil(value) { install = value; } }); await install;
  const cached = stored.get('kin-static-v0.38.2');
  assert.ok(!cached.has('/manifest.webmanifest'), 'the household-specific manifest is not in the shell');
  assert.ok(![...cached.keys()].some((key) => key.startsWith('/install-icon/')));
  assert.ok(cached.has('/icon.svg'), "Kin's own icon stays in the shell");
  for (const path of ['/manifest.webmanifest', '/install-icon/192.png?v=3', '/install-icon/apple-180.png']) {
    let handled = false;
    listeners.get('fetch')({ request: { method: 'GET', url: `https://kin.test${path}`, mode: 'cors' }, respondWith() { handled = true; } });
    assert.equal(handled, false, `${path} passes through to the network`);
  }
});

test('every manifest icon is in the offline shell, and every shortcut opens offline (#473)', async () => {
  const manifest = JSON.parse(await readFile(new URL('./manifest.webmanifest', import.meta.url), 'utf8'));
  const { listeners, stored } = await worker(); let install;
  listeners.get('install')({ waitUntil(value) { install = value; } }); await install;
  const cached = stored.get('kin-static-v0.38.2');
  const icons = [...manifest.icons, ...manifest.shortcuts.flatMap((shortcut) => shortcut.icons)].map((icon) => icon.src);
  assert.ok(icons.length > 10);
  for (const src of icons) assert.ok(cached.has(src), `${src} is cached`);
  const offline = await worker({ offline: true });
  const shell = new Response('offline-shell');
  offline.stored.set('kin-static-v0.38.2', new Map([['/index.html', shell]]));
  for (const { url } of manifest.shortcuts) {
    let response;
    offline.listeners.get('fetch')({ request: { method: 'GET', url: new URL(url, 'https://kin.test').href, mode: 'navigate' }, respondWith(value) { response = value; } });
    assert.equal(await response, shell, `${url} opens the shell offline`);
  }
});

test('a push always shows one content-free notification and never touches caches or keys (#85)', async () => {
  const listeners = new Map(); const shown = []; const fetched = [];
  const self = {
    registration: { active: true, async showNotification(title, options) { shown.push({ title, options }); } },
    clients: { async matchAll() { return []; }, async claim() {}, async openWindow(url) { return { url }; } },
    location: { origin: 'https://kin.test', href: 'https://kin.test/service-worker.js?v=0.38.2' },
    addEventListener(type, callback) { listeners.set(type, callback); }, async skipWaiting() {},
  };
  const manifests = [
    new Response(JSON.stringify({ short_name: 'Nest', icons: [{ src: '/install-icon/192.png?v=a', type: 'image/png', purpose: 'any' }] })),
    new Response('nope', { status: 500 }),
  ];
  const caches = { async open() { throw new Error('the push path must not open caches'); }, async keys() { return []; } };
  const context = { self, caches, URL, Response, Promise, AbortController, setTimeout, clearTimeout, indexedDB: undefined,
    fetch: async (path, options) => { fetched.push([path, options?.credentials]); return manifests.shift(); } };
  vm.runInNewContext(await readFile(new URL('./service-worker.js', import.meta.url), 'utf8'), context);
  for (let i = 0; i < 2; i++) { let done; listeners.get('push')({ data: { text: () => '{"v":1,"kind":"new"}' }, waitUntil(value) { done = value; } }); await done; }
  assert.deepEqual(shown.map(({ title, options }) => [title, options.body, options.tag, options.icon]), [
    ['Nest', 'Something new in Nest', 'kin-new', '/install-icon/192.png?v=a'],
    ['Kin', 'Something new in Kin', 'kin-new', '/icon.svg'],
  ]);
  assert.deepEqual(fetched, [['/manifest.webmanifest', 'include'], ['/manifest.webmanifest', 'include']]);
  let opened; listeners.get('notificationclick')({ notification: { close() {} }, waitUntil(value) { opened = value; } });
  assert.deepEqual(await opened, { url: '/' }, 'with no Kin window open, tapping opens Kin');
});

test('a share POST is answered by the worker, held in memory once, and never cached or fetched (#389)', async () => {
  const { listeners, stored } = await worker({ failPath: '/share' });
  const form = new FormData();
  form.set('title', 'Pancakes');
  form.set('text', 'Recipe https://example.test/pancakes');
  form.append('files', new File(['x'.repeat(10)], 'photo.jpg', { type: 'image/jpeg' }));
  form.append('files', new File([], 'empty.txt'));
  let answer;
  listeners.get('fetch')({ request: new Request('https://kin.test/share', { method: 'POST', body: form }), respondWith(value) { answer = value; } });
  const response = await answer;
  assert.equal(response.status, 303);
  const id = /#kin-share=([a-f0-9]{32})$/.exec(response.headers.get('location'))?.[1];
  assert.ok(id, 'the page is sent to its own address with a random id');
  const take = () => new Promise((resolve) => {
    listeners.get('message')({ data: { type: 'kin-share-take', id }, ports: [{ postMessage: resolve }] });
  });
  const shared = await take();
  assert.equal(shared.title, 'Pancakes');
  assert.equal(shared.text, 'Recipe https://example.test/pancakes');
  assert.deepEqual(shared.files.map((file) => file.name), ['photo.jpg'], 'empty files are dropped');
  assert.equal(await take(), null, 'taken once');
  for (const entries of stored.values()) assert.ok(![...entries.keys()].some((key) => String(key).includes('share')), 'nothing shared is cached');
});

test('a page that missed the activation claim can ask the worker for one (#770)', async () => {
  const { listeners, claims } = await worker();
  let claimed;
  listeners.get('message')({ data: { type: 'KIN_CLAIM', release: '0.38.2' }, waitUntil(value) { claimed = value; } });
  await claimed;
  assert.equal(claims.length, 1, 'the worker claims the open pages and keeps running until it has');
  listeners.get('message')({ data: { type: 'something-else' }, waitUntil() { throw new Error('not for other messages'); } });
  assert.equal(claims.length, 1);
});

test('the worker claims only a page of its own release, so files never mix releases', async () => {
  // A hard reload loads a newer release from the network while an older
  // worker is still active for another tab. That worker would answer the
  // page's later engine fetch from its own cache: a newer kin-engine.js
  // with an older kin_engine.wasm.
  const { listeners, claims } = await worker({ release: '0.38.1' });
  for (const data of [{ type: 'KIN_CLAIM', release: '0.38.2' }, { type: 'KIN_CLAIM', release: '0.38.1+abc' }, { type: 'KIN_CLAIM' }]) {
    listeners.get('message')({ data, waitUntil() { throw new Error(`no claim for ${JSON.stringify(data)}`); } });
  }
  assert.equal(claims.length, 0);
});
