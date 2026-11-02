import {
  createScene,
  repositoryLanguages,
  selectRepositories,
} from "./constellation.mjs";
import { normalizeRecords, toGraphRecords } from "./data-pipeline.mjs";
import { createTimeline } from "./timeline.mjs";
import { artifactPositions } from "./artifact-layouts.mjs";
import {
  temporalStackOptions,
  temporalBridges,
  MAX_TEMPORAL_LAYERS,
  MAX_TEMPORAL_NODES,
} from "./temporal-stack-model.mjs";
import { temporalGeometryMath } from "./temporal-geometry.mjs";
import { temporalRingLayout } from "./temporal-ring-layout.mjs";
import { temporalGeometryDrawing } from "./temporal-geometry-drawing.mjs";
import { historyOptions } from "./history/settings.mjs";
import { retainEvidenceSubjects } from "./evidence.mjs";

export function createTemporalStack(
  account,
  records,
  options = {},
  runtime = {},
) {
  runtime.signal?.throwIfAborted();
  const settings = {
    ...temporalStackOptions(options.temporalStack),
    enabled: true,
  };
  if (
    options.temporalGeometry &&
    options.temporalStack?.innerArrangement === undefined
  )
    settings.innerArrangement = "rings";
  const referenceDate =
    options.timeline?.referenceDate ||
    options.referenceDate ||
    options.generatedAt ||
    new Date().toISOString();
  const small =
    options.layout === "compact" ||
    ["compact", "profile", "readme", "repository"].includes(
      options.exportProfile,
    );
  const inner = {
    ...options,
    temporalStack: undefined,
    timeline: undefined,
    arrangement: settings.innerArrangement,
    layout: "atlas",
    exportProfile: "custom",
    referenceDate,
    historicalYear: undefined,
    timeLapse: false,
  };
  let scene,
    frameList,
    layers,
    reduced = false;
  if (settings.axis === "year") {
    const current = new Date(referenceDate).getUTCFullYear();
    const end = settings.yearEnd ?? current,
      start = settings.yearStart ?? Math.max(1970, end - 5);
    if (!Number.isInteger(current) || end > current || start > end)
      throw new Error(
        "Temporal Stack years must end at or before the reference year.",
      );
    const years = [];
    for (let year = end; year >= start; year -= settings.yearStep)
      years.push(year);
    if (years.length > MAX_TEMPORAL_LAYERS)
      throw new Error(
        "Temporal Stack supports at most 20 yearly layers. Increase yearStep.",
      );
    const shown = small ? years.slice(0, 3) : years;
    const dates = shown
      .filter((year) => year !== current)
      .map((year) => year + "-12-31T23:59:59.999Z");
    scene = createTimeline(
      account,
      records,
      inner,
      options.timeline || { referenceDate, dates },
      runtime,
    );
    frameList = scene.timeline.frames;
    const byYear = new Map(
      frameList.map((frame) => [new Date(frame.date).getUTCFullYear(), frame]),
    );
    layers = shown
      .filter((year) => byYear.has(year))
      .map((year, index) => ({
        year,
        frameId: byYear.get(year).id,
        depth: -index,
      }));
    reduced = small && years.length > shown.length;
  } else {
    const pool = selectRepositories(
      toGraphRecords(normalizeRecords(records).records),
      inner,
    );
    const membership = (repo) =>
      settings.axis === "language"
        ? repositoryLanguages(repo)
        : settings.axis === "topic"
          ? repo.topics || []
          : [repo.full_name];
    const groups = new Map();
    for (const repo of pool)
      for (const value of new Set(membership(repo))) {
        if (!groups.has(value)) groups.set(value, []);
        groups.get(value).push(repo);
      }
    const ranked = [...groups.keys()].sort(
      (a, b) =>
        groups.get(b).length - groups.get(a).length ||
        groups.get(b).reduce((n, r) => n + (r.stargazers_count || 0), 0) -
          groups.get(a).reduce((n, r) => n + (r.stargazers_count || 0), 0) ||
        a.localeCompare(b),
    );
    const values = settings.layerValues || ranked.slice(0, 8);
    if (values.some((value) => !groups.has(value)))
      throw Error(
        "A selected universe layer is unavailable in the filtered projects.",
      );
    const shown = small ? values.slice(0, 3) : values;
    reduced = shown.length < ranked.length;
    const build = (repos) =>
      createScene(
        account,
        repos,
        {
          ...inner,
          nodeMode:
            settings.axis === "repository" ? "combined" : "repositories",
          maxRepos: Math.max(1, repos.length),
          includeRepos: undefined,
          history: {
            mode: "current",
            year: null,
            timeLapse: { enabled: false },
          },
        },
        runtime,
      );
    scene = build(pool);
    frameList = shown.map((value) => ({
      id: settings.axis + ":" + encodeURIComponent(value),
      evidence: "current-membership",
      scene: build(groups.get(value)),
    }));
    layers = frameList.map((frame, index) => ({
      id: frame.id,
      axis: settings.axis,
      value: shown[index],
      label: shown[index],
      depth: -index,
      frameId: frame.id,
      evidence: frame.evidence,
    }));
  }
  if (!layers.length)
    throw Error(
      "No layers match this universe dimension. Choose another dimension or project selection.",
    );
  // Inner frames use custom sizing; retain the outer export's sky semantics.
  scene.presentation.options.exportProfile = options.exportProfile || "custom";
  // Frames remain snapshots; playback emphasizes the existing cross-sections.
  scene.presentation.options.history = historyOptions(options).history;
  if (settings.axis !== "year")
    scene.presentation.options.history = {
      ...scene.presentation.options.history,
      mode: "current",
      year: null,
      timeLapse: {
        ...scene.presentation.options.history.timeLapse,
        enabled: false,
      },
    };
  const union = new Map();
  for (const frame of frameList)
    for (const node of frame.scene.nodes) union.set(node.id, node);
  const nodes = [...union.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (nodes.length > 2048)
    throw new Error(
      "Temporal Stack exceeds 2,048 unique nodes. Reduce snapshots or graph size.",
    );
  const profileTopology = settings.innerArrangement === "profile";
  const anchors =
    settings.innerArrangement === "rings" || profileTopology
      ? Object.fromEntries(nodes.map((node) => [node.id, node.geometry]))
      : artifactPositions(
          nodes.map((node) => node.metadata),
          settings.innerArrangement,
          scene.metadata.seed,
          false,
          options.majorMetric,
        );
  Object.assign(anchors, options.starPositions);
  const ringModel = temporalRingLayout(
    scene.metadata.seed,
    nodes,
    {
      ...options,
      ...(profileTopology
        ? { snapToRings: false, ringPlacements: undefined }
        : {}),
      innerArrangement: settings.innerArrangement,
    },
    anchors,
  );
  for (const frame of frameList) {
    runtime.signal?.throwIfAborted();
    const labels = new Map(
      frame.scene.labels.map((label) => [label.id, label]),
    );
    if (!profileTopology)
      for (const node of frame.scene.nodes) {
        const anchor = anchors[node.id],
          dx = anchor.x - node.geometry.x,
          dy = anchor.y - node.geometry.y;
        const label = labels.get(node.id);
        if (label) {
          label.x += dx;
          label.y += dy;
        }
        node.geometry = { ...node.geometry, x: anchor.x, y: anchor.y };
      }
    const byId = new Map(
      frame.scene.nodes.map((node) => [node.id, node.geometry]),
    );
    for (const edge of frame.scene.edges)
      edge.geometry.distance =
        (byId.get(edge.from).x - byId.get(edge.to).x) ** 2 +
        (byId.get(edge.from).y - byId.get(edge.to).y) ** 2;
  }
  if (profileTopology) scene.annotations = [];
  const latest = frameList.at(-1).scene;
  for (const key of ["nodes", "edges", "labels", "geometry"])
    scene[key] = structuredClone(latest[key]);
  const frames = new Map(frameList.map((frame) => [frame.id, frame.scene]));
  if (
    layers.reduce(
      (total, layer) => total + frames.get(layer.frameId).nodes.length,
      0,
    ) > MAX_TEMPORAL_NODES
  )
    throw new Error(
      "Universe exceeds 4,096 displayed node occurrences. Reduce layers or graph size.",
    );
  scene.temporalStack = {
    version: settings.axis === "year" ? 1 : 2,
    axis: settings.axis,
    settings,
    layers,
    bridges: temporalBridges(layers, frames, settings.connections),
    reduced,
    ...(settings.axis === "year" ? {} : { frames: frameList }),
  };
  const profile = temporalGeometryMath.options(
    options.temporalGeometry || {
      shape: "stack",
      depth: Math.max(
        80,
        Math.min(1600, (layers.length - 1) * settings.depthGap),
      ),
    },
  );
  scene.temporalStack.geometry = { version: 1, profile, ...ringModel };
  const evidenceNodeIds = new Set(scene.nodes.map(node => node.id));
  for (const frame of frameList) for (const node of frame.scene.nodes) evidenceNodeIds.add(node.id);
  scene.evidence = retainEvidenceSubjects(scene.evidence, evidenceNodeIds);
  const viewBox = temporalGeometryDrawing(scene).viewBox;
  scene.viewport = {
    width: 900,
    height: (viewBox[3] * 900) / viewBox[2],
    viewBox,
  };
  return scene;
}
