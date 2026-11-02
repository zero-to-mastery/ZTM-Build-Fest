import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { createPreviewServer } from "../scripts/preview-server.mjs";
import {
  createScene,
  createTimeline,
  createHierarchy,
  createStory,
  renderSceneSVG,
  renderSceneHTML,
  serializeScene,
  parseScene,
  parseConfig,
  projectTemporalPlane,
  validateScene,
} from "../src/core-api.mjs";
import { browser, openBrowser } from "../scripts/browser-harness.mjs";

const records = [
  {
    name: "compiler",
    full_name: "demo/compiler",
    created_at: "2020-01-01",
    language: "Rust",
    stargazers_count: 100,
  },
  {
    name: "runtime",
    full_name: "demo/runtime",
    created_at: "2024-05-01",
    language: "Rust",
    stargazers_count: 20,
  },
  { name: "unknown", full_name: "demo/unknown", language: "Rust" },
];
const options = {
  referenceDate: "2026-09-01T00:00:00.000Z",
  arrangement: "temporal-stack",
  animate: false,
};

test("yearly layers use timeline evidence, stable anchors, adjacent bridges and unique DOM identities", () => {
  const scene = createScene("demo", records, options);
  assert.deepEqual(
    scene.temporalStack.layers.map((layer) => layer.year),
    [2026, 2025, 2024, 2023, 2022, 2021],
  );
  const positions = new Map();
  for (const frame of scene.timeline.frames) {
    for (const node of frame.scene.nodes) {
      const point = [node.geometry.x, node.geometry.y];
      if (positions.has(node.id))
        assert.deepEqual(point, positions.get(node.id));
      positions.set(node.id, point);
    }
    if (frame.evidence !== "current") {
      assert.equal(frame.evidence, "current-metadata");
      assert.equal(
        frame.scene.nodes.some((node) => node.id === "demo/unknown"),
        false,
      );
      assert.equal(
        frame.scene.nodes.find((node) => node.id === "demo/compiler").metadata
          .stargazers_count,
        100,
      );
    }
  }
  assert.equal(scene.temporalStack.bridges.length, 7);
  assert.ok(
    scene.temporalStack.bridges.every(
      (edge) => edge.toYear - edge.fromYear === 1,
    ),
  );
  const svg = renderSceneSVG(scene),
    ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(svg, /Current-metadata retrospective view/);
  assert.match(svg, /temporal-birth/);
  assert.equal(
    serializeScene(parseScene(serializeScene(scene))),
    serializeScene(scene),
  );
  assert.equal(
    renderSceneSVG(createScene("demo", [...records].reverse(), options)),
    svg,
  );
  assert.deepEqual(scene.nodes, scene.timeline.frames.at(-1).scene.nodes);
});

test("Developer Topology derives evidence and positions from each temporal snapshot", () => {
  const referenceDate = "2025-09-01T00:00:00.000Z";
  const scene = createScene("demo", [], {
    ...options,
    referenceDate,
    arrangement: "temporal-stack",
    temporalStack: {
      enabled: true,
      yearStart: 2023,
      yearEnd: 2025,
      innerArrangement: "profile",
    },
    timeline: {
      referenceDate,
      snapshots: [
        {
          date: "2023-12-31T23:59:59.999Z",
          records: [
            { name: "compiler", full_name: "demo/compiler", language: "Rust" },
          ],
        },
        {
          date: "2024-12-31T23:59:59.999Z",
          records: [
            { name: "compiler", full_name: "demo/compiler", language: "Rust" },
            {
              name: "interface",
              full_name: "demo/interface",
              language: "HTML",
              topics: ["frontend"],
            },
          ],
        },
      ],
    },
  });
  const years = new Map(
    scene.timeline.frames.map((frame) => [
      new Date(frame.date).getUTCFullYear(),
      frame.scene,
    ]),
  );
  assert.ok(
    years
      .get(2023)
      .developerProfile.dimensions.find(
        (dimension) => dimension.id === "systems",
      ).evidence.length,
  );
  assert.equal(
    years
      .get(2023)
      .developerProfile.dimensions.find(
        (dimension) => dimension.id === "interface",
      ).evidence.length,
    0,
  );
  assert.ok(
    years
      .get(2024)
      .developerProfile.dimensions.find(
        (dimension) => dimension.id === "interface",
      ).evidence.length,
  );
  assert.equal(scene.temporalStack.settings.innerArrangement, "profile");
  assert.equal(validateScene(scene).valid, true);
  assert.match(renderSceneSVG(scene), /Developer evidence:/);
});

