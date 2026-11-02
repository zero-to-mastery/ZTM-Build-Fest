import { githubRepository } from "../badges/providers/github.js";
const ecosystems = { Node: "node", Rust: "rust", Python: "python", Go: "go" };
const kinds = new Set(["runtime", "development", "peer", "build", "optional"]);
export function normalizeDependencyName(name, ecosystem) {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 200 ||
    /[\s<>"'\x00-\x1f]/.test(name)
  )
    throw Error("Invalid dependency name.");
  if (ecosystem === "python") return name.toLowerCase().replace(/[-_.]+/g, "-");
  if (ecosystem === "node") return name.toLowerCase();
  if (ecosystem === "rust" || ecosystem === "go") return name;
  throw Error("Unsupported dependency ecosystem.");
}
// Confidence basis: the named reason a Declaration is believed. One fixed
// explanation per basis; never a number, ranking or statement about a person.
export const CONFIDENCE_BASES = Object.freeze({
  explicit: "Stated directly in a supported dependency field of this manifest.",
  inherited:
    "Declared with workspace = true and resolved from [workspace.dependencies] in the same file.",
  conditional:
    "Optional, peer, build or target-specific, so it may not be active in every build or install.",
  ambiguous:
    "The file cannot tell a direct entry from a generated or aliased one (requirements files may be freeze output; npm aliases name another package).",
});
// Assigns the basis from the parser's own facts: the registry file name, the
// entry's kind (`role`) and its section string. Precedence, most uncertain
// first: ambiguous, conditional, inherited, explicit. Unknown files are
// ambiguous rather than explicit.
export function confidenceBasis(entry, manifestFile) {
  const section = String(entry?.evidence ?? entry?.section ?? "");
  const role = entry?.role ?? entry?.kind;
  if (manifestFile === "requirements.txt") return "ambiguous";
  if (manifestFile === "package.json" && section.includes("(alias:"))
    return "ambiguous";
  if (
    !["package.json", "Cargo.toml", "pyproject.toml", "go.mod"].includes(
      manifestFile,
    )
  )
    return "ambiguous";
  if (["optional", "peer", "build"].includes(role)) return "conditional";
  if (manifestFile === "Cargo.toml") {
    if (section.startsWith("target.")) return "conditional";
    if (section.includes("(inherited from workspace.dependencies)"))
      return "inherited";
  }
  return "explicit";
}
// The one fixed explanation of a basis, looked up when it is shown so cached
// records do not repeat it on every evidence item.
export const basisExplanation = (basis) =>
  Object.hasOwn(CONFIDENCE_BASES, basis) ? CONFIDENCE_BASES[basis] : "";
// Provenance of one Declaration: where and when it was observed. `context`
// carries the record's repository association, branch and Observed at. The
// basis is stored by name only; see basisExplanation().
export function provenance(context, manifest, { section, line, basis }) {
  return {
    repository: context.repository,
    branch: context.branch,
    project: typeof manifest.project === "string" ? manifest.project : "",
    manifest: manifest.path,
    blobSha: typeof manifest.sha === "string" ? manifest.sha : "",
    section: String(section),
    line: Number.isSafeInteger(line) && line > 0 ? line : null,
    observedAt: context.observedAt,
    basis,
  };
}
// A dependency is direct because it is explicitly declared, not because we
// resolved a lockfile or executed a package manager. Keep evidence per kind
// and per Project boundary (`manifest.project`, "" for the root); each
// evidence item is a Provenance with its Confidence basis and names the full
// repository path of the Manifest.
export function normalizeDependencies(
  repository,
  manifests,
  { branch = "", observedAt = null } = {},
) {
  const association = githubRepository(repository).toLowerCase();
  const context = { repository: association, branch, observedAt };
  const dependencies = new Map();
  for (const manifest of manifests) {
    const ecosystem = ecosystems[manifest.ecosystem];
    if (!ecosystem) throw Error("Unsupported dependency ecosystem.");
    const project =
      typeof manifest.project === "string" ? manifest.project : "";
    // `file` is the registry name; manifests analyzed directly only carry it
    // as `path`.
    const file = manifest.file || manifest.path;
    for (const entry of manifest.entries) {
      if (!kinds.has(entry.role)) continue;
      const name = normalizeDependencyName(entry.name, ecosystem);
      const key = JSON.stringify([
        association,
        project,
        ecosystem,
        name,
        entry.role,
      ]);
      let dependency = dependencies.get(key);
      if (!dependency) {
        dependency = {
          name,
          ecosystem,
          kind: entry.role,
          repository: association,
          project,
          direct: true,
          evidence: [],
        };
        dependencies.set(key, dependency);
      }
      const evidence = provenance(context, manifest, {
        section: entry.evidence,
        line: entry.line,
        basis: confidenceBasis(entry, file),
      });
      if (
        !dependency.evidence.some(
          (item) => JSON.stringify(item) === JSON.stringify(evidence),
        )
      )
        dependency.evidence.push(evidence);
    }
  }
  return [...dependencies.values()].sort((a, b) => {
    const left = JSON.stringify([a.ecosystem, a.name, a.kind]),
      right = JSON.stringify([b.ecosystem, b.name, b.kind]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
export const UNCERTAIN_BASES = Object.freeze(["conditional", "ambiguous"]);
const DAY = 24 * 60 * 60 * 1000;
// Why a stack result may no longer match its repository, computed when it is
// shown from data Studio already holds: never a timer, refetch or extra
// request. "pushed-since": the currently loaded repository list reports a
// newer push than the pushed_at the scan started from (`record.pushedAt`).
// Both times come from GitHub, so a wrong local clock cannot fake or hide a
// push; only a record without a scan-time pushed_at falls back to comparing
// with Observed at. "age": observed more than 24 hours before `now`.
export function staleness(record, currentRepo, now = Date.now()) {
  const observed = record?.observedAt ?? record?.checkedAt;
  if (!Number.isFinite(observed)) return [];
  const reasons = [];
  const pushed = Date.parse(currentRepo?.pushed_at ?? "");
  const scanned = Date.parse(record?.pushedAt ?? "");
  if (
    Number.isFinite(pushed) &&
    pushed > (Number.isFinite(scanned) ? scanned : observed)
  )
    reasons.push("pushed-since");
  if (Number.isFinite(now) && now - observed > DAY) reasons.push("age");
  return reasons;
}
// Uncertain stack results of one record: conditional or ambiguous
// Declarations, and Manifests that were found but not read (their contents
// are unknown, never absent). `unlisted` counts unread Manifests beyond the
// bounded skipped list, so the total matches the discovery summary. Failed
// records contribute nothing.
export function uncertainResults(record) {
  if (!record || record.status === "failed")
    return { declarations: [], unread: [], unlisted: 0 };
  const declarations = [];
  for (const dependency of record.dependencies || [])
    for (const evidence of dependency.evidence || [])
      if (UNCERTAIN_BASES.includes(evidence.basis))
        declarations.push({
          name: dependency.name,
          ecosystem: dependency.ecosystem,
          kind: dependency.kind,
          project: dependency.project || "",
          evidence,
        });
  const unread = (record.discovery?.skipped || []).map((entry) => ({
    path: String(entry.path),
    reason: String(entry.reason),
  }));
  const discovery = record.discovery;
  const notRead =
    Number.isSafeInteger(discovery?.found) &&
    Number.isSafeInteger(discovery?.read)
      ? discovery.found - discovery.read
      : 0;
  return {
    declarations,
    unread,
    unlisted: Math.max(0, notRead - unread.length),
  };
}
