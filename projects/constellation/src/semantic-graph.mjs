import { createScene } from './constellation.mjs';
import { validateScene } from './scene.mjs';
import { createProjectConstellationScene } from './project-constellation-scene.mjs';
import { validateProjectConstellation, PROJECT_CONSTELLATION_VERSION } from './project-constellation.mjs';
import { validateEvidence, EVIDENCE_VERSION, safeEvidenceText } from './evidence.mjs';
import { buildSemanticHierarchy } from './semantic-groups.mjs';
import { projectSemanticLevel } from './semantic-groups.mjs';

export const SEMANTIC_GRAPH_VERSION = 1;
export const SEMANTIC_GRAPH_LIMITS = Object.freeze({ nodes: 4096, edges: 16384, groups: 256, memberships: 32768, string: 4096, jsonBytes: 16 * 1024 * 1024, evidenceFacts: 32768 });
export const SEMANTIC_NODE_KINDS = Object.freeze(['developer','project','semantic-group','language','topic','project-root','package','directory','module','entry-point']);
export const SEMANTIC_EDGE_KINDS = Object.freeze(['member-of','repository-owner','uses-language','has-topic','project-relationship','contains','workspace-member','entry-of','imports']);
const safeText = value => typeof value === 'string' && value.length > 0 && value.length <= SEMANTIC_GRAPH_LIMITS.string && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) && !/(?:gh[pousr]_[A-Za-z\d]{20,}|github_pat_[A-Za-z\d_]{20,}|bearer\s+\S+)/i.test(value);
const obj = value => value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const clone = value => JSON.parse(JSON.stringify(value));
const idHash = value => { let h=2166136261; for (const c of value) h=Math.imul(h^c.codePointAt(0),16777619); return (h>>>0).toString(16).padStart(8,'0'); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : obj(value) ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
const canonicalGraph = graph => {
  const value=canonical(graph);
  for(const key of ['nodes','edges','groups']) if(Array.isArray(value[key])) value[key].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  if(value.evidence){value.evidence.facts.sort((a,b)=>a.id.localeCompare(b.id));value.evidence.subjects.sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));for(const s of value.evidence.subjects)s.facts.sort();}
  return value;
};
const validProvenance = p => obj(p) && ['source','user','derived'].includes(p.category) && safeText(p.source) && Object.keys(p).every(k=>['category','source','ref','commit'].includes(k)) && (p.ref===undefined||safeText(p.ref)) && (p.commit===undefined||typeof p.commit==='string'&&/^[a-f\d]{7,64}$/i.test(p.commit));
function safeTree(value, depth=0) {
  if (depth > 8) throw new Error('Semantic graph value exceeds nesting bounds.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { if (value.length > SEMANTIC_GRAPH_LIMITS.string || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || /(?:gh[pousr]_[A-Za-z\d]{20,}|github_pat_[A-Za-z\d_]{20,}|bearer\s+\S+)/i.test(value)) throw new Error('Semantic graph contains unsafe or oversized text.'); return value; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Semantic graph contains a non-finite number.'); return value; }
  if (Array.isArray(value)) { if(value.length>4096) throw new Error('Semantic graph value exceeds collection bounds.'); return value.map(x=>safeTree(x,depth+1)); }
  if (!obj(value)) throw new Error('Semantic graph must contain plain JSON values.');
  const keys=Object.keys(value); if(keys.length>256 || keys.some(k=>['__proto__','constructor','prototype'].includes(k)||!safeText(k))) throw new Error('Semantic graph contains an unsafe key.');
  return Object.fromEntries(keys.sort().map(k=>[k,safeTree(value[k],depth+1)]));
}
function finish(subject, nodes, edges, extras={}) {
  nodes.sort((a,b)=>a.id.localeCompare(b.id)); edges.sort((a,b)=>a.id.localeCompare(b.id));
  const graph={ version:SEMANTIC_GRAPH_VERSION, kind:'constellation-semantic-graph', subject, nodes, edges, ...extras };
  graph.statistics={ nodeCount:nodes.length, edgeCount:edges.length, truncated:extras.statistics?.truncated===true, limitations:[...(extras.statistics?.limitations||[])].sort() };
  const result=validateSemanticGraph(graph); if(!result.valid) throw new Error(`Invalid semantic graph: ${result.errors.join(' ')}`);
  return graph;
}
function portableEvidence(attachment) {
  const source=attachment&&validateEvidence(attachment)?attachment:{version:EVIDENCE_VERSION,facts:[],subjects:[]};
  const byKey=new Map(); for(const fact of source.facts){const key=JSON.stringify([fact.kind,fact.value,fact.provenance,fact.source||null]);byKey.set(fact.id,key);}
  const stableIdByKey=new Map(); for(const key of [...new Set(byKey.values())].sort()) stableIdByKey.set(key,`fact:${idHash(key)}${idHash(`${key}#`)}`);
  const facts=[...stableIdByKey].map(([key,id])=>{const [kind,value,provenance,sourceName]=JSON.parse(key);return {id,kind,value,provenance,...(sourceName?{source:sourceName}:{})};}).sort((a,b)=>a.id.localeCompare(b.id));
  const subjects=source.subjects.map(s=>({kind:s.kind,id:s.id,facts:[...new Set(s.facts.map(id=>stableIdByKey.get(byKey.get(id))).filter(Boolean))].sort()})).sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  return {evidence:{version:EVIDENCE_VERSION,facts,subjects},subjectFacts:new Map(subjects.map(s=>[s.id,s.facts]))};
}
function projectMetadataFromScene(scene) {
  const canonical=scene.semanticGroups?.canonical;
  const hierarchy=canonical?null:buildSemanticHierarchy(scene);
  const account=canonical?.account || scene.metadata?.account || scene.presentation?.graph?.focus || 'unknown';
  const projects=canonical?.projects || scene.nodes.filter(n=>n.metadata?.nodeKind==='repository'||n.metadata?.full_name?.includes('/')).map(n=>({id:n.metadata.full_name,name:n.metadata.name,description:n.metadata.description,url:n.metadata.html_url,created_at:n.metadata.created_at,updated_at:n.metadata.updated_at,language:n.metadata.language,topics:n.metadata.topics,source:n.metadata.pluginSource||n.metadata.source,family:n.metadata.projectFamily}));
  const rawGroups=canonical?.groups || hierarchy.groups.map(g=>({id:g.id,kind:g.kind,label:g.label,provenance:g.provenance,basis:g.basis,members:g.members}));
  const groups=rawGroups.map(g=>({id:g.id,kind:g.kind,label:safeEvidenceText(g.label,160)?g.label:(g.kind==='project-family'?'Project family':'Repository owner group'),provenance:g.provenance,basis:(g.basis||[]).filter(value=>safeEvidenceText(value,160)).slice(0,16),members:[...g.members].sort()}));
  const {evidence,subjectFacts}=portableEvidence(canonical?.evidence || scene.evidence);
  const nodes=[{id:`developer:${account}`,kind:'developer',label:account,properties:{},provenance:[{category:'source',source:'github-profile'}],evidenceIds:[]}],edges=[];
  const safeProjects=projects.map(p=>{
    const id=p.id;
    const optional=(value,max=160)=>safeEvidenceText(value,max)?value:undefined;
    const curatedRole=optional(scene.presentation?.options?.projectShowcase?.[id]?.role,32);
    const language=optional(p.language), topics=(Array.isArray(p.topics)?p.topics:[]).filter(value=>safeEvidenceText(value,160)).slice(0,32);
    return {id,label:optional(p.name)||id,properties:{...(optional(p.description)?{description:optional(p.description)}:{}),...(optional(p.url)?{url:optional(p.url)}:{}),...(optional(p.created_at)?{createdAt:optional(p.created_at)}:{}),...(optional(p.updated_at)?{updatedAt:optional(p.updated_at)}:{}),...(curatedRole?{curatedRole}:{}),...(language?{language}:{}),...(topics.length?{topics}:{}),...(optional(p.family)?{family:optional(p.family)}:{})},source:optional(p.source,80)||'github'};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  for(const p of safeProjects){
    const {id,label,properties,source}=p;
    nodes.push({id,kind:'project',label,properties:safeTree(properties),provenance:[{category:'source',source}],evidenceIds:subjectFacts.get(id)||[]});
    const namespace=id.split('/')[0];
    if(namespace.toLocaleLowerCase('en-US')===String(account).toLocaleLowerCase('en-US')) edges.push({id:`owner:${idHash(`repository-owner:${id}:${account}`)}`,kind:'repository-owner',from:id,to:`developer:${account}`,provenance:[{category:'derived',source:'repository-owner'}],evidence:[]});
    const language=properties.language;
    if(language){const lid=`language:${idHash(language.toLocaleLowerCase('en-US'))}`;if(!nodes.some(n=>n.id===lid))nodes.push({id:lid,kind:'language',label:language,properties:{},provenance:[{category:'source',source:'github-repository-metadata'}],evidenceIds:[]});edges.push({id:`uses-language:${idHash(`${id}:${lid}`)}`,kind:'uses-language',from:id,to:lid,provenance:[{category:'source',source:'github-repository-metadata'}],evidence:[]});}
    for(const topic of properties.topics||[]){const tid=`topic:${idHash(topic.toLocaleLowerCase('en-US'))}`;if(!nodes.some(n=>n.id===tid))nodes.push({id:tid,kind:'topic',label:topic,properties:{},provenance:[{category:'source',source:'github-repository-metadata'}],evidenceIds:[]});edges.push({id:`has-topic:${idHash(`${id}:${tid}`)}`,kind:'has-topic',from:id,to:tid,provenance:[{category:'source',source:'github-repository-metadata'}],evidence:[]});}
  }
  const projectIds=new Set(safeProjects.map(p=>p.id));
  for(const pair of canonical?.projectRelationships||scene.presentation?.options?.projectRelationships||[]){if(!Array.isArray(pair)||pair.length!==2||!pair.every(id=>projectIds.has(id)))continue;const [a,b]=[...pair].sort();edges.push({id:`project-relationship:${idHash(`${a}:${b}`)}`,kind:'project-relationship',from:a,to:b,provenance:[{category:'user',source:'user-project-relationship'}],evidence:{source:'user-project-relationship',projects:[a,b]}});}
  for(const g of groups){nodes.push({id:g.id,kind:'semantic-group',label:g.label,properties:safeTree({groupKind:g.kind,members:g.members,basis:g.basis}),provenance:[{category:g.provenance,source:g.provenance==='user'?'user-project-family':'derived-repository-owner'}],evidenceIds:subjectFacts.get(g.id)||[]});for(const member of g.members)edges.push({id:`member:${idHash(`${member}:${g.id}`)}`,kind:'member-of',from:member,to:g.id,provenance:[{category:g.provenance,source:g.provenance==='user'?'user-project-family':'derived-repository-owner'}],evidence:[]});}
  const relationships=scene.edges.filter(e=>e.metadata?.structuralKind||e.metadata?.relationshipKind||e.metadata?.projectRelationship);
  for(const e of relationships){const kind=e.metadata.structuralKind;if(SEMANTIC_EDGE_KINDS.includes(kind))edges.push({id:e.id,kind,from:e.from,to:e.to,provenance:[{category:'source',source:'scene-relationship'}],evidence:safeTree(e.metadata.evidence||[])});}
  const truncated=canonical?.truncated??(scene.presentation?.pipeline?.truncated===true);
  return finish({kind:'developer',id:account},nodes,edges,{evidence,groups:safeTree(groups),statistics:{truncated,limitations:truncated?['source-pipeline-bounded']:[]}});
}
export function semanticGraphFromScene(scene) {
  const validation=validateScene(scene); if(!validation.valid) throw new Error(`Invalid Scene: ${validation.errors.join(' ')}`);
  if(scene.semanticGroups && !scene.semanticGroups.canonical) throw new Error('Cannot derive portable semantic truth from a projected Scene without canonical group input.');
  return projectMetadataFromScene(scene);
}

export function semanticGraphFromProjectConstellation(model) {
  const validation=validateProjectConstellation(model); if(!validation.valid) throw new Error(`Invalid project constellation: ${validation.errors.join(' ')}`);
  const nodes=model.nodes.map(n=>({id:n.id,kind:n.kind,label:n.label,properties:safeTree({path:n.path,projectId:model.projectId,parent:n.parent,source:n.source,metadata:n.metadata}),provenance:[{category:'source',source:n.source==='manifest'?'package-manifest':'repository-tree',ref:model.provenance.ref,...(model.provenance.commit?{commit:model.provenance.commit}:{})}],evidenceIds:[]}));
  const edges=model.edges.map(e=>({id:e.id,kind:e.kind,from:e.from,to:e.to,provenance:[{category:'source',source:e.evidence.source,ref:model.provenance.ref,...(model.provenance.commit?{commit:model.provenance.commit}:{})}],evidence:safeTree(e.evidence)}));
  return finish({kind:'project',id:model.projectId},nodes,edges,{project:{version:PROJECT_CONSTELLATION_VERSION,projectId:model.projectId,manifestPaths:[...model.manifestPaths].sort(),provenance:safeTree(model.provenance),statistics:safeTree(model.statistics)},statistics:{truncated:model.statistics.truncated,limitations:model.statistics.limitation?[model.statistics.limitation]:[]}});
}
function projectModelFromGraph(graph){
  const p=graph.project;
  return {version:p.version,projectId:p.projectId,manifestPaths:p.manifestPaths,provenance:p.provenance,statistics:p.statistics,nodes:graph.nodes.map(n=>({id:n.id,path:n.properties.path,kind:n.kind,label:n.label,parent:n.properties.parent,source:n.properties.source,metadata:n.properties.metadata||{}})),edges:graph.edges.map(e=>({id:e.id,from:e.from,to:e.to,kind:e.kind,evidence:e.evidence}))};
}

function retainEvidenceForProjectedScene(scene, evidence) {
  const represented = new Set([...(scene.nodes || []).map(node => node.id), ...(scene.semanticGroups?.sourceNodeIds || [])]);
  const subjects = evidence.subjects.filter(subject => represented.has(subject.id));
  const facts = new Set(subjects.flatMap(subject => subject.facts));
  const retained = { version: evidence.version, facts: evidence.facts.filter(fact => facts.has(fact.id)), subjects: subjects.map(subject => ({ ...subject, facts: subject.facts.filter(id => facts.has(id)) })) };
  if (scene.semanticGroups?.canonical) scene.semanticGroups.canonical.evidence = clone(retained);
  return retained;
}

export function validateSemanticGraph(graph) {
  const errors=[]; const fail=s=>{if(!errors.includes(s)) errors.push(s);};
  if(!obj(graph)||graph.version!==SEMANTIC_GRAPH_VERSION||graph.kind!=='constellation-semantic-graph'){return {valid:false,errors:['Invalid semantic graph version or kind.']};}
  if(!obj(graph.subject)||!['developer','project'].includes(graph.subject.kind)||!safeText(graph.subject.id)) fail('Invalid semantic subject.');
  if(!Array.isArray(graph.nodes)||graph.nodes.length>SEMANTIC_GRAPH_LIMITS.nodes||!Array.isArray(graph.edges)||graph.edges.length>SEMANTIC_GRAPH_LIMITS.edges) return {valid:false,errors:['Semantic graph exceeds node or edge bounds.']};
  const ids=new Set(); let memberTotal=0;
  for(const n of graph.nodes){ if(!obj(n)||!safeText(n.id)||ids.has(n.id)||!SEMANTIC_NODE_KINDS.includes(n.kind)||!safeText(n.label)||!obj(n.properties)||!Array.isArray(n.provenance)||n.provenance.length<1||n.provenance.length>16||n.provenance.some(p=>!validProvenance(p))||!Array.isArray(n.evidenceIds)||n.evidenceIds.length>64||new Set(n.evidenceIds).size!==n.evidenceIds.length||n.evidenceIds.some(id=>!safeText(id))) fail('Invalid or duplicate semantic node.'); else { ids.add(n.id); try{safeTree(n);}catch{fail('Unsafe semantic node data.');} } }
  const edgeIds=new Set();
  for(const e of graph.edges||[]){ if(obj(e)&&(!ids.has(e.from)||!ids.has(e.to)))fail('Semantic edge references a missing endpoint.'); if(!obj(e)||!safeText(e.id)||edgeIds.has(e.id)||!SEMANTIC_EDGE_KINDS.includes(e.kind)||!ids.has(e.from)||!ids.has(e.to)||e.from===e.to||!Array.isArray(e.provenance)||!e.provenance.length||e.provenance.some(p=>!validProvenance(p))||!(Array.isArray(e.evidence)||obj(e.evidence))) fail('Invalid or duplicate semantic edge.'); else {edgeIds.add(e.id);try{safeTree(e); }catch{fail('Unsafe semantic edge data.');}} }
  if(graph.evidence!==undefined && (!validateEvidence(graph.evidence,new Set([...ids,...(graph.evidence.subjects||[]).map(s=>s.id)])))) fail('Invalid Evidence v1 attachment.');
  const factIds=new Set(graph.evidence?.facts?.map(f=>f.id)||[]); for(const n of graph.nodes||[])if(n.evidenceIds?.some(id=>!factIds.has(id)))fail('Semantic node references missing evidence.');
  const stats=graph.statistics;
  if(!obj(stats)||stats.nodeCount!==graph.nodes.length||stats.edgeCount!==graph.edges.length||typeof stats.truncated!=='boolean'||!Array.isArray(stats.limitations)||stats.limitations.length>128||stats.limitations.some(x=>!safeText(x))) fail('Inconsistent semantic graph statistics.');
  if(graph.subject?.kind==='project'){
    if(!obj(graph.project)||graph.project.version!==PROJECT_CONSTELLATION_VERSION||graph.project.projectId!==graph.subject.id||!Array.isArray(graph.project.manifestPaths)||!obj(graph.project.provenance)||!obj(graph.project.statistics))fail('Project graph metadata is inconsistent.');
    else {try{const projectValidation=validateProjectConstellation(projectModelFromGraph(graph));if(!projectValidation.valid)fail('Project graph does not preserve a valid Project Constellation.');}catch{fail('Project graph does not preserve a valid Project Constellation.');}}
  }
  if(graph.groups!==undefined&&(!Array.isArray(graph.groups)||graph.groups.length>SEMANTIC_GRAPH_LIMITS.groups))fail('Invalid semantic group inventory.');
  if(graph.subject?.kind==='developer'){
    const projectIds=new Set((graph.nodes||[]).filter(n=>n?.kind==='project').map(n=>n.id));
    const groupNodes=new Map((graph.nodes||[]).filter(n=>n?.kind==='semantic-group').map(n=>[n.id,n]));
    const inventory=Array.isArray(graph.groups)?graph.groups:[];
    if(groupNodes.size!==inventory.length)fail('Semantic group nodes and inventory disagree.');
    const expected=new Set();
    for(const g of inventory){
      if(!obj(g)||!safeText(g.id)||!['project-family','repository-owner'].includes(g.kind)||!['user','derived'].includes(g.provenance)||!safeText(g.label)||!Array.isArray(g.basis)||g.basis.length>16||g.basis.some(v=>!safeText(v))||!Array.isArray(g.members)||g.members.length<2||g.members.length>2048||new Set(g.members).size!==g.members.length||g.members.some(id=>!projectIds.has(id))){fail('Invalid semantic group inventory entry.');continue;}
      memberTotal+=g.members.length;
      const node=groupNodes.get(g.id);
      if(!node||node.label!==g.label||node.properties?.groupKind!==g.kind||node.provenance?.length!==1||node.provenance[0]?.category!==g.provenance||!Array.isArray(node.properties?.members)||JSON.stringify([...node.properties.members].sort())!==JSON.stringify([...g.members].sort())||!Array.isArray(node.properties?.basis)||JSON.stringify(node.properties.basis)!==JSON.stringify(g.basis))fail('Semantic group node contradicts its inventory.');
      for(const member of g.members)expected.add(`${member}\n${g.id}`);
    }
    if(memberTotal>SEMANTIC_GRAPH_LIMITS.memberships)fail('Semantic group membership exceeds bounds.');
    const actual=new Set();
    for(const edge of graph.edges||[])if(edge?.kind==='member-of'){
      const key=`${edge.from}\n${edge.to}`;
      if(actual.has(key)||!expected.has(key))fail('Contradictory semantic group membership edge.');
      actual.add(key);
      const group=inventory.find(g=>g?.id===edge.to);
      if(!group||edge.provenance?.length!==1||edge.provenance[0]?.category!==group.provenance)fail('Semantic group edge provenance disagrees with inventory.');
    }
    if(actual.size!==expected.size)fail('Semantic group membership edges are incomplete.');
  }
  try{safeTree(graph);}catch{fail('Unsafe or oversized semantic graph data.');}
  try{ if(new TextEncoder().encode(JSON.stringify(graph)).length>SEMANTIC_GRAPH_LIMITS.jsonBytes) fail('Semantic graph exceeds serialized size bound.'); }catch{fail('Semantic graph is not serializable JSON.');}
  return {valid:errors.length===0,errors};
}
export function serializeSemanticGraph(graph) {
  const result=validateSemanticGraph(graph); if(!result.valid) throw new Error(`Invalid semantic graph: ${result.errors.join(' ')}`);
  const json=JSON.stringify(canonicalGraph(graph),null,2)+'\n'; if(new TextEncoder().encode(json).length>SEMANTIC_GRAPH_LIMITS.jsonBytes) throw new Error('Semantic graph exceeds 16 MiB.'); return json;
}
export function semanticGraphExportInfo(graph) {
  const result=validateSemanticGraph(graph); if(!result.valid) throw new Error(`Invalid semantic graph: ${result.errors.join(' ')}`);
  const subject=graph.subject.kind==='developer'?graph.subject.id:graph.subject.id.replace('/','-');
  const safeSubject=subject.replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'')||'constellation';
  return Object.freeze({filename:`${safeSubject}.semantic-graph.json`,mediaType:'application/json',fingerprint:semanticGraphFingerprint(graph),subject:{...graph.subject},version:SEMANTIC_GRAPH_VERSION});
}
export function parseSemanticGraph(json) {
  if(typeof json!=='string'||json.length>SEMANTIC_GRAPH_LIMITS.jsonBytes||new TextEncoder().encode(json).length>SEMANTIC_GRAPH_LIMITS.jsonBytes) throw new Error('Semantic graph JSON exceeds 16 MiB.');
  const graph=JSON.parse(json);
  if(obj(graph)&&graph.kind==='constellation-semantic-graph'&&graph.version!==SEMANTIC_GRAPH_VERSION) throw new Error('Unsupported Semantic Graph version.');
  const result=validateSemanticGraph(graph); if(!result.valid) throw new Error(`Invalid semantic graph: ${result.errors.join(' ')}`); return canonicalGraph(graph);
}
export function semanticGraphFingerprint(graph) { let h=2166136261; for(const c of serializeSemanticGraph(graph)) h=Math.imul(h^c.codePointAt(0),16777619); return `sg1:${(h>>>0).toString(16).padStart(8,'0')}`; }

export function projectSemanticGraphToScene(graph, options={}, runtime={}, { preserveProjects = false } = {}) {
  const result=validateSemanticGraph(graph); if(!result.valid) throw new Error(`Invalid semantic graph: ${result.errors.join(' ')}`);
  let scene;
  if(graph.subject.kind==='project'){
    const model=projectModelFromGraph(graph);
    const v=validateProjectConstellation(model); if(!v.valid) throw new Error(`Project graph cannot be projected: ${v.errors.join(' ')}`);
    scene=createProjectConstellationScene(model,options,runtime).scene;
  } else {
    const developer=graph.nodes.find(n=>n.kind==='developer');
    const records=graph.nodes.filter(n=>n.kind==='project').sort((a,b)=>a.id.localeCompare(b.id)).slice(0,100).map(n=>({full_name:n.id,name:n.label,description:n.properties.description||'',language:n.properties.language||null,topics:n.properties.topics||[],created_at:n.properties.createdAt||null,updated_at:n.properties.updatedAt||null}));
    const projectIds=new Set(records.map(record=>record.full_name));
    const families=Object.fromEntries((graph.groups||[]).filter(group=>group.provenance==='user').map(group=>[group.id.startsWith('group:user:')?group.id.slice('group:user:'.length):group.id,{label:group.label,members:group.members.filter(id=>projectIds.has(id))}]).filter(([,family])=>family.members.length>=2));
    const relationships=graph.edges.filter(edge=>edge.kind==='project-relationship'&&projectIds.has(edge.from)&&projectIds.has(edge.to)).slice(0,6).map(edge=>[edge.from,edge.to]);
    const base=createScene(developer?.label||graph.subject.id,records,{...options,maxRepos:Math.max(1,records.length),includeRepos:records.map(r=>r.full_name),projectFamilies:families,projectRelationships:relationships},runtime);
    const groups=(graph.groups||[]).map(group=>({...group,version:1,members:group.members.filter(id=>projectIds.has(id))})).filter(group=>group.members.length>=2);
    scene=groups.length&&!preserveProjects?projectSemanticLevel(base,'groups',{hierarchy:{groups,projectIds:[...projectIds],source:base}}):base;
    if(graph.evidence)scene.evidence=retainEvidenceForProjectedScene(scene,graph.evidence);
  }
  const validation=validateScene(scene); if(!validation.valid) throw new Error(`Projected Scene invalid: ${validation.errors.join(' ')}`); return scene;
}
