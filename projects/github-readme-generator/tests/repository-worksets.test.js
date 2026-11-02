import { describe, expect, it } from "vitest";
import { newDraft } from "../src/state/drafts.js";
import {
  createWorksetPack,
  emptyWorksets,
  importWorksets,
  mergeWorksets,
  repositoryIndex,
  recoverWorksets,
  resolveWorkset,
  saveWorkset,
  validateWorksetPack,
  validateWorksets,
  WORKSET_LIMIT,
  WORKSET_REPOSITORY_LIMIT,
} from "../src/workspace/repository-worksets.js";
import {
  createBackup,
  restoreWorkspace,
  validateWorkspace,
} from "../src/state/workspace-backup.js";
import "../src/components/repository-worksets.js";

const targeted = (name, repository, path = "README.md") => {
  const draft = newDraft(name);
  draft.metadata.workspaceDocument = {
    version: 1,
    kind: "repository",
    target: { repository, branch: "main", path },
  };
  return draft;
};

describe("repository worksets", () => {
  it("stores only a bounded name and normalized repository identities", () => {
    const saved = saveWorkset(emptyWorksets(), {
      name: "Release sweep",
      repositories: ["Ada/Tools", "ada/tools", "ada/docs"],
      token: "never keep me",
    });
    expect(saved.items[0]).toEqual({
      id: expect.any(String),
      name: "Release sweep",
      repositories: ["ada/tools", "ada/docs"],
    });
    expect(saved.items[0]).not.toHaveProperty("token");
    expect(() =>
      saveWorkset(emptyWorksets(), {
        name: "Too many",
        repositories: Array.from(
          { length: WORKSET_REPOSITORY_LIMIT + 1 },
          (_, i) => `owner/repo-${i}`,
        ),
      }),
    ).toThrow("at most 100");
  });

  it("rejects malformed and oversized stored data without retaining secrets", () => {
    expect(() =>
      validateWorksets({
        version: 1,
        items: [{ name: "Bad", repositories: ["not-a-repository"] }],
      }),
    ).toThrow("owner/name");
    expect(() =>
      validateWorksets({
        version: 1,
        items: Array.from({ length: WORKSET_LIMIT + 1 }, (_, i) => ({
          name: `Set ${i}`,
          repositories: [`owner/repo-${i}`],
        })),
      }),
    ).toThrow("at most 50");
    expect(
      recoverWorksets({
        version: 1,
        items: [
          { name: "Good", repositories: ["owner/repo"] },
          { name: "Bad", repositories: ["not-a-repository"] },
        ],
      }).items.map((item) => item.name),
    ).toEqual(["Good"]);
  });

  it("resolves every matching document and reports missing repositories", () => {
    const drafts = [
      targeted("README", "ada/tools"),
      targeted("Guide", "ada/tools", "docs/README.guide"),
      targeted("Other", "ada/other"),
    ];
    expect(repositoryIndex(drafts).get("ada/tools")).toHaveLength(2);
    const resolved = resolveWorkset(
      { repositories: ["ada/tools", "ada/missing"] },
      drafts,
    );
    expect(resolved[0].documents.map((draft) => draft.name)).toEqual([
      "README",
      "Guide",
    ]);
    expect(resolved[1].documents).toEqual([]);
  });

  it("round-trips v1 packs and migrates the bounded v0 shape", () => {
    const local = saveWorkset(emptyWorksets(), {
      name: "Local",
      repositories: ["ada/local"],
    });
    const pack = createWorksetPack(local);
    expect(
      validateWorksetPack(JSON.parse(JSON.stringify(pack))).items[0],
    ).toMatchObject({ name: "Local", repositories: ["ada/local"] });
    const migrated = validateWorksetPack({
      kind: "readme-studio-repository-worksets",
      version: 0,
      sets: [{ title: "Legacy", repos: ["Ada/Old"] }],
      token: "ignored",
    });
    expect(migrated.items[0]).toMatchObject({
      name: "Legacy",
      repositories: ["ada/old"],
    });
    const merged = importWorksets(local, {
      kind: "readme-studio-repository-worksets",
      version: 1,
      worksets: [{ name: "Local", repositories: ["ada/other"] }],
    });
    expect(merged.items.map((item) => item.name)).toEqual([
      "Local",
      "Local (2)",
    ]);
  });

  it("merges backup libraries without reusing IDs or overwriting names", () => {
    const first = saveWorkset(emptyWorksets(), {
      name: "Sweep",
      repositories: ["ada/one"],
    });
    const second = saveWorkset(emptyWorksets(), {
      name: "Sweep",
      repositories: ["ada/two"],
    });
    const merged = mergeWorksets(first, second);
    expect(merged.items.map((item) => item.name)).toEqual([
      "Sweep",
      "Sweep (2)",
    ]);
    expect(new Set(merged.items.map((item) => item.id)).size).toBe(2);
  });

  it("survives workspace backup, defaults legacy workspaces, and merges explicitly", () => {
    const draft = targeted("README", "ada/one");
    const first = {
      version: 1,
      drafts: [draft],
      active: draft.id,
      repositoryWorksets: saveWorkset(emptyWorksets(), {
        name: "First",
        repositories: ["ada/one"],
      }),
    };
    const restored = validateWorkspace(createBackup(first));
    expect(restored.repositoryWorksets.items[0]).toMatchObject({
      name: "First",
      repositories: ["ada/one"],
    });
    const legacy = validateWorkspace({
      version: 1,
      drafts: [targeted("Legacy", "ada/legacy")],
      active: "missing",
    });
    expect(legacy.repositoryWorksets).toEqual(emptyWorksets());
    expect(
      restoreWorkspace(legacy, createBackup(first), "merge").repositoryWorksets
        .items,
    ).toHaveLength(1);
  });

  it("invalidates a reviewed import while replacement files are pending or fail", async () => {
    const element = document.createElement("repository-worksets");
    document.body.append(element);
    element.configure({ library: emptyWorksets(), drafts: [] });
    const pack = JSON.stringify({
      kind: "readme-studio-repository-worksets",
      version: 1,
      worksets: [{ name: "Reviewed", repositories: ["ada/tools"] }],
    });
    const json = element.querySelector("[data-json]");
    const input = element.querySelector("[data-file]");
    const review = element.querySelector("[data-import-review]");
    const setFile = (file) =>
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });
    json.value = pack;
    element.reviewImport();
    expect(review.textContent).toContain("Reviewed");

    let finish;
    setFile({
      size: 10,
      text: () => new Promise((resolve) => (finish = resolve)),
    });
    input.dispatchEvent(new Event("change"));
    expect(review.childElementCount).toBe(0);
    finish(pack);
    await Promise.resolve();
    await Promise.resolve();
    expect(review.textContent).toContain("Reviewed");

    let finishStale;
    setFile({
      size: 10,
      text: () => new Promise((resolve) => (finishStale = resolve)),
    });
    input.dispatchEvent(new Event("change"));
    element.configure({ library: emptyWorksets(), drafts: [] });
    finishStale(pack);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      element.querySelector("[data-import-review]").childElementCount,
    ).toBe(0);

    const currentInput = element.querySelector("[data-file]");
    const currentJson = element.querySelector("[data-json]");
    const currentReview = element.querySelector("[data-import-review]");
    const setCurrentFile = (file) =>
      Object.defineProperty(currentInput, "files", {
        configurable: true,
        value: [file],
      });
    setCurrentFile({ size: 250_001, text: async () => pack });
    currentInput.dispatchEvent(new Event("change"));
    expect(currentReview.childElementCount).toBe(0);
    expect(element.querySelector("[data-status]").textContent).toContain(
      "exceeds 250 KB",
    );

    currentJson.value = pack;
    element.reviewImport();
    setCurrentFile({
      size: 10,
      text: async () => {
        throw Error("unreadable");
      },
    });
    currentInput.dispatchEvent(new Event("change"));
    await Promise.resolve();
    await Promise.resolve();
    expect(currentReview.childElementCount).toBe(0);
    expect(element.querySelector("[data-status]").textContent).toContain(
      "Could not read",
    );
    element.remove();
  });
});
