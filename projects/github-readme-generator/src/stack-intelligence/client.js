import { normalizeDependencies, provenance } from "./dependencies.js";
import { auditClient, AuditError } from "../repository-audit/github.js";
import { githubRepository } from "../badges/providers/github.js";
import { manifests, analyzeManifest, MANIFEST_LIMIT } from "./manifests.js";
import {
  DISCOVERY_LIMITS,
  discoverManifests,
  displayPath,
  encodePath,
  workspaceFiles,
  workspacePatterns,
} from "./discovery.js";
import { readTree } from "../github/evidence.js";
export const NESTED_LIMIT_MESSAGE = (count) =>
  `Nested manifests can be included for at most ${DISCOVERY_LIMITS.repositories} repositories per run; ${count} are selected. Select fewer repositories or turn off Include nested manifests. Nothing was read.`;
const DECLARATION_NOTICE =
  "Only the first 200 dependency declarations per repository are retained.";
// Root-only manifest notes that are no longer true with Nested discovery:
// members are mapped from the tree; local path dependencies still are not.
const nestedNotes = {
  "Workspace members are not followed; only root declarations were read.": [],
  "Workspace members and local path dependencies are not followed.": [
    "Local path dependencies are not followed.",
  ],
};
// The repository list's pushed_at, kept only when it is a parseable time.
const pushedAt = (repo) =>
  typeof repo.pushed_at === "string" &&
  Number.isFinite(Date.parse(repo.pushed_at))
    ? repo.pushed_at
    : "";
