// One prebuilt Rust module runs in the browser and in the Node action.
import { overviewEdges } from "./scaling.mjs";
import { evidenceNavigatorAdapter } from "./evidence-navigator.mjs";
// Supported rendering always uses the bundled Rust/WASM engine.
let core;
export let engineError;
try {
  const bindings = await import("./wasm/constellation_core.js");
  let module;
  if (typeof process === "undefined" || !process.versions?.node) {
    try {
      const response = await fetch(new URL("./wasm/constellation_core_bg.wasm", import.meta.url));
      const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (response.ok && contentType === "application/wasm") module = response;
    } catch {}
  }
  if (!module) {
    const { base64 } = await import("./wasm/inline.mjs");
    module = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  }
  await bindings.default({ module_or_path: module });
  core = bindings;
} catch (error) {
  engineError = error;
  throw new Error(
    "Constellation requires its bundled Rust/WASM engine. Restore the generated inline WASM module and allow WebAssembly in your browser policy.",
    { cause: error },
  );
}

export const rustAvailable = Boolean(core);
export function semanticLayout(input) {
  if (!core?.semantic_layout) throw new Error('Semantic Studio requires the rebuilt Rust/WASM engine.');
  return JSON.parse(core.semantic_layout(JSON.stringify(input)));
}
const stableCoordinates = new Map();
export const layoutStatistics = { computedNodes: 0, reusedNodes: 0 };
function stableScene(input) {
  const prefix = JSON.stringify([input.account, input.compact, Boolean(input.round)]);
  const keys = input.repos.map((repo) => `${prefix}:${repo.name}`);
  const missing = input.repos.filter(
    (_repo, i) => !stableCoordinates.has(keys[i]),
  );
  if (missing.length) {
    const positions = JSON.parse(
      core.stable_positions(
        JSON.stringify({
          account: input.account,
          compact: input.compact,
          round: Boolean(input.round),
          names: missing.map((repo) => repo.name),
        }),
      ),
    );
    missing.forEach((repo, i) =>
      stableCoordinates.set(`${prefix}:${repo.name}`, positions[i]),
    );
  }
  layoutStatistics.computedNodes += missing.length;
  layoutStatistics.reusedNodes += input.repos.length - missing.length;
  const anchors = input.snapToRings
    ? identityPoints(input.account, input.nodeCap, input.ring_rotations)
    : [];
  const positions = input.repos.map((repo, i) => {
    if (repo.position) return repo.position;
    const position = stableCoordinates.get(keys[i]);
    if (!anchors.length) return position;
    let best = position,
      distance = Infinity;
    for (let j = 0; j < anchors.length; j += 3) {
      const point = [
        450 + ((anchors[j] - 240) * (input.round ? (input.compact ? 88 : 192) : 368)) / 172,
        (input.compact ? 126 : 270) +
          ((anchors[j + 1] - 240) * (input.compact ? 88 : 192)) / 172,
      ];
      const next =
        (point[0] - position[0]) ** 2 + (point[1] - position[1]) ** 2;
      if (next < distance) {
        best = point;
        distance = next;
      }
    }
    return best;
  });
  while (stableCoordinates.size > 8192)
    stableCoordinates.delete(stableCoordinates.keys().next().value);
  return {
    positions,
    edges: overviewEdges(input.repos, input.basis),
    total: input.repos.length,
  };
}
const refinements = new Map();
export function refineLayout(input) {
  if (!core?.refine_layout)
    throw new Error(
      "Layout refinement needs the rebuilt Rust engine. Reload the studio or run npm run build:rust.",
    );
  const key = JSON.stringify(input);
  if (!refinements.has(key)) {
    if (refinements.size >= 8)
      refinements.delete(refinements.keys().next().value);
    refinements.set(key, JSON.parse(core.refine_layout(key)));
  }
  return refinements.get(key);
}
const projections = new Map();
export function projectNodes(input) {
  if (!core)
    throw new Error(
      "Language and topic nodes need the Rust engine. Reload to try again.",
    );
  const key = JSON.stringify(input);
  if (!projections.has(key)) {
    const result = JSON.parse(core.project_nodes(key));
    if (projections.size >= 8)
      projections.delete(projections.keys().next().value);
    projections.set(key, result);
  }
  return structuredClone(projections.get(key));
}
const scenes = new Map();
export function layoutCacheStatistics() {
  return {
    scenes: scenes.size,
    sceneLimit: 8,
    projections: projections.size,
    projectionLimit: 8,
    refinements: refinements.size,
    refinementLimit: 8,
    stableCoordinates: stableCoordinates.size,
    stableCoordinateLimit: 8192,
  };
}
export function computeScene(input) {
  if (input.stableOverview) return stableScene(input);
  const key = JSON.stringify(input);
  if (!scenes.has(key)) {
    const scene = JSON.parse(core.compute_scene(key));
    if (scenes.size >= 8) scenes.delete(scenes.keys().next().value);
    scenes.set(key, scene);
  }
  return scenes.get(key);
}

