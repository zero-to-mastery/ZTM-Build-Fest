import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  cp,
  writeFile,
  readFile,
  rm,
  readdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { browser, openBrowser } from "../scripts/browser-harness.mjs";
import { createScene } from "../src/constellation.mjs";
import { serializeScene } from "../src/scene.mjs";
import { renderSceneSVG } from "../src/renderer-svg.mjs";

test(
  "web component package works outside the repository with bounded assets and accessible controls",
  { skip: !browser, timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "constellation-consumer-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const externalScene = createScene('demo', ['compiler','runtime','studio'].map((name, i) => ({ name, full_name: `demo/${name}`, language: i === 2 ? 'JavaScript' : 'Rust', stargazers_count: 10 + i })), { animate: false });
    const requestCounts = new Map();
    await writeFile(join(root, 'scene.json'), serializeScene(externalScene));
    await writeFile(join(root, 'constellation.svg'), renderSceneSVG(externalScene));
    await writeFile(join(root, 'precedence.json'), serializeScene(createScene('precedence', [{ name: 'later', full_name: 'precedence/later', language: 'Go' }], { animate: false })));
    for (const name of ["core", "web-component"])
      await cp(
        new URL(`../packages/${name}/`, import.meta.url),
        join(root, "node_modules", "@constellation", name),
        { recursive: true },
      );
    const directory = join(
      root,
      "node_modules",
      "@constellation",
      "web-component",
    );
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const core = JSON.parse(
      await readFile(
        join(root, "node_modules", "@constellation", "core", "package.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.dependencies["@constellation/core"], core.version);
    assert.deepEqual((await readdir(directory)).sort(), [
      "README.md",
      "developer-topology.md",
      "evidence-provenance.md",
      "index.mjs",
      "package.json",
      "portable-embed.md",
      "project-constellations.md",
      "semantic-groups.md",
      "temporal-stack.md",
      "web-component-atlas.mjs",
    ]);
    assert.ok((await stat(join(directory, "index.mjs"))).size < 24 * 1024);
    const coreFiles = await readdir(
      join(root, "node_modules", "@constellation", "core"),
      { recursive: true },
    );
    let bytes = 0;
    for (const file of coreFiles) {
      const info = await stat(
        join(root, "node_modules", "@constellation", "core", file),
      );
      if (info.isFile()) bytes += info.size;
    }
    assert.ok(bytes < 2 * 1024 * 1024, `Core package exceeds 2 MiB: ${bytes}`);
    await writeFile(
      join(root, "index.html"),
      `<!doctype html><html lang="en"><title>Consumer</title>
<script type="importmap">{"imports":{"@constellation/core":"/node_modules/@constellation/core/src/core-api.mjs","@constellation/core/browser-runtime":"/node_modules/@constellation/core/src/browser-runtime.mjs","@constellation/web-component":"/node_modules/@constellation/web-component/index.mjs"}}</script>
<img id="fallback" src="/constellation.svg" alt="Static project constellation"><div id="first-host"></div><div style="display:flex;min-width:0"><constellation-view id="external" src="/scene.json"></constellation-view></div><script type="module">window.consumerStart=performance.now();await import('@constellation/web-component'); const {createScene,buildSemanticHierarchy,projectSemanticLevel}=await import('@constellation/core'); const view=document.createElement('constellation-view');view.id='first';view.addEventListener('scene-ready',()=>window.consumerReadyMs=performance.now()-window.consumerStart,{once:true});document.querySelector('#first-host').append(view); const records=['compiler','runtime','studio'].map((name,i)=>({name,full_name:'demo/'+name,language:i===2?'JavaScript':'Rust'})); const options={projectFamilies:{'consumer-family':{label:'Consumer Family',members:records.map(record=>record.full_name)}}}; const source=createScene('demo',records,options); const hierarchy=buildSemanticHierarchy(source); window.semanticPackageCheck={groupId:hierarchy.groups[0].id,visible:projectSemanticLevel(source,'groups',{hierarchy}).nodes.length}; view.records=records; view.config={version:7,account:'demo',...options,options:{animate:false,...options}};</script></html>`,
    );
    const server = createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(
          new URL(req.url, "http://localhost").pathname,
        );
        requestCounts.set(pathname, (requestCounts.get(pathname) || 0) + 1);
        const path = resolve(
          root,
          "." + (pathname === "/" ? "/index.html" : pathname),
        );
        if (!path.startsWith(root + sep)) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.setHeader(
          "Content-Type",
          path.endsWith(".wasm")
            ? "application/wasm"
            : path.endsWith(".svg")
              ? "image/svg+xml"
              : path.endsWith(".json")
                ? "application/json"
            : path.endsWith(".mjs") || path.endsWith(".js")
              ? "text/javascript"
              : "text/html",
        );
        res.end(await readFile(path));
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    );
    const { evaluate, waitFor, cdp, errors } = await openBrowser(
      t,
      `http://127.0.0.1:${server.address().port}/`,
    );
    await waitFor(
      `Boolean(document.querySelector('#first')?.shadowRoot?.querySelector('.star') && document.querySelector('#external')?.shadowRoot?.querySelector('.star') && document.querySelector('#fallback')?.complete && document.querySelector('#fallback').naturalWidth > 0)`,
    );
    assert.deepEqual(await evaluate("window.semanticPackageCheck"), { groupId: "group:user:consumer-family", visible: 1 });
    const accessibility = await cdp("Accessibility.getFullAXTree");
    assert.ok(
      accessibility.nodes.some(
        (node) =>
          node.role?.value === "button" && node.name?.value === "Zoom in",
      ),
    );
    assert.ok(
      accessibility.nodes.some(
        (node) =>
          node.role?.value === "button" &&
          node.name?.value.includes("compiler"),
      ),
    );
    await evaluate(
        `document.querySelector('#first').shadowRoot.querySelector('.repository').focus()`,
    );
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
    assert.equal(
      await evaluate(
        `document.querySelector('#first').selection.start`,
      ),
      "demo/compiler",
    );
    assert.equal(await evaluate(`document.querySelector('#first').focusState.project`), 'demo/compiler');
    await evaluate(`(() => {
      const source=document.querySelector('#first');
      const second=document.createElement('constellation-view');
      second.id='second'; second.style.cssText='display:block;width:100%;height:420px';
      second.scene=source.scene; const grid=document.createElement('div');grid.id='grid';grid.style.cssText='display:grid;grid-template-columns:minmax(0,1fr);min-width:0';grid.append(second);document.body.append(grid);
      window.secondView=second;
    })()`);
    await waitFor(`Boolean(window.secondView.shadowRoot.querySelector('.star'))`);
    assert.equal(await evaluate(`window.secondView.scene.nodes.length`), await evaluate(`document.querySelector('constellation-view').scene.nodes.length`));
    await evaluate(`window.secondView.focusProject('demo/compiler')`);
    const authoredCoordinates = await evaluate(`JSON.stringify(window.secondView.scene.nodes.map(({id,x,y})=>[id,x,y]))`);
    const navigationMs = await evaluate(`(()=>{const start=performance.now();window.secondView.focusProject('demo/compiler');window.secondView.focusRelationship('demo/compiler','demo/runtime');return performance.now()-start})()`);
    const resizeMs = await evaluate(`(async()=>{const view=window.secondView,start=performance.now();for(const width of [240,280,360,768,1280]){view.style.width=width+'px';window.dispatchEvent(new Event('resize'));await new Promise(requestAnimationFrame);view.shadowRoot.querySelector('svg').getBoundingClientRect()}return performance.now()-start})()`);
    assert.equal(await evaluate(`window.secondView.focusState.related`), 'demo/runtime');
    assert.equal(await evaluate(`window.secondView.focusState.project`), 'demo/compiler');
    assert.equal(await evaluate(`JSON.stringify(window.secondView.scene.nodes.map(({id,x,y})=>[id,x,y]))`), authoredCoordinates, 'responsive resizing preserves authored scene coordinates');
    assert.equal(await evaluate(`document.querySelector('#first').focusState.related`), null, 'focus remains local to each component');
    await evaluate(`(async()=>{const view=window.secondView,grid=view.parentElement;grid.style.display='none';await new Promise(requestAnimationFrame);grid.style.display='grid';await new Promise(requestAnimationFrame)})()`);
    assert.equal(await evaluate(`window.secondView.focusState.related`), 'demo/runtime');
    const reconnectMs = await evaluate(`(async()=>{const view=window.secondView,grid=view.parentElement,start=performance.now(),ready=new Promise(resolve=>view.addEventListener('scene-ready',resolve,{once:true}));view.remove();grid.append(view);await ready;return performance.now()-start})()`);
    await waitFor(`Boolean(window.secondView.shadowRoot.querySelector('.star'))`);
    assert.equal(await evaluate(`window.secondView.focusState.related`), 'demo/runtime');
    const secondSvg = await evaluate(`window.secondView.shadowRoot.querySelector('svg') !== null`);
    assert.equal(secondSvg, true);
    const original = await evaluate(
      `document.querySelector('constellation-view').scene.metadata.account`,
    );
    assert.equal(
      await evaluate(
        `(() => { const view=document.querySelector('constellation-view'); const scene=view.scene; scene.presentation.options.css='@import "https://example.com/attack.css";'; return view.loadScene(scene); })()`,
      ),
      false,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('constellation-view').scene.metadata.account`,
      ),
      original,
    );
    const detachedPrecedence = await evaluate(`(async()=>{const view=document.createElement('constellation-view');view.scene=document.querySelector('#first').scene;view.setAttribute('src','/precedence.json');const ready=new Promise(resolve=>view.addEventListener('scene-ready',resolve,{once:true}));document.body.append(view);await ready;const account=view.scene.metadata.account;view.remove();return account})()`);
    assert.equal(detachedPrecedence, 'precedence', 'a src set on a detached element after the scene property still loads on connect');
    assert.equal(requestCounts.get('/precedence.json'), 1);
    assert.deepEqual(errors, []);
    assert.equal(requestCounts.get('/scene.json'), 1, 'resize and lifecycle recovery do not refetch the scene');
    assert.ok((await evaluate('window.consumerReadyMs')) > 0);
    t.diagnostic(JSON.stringify({ consumerReadyMs: await evaluate('window.consumerReadyMs'), navigationMs, resizeMs, reconnectMs, packageEntryBytes: (await stat(join(directory, 'index.mjs'))).size }));
  },
);
