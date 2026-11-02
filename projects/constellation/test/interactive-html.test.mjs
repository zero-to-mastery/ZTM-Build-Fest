import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createScene, renderSceneHTML } from "../src/core-api.mjs";
import { htmlBundleStatistics } from "../src/renderer-html.mjs";
import { browser, openBrowser } from "../scripts/browser-harness.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/scene-svg-v2.json", import.meta.url)),
);
const scene = createScene(
  fixture.account,
  fixture.repositories,
  fixture.cases[0].options,
);

// Small JavaScript scanner: reports string/template literals that contain a line
// break. Regex literals in the runtime contain no quotes or backticks.
function multiLineLiterals(source) {
  const found = [], stack = [];
  let state = "code";
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") state = "line";
      else if (c === "/" && next === "*") state = "block";
      else if (c === '"' || c === "'") state = c;
      else if (c === "`") state = "template";
      else if (c === "{" && stack.length) stack[stack.length - 1]++;
      else if (c === "}" && stack.length) {
        if (stack.at(-1) === 0) { stack.pop(); state = "template"; } else stack[stack.length - 1]--;
      }
    } else if (state === "line") { if (c === "\n") state = "code"; }
    else if (state === "block") { if (c === "*" && next === "/") { state = "code"; i++; } }
    else if (state === '"' || state === "'") {
      if (c === "\\") { if (next === "\n") found.push("string"); i++; }
      else if (c === state || c === "\n") state = "code";
    } else if (state === "template") {
      if (c === "\\") i++;
      else if (c === "`") state = "code";
      else if (c === "$" && next === "{") { stack.push(0); state = "code"; i++; }
      else if (c === "\n") found.push("template");
    }
  }
  return [...new Set(found)];
}

test("HTML export is deterministic and embeds escaped scene data", () => {
  const html = renderSceneHTML(scene, { title: "<safe>" });
  assert.equal(html, renderSceneHTML(scene, { title: "<safe>" }));
  assert.match(html, /<title>&lt;safe&gt;<\/title>/);
  const dangerous = structuredClone(scene);
  dangerous.nodes[0].metadata.description =
    "</script><script>window.injected=true</script>";
  const output = renderSceneHTML(dangerous);
  assert.ok(!output.includes("<script>window.injected"));
  assert.match(output, /\\u003c\/script\\u003e/);
  assert.match(output, /Content-Security-Policy/);
  const size = htmlBundleStatistics(scene);
  assert.ok(size.runtimeBytes < 1024 * 1024);
  // The export drops leading indentation from the embedded runtime. That is only
  // lossless while no string or template literal spans a line break.
  const runtime = html.slice(html.indexOf('<script type="module">') + 22, html.lastIndexOf("</script>"));
  assert.deepEqual(multiLineLiterals(runtime), []);
  assert.deepEqual(multiLineLiterals("const a = `x\n  y`;"), ["template"], "the guard detects multi-line templates");
  assert.deepEqual(multiLineLiterals("const a = 'x\\\n  y';"), ["string"], "the guard detects line continuations");
  assert.ok(size.wasmBytes > 100000);
  for (const mutate of [
    (value) => {
      value.presentation.options.colors = {
        star: "</style><script>alert(1)</script>",
      };
    },
    (value) => {
      value.presentation.nodeMode = "<script>alert(1)</script>";
    },
    (value) => {
      value.viewport.viewBox[3] = 1000000;
    },
  ]) {
    const invalid = structuredClone(scene);
    mutate(invalid);
    assert.throws(() => renderSceneHTML(invalid));
  }
});

test("profile export exposes accessible dimensions and evidence controls", () => {
  const profileScene = createScene(fixture.account, fixture.repositories, {
    ...fixture.cases[0].options,
    arrangement: "profile",
  });
  const html = renderSceneHTML(profileScene);
  assert.match(html, /Developer evidence dimensions/);
  assert.match(html, /Clear dimensions/);
  assert.match(html, /developer-profile-description/);
  assert.match(html, /Developer evidence:/);
  assert.match(html, /Why is this here\?/);
});

