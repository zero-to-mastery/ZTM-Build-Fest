import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';
import { createScene } from '../src/constellation.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { repositories, options } from './fixtures/recruiter.mjs';

test('recruiter SVG at README widths: text bounds, sparse labels, frozen layout and reduced motion', { skip: !browser, timeout: 120000 }, async t => {
  const svg = renderSceneSVG(createScene('alice', repositories, options));
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<style>body{margin:0;background:#0d1117}svg{width:100%;height:auto;display:block}</style>${svg}`); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { evaluate, cdp, errors, waitFor } = await openBrowser(t, `http://127.0.0.1:${server.address().port}`);
  await waitFor(`document.querySelectorAll('.planet').length===7`);
  await mkdir('.cache/recruiter', { recursive: true });
  await writeFile('.cache/recruiter/animated.svg', svg);
  await writeFile('.cache/recruiter/static.svg', renderSceneSVG(createScene('alice', repositories, { ...options, animate: false })));
  for (const width of [800, 1000, 1200]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: Math.ceil(width * 840 / 1200), deviceScaleFactor: 1, mobile: false });
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const metrics = await evaluate(`(() => {
      const labels = [...document.querySelectorAll('.project-label')].map(el => el.getBoundingClientRect());
      return { overflow: [...document.querySelectorAll('text')].filter(el => {const b=el.getBoundingClientRect();return b.left < -1 || b.right > innerWidth+1}).map(el=>el.textContent),
        overlap: labels.some((a,i)=>labels.slice(i+1).some(b=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)),
        moons: document.querySelectorAll('.moons').length,
        activePlanets: [...document.querySelectorAll('.planet,.repo-label')].some(el=>getComputedStyle(el).animationName!=='none') };
    })()`);
    assert.deepEqual(metrics.overflow, []); assert.equal(metrics.overlap, false); assert.equal(metrics.moons, 0); assert.equal(metrics.activePlanets, false);
    await writeFile(`.cache/recruiter/${width}.png`, Buffer.from((await cdp('Page.captureScreenshot')).data, 'base64'));
  }
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.recent-pulse')).animationName`), 'none');
  await evaluate(`document.querySelector('.key').style.display='none'`);
  assert.equal(await evaluate(`document.querySelectorAll('.planet').length`), 7);
  await writeFile('.cache/recruiter/without-key.png', Buffer.from((await cdp('Page.captureScreenshot')).data, 'base64'));
  const metadataOnly = renderSceneSVG(createScene('alice', repositories, { ...options, theme: 'light', animate: false, commitFieldData: undefined, organizationData: undefined }));
  await evaluate(`document.body.innerHTML=${JSON.stringify(metadataOnly)};`);
  await waitFor(`document.querySelectorAll('.planet').length===7`);
  assert.equal(await evaluate(`document.querySelectorAll('.moons').length`), 0);
  assert.match(await evaluate(`document.body.textContent`), /contributors unknown/);
  await writeFile('.cache/recruiter/metadata-only.png', Buffer.from((await cdp('Page.captureScreenshot')).data, 'base64'));
  const longAccount = 'a-very-long-github-username-for-testing';
  const longRepos = repositories.map(repo => ({ ...repo, name: 'WWW-very-long-repository-name-with-many-characters' }));
  const longSVG = renderSceneSVG(createScene(longAccount, longRepos, { ...options, animate: false, accountData: { name: 'A Very Long Display Name With Many Words' } }));
  for (const width of [800, 1000, 1200]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: Math.ceil(width * 840 / 1200), deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.body.innerHTML=${JSON.stringify(longSVG)}`);
    const bounds = await evaluate(`(() => {
      const texts = [...document.querySelectorAll('text')].map(el => ({text:el.textContent,b:el.getBoundingClientRect()}));
      return { clipped: texts.filter(({b})=>b.left<0||b.right>innerWidth||b.top<0||b.bottom>innerHeight).map(el=>el.text),
        overlapping: texts.some((a,i)=>texts.slice(i+1).some(b=>a.b.left<b.b.right&&a.b.right>b.b.left&&a.b.top<b.b.bottom&&a.b.bottom>b.b.top)),
        animated: document.querySelector('svg').getAnimations({subtree:true}).length,
        identity: document.querySelector('.developer title').textContent };
    })()`);
    assert.deepEqual(bounds.clipped, []); assert.equal(bounds.overlapping, false); assert.equal(bounds.animated, 0);
    assert.ok(bounds.identity.includes(longAccount));
    await writeFile(`.cache/recruiter/long-${width}.png`, Buffer.from((await cdp('Page.captureScreenshot')).data, 'base64'));
  }
  assert.deepEqual(errors, []);
});
