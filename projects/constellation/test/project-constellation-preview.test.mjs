import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPreviewServer } from '../scripts/preview-server.mjs';

async function withPreview(t, run) {
  const server = createPreviewServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  await run(`http://127.0.0.1:${server.address().port}`);
}

const mime = { mjs: /^text\/javascript/, js: /^text\/javascript/, css: /^text\/css/, wasm: /^application\/wasm/ };

// A module missing from the preview server only fails in a browser, so walk the
// Studio's real import graph from the page and prove every file is served.
test('preview server serves every module and stylesheet the Studio page imports', async t => {
  await withPreview(t, async origin => {
    const page = await fetch(new URL('/', origin));
    assert.equal(page.status, 200);
    const html = await page.text();
    const pending = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="stylesheet"[^>]*\shref)="([^"]+)"/g)]
      .map(match => new URL(match[1], origin).pathname);
    assert.ok(pending.includes('/src/app/boot.mjs'), 'the page loads the Studio boot module');
    const visited = new Set();
    while (pending.length) {
      const path = pending.pop();
      if (visited.has(path)) continue;
      visited.add(path);
      const response = await fetch(new URL(path, origin));
      assert.equal(response.status, 200, `${path} must be available to the Studio browser`);
      const extension = path.split('.').pop();
      assert.match(response.headers.get('content-type'), mime[extension], `${path} has a usable MIME type`);
      if (extension !== 'mjs' && extension !== 'js') continue;
      const source = await response.text();
      const references = /\b(?:from\s*|import\s*\(\s*|import\s+|new URL\(\s*)['"](\.{1,2}\/[^'"]+\.(?:mjs|js|css|wasm))['"]/g;
      for (const match of source.matchAll(references)) {
        const dependency = new URL(match[1], new URL(path, origin)).pathname;
        if (dependency.startsWith('/src/') || dependency.startsWith('/packages/')) pending.push(dependency);
      }
    }
    for (const required of ['/src/app/main.mjs', '/src/app/app.css', '/src/engine.mjs', '/src/scene.mjs', '/src/wasm/inline.mjs']) {
      assert.ok(visited.has(required), `${required} should be in the audited graph`);
    }
  });
});
