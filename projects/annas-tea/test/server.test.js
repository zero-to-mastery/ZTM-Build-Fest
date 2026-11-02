import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';

test('preview serves application files but not source tests, docs or traversal', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [file, contentType] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/src/model.js', 'text/javascript'], ['/assets/favicon.svg', 'image/svg+xml'], ['/assets/working-shop.webp', 'image/webp']]) {
    const response = await fetch(base + file);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(contentType));
  }
  for (const file of ['/test/model.test.js', '/README.md', '/server.js', '/assets/%2e%2e%5cREADME.md', '/%zz', '/does-not-exist']) assert.equal((await fetch(base + file)).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  assert.equal(await (await fetch(base + '/', { method: 'HEAD' })).text(), '');
});
