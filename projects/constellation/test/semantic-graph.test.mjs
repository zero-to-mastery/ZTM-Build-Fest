import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from '../src/constellation.mjs';
import { createProjectConstellation } from '../src/project-constellation.mjs';
import { SEMANTIC_GRAPH_LIMITS, semanticGraphFromScene, semanticGraphFromProjectConstellation, validateSemanticGraph, serializeSemanticGraph, parseSemanticGraph, semanticGraphFingerprint, semanticGraphExportInfo, projectSemanticGraphToScene } from '../src/semantic-graph.mjs';
import { validateScene } from '../src/scene.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { repositories as recruiterRepositories } from './fixtures/recruiter.mjs';
import { buildSemanticHierarchy, projectSemanticLevel, expandGroup } from '../src/semantic-groups.mjs';
import { renderSemanticMarkdown } from '../src/semantic-markdown.mjs';
import { renderSceneHTML } from '../src/renderer-html.mjs';

test('developer semantic graphs ignore Scene presentation and ordering', () => {
  const scene=createScene('octocat',[{full_name:'octocat/alpha',name:'alpha',language:'JavaScript',topics:['tooling']},{full_name:'octocat/beta',name:'beta',language:'Rust',topics:[]}]);
  const graph=semanticGraphFromScene(scene);
  const changed=structuredClone(scene); changed.nodes.reverse(); changed.edges.reverse(); changed.nodes.forEach((node,i)=>{node.geometry.x+=50+i;node.style.color='#abcdef';}); changed.viewport.width+=200;
  assert.deepEqual(semanticGraphFromScene(changed),graph);
  assert.deepEqual(semanticGraphFromScene(createScene('octocat',[{full_name:'octocat/beta',name:'beta',language:'Rust',topics:[]},{full_name:'octocat/alpha',name:'alpha',language:'JavaScript',topics:['tooling']} ])),graph);
  const projected=projectSemanticGraphToScene(graph); assert.equal(validateScene(projected).valid,true); assert.match(renderSceneSVG(projected),/<svg/);
  assert.equal(graph.nodes.some(n=>'geometry' in n||'style' in n),false);
});

test('developer portable artifact round trip preserves canonical bytes, Markdown and offline projections', () => {
  const records=recruiterRepositories.slice(0,12);
  const scene=createScene('alice',records,{projectFamilies:{studio:{label:'Studio',members:records.slice(0,4).map(r=>r.full_name)}},projectRelationships:[[records[0].full_name,records[1].full_name]]});
  const graph=semanticGraphFromScene(scene), json=serializeSemanticGraph(graph), imported=parseSemanticGraph(json);
  assert.equal(serializeSemanticGraph(imported),json);
  assert.equal(semanticGraphFingerprint(imported),semanticGraphFingerprint(graph));
  assert.deepEqual(imported.nodes.map(n=>n.id),graph.nodes.map(n=>n.id));
  assert.deepEqual(imported.edges.map(e=>e.id),graph.edges.map(e=>e.id));
  assert.deepEqual(imported.groups.map(g=>g.id),graph.groups.map(g=>g.id).sort());
  assert.deepEqual(imported.evidence,graph.evidence);
  assert.deepEqual(imported.subject,graph.subject);
  assert.deepEqual(imported.statistics,graph.statistics);
  for(const detail of ['summary','standard','detailed']) assert.equal(renderSemanticMarkdown(imported,{detail}),renderSemanticMarkdown(graph,{detail}));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error('network should not be used');};
  try {
    const projected=projectSemanticGraphToScene(imported);
    assert.equal(validateScene(projected).valid,true);
    assert.match(renderSceneSVG(projected),/<svg/);
    assert.match(renderSceneHTML(projected),/<!doctype html/i);
    assert.equal(semanticGraphFingerprint(imported),semanticGraphFingerprint(graph));
  } finally { globalThis.fetch=originalFetch; }
});

