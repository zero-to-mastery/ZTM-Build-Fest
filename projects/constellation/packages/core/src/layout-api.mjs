import { roundOrbits } from './orbit-shape.mjs';
import { computeScene, rustAvailable, semanticLayout } from "./engine.mjs";
import { semanticActive } from './semantic-studio.mjs';
import { artifactLayouts, artifactPositions } from "./artifact-layouts.mjs";
import {
  organizationLayouts,
  organizationNodeMode,
} from "./organization/settings.mjs";
import { organizationPositions } from "./organization/graph.mjs";
import { timelinePositions } from "./history/history-svg.mjs";
import { historyOptions } from "./history/settings.mjs";
import { resolveSeed } from "./seeded-random.mjs";
import { scalingOptions } from "./scaling.mjs";
import { profileDimensions } from "./export-image.mjs";

export const BUILTIN_LAYOUTS = Object.freeze([
  "field",
  "orbital",
  "force",
  "rings",
  "profile",
  ...artifactLayouts,
  ...organizationLayouts,
]);

function showcaseRole(repository, showcase = {}) {
  const lookup = (id) =>
    showcase[id] ||
    Object.entries(showcase).find(
      ([key]) => key.toLowerCase() === id.toLowerCase(),
    )?.[1];
  if (
    repository.nodeKind &&
    repository.nodeKind !== "repository" &&
    Array.isArray(repository.members)
  ) {
    return (
      ["featured", "supporting", "experimental", "historical"].find((role) =>
        repository.members.some((member) => lookup(member)?.role === role),
      ) || ""
    );
  }
  return (
    lookup(repository.full_name)?.role || lookup(repository.name)?.role || ""
  );
}

export function layoutCapabilities(
  id = "rings",
  { nodeCap, nodeMode = "repositories", organization = false } = {},
) {
  if (id !== "stable-overview" && !BUILTIN_LAYOUTS.includes(id))
    throw new Error(`Unknown layout: ${id}`);
  const effective =
    id === "stable-overview" || (nodeCap > 100 && id !== "profile")
      ? "stable-overview"
      : id;
  return {
    id: effective,
    requested: id,
    maxNodes:
      effective === "stable-overview"
        ? 2048
        : id === "profile"
          ? ["combined", "commits"].includes(nodeMode) ||
            (organization && nodeMode !== "repositories")
            ? 256
            : 100
          : ["combined", "commits"].includes(nodeMode) ||
              (organization && nodeMode !== "repositories")
            ? 256
            : 100,
    manualPositioning: true,
    ringSnapping: true,
    deterministicSeed: true,
    animation: true,
    refinement: true,
    requiresWasm: true,
    ringSnappingPhase:
      effective === "rings" || effective === "stable-overview"
        ? "layout-and-editing"
        : "editing-and-refinement",
  };
}

export function diagnoseLayout(scene, options = {}, context = {}) {
  const organization = Boolean(
    context.graph?.organization || scene.presentation?.graph?.organization,
  );
  const capabilities = layoutCapabilities(
    options.arrangement || (rustAvailable ? "rings" : "field"),
    {
      ...options,
      nodeMode: organization ? organizationNodeMode(options) : options.nodeMode,
      organization,
    },
  );
  const diagnostics = [];
  if (scene.nodes.length > capabilities.maxNodes)
    diagnostics.push({
      code: "layout-size",
      severity: "error",
      message: `${capabilities.id} supports at most ${capabilities.maxNodes} nodes for this graph mode.`,
    });
  if (capabilities.requiresWasm && !rustAvailable)
    diagnostics.push({
      code: "layout-wasm",
      severity: "error",
      message: `${capabilities.id} requires the bundled Rust/WASM engine.`,
    });
  if (capabilities.id !== capabilities.requested)
    diagnostics.push({
      code: "layout-overview",
      severity: "info",
      message: `Using stable-overview instead of ${capabilities.requested} for nodeCap > 100.`,
    });
  return { capabilities, diagnostics };
}

