import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';
import { createScene } from '../src/constellation.mjs';
import { serializeScene } from '../src/scene.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
async function verifyApp(t, name) {
  const root = resolve(repo, 'fixtures', `consumer-${name}`);
  let generatedScene;
  if (name === 'astro') {
    const publicDir = resolve(root, 'public');
    await mkdir(publicDir, { recursive: true });
    generatedScene = resolve(publicDir, 'scene.json');
    const scene = createScene('astro-demo', [
      { name: 'compiler', full_name: 'astro-demo/compiler', language: 'Rust' },
      { name: 'studio', full_name: 'astro-demo/studio', language: 'JavaScript' },
    ], { projectFamilies: { tools: { label: 'Tools', members: ['astro-demo/compiler', 'astro-demo/studio'] } } });
    await writeFile(generatedScene, serializeScene(scene));
    t.after(() => rm(generatedScene, { force: true }));
  }
  const packageRoot = resolve(root, 'node_modules', '@constellation');
  await mkdir(packageRoot, { recursive: true });
  for (const pkg of ['core', 'web-component']) {
    const destination = resolve(packageRoot, pkg);
    await rm(destination, { recursive: true, force: true });
    await cp(resolve(repo, 'packages', pkg), destination, { recursive: true });
  }
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const serverArgs = ['--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  const args = name === 'react'
    ? ['node_modules/vite/bin/vite.js', ...serverArgs]
    : ['node_modules/astro/astro.js', 'dev', ...serverArgs];
  const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-5000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-5000); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 45000;
  let reachable = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try { const response = await fetch(url); reachable = response.ok; if (reachable) break; } catch {}
    await delay(100);
  }
  assert.ok(reachable, `${name} fixture server did not start at ${url}: ${output}`);
  const { evaluate, waitFor, errors } = await openBrowser(t, url);
  try {
  await waitFor(`['Projects ready','The project map could not be loaded.'].includes(document.querySelector('#status')?.textContent)`);
  } catch (error) {
    throw Error(`${error.message}; page=${JSON.stringify(await evaluate(`({url:location.href,title:document.title,text:document.body.innerText.slice(0,500),html:document.body.innerHTML.slice(0,500),shadow:document.querySelector('#portfolio')?.shadowRoot?.innerHTML.slice(0,500),scene:!!document.querySelector('#portfolio')?.scene})`))}; exceptions=${errors.join('\n')}; server=${output}`);
  }
  assert.equal(await evaluate(`document.querySelector('#status').textContent`), 'Projects ready', `${name} browser errors: ${errors.join('\n')}`);
  await waitFor(`Boolean(document.querySelector('#portfolio')?.shadowRoot?.querySelector('.star'))`);
  const focus = await evaluate(`(()=>{const view=document.querySelector('#portfolio');view.focusProject('${name}-demo/compiler');view.focusRelationship('${name}-demo/compiler','${name}-demo/studio');return view.focusState})()`);
  assert.equal(focus.project, `${name}-demo/compiler`);
  assert.equal(focus.related, `${name}-demo/studio`);
  if (name === 'react') {
    const updates = await evaluate('window.statusUpdateCount || 0');
    await evaluate('(()=>{window.unmountedView=document.querySelector("#portfolio");return true})()');
    await evaluate('window.unmountPortfolio()');
    await evaluate(`window.unmountedView.dispatchEvent(new CustomEvent('scene-change', { bubbles:true }))`);
    assert.equal(await evaluate('window.statusUpdateCount || 0'), updates, 'React cleanup removes listeners on unmount');
    await evaluate('window.mountPortfolio()');
    await waitFor(`document.querySelector('#status')?.textContent === 'Projects ready'`);
    const mountedView = await evaluate(`document.querySelector('#portfolio').dispatchEvent(new CustomEvent('scene-change', { bubbles:true }))`);
    assert.equal(mountedView, true);
    assert.equal(await evaluate('window.statusUpdateCount'), updates + 2, 'a remount registers one live event handler');
  }
  assert.deepEqual(errors, []);
}

for (const [name, entry] of [
  ['react', 'node_modules/react/package.json'],
  ['astro', 'node_modules/astro/package.json'],
]) {
  test(`${name} consumer app mounts the published Web Component and handles focus in Chromium`, {
    skip: !browser || !existsSync(resolve(repo, 'fixtures', `consumer-${name}`, entry)),
    timeout: 120000,
  }, t => verifyApp(t, name));
}
