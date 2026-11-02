import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticLayout } from '../src/engine.mjs';
import { createScene, renderConstellation } from '../src/constellation.mjs';
import { serializeConfig, parseConfig } from '../src/config-schema.mjs';
import { encodeShare, decodeShare } from '../src/share-link.mjs';
import { renderWorkflow } from '../src/export.mjs';
import { explainGraphic, semanticActive } from '../src/semantic-studio.mjs';
import { lockRandomParts, randomizeParts } from '../src/randomize-parts.mjs';
import { randomizeDesign } from '../src/design-randomizer.mjs';

const repos = [
  {name:'ui',full_name:'demo/ui',language:'HTML',topics:['react','api'],created_at:'2019-01-01',updated_at:'2026-09-01',stargazers_count:5},
  {name:'tool',full_name:'demo/tool',language:'Rust',topics:['cli'],created_at:'2020-01-01',updated_at:'2026-01-01'},
  {name:'unknown',full_name:'demo/unknown'},
];
const base={arrangement:'rings',ringMeaning:'capability',accountSun:'profile',referenceDate:'2026-10-01T00:00:00Z',maxRepos:10,nodeSize:'uniform'};
test('WASM semantic API matches native contract and validates input bounds',()=>{
  const input={mode:'capability',reference_day:20000,repositories:[{name:'b',topics:['api','react']},{name:'a'}]};
  const a=semanticLayout(input);
  assert.deepEqual(a,semanticLayout({...input,repositories:[...input.repositories].reverse()}));
  assert.equal(a.placements[0].category,'no evidence');
  assert.equal(a.placements[1].category,'interface');
  assert.equal(a.placements[1].band,1);
  assert.deepEqual(a.placements[1].position,[450,159.28]);
  assert.equal(a.profile.dimensions[0].evidence[0].repository,'b');
  assert.throws(()=>semanticLayout({...input,repositories:Array.from({length:257},(_,i)=>({name:String(i)}))}),/256/);
  assert.throws(()=>semanticLayout({...input,mode:'invented'}),/Unknown/);
  assert.throws(()=>semanticLayout({...input,rotations:[1,2,3,Infinity]}));
});
test('semantic geometry reaches scene and static SVG with accessible evidence and labels',()=>{
  for(const ringMeaning of ['capability','showcase','activity','era']){
    const options={...base,ringMeaning,projectShowcase:{'demo/ui':{role:'featured'}},semanticLegend:true};
    const scene=createScene('demo',repos,options);
    for(const p of scene.semantic.placements){
      const n=scene.nodes.find(n=>n.id===p.repository);
      assert.deepEqual([n.geometry.x,n.geometry.y],p.position);
      assert.ok(p.position.every(Number.isFinite));
    }
    const svg=renderConstellation('demo',repos,options);
    assert.match(svg,/class="semantic-rings"/);
    assert.match(svg,/class="semantic-labels"/);
    assert.equal((svg.match(/class="profile-segment"/g)||[]).length,6);
    assert.match(svg,/tabindex="0" role="button"/);
    assert.match(svg,/demo\/ui.*topic:/);
    assert.match(svg,/class="semantic-legend"/);
    assert.match(svg,/decorative, not activity/);
    assert.doesNotMatch(svg,/<script|NaN|Infinity/);
  }
  const manual=createScene('demo',repos,{...base,starPositions:{'demo/ui':{x:100,y:120}}});
  assert.equal(manual.nodes.find(n=>n.id==='demo/ui').geometry.x,100);
});
test('semantic configuration survives config, shares and workflows; old identity stays exact',()=>{
  const restored=parseConfig(serializeConfig('demo',{...base,semanticLegend:true}));
  assert.equal(restored.options.ringMeaning,'capability');
  assert.equal(restored.options.accountSun,'profile');
  assert.equal(decodeShare(encodeShare('https://example.com','demo',restored.options)).options.semanticLegend,true);
  assert.match(renderWorkflow('demo',restored.options),/ringMeaning/);
  const old=createScene('demo',repos,{arrangement:'rings'});
  const identity=createScene('demo',repos,{arrangement:'rings',ringMeaning:'identity'});
  assert.deepEqual(old.nodes,identity.nodes);
  assert.deepEqual(old.geometry,identity.geometry);
  assert.throws(()=>parseConfig({version:7,account:'demo',options:{ringMeaning:'random'}}),/ringMeaning/);
});
test('explanations follow actual mappings and disclose inactive meanings and overrides',()=>{
  assert.match(explainGraphic(base).join(' '),/uniform; no data meaning/);
  assert.match(explainGraphic({...base,arrangement:'galaxy'}).join(' '),/apply only/);
  assert.match(explainGraphic({...base,ringMeaning:'activity'}).join(' '),/not GitHub contribution/);
  assert.match(explainGraphic({...base,nodeColors:{x:'#ffffff'}}).join(' '),/override/);
});
test('locks preserve authored roles, semantic composition, repositories and animation across draws',()=>{
  const recipe=randomizeDesign('v6:m000-y2026-f2026-e0-semantic');
  const current={...recipe,...base,projectShowcase:{'demo/ui':{role:'featured'}},includeRepos:['demo/ui'],animate:true};
  const result=lockRandomParts(current,recipe,{semantics:true,repositories:true,animations:true});
  assert.equal(result.arrangement,'rings');assert.equal(result.accountSun,'profile');assert.equal(result.ringMeaning,'capability');
  assert.deepEqual(result.includeRepos,current.includeRepos);assert.deepEqual(result.projectShowcase,current.projectShowcase);assert.equal(result.animate,true);
  assert.equal(result.designCode,undefined);
  assert.deepEqual(randomizeParts(current,recipe,{semantics:true},repos),randomizeParts(current,recipe,{semantics:true},repos));
  const fromTemporal = randomizeParts({...current,temporalStack:{enabled:true},layoutEngine:'custom:test'},recipe,{semantics:true},repos);
  assert.equal(fromTemporal.temporalStack.enabled,false);
  assert.equal(fromTemporal.layoutEngine,undefined);
  assert.equal(semanticActive({...current,temporalStack:{enabled:true}}),false);
});
