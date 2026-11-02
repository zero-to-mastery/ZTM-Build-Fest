import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SITE = 'https://mnichols08.github.io/constellation/';
const meta = (html, key) => html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`))?.[1];

test('both pages carry a complete link preview pointing at the committed image', async () => {
  for (const [file, url] of [['index.html', SITE], ['how-it-works.html', `${SITE}how-it-works.html`]]) {
    const html = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const key of ['og:title', 'og:description', 'og:image:alt', 'twitter:image:alt']) {
      assert.ok(meta(html, key)?.length > 10, `${file} has ${key}`);
    }
    assert.equal(meta(html, 'og:url'), url, `${file} og:url`);
    assert.equal(meta(html, 'twitter:card'), 'summary_large_image');
    // Social sites need an absolute URL; it must map to a file this repository publishes.
    const image = meta(html, 'og:image');
    assert.ok(image.startsWith(SITE), `${file} og:image is absolute on the site`);
    assert.equal(meta(html, 'og:image:width'), '1200');
    assert.equal(meta(html, 'og:image:height'), '630');
    await readFile(new URL(`../${image.slice(SITE.length)}`, import.meta.url));
  }
});

test('the preview image is a 1200×630 PNG of a sensible size', async () => {
  const png = await readFile(new URL('../assets/og-image.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  // Most sites refuse previews over 5 MB; stay well under.
  assert.ok(png.length < 1_000_000, `${png.length} bytes`);
});