test('portable artifact metadata and import errors are bounded and explicit', () => {
  const graph=semanticGraphFromScene(createScene('alice',[{full_name:'alice/project',name:'Project',language:'Rust'},{full_name:'community/tool',name:'Tool',language:'Rust'}]));
  const info=semanticGraphExportInfo(graph);
  assert.equal(info.filename,'alice.semantic-graph.json');
  assert.equal(info.mediaType,'application/json');
  assert.equal(info.fingerprint,semanticGraphFingerprint(graph));
  assert.throws(()=>parseSemanticGraph('{'),/JSON|position/i);
  assert.throws(()=>parseSemanticGraph(JSON.stringify({kind:'constellation-semantic-graph',version:2})),/Unsupported Semantic Graph version/);
  const secret=structuredClone(graph);secret.nodes[0].label='ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  assert.throws(()=>parseSemanticGraph(JSON.stringify(secret)),/unsafe|secret-like/i);
  const endpoint=structuredClone(graph);endpoint.edges[0].to='missing:node';
  assert.throws(()=>parseSemanticGraph(JSON.stringify(endpoint)),/missing endpoint/i);
  assert.throws(()=>parseSemanticGraph(' '.repeat(SEMANTIC_GRAPH_LIMITS.jsonBytes+1)),/16 MiB/);
  assert.throws(()=>parseSemanticGraph('\uFEFF'+serializeSemanticGraph(graph)),/JSON|position/i);
});

test('canonical semantic truth survives collapsed, expanded, filtered and presentation projections', () => {
  const families = { studio: { label: 'Studio', members: recruiterRepositories.slice(0, 4).map(repo => repo.full_name) }, tools: { label: 'Tools', members: recruiterRepositories.slice(5, 8).map(repo => repo.full_name) } };
  const base = createScene('alice', recruiterRepositories, { projectFamilies: families, projectRelationships: [['alice/atlas', 'alice/atlas-mobile']] });
  const hierarchy = buildSemanticHierarchy(base);
  const grouped = projectSemanticLevel(base, 'groups', { hierarchy });
  const firstGroup = hierarchy.groups.find(group => group.provenance === 'user');
  const expanded = expandGroup(grouped, hierarchy, firstGroup.id);
  const presentation = structuredClone(base); presentation.presentation.options.semanticZoom = { enabled: true, level: 'groups' };
  const graphs = [base, grouped, expanded, presentation].map(semanticGraphFromScene);
  for (const graph of graphs.slice(1)) assert.deepEqual(graph, graphs[0]);
  assert.equal(graphs[0].nodes.some(node => node.id === 'community/query-engine' && node.kind === 'project'), true);
  assert.equal(graphs[0].edges.some(edge => edge.kind === 'repository-owner' && edge.from === 'community/query-engine'), false);
  assert.equal(graphs[0].edges.some(edge => edge.kind === 'repository-owner' && edge.from === 'alice/atlas'), true);
});

