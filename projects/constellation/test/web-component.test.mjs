import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';
import { createScene } from '../src/constellation.mjs';
import { semanticGraphFromScene, semanticGraphFromProjectConstellation, serializeSemanticGraph, semanticGraphFingerprint } from '../src/semantic-graph.mjs';
import { createProjectConstellation } from '../src/project-constellation.mjs';

test('component loads Semantic Graph offline and preserves the active graph after invalid replacement', { skip: !browser, timeout: 120000 }, async t => {
  const server = createPreviewServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { evaluate, waitFor, errors } = await openBrowser(t, `http://127.0.0.1:${server.address().port}/examples/web-component.html`);
  await waitFor(`Boolean(document.querySelector('constellation-view')?.shadowRoot?.querySelector('main')?.constellation)`);
  const graph = semanticGraphFromScene(createScene('portable-alice', [{ full_name: 'portable-alice/tool', name: 'tool', language: 'Rust' }]));
  const graphB = semanticGraphFromScene(createScene('portable-bob', [{ full_name: 'portable-bob/tool', name: 'tool', language: 'Rust' }]));
  const json = serializeSemanticGraph(graph);
  const jsonB = serializeSemanticGraph(graphB);
  await evaluate(`window.graphInput=${json}; window.originalFetch=window.fetch; window.fetch=()=>{throw new Error('unexpected network')}; window.events=[]; const v=document.querySelector('#view'); v.addEventListener('semantic-graph-load',e=>events.push(e.detail)); v.addEventListener('semantic-graph-error',e=>events.push({error:e.detail.message})); window.graphBefore=structuredClone(graphInput); v.semanticGraph=graphInput;`);
  assert.equal(await evaluate(`document.querySelector('#view').semanticFingerprint`), semanticGraphFingerprint(graph));
  assert.equal(await evaluate(`document.querySelector('#view').shadowRoot.querySelector('.star[data-repo="portable-alice/tool"]') !== null`), true);
  assert.equal(await evaluate(`JSON.stringify(graphInput)===JSON.stringify(graphBefore)`), true);
  assert.equal(await evaluate(`events.at(-1).fingerprint`), semanticGraphFingerprint(graph));
  await evaluate(`const invalid=structuredClone(graphInput); invalid.version=2; document.querySelector('#view').semanticGraph=invalid; window.fetch=originalFetch`);
  assert.equal(await evaluate(`document.querySelector('#view').semanticFingerprint`), semanticGraphFingerprint(graph));
  assert.equal(await evaluate(`document.querySelector('#view').shadowRoot.querySelector('.star[data-repo="portable-alice/tool"]') !== null`), true);
  assert.match(await evaluate(`events.at(-1).error`), /Semantic Graph version|semantic graph version/i);
  await evaluate(`window.fetchCalls=[]; window.fetch=(url,{signal})=>{const value=String(url);fetchCalls.push(value);if(value.endsWith('/a.json'))return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));if(value.endsWith('/b.json'))return Promise.resolve(new Response(${JSON.stringify(jsonB)},{headers:{'content-type':'application/json'}}));if(value.includes('api.github.com'))throw new Error('GitHub must not be called');throw new Error('Unexpected graph URL '+value)}; window.urlView=document.querySelector('#view'); urlView.setAttribute('semantic-graph','https://graphs.example/a.json'); urlView.setAttribute('semantic-graph','https://graphs.example/b.json');`);
  await waitFor(`document.querySelector('#view').semanticFingerprint === '${semanticGraphFingerprint(graphB)}'`);
  assert.equal(await evaluate(`document.querySelector('#view').semanticGraph.subject.id`), 'portable-bob');
  assert.equal(await evaluate(`fetchCalls.length`), 2);
  assert.deepEqual(errors, []);
});

