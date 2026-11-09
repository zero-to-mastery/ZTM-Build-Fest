import { describe, it, expect } from "vitest";
import {
  validateSnapshots,
  validateSnapshot,
  recoverSnapshots,
  retainSnapshots,
  createSnapshot,
  addSnapshot,
  pinBaseline,
  unpinBaseline,
  deleteSnapshot,
  forgetDocument,
  mergeSnapshots,
  documentSnapshots,
  differentTarget,
  snapshotSummary,
  compareEvidence,
  DOCUMENT_RETENTION,
  WORKSPACE_RETENTION,
  LINK_LIMIT,
} from "../src/workspace/evidence-snapshots.js";
import {
  readEvidence,
  linkedPaths,
  recognisedFiles,
} from "../src/github/evidence.js";
import { AuditClient } from "../src/repository-audit/github.js";
import {
  createBackup,
  validateWorkspace,
  restoreWorkspace,
  recoverWorkspace,
} from "../src/state/workspace-backup.js";
import {
  newDraft,
  readDrafts,
  saveDrafts,
  STORAGE_KEY,
} from "../src/state/drafts.js";
import { createProject } from "../src/studio-projects/model.js";
import "../src/components/evidence-snapshots.js";

const sha = (c) => c.repeat(40);
const target = {
  repository: "example/widget",
  branch: "main",
  path: "docs/README.md",
};
const source = [
  "# Widget",
  "See [usage](usage.md), [the guide](./guide/), [root notes](/NOTES.md) and [license](../LICENSE).",
  '<img src="img/logo.png" srcset="img/logo@2x.png 2x" alt="">',
  "[anchor](#usage) [site](https://example.com) [mail](mailto:a@example.com) [self](README.md)",
  "```md\n[fenced](fenced.md)\n```",
  "[gone](missing.md)",
].join("\n");
const tree = (overrides = {}) => ({
  sha: sha("2"),
  truncated: false,
  tree: [
    { path: "docs/README.md", type: "blob", sha: sha("3") },
    { path: "package.json", type: "blob", sha: sha("4") },
    { path: "package-lock.json", type: "blob", sha: sha("5") },
    { path: "docs/usage.md", type: "blob", sha: sha("6") },
    { path: "docs/guide", type: "tree", sha: sha("7") },
    { path: "NOTES.md", type: "blob", sha: sha("8") },
    { path: "LICENSE", type: "blob", sha: sha("9") },
    { path: "docs/img/logo.png", type: "blob", sha: sha("a") },
    { path: "docs/img/logo@2x.png", type: "blob", sha: sha("b") },
    { path: "src/index.js", type: "blob", sha: sha("c") },
  ],
  ...overrides,
});
const head = (h = sha("1"), t = sha("2")) => [
  { sha: h, commit: { tree: { sha: t } } },
];
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });
function github(routes) {
  const requests = [];
  const client = new AuditClient({
    fetcher: async (url, init) => {
      requests.push({ url, init });
      for (const [match, reply] of routes)
        if (url.includes(match)) return reply(url);
      return json({}, 404);
    },
  });
  return { client, requests };
}
const healthy = (data = tree(), commits = head()) =>
  github([
    ["/commits?", () => json(commits)],
    ["/git/trees/", () => json(data)],
  ]);
async function capture(client, markdown = source, now = Date.UTC(2026, 9, 1)) {
  const links = linkedPaths(markdown, target.path);
  const evidence = await readEvidence({
    client,
    target,
    linked: links.paths,
    notes: links.notes,
  });
  return createSnapshot({
    documentId: "doc-1",
    target,
    source: markdown,
    evidence,
    now,
  });
}