// All positions are keyed by stable scene node ID. The accompanying relationship
// result preserves the existing Rust graph selection while callers migrate.
export function layoutScene(scene, options = {}, context = {}) {
  const { signal } = context;
  signal?.throwIfAborted();
  if (!scene || !Array.isArray(scene.nodes))
    throw new Error("Layout requires scene nodes.");
  const report = diagnoseLayout(scene, options, context);
  for (const diagnostic of report.diagnostics)
    context.onDiagnostic?.(diagnostic);
  const error = report.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (error) throw new Error(error.message);
  signal?.throwIfAborted();
  const records = scene.nodes.map((node) => {
    if (
      !node ||
      typeof node.id !== "string" ||
      !node.metadata ||
      node.id !== node.metadata.full_name
    )
      throw new Error("Layout nodes require matching IDs and metadata.");
    return node.metadata;
  });
  if (new Set(scene.nodes.map((node) => node.id)).size !== records.length)
    throw new Error("Layout node IDs must be unique.");
  const graph = context.graph || {
    ...scene.presentation?.graph,
    nodes: records,
    edges: (scene.edges || []).map((edge) => ({
      from: edge.from,
      to: edge.to,
      members: edge.metadata?.sharedRepositories || [],
    })),
  };
  const account = context.account || scene.metadata?.account || "constellation";
  const seed = context.seed ?? resolveSeed(account, options);
  const reference =
    context.reference ??
    Date.parse(
      scene.metadata?.referenceDate ||
        options.referenceDate ||
        "1970-01-01T00:00:00Z",
    );
  const compact = options.layout === "compact";
  const outputHeight = profileDimensions(
    options.exportProfile,
    compact ? 280 : 560,
  ).height;
  const arrangement =
    options.arrangement || (rustAvailable ? "rings" : "field");
  if (!BUILTIN_LAYOUTS.includes(arrangement))
    throw new Error("Unknown built-in layout.");
  const scaling = scalingOptions(options),
    stableOverview = options.nodeCap > 100 && arrangement !== "profile";
  const temporal = historyOptions(options);
  let positions = options.starPositions || {};
  for (const point of Object.values(positions))
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
      throw new Error("Manual layout positions must be finite.");
  if (!stableOverview)
    positions = {
      ...artifactPositions(
        graph.nodes,
        arrangement,
        seed,
        compact,
        options.majorMetric,
        undefined,
        roundOrbits(options),
      ),
      ...positions,
    };
  if (!stableOverview && organizationLayouts.includes(arrangement))
    positions = {
      ...organizationPositions(
        graph,
        arrangement,
        compact,
        seed,
        options.majorMetric,
      ),
      ...options.starPositions,
    };
  if (
    !stableOverview &&
    temporal.languageEvolution.enabled &&
    temporal.languageEvolution.style === "timeline"
  )
    positions = {
      ...timelinePositions(
        [...graph.nodes].sort((a, b) => a.full_name.localeCompare(b.full_name)),
        reference,
        compact,
      ),
      ...options.starPositions,
    };
  const mode = graph.organization
    ? organizationNodeMode(options)
    : options.nodeMode || "repositories";
  const hidden = new Set(options.hiddenNodes || []);
  const profileRepositories =
    arrangement === "profile" || options.accountSun === 'profile' || semanticActive(options)
      ? (
          context.profileRepositories ||
          records.filter(
            (repo) => !repo.nodeKind || repo.nodeKind === "repository",
          )
        ).map((repo) => ({
          name: repo.full_name,
          languages: Object.fromEntries(
            Object.entries(repo.languages || {})
              .filter(
                ([language, share]) =>
                  share > 0 &&
                  (options.languages == null ||
                    options.languages.includes(language)),
              )
              .sort(([left], [right]) => left.localeCompare(right)),
          ),
          language_names: (repo.languages
            ? Object.keys(repo.languages).filter(
                (language) => repo.languages[language] > 0,
              )
            : repo.language
              ? [repo.language]
              : []
          ).filter(
            (language) =>
              options.languages == null || options.languages.includes(language),
          ),
          topics: (repo.topics || []).filter(
            (topic) => options.topics == null || options.topics.includes(topic),
          ),
          role: showcaseRole(repo, options.projectShowcase),
        }))
      : [];
  const input = {
    stableOverview,
    nodeCap: scaling.nodeCap,
    snapToRings: options.snapToRings,
    account: options.seedMode ? seed : account,
    compact,
    round: roundOrbits(options),
    profile_emphasis: options.profileEmphasis || "automatic",
    profile_height: arrangement === "profile" ? outputHeight : 0,
    arrangement:
      artifactLayouts.includes(arrangement) ||
      organizationLayouts.includes(arrangement)
        ? "field"
        : arrangement,
    ring_rotations:
      options.ringRotations || Array(4).fill(options.ringRotation || 0),
    all: options.connectionDensity === "all",
    basis:
      (graph.organization && mode !== "repositories") ||
      ["combined", "commits"].includes(mode)
        ? "membership"
        : mode !== "repositories"
          ? "repositories"
          : options.connectionBasis || "languages",
    profile_repositories: profileRepositories,
    repos: records.map((repo) => ({
      name: repo.full_name,
      group: repo.language || "Other",
      languages: (repo.languages
        ? Object.keys(repo.languages)
            .filter((key) => repo.languages[key] > 0)
            .sort()
        : repo.language
          ? [repo.language]
          : []
      ).filter(
        (language) =>
          options.languages == null || options.languages.includes(language),
      ),
      language_shares: Object.fromEntries(
        Object.entries(repo.languages || {})
          .filter(
            ([language, share]) =>
              share > 0 &&
              (options.languages == null ||
                options.languages.includes(language)),
          )
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
      topics: (repo.topics || []).filter(
        (topic) => options.topics == null || options.topics.includes(topic),
      ),
      role: showcaseRole(repo, options.projectShowcase),
      members: mode === "commits" ? [] : repo.members || [],
      kind: repo.nodeKind || "repository",
      hidden: hidden.has(repo.full_name),
      position: Object.hasOwn(positions, repo.full_name)
        ? [positions[repo.full_name].x, positions[repo.full_name].y]
        : null,
    })),
  };
  signal?.throwIfAborted();
  const semantic = (semanticActive(options) || options.accountSun === 'profile') ? semanticLayout({
    mode: semanticActive(options) ? options.ringMeaning : 'identity',
    compact,
    round: roundOrbits(options),
    reference_day: Math.max(0, Math.floor((Date.parse(options.referenceDate) || Math.max(0, ...records.map(r => Date.parse(r.pushed_at || r.updated_at) || 0))) / 86400000)),
    rotations: options.ringRotations || Array(4).fill(options.ringRotation || 0),
    repositories: profileRepositories.map(evidence => {
      const repo = (context.profileRepositories || records).find(r => r.full_name === evidence.name);
      const updated = Date.parse(repo?.pushed_at || repo?.updated_at);
      const year = new Date(repo?.created_at).getUTCFullYear();
      return {...evidence, updated_day: Number.isFinite(updated) && updated >= 0 ? Math.floor(updated / 86400000) : null, created_year: year >= 1970 && year <= 9999 ? year : null};
    }),
  }) : null;
  if (semanticActive(options)) {
    const byName = new Map(semantic.placements.map(p => [p.repository, p.position]));
    for (const repo of input.repos) repo.position = options.starPositions?.[repo.name] ? [options.starPositions[repo.name].x, options.starPositions[repo.name].y] : byName.get(repo.name) || repo.position;
    input.snapToRings = false;
  }
  const result = computeScene(input);
  signal?.throwIfAborted();
  return {
    positions: Object.fromEntries(
      scene.nodes.map((node, i) => [
        node.id,
        { x: result.positions[i][0], y: result.positions[i][1] },
      ]),
    ),
    edges: structuredClone(result.edges),
    total: result.total,
    profile: result.profile || semantic?.profile || null,
    semantic,
  };
}