test('Developer Atlas exposes accessible breadcrumbs, group and project contexts without graph mutation', { skip: !browser, timeout: 120000 }, async t => {
  const server = createPreviewServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { evaluate, waitFor, errors } = await openBrowser(t, `http://127.0.0.1:${server.address().port}/examples/web-component.html`);
  await waitFor(`Boolean(document.querySelector('#view')?.shadowRoot?.querySelector('main')?.constellation)`);
  const source = createScene('atlas-alice', [
    { full_name: 'atlas-alice/one', name: 'one', language: 'Rust' },
    { full_name: 'atlas-alice/two', name: 'two', language: 'Rust' },
    { full_name: 'atlas-alice/three', name: 'three', language: 'Rust' },
    { full_name: 'atlas-bob/other', name: 'other', language: 'JavaScript' },
  ], { projectFamilies: { tools: { label: 'Developer Tools', members: ['atlas-alice/one', 'atlas-alice/two', 'atlas-alice/three'] } } });
  const graph = semanticGraphFromScene(source); const fingerprint = semanticGraphFingerprint(graph);
  const projectGraph = semanticGraphFromProjectConstellation(createProjectConstellation({ projectId: 'atlas-alice/one', ref: 'main', tree: [
    { path: 'packages', type: 'tree' }, { path: 'packages/core', type: 'tree' }, { path: 'packages/core/package.json', type: 'blob' },
  ] }));
  const packageNode = projectGraph.nodes.find(node => node.kind === 'package');
  await evaluate(`window.atlasGraph=${JSON.stringify(graph)}; window.atlasProjectGraph=${JSON.stringify(projectGraph)}; window.atlasPackageId=${JSON.stringify(packageNode.id)}; window.atlasCalls=[]; window.atlasFetch=window.fetch; window.fetch=(...args)=>{atlasCalls.push(args[0]);throw Error('Atlas navigation must stay offline')}; const atlasView=document.querySelector('#view'); atlasView.semanticGraph=atlasGraph; window.atlasEvents=[]; atlasView.addEventListener('atlas-change',event=>atlasEvents.push(event.detail));`);
  await waitFor(`document.querySelector('#view').shadowRoot.querySelector('[aria-label="Developer Atlas"]')`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'developer');
  assert.equal(await evaluate(`document.querySelector('#view').semanticFingerprint`), fingerprint);
  await evaluate(`document.querySelector('#view').shadowRoot.querySelector('[aria-label="Atlas context"] button').click()`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'group');
  assert.equal(await evaluate(`document.querySelector('#view').shadowRoot.activeElement.getAttribute('aria-current')`), 'location');
  assert.match(await evaluate(`document.querySelector('#view').shadowRoot.querySelector('[role="status"]').textContent`), /Developer Atlas: Developer Tools/);
  await evaluate(`document.querySelector('#view').shadowRoot.querySelector('[aria-label^="Open developer:"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'developer');
  await evaluate(`document.querySelector('#view').navigateAtlasGroup(atlasGraph.groups.find(group=>group.label==='Developer Tools').id)`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'group');
  assert.match(await evaluate(`document.querySelector('#view').shadowRoot.querySelector('[aria-label="Atlas context"]').textContent`), /User-authored group/);
  await evaluate(`document.querySelector('#view').navigateAtlasProject('atlas-alice/one')`);
  assert.deepEqual(await evaluate(`document.querySelector('#view').atlasBreadcrumbs.map(item=>item.level)`), ['developer', 'group', 'project']);
  const reorderedGraph = semanticGraphFromScene(createScene('atlas-alice', [
    { full_name: 'atlas-bob/other', name: 'other', language: 'JavaScript' },
    { full_name: 'atlas-alice/two', name: 'two', language: 'Rust' },
    { full_name: 'atlas-alice/three', name: 'three', language: 'Rust' },
    { full_name: 'atlas-alice/one', name: 'one', language: 'Rust' },
  ], { projectFamilies: { tools: { label: 'Developer Tools', members: ['atlas-alice/one', 'atlas-alice/two', 'atlas-alice/three'] } } }));
  await evaluate(`document.querySelector('#view').semanticGraph=${JSON.stringify(reorderedGraph)}`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.projectId`), 'atlas-alice/one');
  const graphWithoutOne = semanticGraphFromScene(createScene('atlas-alice', [
    { full_name: 'atlas-alice/two', name: 'two', language: 'Rust' },
    { full_name: 'atlas-alice/three', name: 'three', language: 'Rust' },
    { full_name: 'atlas-bob/other', name: 'other', language: 'JavaScript' },
  ], { projectFamilies: { tools: { label: 'Developer Tools', members: ['atlas-alice/two', 'atlas-alice/three'] } } }));
  await evaluate(`document.querySelector('#view').semanticGraph=${JSON.stringify(graphWithoutOne)}`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'group');
  await evaluate(`document.querySelector('#view').semanticGraph=${JSON.stringify(graph)}`);
  await evaluate(`document.querySelector('#view').navigateAtlasProject('atlas-alice/one')`);
  await evaluate(`document.querySelector('#view').navigateAtlasStructure(atlasProjectGraph, atlasPackageId)`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'structure');
  assert.equal((await evaluate(`document.querySelector('#view').atlasBreadcrumbs.at(-1).label`)), 'packages/core');
  assert.equal(await evaluate(`document.querySelector('#view').shadowRoot.querySelector('.star[data-repo="'+atlasPackageId+'"]')!==null`), true);
  await evaluate(`const historyView=document.querySelector('#view');historyView._atlasHandlers=()=>({render:()=>false,changed:()=>{}});`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasBack()`), false);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'structure');
  assert.equal(await evaluate(`document.querySelector('#view').atlasCanBack`), true);
  await evaluate(`document.querySelector('#view')._atlasHandlers=()=>({render:()=>true,changed:()=>{}});`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasBack()`), true);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'project');
  await evaluate(`document.querySelector('#view')._atlasHandlers=()=>({render:()=>false,changed:()=>{}});`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasForward()`), false);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'project');
  assert.equal(await evaluate(`document.querySelector('#view').atlasCanForward`), true);
  await evaluate(`document.querySelector('#view')._atlasHandlers=()=>({render:()=>true,changed:()=>{}});`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasForward()`), true);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'structure');
  assert.equal(await evaluate(`document.querySelector('#view').atlasBack()`), true);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'project');
  assert.equal(await evaluate(`document.querySelector('#view').atlasBack()`), true);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'group');
  assert.equal(await evaluate(`document.querySelector('#view').semanticFingerprint`), fingerprint);
  assert.equal(await evaluate(`atlasCalls.length`), 0);
  assert.ok(await evaluate(`atlasEvents.length >= 3`));
  const aliceSharedGraph = semanticGraphFromScene(createScene('atlas-alice', [
    { full_name: 'alice/other', name: 'other', language: 'Rust' },
    { full_name: 'shared-org/tool', name: 'tool', language: 'Rust' },
  ], { projectFamilies: { shared: { label: 'Shared work', members: ['alice/other', 'shared-org/tool'] } } }));
  const bobSharedGraph = semanticGraphFromScene(createScene('atlas-bob', [
    { full_name: 'atlas-bob/other', name: 'other', language: 'Rust' },
    { full_name: 'shared-org/tool', name: 'tool', language: 'Rust' },
  ], { projectFamilies: { shared: { label: 'Shared work', members: ['atlas-bob/other', 'shared-org/tool'] } } }));
  await evaluate(`window.atlasSharedAlice=${JSON.stringify(aliceSharedGraph)}; window.atlasSharedBob=${JSON.stringify(bobSharedGraph)}; const sharedView=document.querySelector('#view'); sharedView.semanticGraph=atlasSharedAlice; sharedView.navigateAtlasGroup(atlasSharedAlice.groups[0].id); sharedView.navigateAtlasProject('shared-org/tool')`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.projectId`), 'shared-org/tool');
  assert.equal(await evaluate(`document.querySelector('#view').atlasCanBack`), true);
  await evaluate(`document.querySelector('#view').semanticGraph=atlasSharedBob`);
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.level`), 'developer');
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.developerId`), 'atlas-bob');
  assert.equal(await evaluate(`document.querySelector('#view').atlasState.projectId`), null);
  assert.equal(await evaluate(`document.querySelector('#view').atlasCanBack`), false);
  assert.equal(await evaluate(`document.querySelector('#view').atlasCanForward`), false);
  await evaluate('window.fetch=window.atlasFetch');
  assert.deepEqual(errors, []);
});

test('Semantic Graph override restores src and programmatic fallbacks when cleared', { skip: !browser, timeout: 120000 }, async t => {
  const server = createPreviewServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { evaluate, waitFor, errors } = await openBrowser(t, `http://127.0.0.1:${server.address().port}/examples/web-component.html`);
  await waitFor(`Boolean(document.querySelector('#view')?.shadowRoot?.querySelector('main')?.constellation)`);
  const sourceScene = createScene('source-alice', [{ full_name: 'source-alice/fallback', name: 'fallback', language: 'Rust' }]);
  const changedSourceScene = createScene('source-carol', [{ full_name: 'source-carol/fallback', name: 'fallback', language: 'Rust' }]);
  const graph = semanticGraphFromScene(createScene('graph-bob', [{ full_name: 'graph-bob/override', name: 'override', language: 'Rust' }]));
  await evaluate(`window.fallbackScene=${JSON.stringify(sourceScene)}; window.changedSourceScene=${JSON.stringify(changedSourceScene)}; window.overrideGraph=${JSON.stringify(graph)}; window.fallbackFetch=window.fetch; window.abortedGraphRequests=0; window.fetch=(url,{signal}={})=>{const value=String(url);if(value.endsWith('/source.json'))return Promise.resolve(new Response(JSON.stringify(fallbackScene)));if(value.endsWith('/source-two.json'))return Promise.resolve(new Response(JSON.stringify(changedSourceScene)));if(value.endsWith('/graph.json'))return Promise.resolve(new Response(JSON.stringify(overrideGraph)));if(value.endsWith('/slow-graph.json'))return new Promise((resolve,reject)=>{window.slowGraphStarted=true;signal.addEventListener('abort',()=>{abortedGraphRequests++;reject(new DOMException('Aborted','AbortError'));},{once:true})});if(value.includes('api.github.com'))throw new Error('GitHub must not be called');throw new Error('Unexpected URL '+value)}; window.srcFallback=document.createElement('constellation-view'); srcFallback.setAttribute('src','/source.json'); srcFallback.setAttribute('semantic-graph','/graph.json'); document.body.append(srcFallback);`);
  await waitFor(`srcFallback.semanticGraph?.subject?.id === 'graph-bob'`);
  const fingerprint = await evaluate(`srcFallback.semanticFingerprint`);
  assert.match(fingerprint, /^sg1:/);
  assert.match(await evaluate(`srcFallback.shadowRoot.querySelector('main').getAttribute('aria-label')`), /Semantic Graph.*sg1:/);
  await evaluate(`srcFallback.semanticGraph={version:2,kind:'constellation-semantic-graph'}`);
  assert.match(await evaluate(`srcFallback.shadowRoot.querySelector('main').getAttribute('aria-description')`), /Semantic Graph version/i);
  await evaluate(`srcFallback.removeAttribute('semantic-graph')`);
  await waitFor(`srcFallback.semanticGraph === null && srcFallback.shadowRoot.querySelector('.star[data-repo="source-alice/fallback"]')`);
  assert.equal(await evaluate(`srcFallback.semanticFingerprint`), null);
  assert.equal(await evaluate(`srcFallback.shadowRoot.querySelector('.star[data-repo="graph-bob/override"]')`), null);
  assert.equal(await evaluate(`/Semantic Graph|sg1:|private source/i.test(srcFallback.shadowRoot.querySelector('main').getAttribute('aria-label')+' '+(srcFallback.shadowRoot.querySelector('main').getAttribute('aria-description')||''))`), false);

  await evaluate(`srcFallback.setAttribute('semantic-graph','/graph.json')`);
  await waitFor(`srcFallback.semanticGraph?.subject?.id === 'graph-bob'`);
  await evaluate(`srcFallback.setAttribute('src','/source-two.json')`);
  assert.equal(await evaluate(`srcFallback.semanticGraph.subject.id`), 'graph-bob', 'src updates do not replace the active graph');
  await evaluate(`srcFallback.removeAttribute('semantic-graph')`);
  await waitFor(`srcFallback.shadowRoot.querySelector('.star[data-repo="source-carol/fallback"]')`);

  await evaluate(`window.configAttributeFallback=document.createElement('constellation-view'); configAttributeFallback.setAttribute('config',JSON.stringify({version:7,account:'config-dora',options:{animate:false}})); configAttributeFallback.setAttribute('semantic-graph','/graph.json'); document.body.append(configAttributeFallback);`);
  await waitFor(`configAttributeFallback.semanticGraph?.subject?.id === 'graph-bob'`);
  await evaluate(`configAttributeFallback.setAttribute('config',JSON.stringify({version:7,account:'updated-dora',options:{animate:false}}))`);
  assert.equal(await evaluate(`configAttributeFallback.semanticGraph.subject.id`), 'graph-bob', 'config updates do not replace the active graph');
  await evaluate(`configAttributeFallback.removeAttribute('semantic-graph')`);
  await waitFor(`configAttributeFallback.semanticGraph===null && configAttributeFallback.scene.metadata.account==='updated-dora'`);
  assert.equal(await evaluate(`configAttributeFallback.semanticFingerprint`), null);

  await evaluate(`window.programmaticFallback=document.createElement('constellation-view'); programmaticFallback.config={version:7,account:'config-alice',options:{animate:false}}; programmaticFallback.records=[{full_name:'config-alice/fallback',name:'fallback',language:'Rust'}]; document.body.append(programmaticFallback);`);
  await waitFor(`Boolean(programmaticFallback.shadowRoot.querySelector('.star[data-repo="config-alice/fallback"]'))`);
  await evaluate(`programmaticFallback.semanticGraph=overrideGraph`);
  assert.equal(await evaluate(`programmaticFallback.semanticGraph.subject.id`), 'graph-bob');
  await evaluate(`programmaticFallback.records=[{full_name:'config-alice/updated-fallback',name:'updated fallback',language:'Rust'}]`);
  assert.equal(await evaluate(`programmaticFallback.semanticGraph.subject.id`), 'graph-bob', 'records updates do not replace the active graph');
  await evaluate(`programmaticFallback.semanticGraph=null`);
  await waitFor(`programmaticFallback.semanticGraph===null && programmaticFallback.shadowRoot.querySelector('.star[data-repo="config-alice/updated-fallback"]')`);
  assert.equal(await evaluate(`programmaticFallback.semanticFingerprint`), null);

  await evaluate(`window.raceFallback=document.createElement('constellation-view'); raceFallback.setAttribute('src','/source.json'); raceFallback.setAttribute('semantic-graph','/slow-graph.json'); document.body.append(raceFallback);`);
  await waitFor(`window.slowGraphStarted===true`);
  await evaluate(`raceFallback.removeAttribute('semantic-graph')`);
  await waitFor(`raceFallback.shadowRoot.querySelector('.star[data-repo="source-alice/fallback"]') && abortedGraphRequests===1`);
  assert.equal(await evaluate(`raceFallback.semanticGraph`), null);
  assert.equal(await evaluate(`raceFallback.semanticFingerprint`), null);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate(`raceFallback.semanticGraph`), null, 'aborted URL cannot reactivate graph mode');
  await evaluate(`window.fetch=fallbackFetch`);
  assert.deepEqual(errors, []);
});

