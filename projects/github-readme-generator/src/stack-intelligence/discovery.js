import { tomlRecords, tomlValue } from "./toml.js";
import { manifests, MANIFEST_LIMIT } from "./manifests.js";

// Pure Nested discovery (ADR epic65-01). Everything here is data in, data
// out: one recursive tree listing and the text of root files. Workspace
// declarations decide whether a Project boundary is a Workspace member or a
// Nested project; they never add paths that are not in the listing.
export const DISCOVERY_LIMITS = Object.freeze({
  depth: 4,
  nested: 15,
  // Requests per repository: head, tree, root listing or Manifests,
  // workspace declaration files and nested Manifests together.
  requests: 24,
  repositories: 25,
  path: 300,
  patterns: 100,
  skipped: 50,
  excluded: Object.freeze([
    "node_modules",
    "vendor",
    "dist",
    "build",
    "out",
    "target",
    "testdata",
    "fixtures",
    "__fixtures__",
    "third_party",
  ]),
});
// Root-only workspace declaration files. Read only during Nested discovery,
// counted in the request budget and never treated as a Manifest.
export const workspaceFiles = Object.freeze(["pnpm-workspace.yaml", "go.work"]);
export const PATTERN_NOTICE = "Workspace pattern not interpreted: ";
const manifestFiles = new Set(manifests.map((m) => m.path));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Control characters are replaced so notices never carry them; the result is
// still escaped wherever it is displayed.
export const displayPath = (path) =>
  String(path)
    .replace(/[\x00-\x1f\x7f]/g, "\ufffd")
    .slice(0, DISCOVERY_LIMITS.path);

// A repository path Studio may request: relative, "/"-separated, no empty,
// "." or ".." segments (also when percent-encoded), no backslash or control
// characters, at most 300 characters.
export function safePath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > DISCOVERY_LIMITS.path ||
    path.startsWith("/") ||
    /[\\\x00-\x1f\x7f]/.test(path)
  )
    return false;
  return path
    .split("/")
    .every((segment) => segment && !/^(?:\.|%2e){1,2}$/i.test(segment));
}
// Each segment is encoded on its own so "/" stays a separator and nothing in
// a name can change the request path.
export const encodePath = (path) =>
  path.split("/").map(encodeURIComponent).join("/");

const excludedSegment = (segment) =>
  segment.startsWith(".") || DISCOVERY_LIMITS.excluded.includes(segment);

