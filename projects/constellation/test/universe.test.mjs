import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScene, renderSceneSVG, renderSceneHTML, serializeScene, parseScene, validateScene, parseConfig } from '../src/core-api.mjs';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';
const repos = [
  { full_name: 'demo/a', name: 'a', language: 'JavaScript', languages: { JavaScript: 80, CSS: 20 }, topics: ['testing', 'web'], stargazers_count: 10, created_at: '2020-01-01' },
  { full_name: 'demo/b', name: 'b', language: 'JavaScript', languages: { JavaScript: 80, Rust: 20 }, topics: ['testing', 'tools'], stargazers_count: 3, created_at: '2021-01-01' },
];
const options = axis => ({ arrangement: 'temporal-stack', referenceDate: '2026-09-01T00:00:00.000Z', animate: false, temporalStack: { axis, innerArrangement: 'rings' } });
test('dimensional membership, representation ranking, ordering and cross-layer identities', () => {
  for (const axis of ['language', 'topic', 'repository']) {
    const scene = createScene('demo', repos, options(axis)), stack = scene.temporalStack;
    assert.equal(stack.version, 2); assert.equal(scene.timeline, undefined);
    assert.ok(stack.layers.every(layer => layer.axis === axis && layer.year === undefined && layer.value === layer.label));
    assert.ok(stack.frames.every(frame => frame.date === undefined && frame.evidence === 'current-membership'));
    assert.equal(serializeScene(parseScene(serializeScene(scene))), serializeScene(scene));
    assert.equal(serializeScene(createScene('demo', [...repos].reverse(), options(axis))), serializeScene(scene));
    assert.ok(stack.bridges.length > 0);
    const svg = renderSceneSVG(scene);
    assert.match(svg, /Current repository membership/); assert.doesNotMatch(svg, /data-year=|undefined|NaN/);
    assert.equal(new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1])).size, [...svg.matchAll(/\sid="([^"]+)"/g)].length);
    if (axis === 'language') assert.equal(stack.layers[0].value, 'JavaScript');
    if (axis === 'topic') assert.equal(stack.layers[0].value, 'testing');
    if (axis === 'repository') {
      assert.ok(stack.frames.every(frame => frame.scene.nodes.length >= 4));
      assert.ok(stack.bridges.some(edge => edge.nodeId === 'language:JavaScript'));
      assert.ok(stack.bridges.some(edge => edge.nodeId === 'topic:testing'));
    }
  }
  const ordered = createScene('demo', repos, { ...options('language'), temporalStack: { axis: 'language', layerValues: ['CSS', 'Rust', 'JavaScript'] } });
  assert.deepEqual(ordered.temporalStack.layers.map(layer => layer.value), ['CSS', 'Rust', 'JavaScript']);
  assert.ok(ordered.temporalStack.bridges.some(edge => edge.fromLayer === 'language:JavaScript' && edge.toLayer === 'language:CSS'), 'repeated projects connect across nonadjacent layers');
});
test('v1 years remain readable; invalid dimensional attachments and configs are rejected', () => {
  const legacy = createScene('demo', repos, options('year')); delete legacy.temporalStack.settings.axis;
  assert.equal(validateScene(legacy).valid, true);
  for (const axis of ['week', '', null]) assert.throws(() => parseConfig({ temporalStack: { axis } }));
  for (const layerValues of [[], ['CSS', 'CSS'], Array(21).fill('x'), ['']]) assert.throws(() => parseConfig({ temporalStack: { axis: 'topic', layerValues } }));
  assert.throws(()=>createScene('demo', repos, {...options('topic'), temporalStack:{axis:'topic',layerValues:['missing']}}),/unavailable/);
  for (const mutate of [s=>s.temporalStack.frames[0].scene.nodes[0].geometry.x++, s=>s.temporalStack.layers[0].year=2026, s=>s.temporalStack.layers[0].id='wrong', s=>s.temporalStack.frames[0].scene.temporalStack={}, s=>s.temporalStack.bridges[0].fromLayer='missing']) {
    const scene=createScene('demo',repos,options('language')); mutate(scene); assert.equal(validateScene(scene).valid,false);
  }
});
test('default layers are bounded and manual anchors survive dimensional exports', () => {
  const scene=createScene('demo',[{...repos[0],topics:Array.from({length:30},(_,i)=>'topic-'+i)}],options('topic'));
  assert.equal(scene.temporalStack.layers.length,8); assert.equal(scene.temporalStack.reduced,true);
  const moved=createScene('demo',repos,{...options('language'),snapToRings:false,starPositions:{'demo/a':{x:250,y:180}}});
  for(const frame of moved.temporalStack.frames) for(const node of frame.scene.nodes.filter(node=>node.id==='demo/a')) assert.deepEqual([node.geometry.x,node.geometry.y],[250,180]);
});
test('offline dimensional HTML supports focus, camera, selection and reduced motion', {skip:!browser,timeout: 120000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'constellation-universe-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'universe.html');await writeFile(file,renderSceneHTML(createScene('demo',repos,options('repository'))));
  const {evaluate:e,waitFor:wait,cdp,errors}=await openBrowser(t,pathToFileURL(file).href);
  await wait(`Boolean(document.querySelector('[aria-label="Focus layer"]'))`);
  assert.equal(await e(`document.querySelector('[aria-label="Focus year"]')`),null);
  await e(`const select=document.querySelector('[aria-label="Focus layer"]');select.value='repository:demo%2Fa';select.dispatchEvent(new Event('change'));`);
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await e(`document.querySelector('.repository').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  assert.equal(await e(`document.querySelectorAll('[data-layer-id]').length > 0`),true);
  assert.deepEqual(errors,[]);
});
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createPreviewServer } from '../scripts/preview-server.mjs';
test('packaged web component renders dimensional scenes and exposes layer focus', {skip:!browser,timeout: 120000},async t=>{
  const scene=createScene('demo',repos,options('language'));
  const preview=createPreviewServer();
  const server=createServer((req,res)=>{
    if(req.url==='/universe-component.html') {res.setHeader('Content-Type','text/html');res.end(`<script type="importmap">{"imports":{"@constellation/core":"/packages/core/src/core-api.mjs","@constellation/core/browser-runtime":"/packages/core/src/browser-runtime.mjs"}}</script><script type="module">import '/packages/web-component/index.mjs';document.querySelector('constellation-view').scene=${serializeScene(scene).replaceAll('<','\\u003c')};</script><constellation-view></constellation-view>`);}
    else preview.emit('request',req,res);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const {evaluate:e,waitFor:wait,errors}=await openBrowser(t,`http://127.0.0.1:${server.address().port}/universe-component.html`);
  await wait(`!!document.querySelector('constellation-view')?.shadowRoot?.querySelector('[aria-label="Focus layer"]')`);
  await e(`document.querySelector('constellation-view').focusLayer('language:CSS')`);
  assert.equal(await e(`document.querySelector('constellation-view').shadowRoot.querySelector('[aria-label="Focus layer"]').value`),'language:CSS');
  assert.deepEqual(errors,[]);
});
test('dimensional SVG retains ring animation without historical playback', () => {
  const scene=createScene('demo',repos,{...options('language'),animate:true,ringAnimation:{enabled:true,speeds:[2,2,2,2]},history:{timeLapse:{enabled:true}}});
  assert.equal(scene.presentation.options.history.timeLapse.enabled,false);
  assert.match(renderSceneSVG(scene),/data-temporal-motion/);
  assert.equal(validateScene(scene).valid,true);
});
import { spawnSync } from 'node:child_process';
import { generateGuidedDesign } from '../src/onboarding-generator.mjs';
import { defaultIntent } from '../src/onboarding-model.mjs';
test('dimensional configs validate without data and work through onboarding and CLI exports', async t => {
  const dir=await mkdtemp(join(tmpdir(),'constellation-universe-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const fixture=join(dir,'repos.json');await writeFile(fixture,JSON.stringify(repos));
  for(const axis of ['language','repository','topic']) {
    const config=parseConfig({version:7,account:'demo',options:options(axis)});
    assert.equal(config.options.temporalStack.axis,axis);
    assert.equal(generateGuidedDesign('demo',repos,{...defaultIntent(repos),history:'dimension',dimension:axis},{seed:'dimension',year:2026}).config.options.temporalStack.axis,axis);
    const path=join(dir,axis+'.json');await writeFile(path,JSON.stringify(config));
    for(const format of ['svg','html']) {
      const result=spawnSync(process.execPath,['--throw-deprecation','src/cli.mjs','--username','demo','--config',path,'--fixture',fixture,'--format',format,'--output',join(dir,axis+'.'+format)],{encoding:'utf8',windowsHide:true,env:{...process.env,CONSTELLATION_CONFIG_JSON:'',GITHUB_OUTPUT:'',GITHUB_STEP_SUMMARY:''}});
      assert.equal(result.status,0,result.stderr);
    }
  }
});