test('semantic zoom resets on canonical records replacement and evaluates Auto immediately', { skip: !browser, timeout: 120000 }, async t => {
  const server = createPreviewServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { evaluate, waitFor, errors } = await openBrowser(t, `http://127.0.0.1:${server.address().port}/examples/web-component.html`);
  await waitFor(`Boolean(document.querySelector('constellation-view')?.shadowRoot?.querySelector('main')?.constellation)`);
  await evaluate(`window.continuity = document.createElement('constellation-view'); document.body.append(continuity);`);
  assert.equal(await evaluate(`(async()=>{const records=Array.from({length:40},(_,i)=>({name:'old-'+i,full_name:'old/project-'+i,language:'Rust',languages:{Rust:1},topics:['continuity'],stargazers_count:i})); const future=Array.from({length:257},(_,i)=>'new/project-'+i); const ok=await continuity.setConfig({version:7,account:'old',maxRepos:2048,nodeCap:2048,projectFamilies:{'old-family':{label:'Old Family',members:records.map(r=>r.full_name)},'future-family':{label:'Future Family',members:future}}}); continuity.records=records; continuity.semanticLevel='groups'; return ok;})()`), true);
  await waitFor(`Boolean(continuity.shadowRoot.querySelector('.star[data-repo^="group:"]'))`);
  await evaluate(`window.oldGroup=continuity.shadowRoot.querySelector('.star[data-repo^="group:"]').dataset.repo; window.levelEvents=[]; continuity.addEventListener('semantic-level-change',e=>levelEvents.push(e.detail)); const base=continuity.scene.viewport.viewBox; continuity.shadowRoot.querySelector('main').constellation.setCamera([base[0],base[1],base[2]/2,base[3]/2]); continuity.semanticLevel='auto';`);
  await waitFor(`continuity.shadowRoot.querySelectorAll('.star[data-repo^="old/"]').length===40`);
  assert.equal(await evaluate(`levelEvents.at(-1)?.current`), 'projects');
  const cameraBefore = await evaluate(`continuity.shadowRoot.querySelector('main').constellation.camera`);
  await evaluate(`continuity.selectNode('old/project-0',{focus:false}); continuity.shadowRoot.querySelector('main').constellation.setCamera([continuity.scene.viewport.viewBox[0],continuity.scene.viewport.viewBox[1],continuity.scene.viewport.viewBox[2]/2,continuity.scene.viewport.viewBox[3]/2]); continuity.records=Array.from({length:257},(_,i)=>({name:'new-'+i,full_name:'new/project-'+i,language:'Rust',languages:{Rust:1},topics:[],stargazers_count:i}));`);
  await waitFor(`continuity.scene.nodes.length===257 && Boolean(continuity.shadowRoot.querySelector('.star[data-repo="group:user:future-family"]'))`);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(await evaluate(`continuity.shadowRoot.querySelectorAll('.star[data-repo^="new/"]').length`), 0, 'large replacement remains at grouped detail');
  assert.ok(await evaluate(`continuity.shadowRoot.querySelector('.star[data-repo^="group:"]')`));
  assert.equal(await evaluate(`continuity.selection.start`), null, 'removed selection is not retained');
  assert.ok(await evaluate(`!continuity.shadowRoot.querySelector('.star[data-repo="'+oldGroup+'"]')`), 'old group is removed');
  assert.deepEqual(await evaluate(`continuity.shadowRoot.querySelector('main').constellation.camera`), cameraBefore);
  await evaluate(`continuity.semanticLevel='projects'; continuity.shadowRoot.querySelector('main').constellation.setCamera([continuity.scene.viewport.viewBox[0],continuity.scene.viewport.viewBox[1],continuity.scene.viewport.viewBox[2]*4,continuity.scene.viewport.viewBox[3]*4]); continuity.semanticLevel='auto';`);
  await waitFor(`continuity.shadowRoot.querySelectorAll('.star[data-repo^="new/"]').length===0`);
  assert.deepEqual(errors, []);
});