describe("linked evidence paths", () => {
  it("resolves relative links from the README directory and ignores everything else", () => {
    const { paths, notes } = linkedPaths(source, target.path);
    expect(paths).toEqual([
      "docs/usage.md",
      "docs/guide",
      "NOTES.md",
      "LICENSE",
      "docs/img/logo.png",
      "docs/img/logo@2x.png",
      "docs/missing.md",
    ]);
    expect(notes).toEqual([]);
  });
  it("bounds recorded links and says how many were skipped", () => {
    const many = Array.from(
      { length: LINK_LIMIT + 3 },
      (_, i) => `[f${i}](f${i}.md)`,
    ).join(" ");
    const { paths, notes } = linkedPaths(many, "README.md");
    expect(paths).toHaveLength(LINK_LIMIT);
    expect(notes[0]).toContain("3 more were not");
  });
  it("never maps links above the repository root onto root files", () => {
    const { paths, notes } = linkedPaths(
      "[a](../../outside.md) [b](docs/../../up.md) [r](root.md) ![i](./img.png) [n](docs/../ok.md)",
      "README.md",
    );
    expect(paths).toEqual(["root.md", "img.png", "ok.md"]);
    expect(notes).toEqual([
      "2 relative link(s) point above the repository root and were not recorded.",
    ]);
    expect(linkedPaths("[l](../../LICENSE)", "docs/README.md").notes).toEqual([
      "1 relative link(s) point above the repository root and were not recorded.",
    ]);
  });
  it("notes links that cannot be decoded instead of dropping them silently", () => {
    const { paths, notes } = linkedPaths(
      "[b](docs/100%.md) [c](docs/a%20b.md) [q](?tab=1) [f](usage.md?x=1#top)",
      "README.md",
    );
    expect(paths).toEqual(["docs/a b.md", "usage.md"]);
    expect(notes).toEqual([
      '1 relative link(s) could not be decoded (for example a literal "%") and were not recorded.',
    ]);
  });
});

