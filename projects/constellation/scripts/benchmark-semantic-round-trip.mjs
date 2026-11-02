import { performance } from 'node:perf_hooks';
import { createScene } from '../src/constellation.mjs';
import { createProjectConstellation } from '../src/project-constellation.mjs';
import { semanticGraphFromScene, semanticGraphFromProjectConstellation, serializeSemanticGraph, parseSemanticGraph, semanticGraphFingerprint, projectSemanticGraphToScene } from '../src/semantic-graph.mjs';
import { renderSemanticMarkdown } from '../src/semantic-markdown.mjs';

const measure=fn=>{const start=performance.now();const value=fn();return {value,ms:+(performance.now()-start).toFixed(2)};};
function report(name,graph){
  const serialized=measure(()=>serializeSemanticGraph(graph));
  const parsed=measure(()=>parseSemanticGraph(serialized.value));
  const fingerprint=measure(()=>semanticGraphFingerprint(parsed.value));
  const scene=measure(()=>projectSemanticGraphToScene(parsed.value));
  const markdown=measure(()=>renderSemanticMarkdown(parsed.value,{detail:'detailed'}));
  process.stdout.write(`${JSON.stringify({case:name,serializeMs:serialized.ms,parseValidateMs:parsed.ms,fingerprintMs:fingerprint.ms,sceneProjectionMs:scene.ms,markdownMs:markdown.ms,jsonBytes:Buffer.byteLength(serialized.value),fingerprint:fingerprint.value})}\n`);
}
for(const count of [45,256]){
  const records=Array.from({length:count},(_,i)=>({full_name:`benchmark/project-${String(i).padStart(3,'0')}`,name:`project-${i}`,language:i%2?'Rust':'JavaScript',topics:['benchmark']}));
  const scene=createScene('benchmark',records,{maxRepos:Math.min(count,100)});
  const present=new Set(scene.nodes.map(n=>n.id));
  for(const record of records)if(!present.has(record.full_name))scene.nodes.push({id:record.full_name,geometry:{x:500,y:500,radius:5},metadata:{...record,description:'',html_url:'',nodeKind:'repository'},style:{color:null,glow:null,opacity:1,shape:'circle'},interaction:{hidden:false,labelHidden:false}});
  scene.presentation.graph.nodeCount=scene.nodes.length;
  report(`developer-${count}`,semanticGraphFromScene(scene));
}
for(const count of [50,100]){
  const tree=Array.from({length:count},(_,i)=>({path:`dir-${String(i).padStart(3,'0')}`,type:'tree'}));
  report(`project-${count}`,semanticGraphFromProjectConstellation(createProjectConstellation({projectId:`benchmark/project-${count}`,tree,contents:{}})));
}