export function analyzeDeveloperProfile(input) {
  if (!core?.developer_profile)
    throw new Error(
      "Developer Topology needs the rebuilt Rust engine. Reload the studio or run npm run build:rust.",
    );
  return JSON.parse(core.developer_profile(JSON.stringify(input)));
}

export const GRAPH_QUALITY_VERSION = 1;
export function evaluateGraphQuality(candidate) {
  if (!core?.graph_quality) throw new Error('Graph Quality needs the rebuilt Rust engine.');
  return JSON.parse(core.graph_quality(JSON.stringify(candidate)));
}

export function composeStory(input) {
  if (!core?.compose_story) throw new Error('Story Composition needs the rebuilt Rust/WASM engine.');
  return JSON.parse(core.compose_story(JSON.stringify(input)));
}

export const STORY_CLARITY_VERSION = 1;
export function analyzeStoryClarity(input) {
  if (!core?.analyze_story_clarity) throw new Error('Story Clarity needs the rebuilt Rust/WASM engine.');
  return JSON.parse(core.analyze_story_clarity(JSON.stringify(input)));
}

export const RECRUITER_EVIDENCE_VERSION = 1;
export function analyzeRecruiterEvidence(input) {
  if (!core?.analyze_recruiter_evidence) throw new Error('Recruiter Evidence needs the rebuilt Rust/WASM engine.');
  return JSON.parse(core.analyze_recruiter_evidence(JSON.stringify(input)));
}

// Evidence Navigation v1: build the retained Rust index once per graph, then
// navigate per interaction. Pass a graph from evidenceNavigationGraph().
export function createEvidenceNavigator(graph) {
  if (!core?.EvidenceNavigator) throw new Error('Evidence Navigation needs the rebuilt Rust/WASM engine.');
  return evidenceNavigatorAdapter(core.EvidenceNavigator, graph);
}
export function navigateEvidence(graph, projectId, { depth = 1 } = {}) {
  if (!core?.EvidenceNavigator) throw new Error('Evidence Navigation needs the rebuilt Rust/WASM engine.');
  const index = new core.EvidenceNavigator(JSON.stringify(graph));
  try { return JSON.parse(index.navigate(JSON.stringify({ projectId, depth }))); } finally { index.free(); }
}

export function identityGeometry(metadata, variation = 0) {
  return Array.from(core.identity_geometry(metadata, variation));
}

export function identityPoints(metadata, count, rotation = 0) {
  return Array.from(
    core.identity_points(
      metadata,
      count,
      Float64Array.from(
        Array.isArray(rotation)
          ? rotation
          : [rotation, rotation, rotation, rotation],
      ),
    ),
  );
}

export function graphSelection(names, pairs, start, end) {
  const index = names.indexOf(start);
  if (index < 0) return [];
  if (end != null) {
    const target = names.indexOf(end);
    if (target < 0 || !core) return [];
    return Array.from(
      core.shortest_path(names.length, Uint32Array.from(pairs), index, target),
      (i) => names[i],
    );
  }
  const adjacent = Array.from(
    core.neighbors(names.length, Uint32Array.from(pairs), index),
  );
  return [start, ...adjacent.map((i) => names[i])];
}
