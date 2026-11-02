import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProjectConstellation, createProjectConstellationHierarchy } from '../src/core-api.mjs';
import { createScene } from '../src/core-api.mjs';
import { renderSceneHTML } from '../src/core-api.mjs';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';

test('offline project constellation opens, explains structure, and restores parent camera and selection', { skip: !browser, timeout: 120000 }, async t => {
  const model=createProjectConstellation({projectId:'owner/repo',ref:'main',commit:'a'.repeat(40),tree:[
    {path:'package.json',type:'blob'},{path:'src',type:'tree'},{path:'src/index.js',type:'blob'},{path:'src/util.js',type:'blob'},
  ],contents:{'package.json':JSON.stringify({exports:{'.':'./src/index.js'}}),'src/index.js':"import './util.js';",'src/util.js':'export const ready = true;'}});
  const parent=createScene('owner',[{full_name:'owner/repo',name:'repo',language:'JavaScript'}],{animate:false});
  const hierarchy=createProjectConstellationHierarchy(parent,'owner/repo',model);
  const directory=await mkdtemp(join(tmpdir(),'constellation-project-browser-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'project.html');await writeFile(file,renderSceneHTML(hierarchy));
  const {evaluate,waitFor,errors}=await openBrowser(t,pathToFileURL(file).href);
  await waitFor(`Boolean(document.querySelector('main')?.constellation)`);
  const parentState=await evaluate(`(()=>{const nav=document.querySelector('main').constellation;nav.selectNode('owner/repo',{focus:false});const view=nav.camera;nav.setCamera([view[0],view[1],view[2]/2,view[3]/2]);return {camera:nav.camera,selection:nav.selectionState.start};})()`);
  assert.equal(parentState.selection,'owner/repo');
  await evaluate(`document.querySelector('main').constellation.openChild('project:owner/repo')`);
  await waitFor(`document.querySelector('main')?.constellation?.scenePath?.length===2`);
  assert.equal(await evaluate(`Boolean(document.querySelector('.star[data-kind="entry-point"]'))`),true);
  assert.equal(await evaluate(`document.querySelector('[data-structural-kind="imports"] title')?.textContent`),"index.js imports ./util.js from src/index.js.");
  await evaluate(`document.querySelector('main').constellation.back()`);
  await waitFor(`document.querySelector('main')?.constellation?.scenePath?.length===1`);
  assert.deepEqual(await evaluate(`({camera:document.querySelector('main').constellation.camera,selection:document.querySelector('main').constellation.selectionState.start})`),parentState);
  assert.deepEqual(errors,[]);
});