test("snapshots preserve measured metadata and gaps, including projects absent today", () => {
  const snapshot = { ...records[0], stargazers_count: 3 };
  const retired = { name: "retired", full_name: "demo/retired", language: "C" };
  const scene = createTimeline("demo", records, options, {
    referenceDate: options.referenceDate,
    snapshots: [
      { date: "2021-06-01", records: [snapshot, retired] },
      { date: "2023-08-01", records: [] },
      { date: "2025-02-01", records: [snapshot, retired] },
    ],
  });
  assert.deepEqual(
    scene.temporalStack.layers.map((layer) => layer.year),
    [2026, 2025, 2023, 2021],
  );
  assert.equal(
    scene.timeline.frames[0].scene.nodes.find(
      (node) => node.id === snapshot.full_name,
    ).metadata.stargazers_count,
    3,
  );
  assert.equal(
    scene.temporalStack.bridges.some(
      (edge) => edge.fromYear === 2021 || edge.fromYear === 2023,
    ),
    false,
  );
  assert.match(renderSceneSVG(scene), /Snapshot · 2021-06-01/);
  assert.equal(validateScene(scene).valid, true);
});

test("manual local coordinates apply to every occurrence and projection never changes layouts", () => {
  const scene = createScene("demo", records, {
    ...options,
    starPositions: { "demo/compiler": { x: 220, y: 170 } },
  });
  for (const frame of scene.timeline.frames)
    assert.deepEqual(
      [
        frame.scene.nodes.find((node) => node.id === "demo/compiler").geometry
          .x,
        frame.scene.nodes.find((node) => node.id === "demo/compiler").geometry
          .y,
      ],
      [220, 170],
    );
  const before = serializeScene(scene);
  for (const layer of scene.temporalStack.layers)
    assert.ok(
      projectTemporalPlane(layer.depth, scene.temporalStack.settings, {
        depth: 2,
        rotation: -1,
        tilt: 0.85,
      }).every(Number.isFinite),
    );
  assert.equal(serializeScene(scene), before);
});

test("config, attachment and size boundaries reject invalid inputs; compact output documents reduction", () => {
  const parsed = parseConfig({
    arrangement: "temporal-stack",
    temporalStack: { yearStart: 2020, yearEnd: 2026 },
  });
  assert.equal(parsed.options.temporalStack.yearStart, 2020);
  for (const value of [
    { tilt: NaN },
    { connections: "all" },
    { unknown: true },
    { yearStep: 0 },
    { yearStart: 2027, yearEnd: 2026 },
  ])
    assert.throws(() =>
      createScene("demo", records, { ...options, temporalStack: value }),
    );
  assert.throws(
    () =>
      createScene("demo", records, {
        ...options,
        temporalStack: { yearStart: 1970 },
      }),
    /20/,
  );
  assert.throws(
    () =>
      createScene("demo", records, {
        ...options,
        temporalStack: { yearEnd: 2027 },
      }),
    /reference/,
  );
  const compact = createScene("demo", records, {
    ...options,
    exportProfile: "profile",
  });
  assert.equal(compact.temporalStack.layers.length, 3);
  assert.match(renderSceneSVG(compact), /latest three/);
  for (const mutate of [
    (s) => (s.temporalStack.layers[0].depth = 2),
    (s) => (s.temporalStack.layers[0].frameId = "missing"),
    (s) => (s.temporalStack.bridges[0].nodeId = "absent"),
    (s) => (s.temporalStack.settings = {}),
    (s) => s.timeline.frames[0].scene.nodes[0].geometry.x++,
  ]) {
    const scene = createScene("demo", records, options);
    mutate(scene);
    assert.equal(validateScene(scene).valid, false);
  }
  const disabled = createScene("demo", records, {
    ...options,
    arrangement: "solar-system",
    temporalStack: { enabled: false },
  });
  assert.equal(disabled.temporalStack, undefined);
  const many = Array.from({ length: 220 }, (_, i) => ({
    ...records[0],
    name: `p${i}`,
    full_name: `demo/p${i}`,
    created_at: "2000-01-01",
  }));
  assert.throws(
    () =>
      createScene("demo", many, {
        ...options,
        maxRepos: 220,
        nodeCap: 220,
        temporalStack: { yearStart: 2007 },
      }),
    /4,096/,
  );
});

