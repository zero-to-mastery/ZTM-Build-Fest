import { createHash } from "node:crypto";
export function offlinePlugin(version) {
  return {
    name: "readme-studio-offline",
    apply: "build",
    generateBundle(_, bundle) {
      const files = [
        ...new Set([
          "./",
          "./index.html",
          "./manifest.webmanifest",
          "./icon.svg",
          ...Object.keys(bundle).map((name) => "./" + name),
        ]),
      ];
      const hash = createHash("sha256")
        .update(offlinePlugin.toString().replace(/\r\n/g, "\n"))
        .update(Object.keys(bundle).sort().join("\n"))
        .digest("hex")
        .slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `
const PREFIX='readme-studio:'+self.registration.scope+':';
const CACHE=PREFIX+${JSON.stringify(version + "-" + hash)};
const FILES=${JSON.stringify(files)}.map(p=>new URL(p,self.registration.scope).href);
const allowed=new Set(FILES);
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES.map(url=>new Request(url,{credentials:'omit',cache:'reload'})))).catch(async error=>{await caches.delete(CACHE);throw error;})));
self.addEventListener('activate',event=>event.waitUntil((async()=>{const keys=(await caches.keys()).filter(k=>k.startsWith(PREFIX)&&k!==CACHE);await Promise.all(keys.slice(0,-1).map(k=>caches.delete(k)));})()));
self.addEventListener('message',event=>{if(event.data==='ACTIVATE_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||url.search||url.pathname.includes('/api/')||request.headers.has('authorization'))return;
 if(!allowed.has(url.href))return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  if(request.mode==='navigate'){
   try{const response=await fetch(new Request(request,{credentials:'omit',cache:'no-cache'}));if(response.ok&&(response.headers.get('content-type')||'').includes('text/html'))await cache.put(new Request(url.href,{credentials:'omit'}),response.clone());return response;}
   catch{const saved=await cache.match(request)||await cache.match(new URL('./',self.registration.scope).href);if(saved)return saved;throw Error('Offline app is not cached.');}
  }
  return await cache.match(request)||fetch(request);
 })());
});`,
      });
    },
  };
}
