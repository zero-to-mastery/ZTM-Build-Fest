// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildChangeSet,
  changeSetContents,
  changeSetsSupported,
  executeChangeSet,
  fileWrites,
  gitBlobSha,
  shortChangeSetId,
  verifyChangeSet,
  CHANGE_SET_UNSUPPORTED,
} from "../src/publishing/change-set.js";
const target = { repository: "octocat/octocat", branch: "main" },
  baseCommitSha = "1".repeat(40),
  readmeBase = "a".repeat(40),
  assetBase = "b".repeat(40);
const readme = (content = "# New 🦀\n", extra = {}) => ({
  path: "README.md",
  kind: "readme",
  baseSha: readmeBase,
  baseContent: "# Old\n",
  content,
  ...extra,
});
const asset = (name, content, extra = {}) => ({
  path: `assets/readme/${name}`,
  kind: "asset",
  baseSha: null,
  content,
  fields: { banner: { title: name } },
  ...extra,
});
const build = (overrides = {}) =>
  buildChangeSet({
    target,
    baseCommitSha,
    message: "Update README",
    files: [readme(), asset("a.svg", "<svg>a</svg>")],
    ...overrides,
  });
afterEach(() => vi.unstubAllGlobals());

describe("gitBlobSha", () => {
  it.each([
    ["", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"],
    ["hello\n", "ce013625030ba8dba906f756967f9e9ca394464a"],
    // UTF-8 byte length, not string length, goes into the blob header.
    ["# 🦀 é\r\n", "937dad9921ccf067cd9a9938c06be4b65beb8dc0"],
    ["café ✓\n", "6b2b281e1146f9673f218f9c76042db37be95d03"],
  ])("matches git hash-object for %j", async (content, sha) => {
    expect(await gitBlobSha(content)).toBe(sha);
  });
  it("is unavailable without Web Crypto, which keeps publishing read-only", async () => {
    vi.stubGlobal("crypto", {});
    expect(changeSetsSupported()).toBe(false);
    await expect(gitBlobSha("x")).rejects.toThrow(CHANGE_SET_UNSUPPORTED);
    await expect(build()).rejects.toThrow("Read-only mode");
  });
});

describe("buildChangeSet", () => {
  it("derives create, update and unchanged from Base and Result SHAs", async () => {
    const same = "<svg>same</svg>";
    const cs = await build({
      files: [
        readme(),
        asset("new.svg", "<svg>new</svg>"),
        asset("same.svg", same, { baseSha: await gitBlobSha(same) }),
        asset("old.svg", "<svg>changed</svg>", {
          baseSha: assetBase,
          baseContent: "<svg>old</svg>",
        }),
      ],
    });
    expect(cs.entries.map((e) => [e.path, e.action])).toEqual([
      ["assets/readme/new.svg", "create"],
      ["assets/readme/same.svg", "unchanged"],
      ["assets/readme/old.svg", "update"],
      ["README.md", "update"],
    ]);
    const [created, unchanged, , primary] = cs.entries;
    expect(created).toMatchObject({
      baseSha: null,
      resultSha: await gitBlobSha("<svg>new</svg>"),
      bytes: 14,
      added: 1,
      removed: 0,
    });
    expect(unchanged).toMatchObject({ added: 0, removed: 0 });
    expect(primary).toMatchObject({
      kind: "readme",
      baseSha: readmeBase,
      resultSha: await gitBlobSha("# New 🦀\n"),
      bytes: new TextEncoder().encode("# New 🦀\n").length,
      added: 1,
      removed: 1,
    });
    expect(fileWrites(cs).map((e) => e.path)).toEqual([
      "assets/readme/new.svg",
      "assets/readme/old.svg",
      "README.md",
    ]);
  });
  it("orders assets first and the README last, whatever the input order", async () => {
    const cs = await build({
      files: [readme(), asset("a.svg", "a"), asset("b.svg", "b")],
    });
    expect(cs.entries.map((e) => e.path)).toEqual([
      "assets/readme/a.svg",
      "assets/readme/b.svg",
      "README.md",
    ]);
  });
  it("keeps a remote BOM in the Base SHA and names an update that drops or adds it", async () => {
    const remote = "\uFEFF# Hi\n",
      baseSha = await gitBlobSha(remote);
    // git hash-object of EF BB BF "# Hi\n".
    expect(baseSha).toBe("4489fbf4ced9bc5f0603376c08477311abd8ed43");
    const entry = async (content, base = remote) =>
      (
        await build({
          files: [
            readme(content, {
              baseSha: await gitBlobSha(base),
              baseContent: base,
            }),
          ],
        })
      ).entries[0];
    // Identical bytes, BOM included: nothing to write.
    expect(await entry(remote)).toMatchObject({
      action: "unchanged",
      bom: null,
    });
    // Same text without the BOM: a real write the review must name.
    expect(await entry("# Hi\n")).toMatchObject({
      action: "update",
      bom: "removed",
    });
    expect(await entry(remote, "# Hi\n")).toMatchObject({
      action: "update",
      bom: "added",
    });
    expect((await build()).entries.at(-1).bom).toBeNull();
  });
  it("is a frozen, versioned manifest without content", async () => {
    const cs = await build();
    expect(cs).toMatchObject({
      version: 1,
      target,
      baseCommitSha,
      message: "Update README",
    });
    expect(cs.id).toMatch(/^[a-f0-9]{64}$/);
    expect(shortChangeSetId(cs.id)).toBe(cs.id.slice(0, 8));
    expect(Object.isFrozen(cs)).toBe(true);
    expect(Object.isFrozen(cs.entries)).toBe(true);
    expect(Object.isFrozen(cs.entries[0])).toBe(true);
    expect(Object.isFrozen(cs.target)).toBe(true);
    const json = JSON.stringify(cs);
    expect(json).not.toContain("New 🦀");
    expect(json).not.toContain("<svg>");
    expect(json).not.toContain("banner");
  });
  it("keeps a stable id and changes it with message, content, target, base commit or order", async () => {
    const base = await build();
    expect((await build()).id).toBe(base.id);
    // Trimmed like the server trims, so the id names what is written.
    expect((await build({ message: "  Update README " })).id).toBe(base.id);
    // Diff counts are not part of the identity.
    expect(
      (
        await build({
          files: [
            readme(undefined, { baseContent: "other" }),
            asset("a.svg", "<svg>a</svg>"),
          ],
        })
      ).id,
    ).toBe(base.id);
    const variants = [
      { message: "Update README!" },
      { files: [readme("# Other\n"), asset("a.svg", "<svg>a</svg>")] },
      { files: [readme(), asset("a.svg", "<svg>A</svg>")] },
      { target: { ...target, branch: "docs" } },
      { target: { ...target, repository: "octocat/other" } },
      { baseCommitSha: "2".repeat(40) },
      { baseCommitSha: null },
      {
        files: [
          readme(undefined, { baseSha: null }),
          asset("a.svg", "<svg>a</svg>"),
        ],
      },
    ];
    for (const variant of variants)
      expect((await build(variant)).id).not.toBe(base.id);
    const ab = await build({
        files: [readme(), asset("a.svg", "a"), asset("b.svg", "b")],
      }),
      ba = await build({
        files: [readme(), asset("b.svg", "b"), asset("a.svg", "a")],
      });
    expect(ab.id).not.toBe(ba.id);
  });
  it.each([
    ["an empty message", { message: " " }, "commit message"],
    ["no files", { files: [] }, "at least one file"],
    ["a duplicate path", { files: [readme(), readme()] }, "twice"],
    [
      "an unsupported kind",
      { files: [{ ...readme(), kind: "secret" }] },
      "Unsupported",
    ],
    [
      "a malformed Base SHA",
      { files: [readme(undefined, { baseSha: "nope" })] },
      "remote SHA",
    ],
    [
      "a hidden asset path",
      { files: [readme(), asset("x", "a", { path: ".github/x.svg" })] },
      "SVG path",
    ],
    ["a traversal target", { target: { ...target, branch: "../x" } }, "branch"],
    ["oversized content", { files: [readme("x".repeat(750_001))] }, "750 KB"],
  ])("rejects %s", async (_, overrides, message) => {
    await expect(build(overrides)).rejects.toThrow(message);
  });
});

describe("verifyChangeSet", () => {
  it("reads every entry and is fresh only while each file keeps its Base SHA", async () => {
    const cs = await build(),
      reads = [];
    const result = await verifyChangeSet(cs, async (t) => {
      reads.push(t);
      // The branch head moved; that alone never makes the set stale.
      return {
        ...t,
        sha: t.kind === "asset" ? null : readmeBase,
        commitSha: "9".repeat(40),
      };
    });
    expect(result.stale).toEqual([]);
    expect(reads).toEqual([
      { ...target, path: "assets/readme/a.svg", kind: "asset" },
      { ...target, path: "README.md" },
    ]);
  });
  it("reports per-file SHA drift, including a create whose file now exists", async () => {
    const cs = await build();
    const drifted = await verifyChangeSet(cs, async (t) => ({
      sha: t.kind === "asset" ? "f".repeat(40) : readmeBase,
      content: "remote",
    }));
    expect(drifted.stale).toEqual(["assets/readme/a.svg"]);
    expect(drifted.remotes["assets/readme/a.svg"].content).toBe("remote");
    const readmeChanged = await verifyChangeSet(cs, async (t) => ({
      sha: t.kind === "asset" ? null : "e".repeat(40),
    }));
    expect(readmeChanged.stale).toEqual(["README.md"]);
  });
  it("propagates a failed read so nothing is written", async () => {
    await expect(
      verifyChangeSet(await build(), async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
  });
});

describe("executeChangeSet", () => {
  async function plan() {
    const same = "<svg>same</svg>",
      files = [
        readme(),
        asset("new.svg", "<svg>new</svg>"),
        asset("same.svg", same, { baseSha: await gitBlobSha(same) }),
        asset("old.svg", "<svg>changed</svg>", { baseSha: assetBase }),
      ];
    return { files, cs: await build({ files }) };
  }
  it("writes only non-unchanged entries, in order, with Base SHA, Result SHA and id", async () => {
    const { files, cs } = await plan(),
      requests = [];
    const outcome = await executeChangeSet(
      cs,
      changeSetContents(files),
      async (op, data) => {
        requests.push([op, data]);
        return { commitSha: "c".repeat(40) };
      },
    );
    expect(outcome.complete).toBe(true);
    expect(requests.map(([op, d]) => [op, d.path])).toEqual([
      ["commit", "assets/readme/new.svg"],
      ["commit", "assets/readme/old.svg"],
      ["commit", "README.md"],
    ]);
    const [created, updated, primary] = requests.map(([, d]) => d);
    expect(created).toMatchObject({
      ...target,
      kind: "asset",
      sha: null,
      resultSha: cs.entries[0].resultSha,
      changeSetId: cs.id,
      content: "<svg>new</svg>",
      banner: { title: "new.svg" },
      message: "Update README",
      confirmed: true,
    });
    expect(updated.sha).toBe(assetBase);
    expect(primary).not.toHaveProperty("kind");
    expect(primary).toMatchObject({
      sha: readmeBase,
      resultSha: await gitBlobSha("# New 🦀\n"),
      content: "# New 🦀\n",
    });
    expect(outcome.results.map((r) => r.status)).toEqual([
      "written",
      "no write",
      "written",
      "written",
    ]);
  });
  it("stops at the first failure and marks the rest not attempted", async () => {
    const { files, cs } = await plan();
    let writes = 0;
    const outcome = await executeChangeSet(
      cs,
      changeSetContents(files),
      async () => {
        if (++writes === 2)
          throw Object.assign(new Error("denied"), { status: 403 });
        return { commitSha: "c".repeat(40) };
      },
    );
    expect(writes).toBe(2);
    expect(outcome.complete).toBe(false);
    expect(outcome.failure.entry.path).toBe("assets/readme/old.svg");
    expect(outcome.failure.error.status).toBe(403);
    expect(outcome.results.map((r) => [r.path, r.status])).toEqual([
      ["assets/readme/new.svg", "written"],
      ["assets/readme/same.svg", "no write"],
      ["assets/readme/old.svg", "failed"],
      ["README.md", "not attempted"],
    ]);
  });
  it("pins each selected-PR write to the preceding exact branch head", async () => {
    const { files, cs } = await plan(),
      observed = [],
      heads = ["d".repeat(40), "e".repeat(40), "f".repeat(40)];
    await executeChangeSet(
      cs,
      changeSetContents(files),
      async (_, data) => {
        observed.push(data.expectedBranchSha);
        return { commitSha: heads[observed.length - 1] };
      },
      { expectedBranchSha: "c".repeat(40) },
    );
    expect(observed).toEqual(["c".repeat(40), "d".repeat(40), "e".repeat(40)]);
  });
  it("marks a lost write response unknown and exposes lifecycle events", async () => {
    const { files, cs } = await plan(),
      events = [];
    const outcome = await executeChangeSet(
      cs,
      changeSetContents(files),
      async () => {
        throw Object.assign(new Error("response lost"), { ambiguous: true });
      },
      {
        beforeWrite: (entry) => events.push([entry.path, "pending"]),
        afterWrite: (entry, status) => events.push([entry.path, status]),
      },
    );
    expect(outcome.complete).toBe(false);
    expect(outcome.results[0]).toMatchObject({
      path: "assets/readme/new.svg",
      status: "unknown",
    });
    expect(events).toEqual([
      ["assets/readme/new.svg", "pending"],
      ["assets/readme/new.svg", "unknown"],
    ]);
  });
  it("retries only explicitly reconciled paths", async () => {
    const { files, cs } = await plan(),
      paths = new Set(["assets/readme/old.svg", "README.md"]),
      requests = [];
    const outcome = await executeChangeSet(
      cs,
      changeSetContents(files),
      async (_, data) => {
        requests.push(data.path);
        return { commitSha: "c".repeat(40) };
      },
      { onlyPaths: paths },
    );
    expect(requests).toEqual(["assets/readme/old.svg", "README.md"]);
    expect(outcome.results.map((result) => result.status)).toEqual([
      "already written",
      "no write",
      "written",
      "written",
    ]);
  });
  it("stops for reconciliation when the response arrived but its journal update failed", async () => {
    const { files, cs } = await plan(),
      request = vi.fn(async () => ({ commitSha: "c".repeat(40) }));
    const outcome = await executeChangeSet(
      cs,
      changeSetContents(files),
      request,
      {
        afterWrite: () => {
          throw new Error("journal full");
        },
      },
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(outcome.complete).toBe(false);
    expect(outcome.results[0]).toMatchObject({
      status: "unknown",
      error: "journal full",
    });
    expect(outcome.failure.error.ambiguous).toBe(true);
    expect(outcome.failure.error.recoveryReason).toBe("journal");
  });
  it("refuses before any write when content no longer matches the review", async () => {
    const { files, cs } = await plan();
    const contents = changeSetContents(files);
    contents.get("README.md").content = "# Edited after approval\n";
    const request = vi.fn();
    await expect(executeChangeSet(cs, contents, request)).rejects.toThrow(
      "no longer matches",
    );
    contents.delete("README.md");
    await expect(executeChangeSet(cs, contents, request)).rejects.toThrow(
      "no longer matches",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