test('component renders isolated config and scene properties with accessible controls', { skip: !browser, timeout: 120000 }, async t => {
  const server = createPreviewServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { cdp, evaluate, waitFor, errors } = await openBrowser(t, `http://127.0.0.1:${server.address().port}/examples/web-component.html`);
  await waitFor(`Boolean(document.querySelector('constellation-view')?.shadowRoot?.querySelector('main')?.constellation)`);
  assert.equal(await evaluate(`document.querySelector('constellation-view').shadowRoot.querySelectorAll('.star').length`), 3);
  assert.equal(await evaluate(`document.querySelectorAll('.star').length`), 0);
  assert.ok(await evaluate(`document.querySelector('constellation-view').shadowRoot.querySelector('[data-action=zoom-in]').getAttribute('aria-label')`));
  assert.equal(await evaluate(`(() => { const view = document.querySelector('constellation-view'); const scene = view.scene; scene.nodes[0].metadata.name = 'mutated'; return view.scene.nodes[0].metadata.name === 'mutated'; })()`), false);
  await evaluate(`const first = document.querySelector('constellation-view'); const second = document.createElement('constellation-view'); second.id = 'second'; second.scene = first.scene; document.body.append(second);`);
  assert.equal(await evaluate(`document.querySelector('#second').shadowRoot.querySelectorAll('.star').length`), 3);
  await evaluate(`document.querySelector('#second').shadowRoot.querySelector('[data-action=zoom-in]').click()`);
  assert.notDeepEqual(await evaluate(`document.querySelector('#second').shadowRoot.querySelector('main').constellation.camera`), await evaluate(`document.querySelector('#view').shadowRoot.querySelector('main').constellation.camera`));
  await evaluate(`document.querySelector('#second').setAttribute('config', '{bad-json')`);
  assert.ok(await evaluate(`document.querySelector('#second').shadowRoot.querySelector('main') !== null`), 'bad updates preserve the last good view');
  await evaluate(`window.componentEvents = []; const secondView = document.querySelector('#second'); for (const type of ['scene-change','node-select','node-hover','error']) secondView.addEventListener(type, event => window.componentEvents.push({type, detail:event.detail})); secondView.selectNode(secondView.scene.nodes[0].id, {focus:false});`);
  assert.ok(await evaluate(`document.querySelector('#second').selection.start`));
  await evaluate(`document.querySelector('#second').clearSelection(); document.querySelector('#second').fit(); document.querySelector('#second').reset();`);
  assert.equal(await evaluate(`document.querySelector('#second').selection.start`), null);
  assert.equal(await evaluate(`document.querySelector('#second').setConfig({version:6,account:'next',options:{animate:false}})`), true);
  assert.ok(await evaluate(`window.componentEvents.some(event => event.type === 'scene-change' && event.detail.scene.metadata.account === 'next')`));
  assert.equal(await evaluate(`document.querySelector('#second').loadScene({version:99})`), false);
  assert.ok(await evaluate(`window.componentEvents.some(event => event.type === 'error')`));
  await evaluate(`window.detached = document.querySelector('#second'); detached.remove(); document.body.append(detached);`);
  await waitFor(`Boolean(document.querySelector('#second').shadowRoot.querySelector('main').constellation)`);
  await evaluate(`(async()=>{ window.groupedView = document.querySelector('#view'); await groupedView.setConfig({version:7,account:'example',projectFamilies:{'sample-family':{label:'Sample Family',members:['example/compiler','example/runtime','example/studio']}}}); groupedView.semanticLevel='groups'; })()`);
  await waitFor(`Boolean(groupedView.shadowRoot.querySelector('.star[data-repo="group:user:sample-family"]'))`);
  await evaluate(`groupedView.selectNode('group:user:sample-family',{focus:false})`);
  assert.ok(await evaluate(`groupedView.shadowRoot.querySelector('[data-details]').textContent.includes('Why grouped?')`));
  const groupInspector = await evaluate(`groupedView.shadowRoot.querySelector('[data-details]').textContent`);
  assert.match(groupInspector, /Grouping reason/);
  assert.match(groupInspector, /Defined by you/);
  assert.match(groupInspector, /Common characteristics/);
  assert.match(groupInspector, /Languages/);
  assert.match(groupInspector, /\d+ \/ \d+/);
  await evaluate(`groupedView.shadowRoot.querySelector('[data-semantic-expand]').focus()`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter" });
  await waitFor(`groupedView.shadowRoot.querySelectorAll('.star').length === 3`);
  assert.equal(await evaluate(`groupedView.scene.nodes.length`), 3, 'canonical scene remains at project level');
  await evaluate(`groupedView.selectNode('example/compiler',{focus:false})`);
  const projectInspector = await evaluate(`groupedView.shadowRoot.querySelector('[data-details]').textContent`);
  assert.match(projectInspector, /Why is this here\?/);
  assert.doesNotMatch(projectInspector, /Grouping reason/);
  assert.ok(await evaluate(`Boolean(groupedView.shadowRoot.querySelector('[data-semantic-collapse]'))`));
  await evaluate(`groupedView.shadowRoot.querySelector('[data-semantic-collapse]').click()`);
  await waitFor(`Boolean(groupedView.shadowRoot.querySelector('.star[data-repo="group:user:sample-family"]'))`);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate(`window.semanticEvents = []; groupedView.addEventListener('semantic-level-change', event => semanticEvents.push(event.detail)); groupedView.semanticLevel = 'auto'; groupedView.selectNode('group:user:sample-family', {focus:false}); const base = groupedView.scene.viewport.viewBox; groupedView.shadowRoot.querySelector('main').constellation.setCamera([base[0],base[1],base[2]/2,base[3]/2]);`);
  await waitFor(`groupedView.shadowRoot.querySelectorAll('.star[data-repo^="example/"]').length === 3`);
  assert.equal(await evaluate(`groupedView.semanticLevel`), 'auto');
  assert.equal(await evaluate(`semanticEvents.at(-1)?.current`), 'projects');
  assert.equal(await evaluate(`groupedView.shadowRoot.querySelector('svg').animationsPaused()`), true);
  assert.ok(await evaluate(`groupedView.shadowRoot.querySelector('[data-details]').textContent.includes('Sample Family')`));
  await evaluate(`groupedView.selectNode('example/compiler',{focus:false}); groupedView.shadowRoot.querySelector('main').constellation.setCamera([base[0],base[1],base[2],base[3]]); window.expectedCamera = groupedView.shadowRoot.querySelector('main').constellation.camera;`);
  await waitFor(`Boolean(groupedView.shadowRoot.querySelector('.star[data-repo="group:user:sample-family"]'))`);
  assert.equal(await evaluate(`groupedView.selection.start`), 'group:user:sample-family');
  assert.equal(await evaluate(`semanticEvents.at(-1)?.current`), 'groups');
  assert.deepEqual(await evaluate(`groupedView.shadowRoot.querySelector('main').constellation.camera`), await evaluate(`expectedCamera`));
  await evaluate(`groupedView.semanticLevel = 'groups'; groupedView.shadowRoot.querySelector('main').constellation.setCamera([base[0],base[1],base[2]/2,base[3]/2]);`);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.ok(await evaluate(`groupedView.shadowRoot.querySelector('.star[data-repo="group:user:sample-family"]')`), 'explicit Groups mode ignores camera scale');
  await evaluate(`groupedView.semanticLevel = 'projects'; groupedView.shadowRoot.querySelector('main').constellation.setCamera([base[0],base[1],base[2]*2,base[3]*2]);`);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.ok(await evaluate(`groupedView.shadowRoot.querySelector('.star[data-repo="example/compiler"]')`), 'explicit Projects mode ignores camera scale');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await evaluate(`window.lazyView = document.createElement('constellation-view'); lazyView.setAttribute('loading','lazy'); lazyView.style.display='none'; lazyView.scene=document.querySelector('#view').scene; document.body.append(lazyView);`);
  assert.equal(await evaluate(`lazyView.shadowRoot.querySelector('main')`), null);
  await evaluate(`lazyView.style.display='block'; lazyView.scrollIntoView()`);
  await waitFor(`Boolean(lazyView.shadowRoot.querySelector('main')?.constellation)`);
  await evaluate(`window.originalFetch = window.fetch; window.cancelledLoads = 0; window.fetch = (url, options) => {
    if (String(url).includes('/slow-scene')) return new Promise((resolve,reject) => options.signal.addEventListener('abort', () => { cancelledLoads++; reject(new DOMException('Aborted','AbortError')); }));
    if (String(url).includes('/fixture-scene')) return Promise.resolve(new Response(JSON.stringify(document.querySelector('#view').scene)));
    return originalFetch(url,options);
  }; lazyView.setAttribute('src','/slow-scene'); lazyView.setAttribute('src','/fixture-scene');`);
  await waitFor(`lazyView.cacheStatistics.sources === 1`);
  assert.equal(await evaluate('cancelledLoads'), 1);
  await evaluate(`lazyView.setAttribute('src','/slow-scene'); lazyView.remove();`);
  assert.equal(await evaluate('cancelledLoads'), 2);
  await evaluate(`lazyView.removeAttribute('src'); document.body.append(lazyView); lazyView.scrollIntoView()`);
  await waitFor(`Boolean(lazyView.shadowRoot.querySelector('main')?.constellation)`);
  assert.equal(await evaluate('lazyView.cacheStatistics.pipeline.entries'), 0);
  await evaluate('window.fetch = originalFetch');
  assert.deepEqual(errors, []);
});