// Returns pattern segments, or null when the pattern uses syntax we do not
// interpret (`?`, `[]`, `{}`, `..`, absolute paths, backslashes, `**` mixed
// into a segment). Consecutive `**` segments collapse into one.
function patternSegments(raw) {
  if (typeof raw !== "string" || !raw || raw.length > DISCOVERY_LIMITS.path)
    return null;
  if (/[?[\]{}\\\x00-\x1f\x7f]/.test(raw) || raw.startsWith("/")) return null;
  const segments = raw
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "")
    .split("/");
  if (segments.length === 1 && segments[0] === ".") return [];
  if (
    segments.some(
      (s) => !s || s === "." || s === ".." || (s.includes("**") && s !== "**"),
    )
  )
    return null;
  return segments.filter((s, i) => s !== "**" || segments[i - 1] !== "**");
}
// `*` inside a segment matches any run of characters; everything else is
// literal. A greedy two-pointer match with one backtrack point takes at most
// O(pattern × segment) steps. No RegExp is built from untrusted text, so
// patterns such as `*a*a*a*b` cannot backtrack exponentially.
function segmentMatches(pattern, segment) {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === segment;
  let p = 0,
    s = 0,
    star = -1,
    mark = 0;
  while (s < segment.length) {
    if (pattern[p] === "*") {
      star = p++;
      mark = s;
    } else if (p < pattern.length && pattern[p] === segment[s]) {
      p++;
      s++;
    } else if (star >= 0) {
      p = star + 1;
      s = ++mark;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

// `*` matches exactly one directory segment (or any characters inside one
// segment when mixed with text), `**` matches any number of segments. Paths
// are directory paths relative to the root, bounded by the depth limit. A
// pattern that needs more single segments than the path has fails at once,
// and `walk` is memoized on (pattern segment, path part), so one call costs
// at most O(segments × parts²) steps whatever the pattern.
export function matchPattern(pattern, directory) {
  const segments = Array.isArray(pattern) ? pattern : patternSegments(pattern);
  if (!segments || typeof directory !== "string") return false;
  const parts = directory ? directory.split("/") : [];
  if (parts.length > DISCOVERY_LIMITS.depth + 1) return false;
  let required = 0;
  for (const segment of segments) if (segment !== "**") required++;
  if (required > parts.length) return false;
  const width = parts.length + 1;
  const memo = new Uint8Array((segments.length + 1) * width); // 0 unknown, 1 no, 2 yes
  const walk = (p, d) => {
    if (p === segments.length) return d === parts.length;
    const key = p * width + d;
    if (memo[key]) return memo[key] === 2;
    let matched = false;
    if (segments[p] === "**")
      for (let i = d; i <= parts.length && !matched; i++)
        matched = walk(p + 1, i);
    else
      matched =
        d < parts.length &&
        segmentMatches(segments[p], parts[d]) &&
        walk(p + 1, d + 1);
    memo[key] = matched ? 2 : 1;
    return matched;
  };
  return walk(0, 0);
}

// Minimal line reader for `packages:` in pnpm-workspace.yaml: a block list
// of plain or quoted strings. Any other form is reported, never guessed.
function pnpmPackages(source, notices) {
  const values = [];
  let inside = false,
    found = false;
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    // Entries are paths of at most 300 characters; longer lines are not
    // interpreted (and would make the item expression below quadratic).
    if (inside && raw.length > 1000) {
      notices.push(
        "pnpm-workspace.yaml packages use YAML syntax that is not interpreted; only a list of plain or quoted strings is read.",
      );
      return [];
    }
    // YAML allows sequence items at the key's own indentation.
    const topItem = inside && /^-(?:\s|$)/.test(raw);
    if (!/^\s/.test(raw) && !topItem) {
      inside = false;
      const key = raw.match(/^packages\s*:\s*(#.*)?$/);
      if (key) {
        inside = found = true;
        continue;
      }
      if (/^packages\s*:/.test(raw)) {
        notices.push(
          "pnpm-workspace.yaml packages use YAML syntax that is not interpreted; only a list of plain or quoted strings is read.",
        );
        return [];
      }
      continue;
    }
    if (!inside) continue;
    const item = raw.match(
      /^\s*-\s+(?:"([^"\\]*)"|'([^']*)'|([^\s"'#&*!|>{}[\],][^#]*?))\s*(?:#.*)?$/,
    );
    if (!item) {
      notices.push(
        "pnpm-workspace.yaml packages use YAML syntax that is not interpreted; only a list of plain or quoted strings is read.",
      );
      return [];
    }
    values.push(item[1] ?? item[2] ?? item[3]);
  }
  if (!found)
    notices.push("pnpm-workspace.yaml has no packages list; nothing mapped.");
  return values;
}
// `use ./dir` and `use ( ... )` blocks in go.work; other directives ignored.
function goWorkUses(source, notices) {
  const values = [];
  let block = false;
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (block) {
      if (line === ")") block = false;
      else values.push(line);
      continue;
    }
    if (/^use\s*\($/.test(line)) block = true;
    else if (/^use\s+\S/.test(line)) values.push(line.replace(/^use\s+/, ""));
  }
  if (block) notices.push("go.work has an unterminated use block.");
  return values.map((value) => value.replace(/^"(.*)"$|^`(.*)`$/, "$1$2"));
}
function tomlArrays(source, keys) {
  const result = Object.fromEntries(keys.map((key) => [key, []]));
  for (const record of tomlRecords(source)) {
    const key = record.path.join(".");
    if (!Object.hasOwn(result, key)) continue;
    const value = tomlValue(record.raw);
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
      throw Error(key + " must be an array of strings.");
    result[key] = value;
  }
  return result;
}

// Reads Workspace declarations from root files only. `rootFiles` maps a root
// file name to its text. Returns interpretable patterns with the declaration
// that named them, plus notices for anything that could not be read.
export function workspacePatterns(rootFiles = {}) {
  const patterns = [],
    notices = [];
  const add = (values, declaredBy, negated = false) => {
    for (const value of values) {
      if (patterns.length >= DISCOVERY_LIMITS.patterns) {
        notices.push(
          `Only the first ${DISCOVERY_LIMITS.patterns} workspace patterns are interpreted.`,
        );
        return;
      }
      let raw = typeof value === "string" ? value.trim() : "";
      let negative = negated;
      if (raw.startsWith("!")) {
        negative = true;
        raw = negated ? "" : raw.slice(1);
      }
      const segments = patternSegments(raw);
      if (!segments) {
        notices.push(PATTERN_NOTICE + displayPath(value));
        continue;
      }
      // The root itself is always the root boundary.
      if (!segments.length) continue;
      patterns.push({
        pattern: segments.join("/"),
        negated: negative,
        declaredBy,
      });
    }
  };
  const read = (file, fn) => {
    if (typeof rootFiles[file] !== "string") return;
    try {
      fn(rootFiles[file].replace(/^\ufeff/, ""));
    } catch (error) {
      notices.push(
        `${file}: workspace declaration could not be read (${String(error.message).slice(0, 200)}).`,
      );
    }
  };
  read("package.json", (source) => {
    const data = JSON.parse(source);
    const workspaces = Array.isArray(data?.workspaces)
      ? data.workspaces
      : data?.workspaces && Array.isArray(data.workspaces.packages)
        ? data.workspaces.packages
        : data?.workspaces === undefined
          ? []
          : null;
    if (!workspaces) throw Error("workspaces must be an array or {packages}");
    add(workspaces, "package.json workspaces");
  });
  read("pnpm-workspace.yaml", (source) =>
    add(pnpmPackages(source, notices), "pnpm-workspace.yaml packages"),
  );
  read("Cargo.toml", (source) => {
    const values = tomlArrays(source, [
      "workspace.members",
      "workspace.exclude",
    ]);
    add(values["workspace.members"], "Cargo.toml workspace.members");
    add(values["workspace.exclude"], "Cargo.toml workspace.exclude", true);
  });
  read("go.work", (source) => add(goWorkUses(source, notices), "go.work use"));
  read("pyproject.toml", (source) => {
    const values = tomlArrays(source, [
      "tool.uv.workspace.members",
      "tool.uv.workspace.exclude",
    ]);
    add(
      values["tool.uv.workspace.members"],
      "pyproject.toml tool.uv.workspace.members",
    );
    add(
      values["tool.uv.workspace.exclude"],
      "pyproject.toml tool.uv.workspace.exclude",
      true,
    );
  });
  return { patterns, notices: [...new Set(notices)] };
}

const regularFile = (item) =>
  item?.type === "blob" && item.mode !== "120000" && item.mode !== "160000";
// The tree entry's size is checked before any request, as for root Manifests.
const withinLimit = (item) =>
  Number.isSafeInteger(item.size) &&
  item.size >= 0 &&
  item.size <= MANIFEST_LIMIT;
const linked = (item) =>
  item?.mode === "120000"
    ? "symlink"
    : item?.type === "commit" || item?.mode === "160000"
      ? "submodule"
      : "";

// Finds nested Manifests in one tree listing (a Map or array of GitHub tree
// entries). Root Manifests are not part of the result; the client reads them
// first. Returns Project boundaries (root excluded), the Manifests to read in
// deterministic order, everything found but not read with its reason, and
// notices. CPU is linear in the listing size: only entries whose last
// segment is a registry Manifest name, or that are symlinks/submodules, get
// further checks, and each pattern check is bounded (see matchPattern).
export function discoverManifests(listing, patterns = [], limits = {}) {
  const limit = { ...DISCOVERY_LIMITS, ...limits };
  const entries = listing instanceof Map ? listing.values() : listing || [];
  const positive = [],
    negative = [];
  for (const item of patterns) {
    const segments = patternSegments(item.pattern);
    if (segments?.length)
      (item.negated ? negative : positive).push({ ...item, segments });
  }
  const notices = [],
    candidates = [],
    links = new Map(),
    directories = new Set();
  // Literal directory prefixes of declared members, so a symlink or
  // submodule standing in for a member is found without matching every entry.
  const prefixes = new Set();
  for (const pattern of positive)
    for (let i = 1; i <= pattern.segments.length; i++) {
      if (pattern.segments[i - 1].includes("*")) break;
      prefixes.add(pattern.segments.slice(0, i).join("/"));
    }
  let linkChecks = 0;
  // Not-read Manifests in reporting priority: safety problems, then the
  // read cap, then excluded or too-deep directories. Each list is bounded;
  // counts stay exact.
  const buckets = { unsafe: [], limit: [], excluded: [] };
  let notRead = 0,
    deep = 0;
  const skip = (bucket, path, reason) => {
    notRead++;
    if (buckets[bucket].length < limit.skipped)
      buckets[bucket].push({ path: displayPath(path), reason });
  };
  for (const item of entries) {
    const path = item?.path;
    if (typeof path !== "string") continue;
    if (item.type === "tree") {
      if (directories.size < 100_000) directories.add(path);
      continue;
    }
    const kind = linked(item);
    if (kind) {
      if (prefixes.has(path)) links.set(path, kind);
      else if (
        linkChecks++ < 1000 &&
        positive.some((p) => matchPattern(p.segments, path)) &&
        notices.length < 20
      )
        notices.push(
          `Workspace member ${displayPath(path)} is a ${kind}; it was not read.`,
        );
    }
    const slash = path.lastIndexOf("/");
    const name = path.slice(slash + 1);
    if (!manifestFiles.has(name)) continue;
    if (slash < 0) continue; // root Manifests are read by the client
    if (!safePath(path)) {
      if (notices.length < 20)
        notices.push(`Unsafe manifest path rejected: ${displayPath(path)}`);
      skip("unsafe", path, "unsafe path; not read");
      continue;
    }
    const directory = path.slice(0, slash);
    const segments = directory.split("/");
    if (segments.some(excludedSegment)) {
      skip("excluded", path, "excluded directory (limit); not read");
      continue;
    }
    if (segments.length > limit.depth) {
      deep++;
      skip(
        "excluded",
        path,
        `deeper than ${limit.depth} directories (limit); not read`,
      );
      continue;
    }
    if (kind) {
      if (notices.length < 20)
        notices.push(`${displayPath(path)} is a ${kind}; it was not read.`);
      skip("unsafe", path, `${kind}; not read`);
      continue;
    }
    if (!regularFile(item)) continue;
    if (!withinLimit(item)) {
      if (notices.length < 20)
        notices.push(
          `${displayPath(path)}: not a regular file within the 256 KB limit.`,
        );
      skip("unsafe", path, "not a regular file within the 256 KB limit");
      continue;
    }
    const declared = positive.filter((p) =>
      matchPattern(p.segments, directory),
    );
    const member =
      declared.length > 0 &&
      !negative.some((p) => matchPattern(p.segments, directory));
    candidates.push({
      path,
      directory,
      depth: segments.length,
      role: member ? "member" : "nested",
      declaredBy: member ? [...new Set(declared.map((p) => p.declaredBy))] : [],
    });
  }
  // Declared literal members must be real directories in the listing.
  for (const pattern of positive) {
    const literal = [];
    for (const segment of pattern.segments) {
      if (segment.includes("*")) break;
      literal.push(segment);
    }
    for (let i = 1; i <= literal.length; i++) {
      const prefix = literal.slice(0, i).join("/");
      const kind = links.get(prefix);
      if (kind) {
        notices.push(
          `Workspace member ${displayPath(pattern.pattern)} is a ${kind}; it was not read.`,
        );
        break;
      }
    }
    if (
      literal.length === pattern.segments.length &&
      !directories.has(literal.join("/")) &&
      !links.has(literal.join("/"))
    )
      notices.push(
        limit.complete === false
          ? `Workspace member ${displayPath(pattern.pattern)} is not in the listed part of the repository tree; it is unknown.`
          : `Workspace member ${displayPath(pattern.pattern)} is not in the repository tree; it was not read.`,
      );
  }
  const order = (a, b) =>
    compare(a.role === "member" ? 0 : 1, b.role === "member" ? 0 : 1) ||
    a.depth - b.depth ||
    compare(a.path, b.path);
  candidates.sort(order);
  const toRead = candidates.slice(0, limit.nested);
  for (const candidate of candidates.slice(limit.nested))
    skip(
      "limit",
      candidate.path,
      `found, not read (limit of ${limit.nested} nested manifests)`,
    );
  // Limits that can hide part of a project are notices (the record is then
  // partial); excluded dependency and build directories are listed only.
  if (candidates.length > limit.nested)
    notices.push(
      `${candidates.length - limit.nested} nested manifests were found but not read (Discovery limit: ${limit.nested} per repository).`,
    );
  if (deep)
    notices.push(
      `${deep} manifests deeper than ${limit.depth} directories were found but not read (Discovery limit).`,
    );
  const skipped = [...buckets.unsafe, ...buckets.limit, ...buckets.excluded];
  const unlisted =
    notRead > skipped.length
      ? [
          `${notRead - skipped.length} more manifests found but not read are not listed.`,
        ]
      : [];
  // Boundaries cover every Manifest read plus the listed over-cap ones.
  const boundaries = new Map();
  for (const candidate of candidates.slice(0, limit.nested + limit.skipped)) {
    let boundary = boundaries.get(candidate.directory);
    if (!boundary) {
      boundary = {
        path: candidate.directory,
        role: candidate.role,
        declaredBy: candidate.declaredBy,
        manifests: [],
      };
      boundaries.set(candidate.directory, boundary);
    }
    boundary.manifests.push(candidate.path);
  }
  return {
    boundaries: [...boundaries.values()]
      .map((b) => ({ ...b, manifests: b.manifests.sort(compare) }))
      .sort((a, b) => compare(a.path, b.path)),
    toRead: toRead.map(({ path, directory, role }) => ({
      path,
      file: path.slice(path.lastIndexOf("/") + 1),
      project: directory,
      role,
    })),
    skipped,
    notRead,
    found: toRead.length + notRead,
    notices: [...[...new Set(notices)].slice(0, 99), ...unlisted],
  };
}
