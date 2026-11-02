/** O(n) bounds for nodes and labels visible in the supplied Scene projection. */
export function contentBounds(scene, { nodeIds } = {}) {
  const included = nodeIds ? new Set(nodeIds) : null;
  const nodes = (scene?.nodes || []).filter(node => (!included || included.has(node.id))
    && node.interaction?.hidden !== true && node.style?.opacity !== 0);
  if (!nodes.length) return null;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  const include=(left,top,right,bottom)=>{minX=Math.min(minX,left);minY=Math.min(minY,top);maxX=Math.max(maxX,right);maxY=Math.max(maxY,bottom);};
  const visible=new Set();
  for(const node of nodes){
    const {x,y,radius}=node.geometry; visible.add(node.id);
    include(x-radius,y-radius,x+radius,y+radius);
  }
  for(const label of scene.labels||[]){
    if(!visible.has(label.id)||label.hidden)continue;
    const halfWidth=Math.min(360,Math.max(4,String(label.text||'').length*2.8));
    include(label.x-halfWidth,label.y-8,label.x+halfWidth,label.y+3);
  }
  return {minX,minY,maxX,maxY,width:maxX-minX,height:maxY-minY,centerX:(minX+maxX)/2,centerY:(minY+maxY)/2,nodeCount:nodes.length};
}

/** Tighten initial framing without changing the Scene's uniform coordinate scale.
 * The existing aspect ratio is preserved; expansion is capped to avoid a lone
 * long label or outlier making a useful constellation microscopic. */
export function fitSceneViewport(scene, { nodeIds, padding = 0.1, maxExpansion = 1.12 } = {}) {
  const bounds=contentBounds(scene,{nodeIds}), current=scene?.viewport?.viewBox;
  if(!bounds||!Array.isArray(current)||current.length!==4)return scene;
  const [x,y,currentWidth,currentHeight]=current,aspect=currentWidth/currentHeight;
  const pad=Math.max(0.04,Math.min(0.2,Number.isFinite(padding)?padding:0.1));
  const requiredWidth=Math.max(bounds.width/(1-2*pad),bounds.height/(1-2*pad)*aspect);
  const width=Math.min(currentWidth*Math.max(1,Math.min(1.2,maxExpansion)),Math.max(120,requiredWidth));
  const height=width/aspect;
  const centerX=bounds.centerX,centerY=bounds.centerY;
  const currentCenterX=x+currentWidth/2,currentCenterY=y+currentHeight/2;
  const widthTolerance=Math.max(1e-6,currentWidth*0.005),heightTolerance=Math.max(1e-6,currentHeight*0.005);
  if(Math.abs(width-currentWidth)<widthTolerance&&Math.abs(height-currentHeight)<heightTolerance
    &&Math.abs(centerX-currentCenterX)<widthTolerance&&Math.abs(centerY-currentCenterY)<heightTolerance)return scene;
  const stable=value=>Math.round(value*1e6)/1e6;
  return {...scene,viewport:{...scene.viewport,viewBox:[stable(centerX-width/2),stable(centerY-height/2),width,height]}};
}