describe("evidence capture", () => {
  it("records branch head, README revision, manifests, lockfiles and linked files through read-only requests", async () => {
    const { client, requests } = healthy();
    const before = source;
    const snapshot = await capture(client);
    expect(source).toBe(before);
    expect(snapshot).toMatchObject({
      documentId: "doc-1",
      target,
      capturedAt: "2026-10-01T00:00:00.000Z",
      head: sha("1"),
      tree: "complete",
      baseline: false,
    });
    expect(snapshot.sourceHash).toMatch(/^fnv1a32:[a-f\d]{8}$/);
    const byPath = Object.fromEntries(
      snapshot.entries.map((entry) => [entry.path, entry]),
    );
    expect(byPath["docs/README.md"]).toEqual({
      path: "docs/README.md",
      kind: "readme",
      status: "captured",
      type: "file",
      sha: sha("3"),
    });
    expect(byPath["package.json"].kind).toBe("manifest");
    expect(byPath["package-lock.json"].kind).toBe("lockfile");
    expect(byPath["docs/guide"]).toMatchObject({ type: "directory" });
    expect(byPath["docs/missing.md"]).toEqual({
      path: "docs/missing.md",
      kind: "linked",
      status: "missing",
    });
    expect(byPath["src/index.js"]).toBeUndefined();
    expect(byPath["Cargo.toml"]).toBeUndefined();
    expect(snapshotSummary(snapshot).partial).toBe(true);
    expect(requests.map((r) => r.url)).toEqual([
      "https://api.github.com/repos/example/widget/commits?sha=main&per_page=1",
      `https://api.github.com/repos/example/widget/git/trees/${sha("2")}?recursive=1`,
    ]);
    for (const { init } of requests) {
      expect(init.method).toBeUndefined();
      expect(init.body).toBeUndefined();
      expect(init.credentials).toBe("omit");
      expect(init.headers.Authorization).toBeUndefined();
    }
    expect(JSON.stringify(snapshot)).not.toContain("Widget");
  });
  it("saves a partial snapshot with unknown entries when the tree cannot be read", async () => {
    const { client } = github([
      ["/commits?", () => json(head())],
      ["/git/trees/", () => json({}, 503)],
    ]);
    const snapshot = await capture(client);
    expect(snapshot.tree).toBe("failed");
    expect(snapshot.notes[0]).toContain("Repository tree could not be read");
    expect(snapshot.entries.every((entry) => entry.status === "failed")).toBe(
      true,
    );
    expect(snapshot.entries.some((entry) => entry.kind === "manifest")).toBe(
      false,
    );
    const summary = snapshotSummary(snapshot);
    expect(summary).toMatchObject({ partial: true, captured: 0, missing: 0 });
    expect(summary.readme.status).toBe("failed");
  });
  it("treats files absent from a truncated tree as unknown, not missing", async () => {
    const { client } = healthy(tree({ truncated: true }));
    const snapshot = await capture(client);
    expect(snapshot.tree).toBe("truncated");
    const gone = snapshot.entries.find((e) => e.path === "docs/missing.md");
    expect(gone).toMatchObject({ status: "failed" });
    expect(gone.note).toContain("truncated");
  });
  it("saves nothing when the branch head is unavailable, offline or cancelled", async () => {
    const notFound = github([["/commits?", () => json({}, 404)]]).client;
    await expect(capture(notFound)).rejects.toMatchObject({
      kind: "not-found",
    });
    const empty = healthy(tree(), []).client;
    await expect(capture(empty)).rejects.toThrow(/no readable branch head/);
    const offline = new AuditClient({
      fetcher: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(capture(offline)).rejects.toMatchObject({ kind: "network" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      readEvidence({
        client: healthy().client,
        target,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("recognises the Stack Intelligence manifests plus common lockfiles", () => {
    const paths = recognisedFiles.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "package.json",
        "Cargo.toml",
        "go.mod",
        "Cargo.lock",
        "go.sum",
        "pnpm-lock.yaml",
      ]),
    );
  });
});

describe("snapshot schema", () => {
  it("accepts absent data, rejects future versions and malformed records", async () => {
    const snapshot = await capture(healthy().client);
    expect(validateSnapshots(undefined)).toEqual({ version: 1, items: [] });
    expect(() => validateSnapshots({ version: 2, items: [] })).toThrow(
      /Unsupported or damaged/,
    );
    const bad = [
      { head: "main" },
      { capturedAt: "yesterday" },
      { sourceHash: "abc" },
      { target: { ...target, path: "../README.md" } },
      {
        entries: snapshot.entries.map((e) =>
          e.kind === "readme" ? { ...e, sha: undefined } : e,
        ),
      },
      {
        entries: snapshot.entries.map((e) =>
          e.kind === "readme" ? { ...e, path: "README.md" } : e,
        ),
      },
      { entries: [...snapshot.entries, snapshot.entries[1]] },
      {
        entries: [
          ...snapshot.entries,
          { path: "../secret", kind: "linked", status: "missing" },
        ],
      },
      {
        entries: [
          ...snapshot.entries,
          { path: "a.md", kind: "linked", status: "missing", note: "x" },
        ],
      },
      { entries: [...snapshot.entries, { path: "a.md", kind: "x" }] },
    ];
    for (const change of bad)
      expect(() => validateSnapshot({ ...snapshot, ...change })).toThrow();
    expect(() =>
      validateSnapshots({
        version: 1,
        items: [
          { ...snapshot, baseline: true },
          { ...snapshot, id: "other", baseline: true },
        ],
      }),
    ).toThrow(/only one Baseline/);
    expect(() =>
      validateSnapshots({ version: 1, items: [snapshot, snapshot] }),
    ).toThrow(/Duplicate/);
  });
});

describe("retention and Baseline", () => {
  const item = (documentId, minute, extra = {}) =>
    validateSnapshot({
      id: `${documentId}-${minute}`,
      documentId,
      target,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
      head: sha("1"),
      tree: "complete",
      sourceHash: "fnv1a32:00000000",
      baseline: false,
      entries: [
        {
          path: target.path,
          kind: "readme",
          status: "captured",
          type: "file",
          sha: sha("3"),
        },
      ],
      notes: [],
      ...extra,
    });
  it("keeps the newest snapshots per document and never evicts the Baseline", () => {
    let snapshots = { version: 1, items: [item("doc", 0, { baseline: true })] };
    const evicted = [];
    for (let minute = 1; minute <= DOCUMENT_RETENTION + 2; minute++) {
      const result = addSnapshot(snapshots, item("doc", minute));
      snapshots = result.snapshots;
      evicted.push(...result.evicted.map((e) => e.id));
    }
    const kept = documentSnapshots(snapshots, "doc").map((e) => e.id);
    expect(kept).toHaveLength(DOCUMENT_RETENTION + 1);
    expect(kept).toContain("doc-0");
    expect(kept[0]).toBe(`doc-${DOCUMENT_RETENTION + 2}`);
    expect(evicted).toEqual(["doc-1", "doc-2"]);
  });
  it("enforces the workspace cap by evicting the oldest non-Baseline snapshots", () => {
    const items = Array.from({ length: WORKSPACE_RETENTION + 1 }, (_, i) =>
      item(`doc-${i}`, i, { baseline: i === 0 }),
    );
    const { snapshots, evicted } = retainSnapshots(items);
    expect(snapshots.items).toHaveLength(WORKSPACE_RETENTION);
    expect(evicted.map((e) => e.id)).toEqual(["doc-1-1"]);
    expect(() =>
      retainSnapshots(
        Array.from({ length: WORKSPACE_RETENTION + 1 }, (_, i) =>
          item(`doc-${i}`, i, { baseline: true }),
        ),
      ),
    ).toThrow(/Baseline/);
  });
  it("always keeps a fresh capture, even behind future-dated snapshots", () => {
    const future = Array.from({ length: DOCUMENT_RETENTION }, (_, i) =>
      item("doc", 0, {
        id: `future-${i}`,
        capturedAt: new Date(Date.UTC(2030, 0, 1, 0, i)).toISOString(),
      }),
    );
    const { snapshots, evicted } = addSnapshot(
      { version: 1, items: future },
      item("doc", 1, { id: "new" }),
    );
    expect(snapshots.items.map((e) => e.id)).toContain("new");
    expect(evicted.map((e) => e.id)).toEqual(["future-0"]);
  });
  it("refuses a capture rather than dropping it when every other snapshot is a Baseline", () => {
    const baselines = {
      version: 1,
      items: Array.from({ length: WORKSPACE_RETENTION }, (_, i) =>
        item(`doc-${i}`, i, { baseline: true }),
      ),
    };
    expect(() => addSnapshot(baselines, item("doc-0", 59))).toThrow(
      /Unpin or delete one first/,
    );
  });
  it("pins one Baseline per document, refuses a Different target and supports unpin/delete/forget", () => {
    let snapshots = {
      version: 1,
      items: [item("doc", 1), item("doc", 2), item("other", 3)],
    };
    snapshots = pinBaseline(snapshots, "doc-1", target);
    snapshots = pinBaseline(snapshots, "doc-2", target);
    expect(snapshots.items.filter((e) => e.baseline).map((e) => e.id)).toEqual([
      "doc-2",
    ]);
    expect(() =>
      pinBaseline(snapshots, "doc-1", { ...target, branch: "next" }),
    ).toThrow(/different target/);
    expect(
      unpinBaseline(snapshots, "doc-2").items.some((e) => e.baseline),
    ).toBe(false);
    expect(deleteSnapshot(snapshots, "doc-1").items).toHaveLength(2);
    expect(() => deleteSnapshot(snapshots, "nope")).toThrow(/no longer exists/);
    expect(forgetDocument(snapshots, "doc").items.map((e) => e.id)).toEqual([
      "other-3",
    ]);
  });
  it("labels snapshots whose repository, branch or path no longer match", () => {
    const snapshot = item("doc", 1);
    expect(differentTarget(snapshot, target)).toBe(false);
    expect(
      differentTarget(snapshot, { ...target, repository: "Example/Widget" }),
    ).toBe(false);
    expect(differentTarget(snapshot, { ...target, branch: "dev" })).toBe(true);
    expect(differentTarget(snapshot, { ...target, path: "README.md" })).toBe(
      true,
    );
    expect(differentTarget(snapshot, null)).toBe(true);
  });
});

describe("change check", () => {
  it("reports unchanged, changed, added, removed and unknown evidence without saving", async () => {
    const baseline = await capture(healthy().client);
    const next = tree();
    next.tree = next.tree
      .filter((e) => e.path !== "package-lock.json")
      .map((e) => (e.path === "docs/usage.md" ? { ...e, sha: sha("d") } : e));
    next.tree.push(
      { path: "Cargo.toml", type: "blob", sha: sha("e") },
      { path: "docs/missing.md", type: "blob", sha: sha("f") },
    );
    const current = await readEvidence({
      client: healthy(next, head(sha("0"))).client,
      target,
      linked: baseline.entries
        .filter((e) => e.kind === "linked")
        .map((e) => e.path),
    });
    const result = compareEvidence(baseline, current);
    const status = Object.fromEntries(
      result.entries.map((e) => [e.path, e.status]),
    );
    expect(result.headChanged).toBe(true);
    expect(status["docs/README.md"]).toBe("unchanged");
    expect(status["docs/usage.md"]).toBe("changed");
    expect(status["package-lock.json"]).toBe("removed");
    expect(status["Cargo.toml"]).toBe("added");
    expect(status["docs/missing.md"]).toBe("added");
    expect(result.counts).toMatchObject({
      changed: 1,
      added: 2,
      removed: 1,
      unknown: 0,
    });
    expect(result.entries[0].kind).toBe("readme");
  });
  it("never reports drift for evidence that could not be read on either side", async () => {
    const baseline = await capture(healthy().client);
    const failed = await readEvidence({
      client: github([
        ["/commits?", () => json(head())],
        ["/git/trees/", () => json({}, 500)],
      ]).client,
      target,
      linked: ["docs/usage.md"],
    });
    const result = compareEvidence(baseline, failed);
    expect(result.entries.every((e) => ["unknown"].includes(e.status))).toBe(
      true,
    );
    expect(result.counts.removed).toBe(0);
    const truncated = await capture(healthy(tree({ truncated: true })).client);
    const withCargo = tree();
    withCargo.tree.push({ path: "Cargo.toml", type: "blob", sha: sha("e") });
    const now = await readEvidence({
      client: healthy(withCargo).client,
      target,
    });
    const cargo = compareEvidence(truncated, now).entries.find(
      (e) => e.path === "Cargo.toml",
    );
    expect(cargo.status).toBe("unknown");
  });
  it("flags local Markdown edited since capture", async () => {
    const snapshot = await capture(healthy().client);
    expect(snapshotSummary(snapshot, source).sourceEdited).toBe(false);
    expect(snapshotSummary(snapshot, source + "\n").sourceEdited).toBe(true);
  });
});

describe("storage, backup and recovery", () => {
  async function workspace() {
    const draft = newDraft("Widget README");
    draft.markdown = source;
    const local = newDraft("Local notes");
    const snapshot = {
      ...(await capture(healthy().client)),
      documentId: draft.id,
      baseline: true,
    };
    return {
      version: 1,
      drafts: [draft, local],
      active: draft.id,
      settings: {},
      evidenceSnapshots: { version: 1, items: [snapshot] },
    };
  }
  it("round-trips through local storage and follows regenerated IDs in backups", async () => {
    const data = await workspace();
    const storage = new Map();
    const fake = {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
    };
    saveDrafts(data, fake);
    const read = readDrafts(fake);
    expect(read.evidenceSnapshots.items[0].documentId).toBe(data.drafts[0].id);
    const restored = validateWorkspace(createBackup(data));
    expect(restored.drafts[0].id).not.toBe(data.drafts[0].id);
    expect(restored.evidenceSnapshots.items[0].documentId).toBe(
      restored.drafts[0].id,
    );
    expect(restored.drafts[0].markdown).toBe(source);
  });
  it("drops snapshots for documents that no longer exist", async () => {
    const data = await workspace();
    data.drafts = [data.drafts[1]];
    data.active = data.drafts[0].id;
    expect(validateWorkspace(data).evidenceSnapshots.items).toEqual([]);
  });
  it("keeps original storage untouched and salvages valid snapshots during recovery", async () => {
    const data = await workspace();
    const raw = JSON.stringify({
      ...data,
      evidenceSnapshots: {
        version: 1,
        items: [data.evidenceSnapshots.items[0], { id: "broken" }],
      },
    });
    const storage = new Map([[STORAGE_KEY, raw]]);
    const fake = {
      getItem: (k) => storage.get(k) ?? null,
      setItem: () => {
        throw Error("must not write");
      },
    };
    let error;
    try {
      readDrafts(fake);
    } catch (e) {
      error = e;
    }
    expect(error.raw).toBe(raw);
    expect(storage.get(STORAGE_KEY)).toBe(raw);
    const recovered = error.recovered;
    expect(recovered.drafts.map((d) => d.markdown)).toEqual([
      source,
      data.drafts[1].markdown,
    ]);
    expect(recovered.evidenceSnapshots.items).toHaveLength(1);
    expect(recovered.evidenceSnapshots.items[0].documentId).toBe(
      recovered.drafts[0].id,
    );
    const future = recoverWorkspace(
      JSON.stringify({ ...data, evidenceSnapshots: { version: 9, items: [] } }),
    );
    expect(future.evidenceSnapshots.items).toEqual([]);
    expect(future.drafts[0].markdown).toBe(source);
  });
  it("merges or replaces snapshots on restore without overwriting local ones", async () => {
    const current = await workspace();
    const backup = createBackup(await workspace());
    const merged = restoreWorkspace(current, backup, "merge");
    expect(merged.evidenceSnapshots.items).toHaveLength(2);
    const ids = new Set(merged.drafts.map((d) => d.id));
    expect(
      merged.evidenceSnapshots.items.every((s) => ids.has(s.documentId)),
    ).toBe(true);
    expect(
      merged.evidenceSnapshots.items.filter((s) => s.baseline),
    ).toHaveLength(2);
    const replaced = restoreWorkspace(current, backup, "replace");
    expect(replaced.evidenceSnapshots.items[0].documentId).toBe(
      replaced.drafts[0].id,
    );
    const self = mergeSnapshots(
      current.evidenceSnapshots,
      current.evidenceSnapshots,
    ).snapshots.items;
    expect(self).toHaveLength(2);
    expect(self.filter((s) => s.baseline).map((s) => s.id)).toEqual([
      current.evidenceSnapshots.items[0].id,
    ]);
  });
  it("recovers drafts even when damaged storage holds more Baselines than the workspace limit", async () => {
    const base = (await workspace()).evidenceSnapshots.items[0];
    const drafts = Array.from({ length: WORKSPACE_RETENTION + 1 }, (_, i) => {
      const draft = newDraft(`Doc ${i}`);
      draft.id = `d${i}`;
      return draft;
    });
    const evidenceSnapshots = {
      version: 1,
      items: drafts.map((draft, i) => ({
        ...base,
        id: `s${i}`,
        documentId: draft.id,
        capturedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        baseline: true,
      })),
    };
    const salvaged = recoverSnapshots(evidenceSnapshots);
    expect(salvaged.items).toHaveLength(WORKSPACE_RETENTION);
    expect(salvaged.items.map((s) => s.id)).not.toContain("s0");
    const recovered = recoverWorkspace(
      JSON.stringify({
        version: 1,
        drafts,
        active: "d0",
        settings: {},
        evidenceSnapshots,
      }),
    );
    expect(recovered.drafts).toHaveLength(WORKSPACE_RETENTION + 1);
    expect(recovered.evidenceSnapshots.items).toHaveLength(WORKSPACE_RETENTION);
  });
  it("never evicts local snapshots on merge and counts incoming ones that do not fit", async () => {
    const base = (await workspace()).evidenceSnapshots.items[0];
    const many = (prefix, documents, year) => ({
      version: 1,
      items: Array.from({ length: documents * DOCUMENT_RETENTION }, (_, i) => ({
        ...base,
        id: `${prefix}${i}`,
        documentId: `${prefix}doc${Math.floor(i / DOCUMENT_RETENTION)}`,
        capturedAt: new Date(Date.UTC(year, 0, 1, 0, i)).toISOString(),
        baseline: false,
      })),
    });
    const local = many("l", 16, 2025),
      incoming = many("i", 10, 2026);
    const { snapshots, dropped } = mergeSnapshots(local, incoming);
    expect(snapshots.items).toHaveLength(WORKSPACE_RETENTION);
    expect(snapshots.items.filter((s) => s.id.startsWith("l"))).toHaveLength(
      80,
    );
    expect(dropped).toBe(30);

    const current = await workspace();
    current.drafts = Array.from({ length: 20 }, (_, i) => newDraft(`L${i}`));
    current.active = current.drafts[0].id;
    current.evidenceSnapshots = {
      version: 1,
      items: Array.from({ length: WORKSPACE_RETENTION }, (_, i) => ({
        ...base,
        id: `local-${i}`,
        documentId: current.drafts[i % 20].id,
        capturedAt: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString(),
        baseline: false,
      })),
    };
    const merged = restoreWorkspace(
      current,
      createBackup(await workspace()),
      "merge",
    );
    expect(
      merged.evidenceSnapshots.items.filter((s) => s.id.startsWith("local-")),
    ).toHaveLength(WORKSPACE_RETENTION);
  });
  it("never puts snapshots in portable Studio projects", async () => {
    const data = await workspace();
    // Pass everything the app could hand over: the workspace as embedded
    // libraries and a draft carrying stray workspace fields.
    const project = JSON.stringify(
      createProject(
        { ...data.drafts[0], evidenceSnapshots: data.evidenceSnapshots },
        data.settings,
        data,
      ),
    );
    expect(project).toContain("libraries");
    expect(project).not.toContain("evidenceSnapshots");
    expect(project).not.toContain(sha("1"));
  });
});

describe("evidence snapshots dialog", () => {
  it("explains ineligible documents and renders labels, empty and check states", async () => {
    const el = document.createElement("evidence-snapshots");
    const draft = { id: "doc-1", markdown: source };
    el.configure({ draft, target: null, snapshots: undefined });
    expect(el.querySelector("[data-capture]")).toBeNull();
    expect(el.querySelector("[data-set-target]")).not.toBeNull();
    expect(el.querySelector("[data-empty]")).not.toBeNull();
    const snapshot = { ...(await capture(healthy().client)), baseline: true };
    const other = {
      ...snapshot,
      id: "older",
      baseline: false,
      capturedAt: "2025-01-01T00:00:00.000Z",
      target: { ...target, branch: "legacy" },
    };
    el.configure({
      draft: { ...draft, markdown: source + "edit" },
      target,
      snapshots: { version: 1, items: [other, snapshot] },
    });
    const items = el.querySelectorAll("[data-snapshot]");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector("[data-labels]").textContent).toContain(
      "Baseline",
    );
    expect(items[0].textContent).toContain("Partial snapshot");
    expect(items[0].textContent).toContain("Markdown edited since capture");
    expect(items[1].textContent).toContain("Different target");
    expect(
      items[1].querySelector('[data-snapshot-action="check"]').disabled,
    ).toBe(true);
    el.busy(true);
    el.busy(false);
    expect(
      items[1].querySelector('[data-snapshot-action="check"]').disabled,
    ).toBe(true);
    expect(
      el.querySelector('[data-id="older"][data-snapshot-action="pin"]')
        .disabled,
    ).toBe(true);
    expect(
      el.querySelector(
        `[data-id="${snapshot.id}"][data-snapshot-action="check"]`,
      ).disabled,
    ).toBe(false);
    expect(
      [...el.querySelectorAll("button")].some((b) =>
        /publish|commit|push/i.test(b.textContent),
      ),
    ).toBe(false);
    // The live region survives re-rendering so outcomes are announced.
    const live = el.querySelector("[data-status]");
    el.status("Pinned as Baseline.");
    el.configure({
      draft,
      target,
      snapshots: { version: 1, items: [snapshot] },
    });
    expect(el.querySelector("[data-status]")).toBe(live);
    expect(el.querySelectorAll("[data-status]")).toHaveLength(1);
    expect(el.querySelectorAll("[data-snapshot]")).toHaveLength(1);
    el.showCheck(snapshot, compareEvidence(snapshot, snapshot));
    expect(el.querySelector("[data-counts]").textContent).toContain(
      "0 changed",
    );
    expect(el.querySelector("[data-check]").textContent).toContain(
      "Nothing was saved",
    );
  });
});
