import test from "node:test";
import assert from "node:assert/strict";
import {
  layoutScene,
  layoutCapabilities,
  diagnoseLayout,
  createScene,
  serializeScene,
  parseScene,
} from "../src/core-api.mjs";
const records = ["Rust", "Python", "Rust"].map((language, i) => ({
  name: `p-${i}`,
  full_name: `layout/p-${i}`,
  language,
  stargazers_count: i * 10,
}));
const options = { referenceDate: "2026-09-01T00:00:00Z", animate: false };
test("layout capabilities describe effective overview mode and validate graph bounds", () => {
  assert.equal(layoutCapabilities("rings").maxNodes, 100);
  assert.equal(
    layoutCapabilities("galaxy", { nodeMode: "combined" }).maxNodes,
    256,
  );
  const overview = layoutCapabilities("galaxy", { nodeCap: 2048 });
  assert.equal(overview.id, "stable-overview");
  assert.equal(overview.maxNodes, 2048);
  assert.equal(overview.manualPositioning, true);
  assert.equal(overview.refinement, true);
  overview.maxNodes = 1;
  assert.equal(layoutCapabilities("galaxy", { nodeCap: 2048 }).maxNodes, 2048);
  assert.equal(
    layoutCapabilities("profile", { nodeCap: 256, nodeMode: "combined" }).id,
    "profile",
  );
  assert.equal(
    layoutCapabilities("profile", { nodeCap: 256, nodeMode: "combined" })
      .maxNodes,
    256,
  );
  assert.equal(layoutCapabilities("profile", { nodeCap: 2048 }).id, "profile");
  assert.equal(layoutCapabilities("profile", { nodeCap: 2048 }).maxNodes, 100);
  const tooLarge = {
    nodes: Array.from({ length: 101 }, (_, i) => ({
      id: `layout/${i}`,
      metadata: { full_name: `layout/${i}`, name: String(i) },
    })),
  };
  assert.equal(diagnoseLayout(tooLarge).diagnostics[0].code, "layout-size");
  assert.throws(() => layoutScene(tooLarge), /at most 100/);
  assert.equal(
    diagnoseLayout(tooLarge, { nodeCap: 2048 }).diagnostics[0].code,
    "layout-overview",
  );
});
test("existing layouts share the scene interface and preserve seeded/manual coordinates", () => {
  for (const arrangement of [
    "field",
    "rings",
    "orbital",
    "force",
    "galaxy",
    "solar-system",
  ]) {
    const settings = {
      ...options,
      arrangement,
      starPositions: { "layout/p-0": { x: 123, y: 234 } },
    };
    const scene = createScene("layout", records, settings);
    const first = layoutScene(scene, settings),
      second = layoutScene(parseScene(serializeScene(scene)), settings);
    assert.deepEqual(first, second);
    assert.deepEqual(first.positions["layout/p-0"], { x: 123, y: 234 });
    assert.deepEqual(
      scene.nodes.map((node) => node.geometry.x),
      scene.nodes.map((node) => first.positions[node.id].x),
    );
    first.positions["layout/p-0"].x = 999;
    assert.equal(layoutScene(scene, settings).positions["layout/p-0"].x, 123);
  }
});
test("Developer Topology returns traceable evidence and preserves real graph edges", () => {
  const showcase = {
    "layout/p-0": { role: "featured", priority: 1 },
    "layout/p-1": { role: "supporting" },
  };
  const settings = {
    ...options,
    arrangement: "profile",
    profileEmphasis: "systems",
    projectShowcase: showcase,
  };
  const scene = createScene("layout", records, settings);
  const profile = scene.developerProfile;
  assert.ok(profile);
  assert.equal(profile.repositories.length, records.length);
  assert.ok(
    profile.dimensions.every((dimension) =>
      dimension.evidence.every((item) =>
        records.some((repo) => repo.full_name === item.repository),
      ),
    ),
  );
  assert.match(profile.signature, /Strongest evidence/);
  assert.ok(
    scene.annotations.some(
      (annotation) => annotation.text === profile.signature,
    ),
  );
  const ordinary = createScene("layout", records, {
    ...settings,
    arrangement: "rings",
  });
  assert.deepEqual(
    scene.edges.map((edge) => edge.id).sort(),
    ordinary.edges.map((edge) => edge.id).sort(),
  );
  assert.deepEqual(
    createScene("layout", records, settings).developerProfile,
    profile,
  );
});
test("Developer Topology gives language/topic nodes affinities from member repositories", () => {
  const selected = records.map((repo, index) => ({
    ...repo,
    languages: { [repo.language]: 100 },
    topics: index === 0 ? ["frontend"] : [],
  }));
  const scene = createScene("layout", selected, {
    ...options,
    arrangement: "profile",
    nodeMode: "combined",
  });
  const rust = scene.developerProfile.nodes.find(
    (node) => node.node === "language:Rust",
  );
  const interfaceNode = scene.developerProfile.nodes.find(
    (node) => node.node === "topic:frontend",
  );
  assert.ok(
    rust.dimensions[
      scene.developerProfile.dimensions.findIndex(
        (dimension) => dimension.id === "systems",
      )
    ] > 0,
  );
  assert.ok(
    interfaceNode.dimensions[
      scene.developerProfile.dimensions.findIndex(
        (dimension) => dimension.id === "interface",
      )
    ] > 0,
  );
  assert.ok(
    scene.developerProfile.dimensions.some((dimension) =>
      dimension.evidence.some((item) => item.repository === "layout/p-0"),
    ),
  );
  assert.ok(
    scene.developerProfile.dimensions.every((dimension) =>
      dimension.evidence.every(
        (item) =>
          !item.repository.startsWith("language:") &&
          !item.repository.startsWith("topic:"),
      ),
    ),
  );
});