test("grouped offline HTML expands and collapses from real projects with group evidence", { skip: !browser, timeout: 120000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "constellation-groups-html-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "index.html");
  const grouped = createScene(fixture.account, fixture.repositories, {
    ...fixture.cases[0].options,
    projectFamilies: { "offline-family": { label: "Offline Family", members: fixture.repositories.map(repo => repo.full_name) } },
  });
  await writeFile(file, renderSceneHTML(grouped, { semanticLevel: "groups" }));
  const { evaluate, waitFor, errors, cdp } = await openBrowser(t, pathToFileURL(file).href);
  await waitFor(`Boolean(document.querySelector('.star[data-repo="group:user:offline-family"]'))`);
  await waitFor(`Boolean(document.querySelector('main').constellation)`);
  assert.equal(await evaluate("document.querySelectorAll('script[src]').length"), 0);
  assert.deepEqual(await evaluate(`performance.getEntriesByType('resource').map(item=>item.name).filter(value=>/^https?:/i.test(value))`), []);
  await evaluate(`document.querySelector('.repository').focus(); document.querySelector('.repository').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await waitFor(`[...document.querySelectorAll('[data-details] summary')].some(item=>item.textContent==='Why grouped?')`);
  assert.equal(await evaluate("[...document.querySelectorAll('[data-details] summary')].find(item=>item.textContent==='Why grouped?')?.textContent"), "Why grouped?");
  const groupInspector = await evaluate(`document.querySelector('[data-details]').textContent`);
  assert.match(groupInspector, /Grouping reason/);
  assert.match(groupInspector, /Defined by you/);
  assert.match(groupInspector, /Common characteristics/);
  assert.match(groupInspector, /Languages/);
  assert.match(groupInspector, /Topics/);
  assert.match(groupInspector, /\d+ \/ \d+/);
  await evaluate("document.querySelector('[data-semantic-expand]').focus()");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter" });
  const expandedState = await evaluate(`({count:document.querySelectorAll('.star').length, selection:document.querySelector('main').constellation?.selection, actions:[...document.querySelectorAll('[data-semantic-expand]')].map(button=>button.dataset.semanticExpand), status:document.querySelector('[data-status]')?.textContent})`);
  assert.equal(expandedState.count, fixture.repositories.length, JSON.stringify(expandedState));
  assert.ok(await evaluate("Boolean(document.querySelector('[data-semantic-collapse]'))"));
  await evaluate(`document.querySelector('main').constellation.selectNode(${JSON.stringify(fixture.repositories[0].full_name)},{focus:false})`);
  const projectInspector = await evaluate(`document.querySelector('[data-details]').textContent`);
  assert.match(projectInspector, /Why is this here\?/);
  assert.doesNotMatch(projectInspector, /Grouping reason/);
  await evaluate("document.querySelector('[data-semantic-collapse]').click()");
  await waitFor(`Boolean(document.querySelector('.star[data-repo="group:user:offline-family"]'))`);
  const collapsedInspector = await evaluate(`document.querySelector('[data-details]').textContent`);
  assert.match(collapsedInspector, /Grouping reason/);
  assert.match(collapsedInspector, /Defined by you/);
  assert.match(collapsedInspector, /Common characteristics/);
  const automatic = join(dir, "automatic.html");
  await writeFile(automatic, renderSceneHTML(grouped, { semanticLevel: "auto" }));
  assert.match(await readFile(automatic, "utf8"), /constellation-semantic-mode/);
  await cdp("Page.navigate", { url: pathToFileURL(automatic).href });
  await waitFor(`Boolean(document.querySelector('main')?.constellation)`);
  await evaluate(`window.semanticChanges = []; document.querySelector('main').addEventListener('semantic-level-change', event => semanticChanges.push(event.detail)); document.querySelector('main').constellation.selectNode('group:user:offline-family',{focus:false}); const base = document.querySelector('main').constellation.camera; document.querySelector('main').constellation.setCamera([base[0],base[1],base[2]/2,base[3]/2]);`);
  await waitFor(`document.querySelectorAll('.star[data-repo^="fixture/"]').length === ${fixture.repositories.length}`);
  assert.equal(await evaluate(`semanticChanges.at(-1)?.current`), "projects");
  assert.ok(await evaluate(`document.querySelector('[data-details]').textContent.includes('Offline Family')`));
  const handoff = join(dir, "handoff.html");
  const handoffScene = createScene(fixture.account, fixture.repositories, {
    ...fixture.cases[0].options,
    projectFamilies: {
      "offline-a": { label: "Offline A", members: fixture.repositories.slice(0, 2).map(repo => repo.full_name) },
      "offline-b": { label: "Offline B", members: fixture.repositories.slice(2).map(repo => repo.full_name) },
    },
  });
  await writeFile(handoff, renderSceneHTML(handoffScene, { semanticLevel: "auto" }));
  assert.equal(await evaluate("document.querySelectorAll('script[src]').length"), 0);
  assert.match(await readFile(handoff, "utf8"), /Content-Security-Policy/);
  await cdp("Page.navigate", { url: pathToFileURL(handoff).href });
  await waitFor(`Boolean(document.querySelector('.star[data-repo="group:user:offline-a"]'))`);
  await waitFor(`Boolean(document.querySelector('main')?.constellation)`);
  await evaluate(`window.handoffChanges=[]; document.querySelector('main').addEventListener('semantic-level-change',e=>handoffChanges.push(e.detail)); const exp=document.querySelector('main').constellation; exp.selectNode('group:user:offline-a',{focus:false}); const view=exp.camera; exp.setCamera([view[0],view[1],view[2]/2,view[3]/2]);`);
  await waitFor(`document.querySelectorAll('.star[data-repo^="fixture/"]').length===2`);
  const handoffCamera = await evaluate(`document.querySelector('main').constellation.camera`);
  const changesBefore = await evaluate(`handoffChanges.length`);
  await evaluate(`document.querySelector('main').constellation.selectNode('group:user:offline-b',{focus:false})`);
  await waitFor(`document.querySelectorAll('.star[data-repo^="fixture/"]').length===2 && document.querySelector('[data-details]').textContent.includes('Offline B')`);
  const handoffText = await evaluate(`document.querySelector('[data-details]').textContent`);
  assert.match(handoffText, /Grouping reason/);
  assert.match(handoffText, /Defined by you/);
  assert.match(handoffText, /Common characteristics/);
  assert.doesNotMatch(handoffText, /Offline A/);
  assert.match(handoffText, /\d+ \/ \d+/);
  assert.equal(await evaluate(`document.querySelectorAll('.star[data-repo^="fixture/"]').length`), 2);
  assert.ok(await evaluate(`Boolean(document.querySelector('.star[data-repo="group:user:offline-a"]'))`), "previous group is collapsed");
  assert.deepEqual(await evaluate(`document.querySelector('main').constellation.camera`), handoffCamera);
  assert.equal(await evaluate(`handoffChanges.length`), changesBefore, "local handoff does not emit a false level transition");
  assert.deepEqual(errors, []);
});

test(
  "standalone file supports selection, keyboard, camera and cleanup",
  { skip: !browser, timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "constellation-html-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "index.html");
    const linked = structuredClone(scene);
    linked.presentation.options.projectShowcase = {
      [linked.nodes[0].id]: { role: "featured", priority: 1 },
    };
    linked.nodes[0].metadata.html_url = "https://example.com/project";
    linked.nodes[1].metadata.html_url = "javascript:window.injected=true";
    linked.nodes[1].metadata.description =
      "<img src=x onerror=window.injected=true>";
    await writeFile(file, renderSceneHTML(linked));
    const { evaluate, waitFor, errors, cdp } = await openBrowser(
      t,
      pathToFileURL(file).href,
    );
    await waitFor('Boolean(document.querySelector("main")?.constellation)');
    await evaluate(
      `document.querySelector('main').setAttribute('onclick', 'window.injected=true'); document.querySelector('main').click()`,
    );
    assert.equal(
      await evaluate("Boolean(window.injected)"),
      false,
      "CSP blocks injected handlers",
    );
    const base = await evaluate(
      'document.querySelector("main").constellation.camera',
    );
    await evaluate('document.querySelector("[data-action=zoom-in]").click()');
    assert.ok(
      (
        await evaluate('document.querySelector("main").constellation.camera')
      )[2] < base[2],
    );
    await evaluate(
      'document.querySelector(".repository[role=button]").dispatchEvent(new MouseEvent("click", {bubbles:true}))',
    );
    assert.ok(
      await evaluate('document.querySelector("main").constellation.selection'),
    );
    assert.equal(await evaluate('document.querySelector("[data-details] details summary")?.textContent'), "Why is this here?");
    await evaluate(
      'document.querySelector(".repository[role=button]").focus()',
    );
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "End" });
    assert.equal(
      await evaluate('document.activeElement.getAttribute("tabindex")'),
      "0",
    );
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
    assert.equal(
      await evaluate('document.activeElement.getAttribute("aria-pressed")'),
      "true",
    );
    await evaluate('document.querySelector("[data-action=fit]").click()');
    assert.deepEqual(
      await evaluate('document.querySelector("main").constellation.camera'),
      base,
      "Fit returns to the already content-fitted initial frame",
    );
    await evaluate('document.querySelector("[data-action=reset]").click()');
    assert.deepEqual(
      await evaluate('document.querySelector("main").constellation.camera'),
      base,
    );
    assert.equal(
      await evaluate('document.querySelector("main").constellation.selection'),
      null,
    );
    await evaluate(
      `document.querySelector('main').constellation.selectNode(${JSON.stringify(scene.nodes[0].id)}, {focus:false})`,
    );
    assert.match(
      await evaluate('document.querySelector("[data-details]").textContent'),
      /Project role: featured · Featured order 1/,
    );
    assert.equal(
      await evaluate(
        'document.querySelector("[data-details] a").getAttribute("rel")',
      ),
      "noopener noreferrer",
    );
    await evaluate(
      `document.querySelector('main').constellation.selectNode(${JSON.stringify(scene.nodes[1].id)}, {focus:false})`,
    );
    assert.equal(
      await evaluate('document.querySelector("[data-details] a")'),
      null,
    );
    assert.equal(
      await evaluate('document.querySelector("[data-details] img")'),
      null,
    );
    const edge = scene.edges[0];
    await evaluate(
      `document.querySelector('main').constellation.selectNode(${JSON.stringify(edge.from)}, {focus:false}); document.querySelector('main').constellation.selectNode(${JSON.stringify(edge.to)}, {focus:false,extend:true})`,
    );
    assert.deepEqual(
      (
        await evaluate(
          'document.querySelector("main").constellation.selectionState',
        )
      ).path,
      [edge.from, edge.to],
    );
    assert.ok(
      await evaluate(
        'document.querySelector("svg").hasAttribute("data-interactive-selection")',
      ),
    );
    assert.ok(
      await evaluate(
        'document.querySelector(".shared-language[data-related]") !== null',
      ),
    );
    await evaluate(
      'document.querySelector("main").constellation.setFilter({query:"no-match-fixture"})',
    );
    assert.equal(
      await evaluate('document.querySelector("main").constellation.selection'),
      null,
    );
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".repository[role=button]:not([data-filtered])").length',
      ),
      0,
    );
    await evaluate(
      'document.querySelector("main").constellation.setFilter({})',
    );
    assert.ok(
      await evaluate(
        'document.querySelectorAll(".repository[role=button]:not([data-filtered])").length > 0',
      ),
    );
    await evaluate(
      'document.querySelector("main").constellation.setTheme("light")',
    );
    assert.equal(
      await evaluate(
        'document.querySelector("svg").style.getPropertyValue("--sky-foreground")',
      ),
      "#202516",
    );
    await evaluate(
      'document.querySelector("main").constellation.setTheme("original")',
    );
    assert.equal(
      await evaluate(
        'document.querySelector("svg").style.getPropertyValue("--sky-foreground")',
      ),
      "",
    );
    await cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await waitFor(
      'document.querySelector("main").hasAttribute("data-reduced-motion")',
    );
    assert.equal(
      await evaluate('document.querySelector("svg").animationsPaused()'),
      true,
    );
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: 375,
      height: 700,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert.ok(
      await evaluate(
        'document.querySelector("[data-canvas]").getBoundingClientRect().width <= 375',
      ),
    );
    await evaluate('document.querySelector("main").constellation.reset()');
    await evaluate(
      'document.querySelector("main").constellation.destroy(); document.querySelector("[data-action=zoom-in]").click()',
    );
    assert.equal(
      await evaluate('document.querySelector("svg").getAttribute("viewBox")'),
      base.join(" "),
    );
    assert.deepEqual(errors, []);
  },
);

test(
  "interactive Developer Topology supports combined dimension selection and evidence inspection",
  { skip: !browser, timeout: 120000 },
  async (t) => {
    const profileScene = createScene(fixture.account, fixture.repositories, {
      ...fixture.cases[0].options,
      arrangement: "profile",
    });
    const dimension = profileScene.developerProfile.dimensions.find(
      (item) => item.evidence.length,
    );
    const repository = dimension.evidence[0].repository;
    const dir = await mkdtemp(join(tmpdir(), "constellation-profile-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "profile.html");
    await writeFile(file, renderSceneHTML(profileScene));
    const { evaluate, waitFor, errors } = await openBrowser(
      t,
      pathToFileURL(file).href,
    );
    await waitFor('Boolean(document.querySelector("main")?.constellation)');
    await evaluate(
      `document.querySelector('[data-profile-dimension="${dimension.id}"]').click()`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('[data-profile-dimension="${dimension.id}"]').getAttribute('aria-pressed')`,
      ),
      "true",
    );
    assert.ok(
      await evaluate('document.querySelector("svg[data-profile-selection]")'),
    );
    assert.ok(
      await evaluate(
        '[...document.querySelectorAll(".repository")].some(node => node.hasAttribute("data-profile-related"))',
      ),
    );
    await evaluate(
      `document.querySelector('main').constellation.selectNode(${JSON.stringify(repository)}, {focus:false})`,
    );
    assert.match(
      await evaluate('document.querySelector("[data-details]").textContent'),
      /Developer evidence:/,
    );
    await evaluate(
      'document.querySelector(".developer-profile-controls button:last-child").click()',
    );
    assert.equal(
      await evaluate(
        'document.querySelector("svg").hasAttribute("data-profile-selection")',
      ),
      false,
    );
    assert.deepEqual(errors, []);
  },
);

test("CLI build emits standalone HTML without changing the SVG default", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "constellation-html-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repos = join(dir, "repos.json"),
    output = join(dir, "index.html"),
    githubOutput = join(dir, "github-output.txt");
  await writeFile(repos, JSON.stringify(fixture.repositories));
  const run = (args) =>
    spawnSync(
      process.execPath,
      [
        "src/cli.mjs",
        "build",
        "--username",
        "fixture",
        "--fixture",
        repos,
        "--output",
        output,
        ...args,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          CONSTELLATION_CONFIG: "",
          CONSTELLATION_CONFIG_JSON: "",
          GITHUB_OUTPUT: githubOutput,
        },
      },
    );
  const result = run(["--format", "html"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(output, "utf8"), /^<!doctype html>/);
  assert.match(await readFile(githubOutput, "utf8"), /^evidence-digest=sha256:[a-f0-9]{64}$/m);
  assert.equal(run(["--format", "invalid"]).status, 1);
  assert.equal(run([]).status, 0);
  assert.match(await readFile(output, "utf8"), /<svg/);
  assert.ok(!(await readFile(output, "utf8")).includes("<!doctype html>"));
});