test(
  "offline camera, keyboard years, trails, filters, timeline switching and cleanup",
  { skip: !browser, timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "constellation-temporal-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "index.html");
    await writeFile(
      file,
      renderSceneHTML(createScene("demo", records, options)),
    );
    const { evaluate, waitFor, errors, cdp } = await openBrowser(
      t,
      pathToFileURL(file).href,
    );
    await waitFor(`Boolean(document.querySelector('main')?.constellation)`);
    await evaluate(
      `window.api = document.querySelector('main').constellation; api.focusTemporalNode('demo/runtime')`,
    );
    assert.equal(
      await evaluate(
        `document.querySelectorAll('.temporal-bridge[data-related]').length`,
      ),
      2,
    );
    assert.match(
      await evaluate(`document.querySelector('[data-details]').textContent`),
      /Visible in: 3/,
    );
    await evaluate(`api.focusYear(2024)`);
    assert.match(
      await evaluate(`document.querySelector('[data-status]').textContent`),
      /current metadata/,
    );
    const before = await evaluate(
      `document.querySelector('[data-temporal-year="2024"]').getAttribute('transform')`,
    );
    await evaluate(`api.setTemporalView({depth:2,rotation:.5,tilt:.6})`);
    assert.notEqual(
      await evaluate(
        `document.querySelector('[data-temporal-year="2024"]').getAttribute('transform')`,
      ),
      before,
    );
    await evaluate(`api.setFilter({query:'compiler'}); api.setTheme('light')`);
    assert.equal(
      await evaluate(
        `document.querySelectorAll('.temporal-bridge:not([data-filtered])').length`,
      ),
      5,
    );
    await evaluate(`api.setFrame(0)`);
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[data-temporal-year]').length`,
      ),
      0,
    );
    await evaluate(`api.resetTemporalView()`);
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[data-temporal-year]').length`,
      ),
      6,
    );
    assert.equal(await evaluate(`api.theme`), "light");
    await evaluate(
      `api.setFilter({}); const node = document.querySelector('.repository[data-node-id="demo/compiler"]'); node.focus(); node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`,
    );
    assert.equal(await evaluate(`api.selection`), "demo/compiler");
    await cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await evaluate(`api.setTemporalView({depth:0}); api.focusYear(2026)`);
    assert.equal(
      await evaluate(
        `document.querySelector('svg').getAnimations({subtree:true}).length`,
      ),
      0,
    );
    await evaluate(`api.destroy()`);
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[aria-label="Temporal Stack"]').length`,
      ),
      0,
    );
    assert.deepEqual(errors, []);
  },
);

test(
  "packaged component temporal APIs focus years, views and nodes",
  { skip: !browser, timeout: 120000 },
  async (t) => {
    const server = createPreviewServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    );
    const base = `http://127.0.0.1:${server.address().port}`;
    const { evaluate, waitFor, errors } = await openBrowser(
      t,
      `${base}/examples/web-component.html`,
    );
    await waitFor(
      `Boolean(document.querySelector('constellation-view')?.shadowRoot?.querySelector('main')?.constellation)`,
    );
    await evaluate(
      `(async()=>{ const {createScene}=await import('/packages/core/src/core-api.mjs'); const view=document.querySelector('constellation-view'); view.scene=createScene('demo',${JSON.stringify(records)},${JSON.stringify(options)}); view.focusYear(2024); view.setTemporalView({rotation:.4}); view.focusTemporalNode('demo/runtime'); })()`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('constellation-view').shadowRoot.querySelectorAll('.temporal-bridge[data-related]').length`,
      ),
      2,
    );
    await evaluate(
      `document.querySelector('constellation-view').setFrame(0); document.querySelector('constellation-view').resetTemporalView()`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('constellation-view').shadowRoot.querySelectorAll('[data-temporal-year]').length`,
      ),
      6,
    );
    assert.deepEqual(errors, []);
  },
);

test(
  "temporal scenes compose with Story and Hierarchy without collapsing occurrences",
  { skip: !browser, timeout: 120000 },
  async (t) => {
    const temporal = createScene("demo", records, options);
    const ordinary = createScene("demo", records, {
      ...options,
      arrangement: "solar-system",
    });
    const hierarchy = createHierarchy({
      root: "root",
      scenes: [
        {
          id: "root",
          scene: temporal,
          links: [{ nodeId: "demo/compiler", target: "child" }],
        },
        { id: "child", scene: ordinary },
      ],
    });
    const scene = createStory({
      chapters: [
        { id: "history", scene: hierarchy },
        { id: "map", scene: temporal },
      ],
    });
    const dir = await mkdtemp(join(tmpdir(), "constellation-temporal-story-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "index.html");
    await writeFile(file, renderSceneHTML(scene));
    const { evaluate, waitFor, errors } = await openBrowser(
      t,
      pathToFileURL(file).href,
    );
    await waitFor(`Boolean(document.querySelector('main')?.constellation)`);
    await evaluate(
      `window.api=document.querySelector('main').constellation; api.focusYear(2024); api.openChild('child');`,
    );
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[data-temporal-year]').length`,
      ),
      0,
    );
    await evaluate(
      `api.back(); api.focusTemporalNode('demo/compiler'); api.setChapter(1); api.setTemporalView({depth:1.5});`,
    );
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[data-temporal-year]').length`,
      ),
      6,
    );
    assert.equal(
      await evaluate(
        `(()=>{const ids=[...document.querySelectorAll('svg [id]')].map(node=>node.id);return ids.length===new Set(ids).size;})()`,
      ),
      true,
    );
    assert.deepEqual(errors, []);
  },
);