export class StackClient {
  constructor({ client = auditClient, now = () => Date.now() } = {}) {
    this.client = client;
    this.now = now;
    this.cache = new Map();
    this.bytes = 0;
  }
  clear() {
    this.cache.clear();
    this.bytes = 0;
  }
  async repository(repo, { signal, force = false, nested = false } = {}) {
    signal?.throwIfAborted();
    nested = nested === true;
    const name = githubRepository(repo.full_name).toLowerCase();
    const branch = repo.default_branch || "HEAD";
    const key = JSON.stringify([name, branch, nested]);
    const cached = this.cache.get(key);
    if (!force && cached && this.now() - cached.at < 300000)
      return {
        ...cached.value,
        repository: repo.full_name,
        language: repo.language || "",
      };
    if (cached) {
      this.bytes -= cached.size;
      this.cache.delete(key);
    }
    // Nested discovery reads every file at the head commit its tree came from.
    let ref = "?ref=" + encodeURIComponent(branch);
    const base = "/repos/" + name + "/contents/";
    // Every request of this repository goes through `client`, so the
    // per-repository request budget is counted, not assumed.
    let requests = 0;
    const client = {
      request: (path, s) => {
        requests++;
        return this.client.request(path, s);
      },
    };
    // Observed at is when Studio read the files, kept on cache hits; the
    // `checkedAt` alias remains for one release. `pushedAt` is the repository
    // list's pushed_at value this scan started from.
    const observedAt = this.now();
    const result = {
      version: 5,
      language: repo.language || "",
      repository: repo.full_name,
      ref: branch,
      observedAt,
      checkedAt: observedAt,
      pushedAt: pushedAt(repo),
      manifests: [],
      projects: [],
      issues: [],
      status: "read",
    };
    const discovery = {
      nested,
      tree: "not-read",
      found: 0,
      read: 0,
      skipped: [],
    };
    // Reads one regular file through the contents API with the existing
    // checks. `path` is a validated repository path; each segment is encoded.
    const readFile = async (path) => {
      const { data } = await client.request(
        base + encodePath(path) + ref,
        signal,
      );
      if (
        data?.type !== "file" ||
        data.path !== path ||
        data.target ||
        data.submodule_git_url ||
        data.encoding !== "base64" ||
        !Number.isSafeInteger(data.size) ||
        data.size < 0 ||
        data.size > MANIFEST_LIMIT ||
        typeof data.content !== "string" ||
        data.content.length > MANIFEST_LIMIT * 2
      )
        throw Error("Not a bounded regular manifest file.");
      const bytes = Uint8Array.from(
        atob(data.content.replace(/\s/g, "")),
        (c) => c.charCodeAt(0),
      );
      if (bytes.length !== data.size || bytes.length > MANIFEST_LIMIT)
        throw Error("Incomplete manifest content.");
      return {
        source: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes),
        sha: typeof data.sha === "string" ? data.sha : "",
      };
    };
    const failed = (path, error) => {
      if (signal?.aborted) throw signal.reason;
      const message = String(error.message).slice(0, 1000);
      result.issues.push(displayPath(path) + ": " + message);
      return message;
    };
    const stop = (error) => {
      if (["rate-limit", "forbidden"].includes(error.kind))
        result.stopped = error.message;
    };
    const rootSources = {};
    const analyze = async ({ path, file, project }) => {
      signal?.throwIfAborted();
      try {
        const { source, sha } = await readFile(path);
        if (!project) rootSources[file] = source;
        const analysis = analyzeManifest(file, source);
        const remaining = Math.max(
          0,
          200 - result.manifests.reduce((n, m) => n + m.entries.length, 0),
        );
        if (analysis.entries.length > remaining) {
          analysis.entries = analysis.entries.slice(0, remaining);
          if (!result.issues.includes(DECLARATION_NOTICE))
            result.issues.push(DECLARATION_NOTICE);
        }
        result.manifests.push({ ...analysis, path, file, project, sha });
      } catch (error) {
        const message = failed(path, error);
        discovery.skipped.push({
          path: displayPath(path),
          reason: message.slice(0, 300),
        });
        stop(error);
      }
    };
    const notRegular = (path) => {
      result.issues.push(
        path + ": not a regular file within the 256 KB limit.",
      );
      discovery.skipped.push({
        path,
        reason: "not a regular file within the 256 KB limit",
      });
    };
    // Nested discovery reads one tree listing at the branch head. Root
    // Manifests and workspace declaration files come from that listing only
    // when it is complete; a truncated or failed tree may omit root files, so
    // the root contents listing (one request) is read for them instead.
    let tree = null;
    if (nested) {
      tree = await readTree({
        client,
        target: { repository: repo.full_name, branch },
        signal,
      });
      result.headSha = tree.head;
      ref = "?ref=" + encodeURIComponent(tree.head);
      discovery.tree = tree.tree;
      if (tree.tree === "truncated")
        result.issues.push(
          "GitHub truncated the repository tree; root manifests were found from the root listing, and nested manifests not listed are unknown.",
        );
      if (tree.tree === "failed") {
        result.issues.push(
          ...tree.notes,
          "Nested manifests could not be listed; only root manifests were read.",
        );
        tree = null;
      }
    }
    // Returns "regular", "other" (listed but not a regular file within the
    // limit) or "" (not listed) for a root file name.
    let rootEntry;
    if (tree?.tree === "complete")
      rootEntry = (path) => {
        const listed = tree.listing.get(path);
        if (!listed) return "";
        return listed.type !== "blob" ||
          listed.mode === "120000" ||
          !Number.isSafeInteger(listed.size) ||
          listed.size > MANIFEST_LIMIT
          ? "other"
          : "regular";
      };
    else {
      const { data: listing } = await client.request(base + ref, signal);
      if (!Array.isArray(listing) || listing.length > 1000)
        throw new AuditError("response", "Unreadable root manifest listing.");
      if (listing.length === 1000)
        result.issues.push(
          "Root listing may be truncated; absence of other manifests is uncertain.",
        );
      rootEntry = (path) => {
        const listed = listing.find((entry) => entry?.path === path);
        if (!listed) return "";
        return listed.type !== "file" ||
          listed.submodule_git_url ||
          listed.size > MANIFEST_LIMIT
          ? "other"
          : "regular";
      };
    }
    const roots = [];
    for (const descriptor of manifests) {
      const kind = rootEntry(descriptor.path);
      if (kind === "other") notRegular(descriptor.path);
      else if (kind) roots.push(descriptor.path);
    }
    discovery.found = roots.length + discovery.skipped.length;
    for (const path of roots) {
      if (result.stopped) {
        discovery.skipped.push({ path, reason: "not read; the scan stopped" });
        continue;
      }
      await analyze({ path, file: path, project: "" });
    }
    const boundaries = [];
    // True once members were mapped from the tree listing.
    let mapped = false;
    if (tree && !result.stopped) {
      // Workspace declaration files are read only here and never analyzed
      // as Manifests; they count toward the per-repository request budget.
      for (const file of workspaceFiles) {
        const kind = rootEntry(file);
        if (!kind || result.stopped) continue;
        if (kind === "other") {
          result.issues.push(
            file + ": not a regular file within the 256 KB limit.",
          );
          continue;
        }
        try {
          rootSources[file] = (await readFile(file)).source;
        } catch (error) {
          failed(file, error);
          stop(error);
        }
      }
      // Nested reads use what is left of the request budget: 15 at most,
      // 14 only when a truncated tree also needed the root listing and every
      // root Manifest and declaration file exists.
      const cap = Math.max(
        0,
        Math.min(DISCOVERY_LIMITS.nested, DISCOVERY_LIMITS.requests - requests),
      );
      const declared = workspacePatterns(rootSources);
      const found = discoverManifests(tree.listing, declared.patterns, {
        complete: tree.tree === "complete",
        nested: cap,
      });
      mapped = true;
      if (cap < DISCOVERY_LIMITS.nested && found.notRead)
        result.issues.push(
          `At most ${cap} nested manifests could be read within the budget of ${DISCOVERY_LIMITS.requests} requests per repository.`,
        );
      result.issues.push(...declared.notices, ...found.notices);
      discovery.found += found.found;
      discovery.skipped.push(...found.skipped);
      boundaries.push(...found.boundaries);
      for (const item of found.toRead) {
        if (result.stopped) {
          discovery.skipped.push({
            path: item.path,
            reason: "not read; the scan stopped",
          });
          continue;
        }
        await analyze(item);
      }
    }
    // Root-only notes about unfollowed members are replaced only when the
    // tree listing actually mapped members; a fallback keeps them.
    if (mapped)
      for (const manifest of result.manifests)
        manifest.notes = manifest.notes.flatMap((note) =>
          Object.hasOwn(nestedNotes, note) ? nestedNotes[note] : [note],
        );
    discovery.read = result.manifests.length;
    result.discovery = discovery;
    const rootManifests = result.manifests
      .filter((m) => !m.project)
      .map((m) => m.path);
    result.projects = [
      ...(rootManifests.length
        ? [{ path: "", role: "root", declaredBy: [], manifests: rootManifests }]
        : []),
      ...boundaries,
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const context = {
      repository: name,
      branch,
      observedAt,
    };
    result.dependencies = normalizeDependencies(
      repo.full_name,
      result.manifests,
      context,
    );
    // Engine signals carry the same Provenance as dependency Declarations.
    for (const manifest of result.manifests)
      manifest.signals = (manifest.signals || []).map((signal) => ({
        ...signal,
        ...provenance(context, manifest, {
          section: signal.evidence,
          line: null,
          basis: "explicit",
        }),
      }));
    result.status = result.issues.length
      ? "partial"
      : result.manifests.length
        ? "read"
        : "none";
    if (!result.issues.length) {
      const size = JSON.stringify(result).length * 2;
      this.cache.set(key, { at: this.now(), value: result, size });
      this.bytes += size;
      while (this.cache.size > 128 || this.bytes > 2_000_000) {
        const first = this.cache.keys().next().value;
        this.bytes -= this.cache.get(first).size;
        this.cache.delete(first);
      }
    }
    return result;
  }
}
export async function scanStacks(
  repositories,
  { client, signal, onResult = () => {}, force = false, nested = false } = {},
) {
  const repos = [
    ...new Map(
      repositories.map((repo) => [repo.full_name.toLowerCase(), repo]),
    ).values(),
  ].slice(0, 1000);
  // Nested discovery is refused, never truncated, above its Discovery limit.
  if (nested && repos.length > DISCOVERY_LIMITS.repositories)
    throw new AuditError("limit", NESTED_LIMIT_MESSAGE(repos.length));
  let cursor = 0,
    completed = 0,
    stopped = "";
  await Promise.all(
    Array.from({ length: Math.min(3, repos.length) }, async () => {
      while (cursor < repos.length && !stopped && !signal?.aborted) {
        const repo = repos[cursor++];
        let result;
        try {
          result = await client.repository(repo, { signal, force, nested });
        } catch (error) {
          if (signal?.aborted) return;
          const observedAt = Date.now();
          result = {
            version: 5,
            repository: repo.full_name,
            ref: repo.default_branch || "HEAD",
            status: "failed",
            manifests: [],
            issues: [error.message],
            observedAt,
            checkedAt: observedAt,
            pushedAt: pushedAt(repo),
          };
          if (["rate-limit", "forbidden"].includes(error.kind))
            result.stopped = error.message;
        }
        if (signal?.aborted) return;
        completed++;
        if (result.stopped) stopped = result.stopped;
        onResult(result);
      }
    }),
  );
  return {
    completed,
    total: repos.length,
    remaining: repos.length - completed,
    stopped,
    cancelled: !!signal?.aborted,
  };
}
export const stackClient = new StackClient();
