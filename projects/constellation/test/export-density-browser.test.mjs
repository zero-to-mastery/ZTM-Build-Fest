import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';
import { createScene } from '../src/core-api.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { semanticGraphFromScene } from '../src/semantic-graph.mjs';
import { generateStoryCandidates } from '../src/story-candidates.mjs';

test('README grouped SVG keeps group, label and weighted-edge hierarchy when rasterized to PNG', { skip: !browser, timeout: 120000 }, async t => {
  const repositories = Array.from({ length: 24 }, (_, i) => ({ full_name: `raster/project-${i}`, name: `project-${i}`, language: 'Rust', topics: ['readme'], stargazers_count: i * 100 }));
  const families = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`family-${i}`, { label: `Family ${i}`, members: repositories.slice(i * 4, i * 4 + 4).map(repo => repo.full_name) }]));
  const scene = createScene('raster', repositories, { exportProfile: 'readme', animate: false, projectFamilies: families });
  scene.viewport.width = 720;
  const svg = renderSceneSVG(scene, { semanticLevel: 'groups' });
  const directory = await mkdtemp(join(tmpdir(), 'constellation-density-png-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'grouped.svg');
  await writeFile(file, svg);
  const { evaluate } = await openBrowser(t, pathToFileURL(file).href);
  const raster = await evaluate(`(async()=>{const source=document.documentElement.outerHTML;const url=URL.createObjectURL(new Blob([source],{type:'image/svg+xml'}));try{const image=new Image();image.src=url;await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject});const canvas=new OffscreenCanvas(image.naturalWidth*2,image.naturalHeight*2);const context=canvas.getContext('2d');context.drawImage(image,0,0,canvas.width,canvas.height);const blob=await canvas.convertToBlob({type:'image/png'});return{width:image.naturalWidth,height:image.naturalHeight,pngBytes:blob.size,groupLabels:document.querySelectorAll('.repo-label[data-repo^="group:"]:not([style*="display:none"])').length,legend:Boolean(document.querySelector('.static-export-legend')),groupNodes:document.querySelectorAll('.star[data-kind="semantic-group"]').length}}finally{URL.revokeObjectURL(url)}})()`);
  assert.equal(raster.width, 720);
  assert.ok(raster.pngBytes > 1000);
  assert.equal(raster.groupNodes, 6);
  assert.equal(raster.groupLabels, 6);
  assert.equal(raster.legend, true);
});

test('Profile Story relationship labels stay bounded and the legend remains inside the static SVG at README widths', { skip: !browser, timeout: 120000 }, async t => {
  const repositories = Array.from({ length: 12 }, (_, i) => ({ full_name: `story/project-${i}`, name: i < 2 ? `A deliberately long project name ${i}` : `Project ${i}`, language: ['Rust', 'TypeScript', 'Python'][i % 3], topics: ['shared-topic', 'shared-language', i % 2 ? 'tooling' : 'visualization'] }));
  const families = { first: { label: 'First family', members: repositories.slice(0, 6).map(repo => repo.full_name) }, second: { label: 'Second family', members: repositories.slice(6).map(repo => repo.full_name) } };
  const options = { nodeMode: 'repositories', showOther: true, animate: false, projectFamilies: families, projectRelationships: [[repositories[0].full_name, repositories[1].full_name], [repositories[8].full_name, repositories[9].full_name]] };
  const graph = semanticGraphFromScene(createScene('story', repositories, options));
  const scene = generateStoryCandidates(graph, options).find(candidate => candidate.id === 'projects').scene;
  const directory = await mkdtemp(join(tmpdir(), 'constellation-story-svg-'));
  const file = join(directory, 'story.svg');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(file, renderSceneSVG(scene));
  const { evaluate } = await openBrowser(t, pathToFileURL(file).href);
  const result = await evaluate(`(()=>{const svg=document.documentElement;const widths=[480,900];return widths.map(width=>{svg.style.width=width+'px';svg.style.height='auto';const legend=svg.querySelector('.story-relationship-legend');const labels=svg.querySelectorAll('.relationship-evidence-label');if(!legend)return{width,hasLegend:false,labelCount:labels.length};const root=svg.getBoundingClientRect(),box=legend.getBoundingClientRect();return{width,hasLegend:true,labelCount:labels.length,inside:box.left>=root.left-1&&box.right<=root.right+1&&box.top>=root.top-1&&box.bottom<=root.bottom+1}})})()`);
  assert.deepEqual(result.map(item => item.width), [480, 900]);
  assert.ok(result.every(item => item.hasLegend && item.inside), JSON.stringify(result));
  assert.ok(result.every(item => item.labelCount <= 3), JSON.stringify(result));
});