test('unsafe optional repository metadata is omitted while identity remains intact', () => {
  const scene = createScene('alice', [{ full_name: 'alice/safe-id', name: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', description: 'x'.repeat(9000), language: 'Rust', topics: ['safe', 'github_pat_abcdefghijklmnopqrstuvwxyz0123456789'] }]);
  const graph = semanticGraphFromScene(scene);
  const project = graph.nodes.find(node => node.kind === 'project');
  assert.equal(project.id, 'alice/safe-id');
  assert.equal(project.label, project.id);
  assert.equal('description' in project.properties, false);
  assert.deepEqual(project.properties.topics, ['safe']);
  assert.equal(JSON.stringify(graph).includes('ghp_'), false);
});

test('group inventory, group nodes and member edges reject contradictory portable truth', () => {
  const records = recruiterRepositories.filter(repo => repo.full_name.startsWith('alice/')).slice(0, 4);
  const scene = createScene('alice', records, { projectFamilies: { studio: { label: 'Studio', members: records.map(repo => repo.full_name) } } });
  const graph = semanticGraphFromScene(scene);
  const missingNode = structuredClone(graph); missingNode.nodes = missingNode.nodes.filter(node => node.id !== missingNode.groups[0].id); missingNode.statistics.nodeCount--;
  assert.equal(validateSemanticGraph(missingNode).valid, false);
  const missingEdge = structuredClone(graph); missingEdge.edges = missingEdge.edges.filter(edge => edge.kind !== 'member-of'); missingEdge.statistics.edgeCount = missingEdge.edges.length;
  assert.equal(validateSemanticGraph(missingEdge).valid, false);
  const mismatchedLabel = structuredClone(graph); mismatchedLabel.nodes.find(node => node.id === mismatchedLabel.groups[0].id).label = 'Different';
  assert.equal(validateSemanticGraph(mismatchedLabel).valid, false);
  const extraEdge = structuredClone(graph); extraEdge.edges.push({ ...structuredClone(extraEdge.edges.find(edge => edge.kind === 'member-of')), id: 'extra-membership', from: 'alice/atlas', to: 'developer:alice' }); extraEdge.statistics.edgeCount++;
  assert.equal(validateSemanticGraph(extraEdge).valid, false);
});

test('project graph preserves structural facts, ref, commit and truncation through JSON', () => {
  const model=createProjectConstellation({projectId:'owner/repo',ref:'main',commit:'abcdef1234567',visibility:'private',tree:[{path:'',type:'tree'},{path:'packages',type:'tree'},{path:'packages/core',type:'tree'},{path:'packages/core/package.json',type:'blob'},{path:'packages/core/src',type:'tree'},{path:'packages/core/src/index.js',type:'blob'}],contents:{'packages/core/package.json':'{"name":"repo","main":"src/index.js"}','packages/core/src/index.js':'export default 1;'}});
  const graph=semanticGraphFromProjectConstellation(model);
  assert.equal(graph.project.provenance.ref,'main'); assert.equal(graph.project.provenance.commit,'abcdef1234567'); assert.equal(graph.project.provenance.visibility,'private');
  assert.ok(graph.nodes.some(n=>n.kind==='project-root')); assert.ok(graph.nodes.some(n=>n.kind==='package')); assert.ok(graph.edges.some(e=>e.kind==='entry-of'));
  const roundTrip=parseSemanticGraph(serializeSemanticGraph(graph)); assert.deepEqual(roundTrip,graph);
  assert.equal(serializeSemanticGraph(roundTrip),serializeSemanticGraph(graph));
  assert.equal(semanticGraphFingerprint(roundTrip),semanticGraphFingerprint(graph));
  assert.equal(renderSemanticMarkdown(roundTrip,{detail:'detailed'}),renderSemanticMarkdown(graph,{detail:'detailed'}));
  const projected=projectSemanticGraphToScene(graph); assert.equal(validateScene(projected).valid,true); assert.match(renderSceneSVG(projected),/<svg/);
  assert.equal(JSON.stringify(graph).includes('export default 1'),false);
  const bounded=createProjectConstellation({projectId:'owner/large',tree:[{path:'',type:'tree'},{path:'a',type:'tree'},{path:'b',type:'tree'}]},{nodes:2});
  assert.equal(semanticGraphFromProjectConstellation(bounded).statistics.truncated,true);
});

test('semantic graph validator rejects duplicate IDs, secrets, endpoints and count mismatch', () => {
  const graph=semanticGraphFromScene(createScene('octocat',[{full_name:'octocat/alpha',name:'alpha'}]));
  const duplicate=structuredClone(graph); duplicate.nodes.push(structuredClone(duplicate.nodes[0])); assert.equal(validateSemanticGraph(duplicate).valid,false);
  const secret=structuredClone(graph); secret.nodes[0].label='ghp_abcdefghijklmnopqrstuvwxyz0123456789'; assert.equal(validateSemanticGraph(secret).valid,false);
  const stats=structuredClone(graph); stats.statistics.nodeCount++; assert.equal(validateSemanticGraph(stats).valid,false);
  const broken=structuredClone(graph); broken.edges.push({id:'bad',kind:'member-of',from:'missing',to:broken.nodes[0].id,provenance:[{category:'derived',source:'test'}],evidence:[]}); broken.statistics.edgeCount++; assert.equal(validateSemanticGraph(broken).valid,false);
});
