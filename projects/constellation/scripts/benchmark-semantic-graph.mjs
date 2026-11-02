import { performance } from 'node:perf_hooks';
import { createScene } from '../src/constellation.mjs';
import { createProjectConstellation } from '../src/project-constellation.mjs';
import { semanticGraphFromScene, semanticGraphFromProjectConstellation, validateSemanticGraph, serializeSemanticGraph, parseSemanticGraph, projectSemanticGraphToScene } from '../src/semantic-graph.mjs';

const measure=(name,fn)=>{const start=performance.now();const value=fn();return {value,ms:+(performance.now()-start).toFixed(2),name};};
for(const count of [45,256]){
  const records=Array.from({length:count},(_,i)=>({full_name:`benchmark/project-${String(i).padStart(3,'0')}`,name:`project-${i}`,language:i%2?'Rust':'JavaScript',topics:['benchmark']}));
  const scene=createScene('benchmark',records,{maxRepos:Math.min(count,100)});
  const present=new Set(scene.nodes.map(n=>n.id));
  for(const [i,record] of records.entries())if(!present.has(record.full_name))scene.nodes.push({id:record.full_name,geometry:{x:500+i,y:500,radius:5},metadata:{...record,description:'',html_url:'',nodeKind:'repository'},style:{color:null,glow:null,opacity:1,shape:'circle'},interaction:{hidden:false,labelHidden:false}});
  scene.presentation.graph.nodeCount=scene.nodes.length;
  const g=measure(`developer ${count} graph`,()=>semanticGraphFromScene(scene));
  const v=measure('validation',()=>validateSemanticGraph(g.value)); const s=measure('serialization',()=>serializeSemanticGraph(g.value));
  const p=measure('parsing',()=>parseSemanticGraph(s.value)); const projection=measure('Scene projection',()=>projectSemanticGraphToScene(p.value));
  console.log(JSON.stringify({case:`developer-${count}`,creationMs:g.ms,validationMs:v.ms,serializationMs:s.ms,parsingMs:p.ms,sceneProjectionMs:projection.ms,bytes:Buffer.byteLength(s.value)}));
}
for(const count of [50,100]){
  const tree=[{path:'',type:'tree'}]; for(let i=0;i<count-1;i++)tree.push({path:`dir-${i}`,type:'tree'});
  const model=createProjectConstellation({projectId:`benchmark/project-${count}`,tree,contents:{}});
  const g=measure('project graph',()=>semanticGraphFromProjectConstellation(model)); const v=measure('validation',()=>validateSemanticGraph(g.value));
  const s=measure('serialization',()=>serializeSemanticGraph(g.value)); const p=measure('parsing',()=>parseSemanticGraph(s.value)); const projection=measure('Scene projection',()=>projectSemanticGraphToScene(p.value));
  console.log(JSON.stringify({case:`project-${count}`,creationMs:g.ms,validationMs:v.ms,serializationMs:s.ms,parsingMs:p.ms,sceneProjectionMs:projection.ms,bytes:Buffer.byteLength(s.value)}));
}
