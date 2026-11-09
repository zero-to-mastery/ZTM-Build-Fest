import { describe, it, expect } from "vitest";
import {
  GOALS,
  GUIDE_LIMIT,
  goalIds,
  defaultGuide,
  validateGuide,
  recoverGuide,
  guideGoal,
  nextStepsEnabled,
  chooseGoal,
  goalOptions,
  blankDocument,
} from "../src/workspace/guide.js";
import {
  validateWorkspace,
  recoverWorkspace,
  createBackup,
  restoreWorkspace,
  workspaceSettings,
} from "../src/state/workspace-backup.js";
import {
  newDraft,
  readDrafts,
  saveDrafts,
  STORAGE_KEY,
} from "../src/state/drafts.js";
import { portableData } from "../src/state/portable-data.js";
import { createProject } from "../src/studio-projects/model.js";
import { commands } from "../src/workspace/commands.js";

const fakeStorage = (entries = []) => {
  const map = new Map(entries);
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  };
};
const workspace = (guide) => {
  const draft = newDraft("Profile", []);
  draft.markdown = "# Hello\r\n\r\nKeep me exactly.\n";
  return {
    version: 1,
    drafts: [draft],
    active: draft.id,
    settings: { pane: "markdown" },
    ...(guide === undefined ? {} : { guide }),
  };
};

describe("guide goals", () => {
  it("defines three Goals and only the audit needs the network", () => {
    expect(goalIds).toEqual(["profile", "repository", "audit"]);
    for (const id of goalIds) {
      expect(GOALS[id].label).toMatch(/README/);
      expect(GOALS[id].description.length).toBeGreaterThan(10);
    }
    expect(goalIds.filter((id) => GOALS[id].needsNetwork)).toEqual(["audit"]);
    expect(GOALS.audit.description).toContain("GitHub connection");
    expect(Object.isFrozen(GOALS.profile)).toBe(true);
  });
  it("offers existing flows for each Goal and offline alternatives for the audit", () => {
    expect(goalOptions("profile").map((o) => o.id)).toEqual([
      "templates",
      "profile",
      "blank-profile",
    ]);
    expect(goalOptions("repository").map((o) => o.label)).toEqual([
      "Build a repository README",
      "Import existing README",
      "Start a blank repository README",
    ]);
    expect(goalOptions("audit")).toEqual([
      { id: "repository-audit", label: "Open README audit" },
    ]);
    const offline = goalOptions("audit", { online: false });
    expect(offline.map((o) => o.id)).toEqual([
      "repository-audit",
      "import",
      "blank-repository",
    ]);
    expect(offline[0].unavailable).toMatch(/offline/i);
    expect(offline.slice(1).every((o) => !o.unavailable)).toBe(true);
    // Offline never hides the profile or repository paths.
    expect(goalOptions("profile", { online: false })).toEqual(
      goalOptions("profile"),
    );
    expect(() => goalOptions("publish")).toThrow(/known Goal/);
  });
  it("creates blank documents without a target", () => {
    expect(blankDocument("profile")).toEqual({
      version: 1,
      kind: "profile",
      target: null,
    });
    expect(blankDocument("repository").kind).toBe("repository");
  });
});

describe("guide validation", () => {
  it("defaults a missing guide and normalizes version 1", () => {
    expect(validateGuide(undefined)).toEqual({
      version: 1,
      goal: null,
      nextSteps: true,
    });
    expect(validateGuide({ version: 1, goal: "audit" })).toEqual({
      version: 1,
      goal: "audit",
      nextSteps: true,
    });
    expect(
      validateGuide({
        version: 1,
        goal: "publish",
        nextSteps: "no",
        token: "secret",
      }),
    ).toEqual({ version: 1, goal: null, nextSteps: true });
    expect(
      validateGuide({ version: 1, goal: "profile", nextSteps: false }),
    ).toEqual({ version: 1, goal: "profile", nextSteps: false });
    expect(validateGuide({ version: 1, goal: "toString" }).goal).toBeNull();
    // Property-key coercion must not let a non-string through as a Goal.
    for (const goal of [["audit"], ["profile"], { toString: () => "audit" }])
      expect(validateGuide({ version: 1, goal, nextSteps: true })).toEqual({
        version: 1,
        goal: null,
        nextSteps: true,
      });
  });
  it("keeps a small unknown or malformed guide unchanged and reads it as no Goal", () => {
    const future = { version: 2, goal: "profile", steps: ["a", "b"] };
    const kept = validateGuide(future);
    expect(kept).toEqual(future);
    expect(kept).not.toBe(future);
    expect(guideGoal(kept)).toBeNull();
    expect(nextStepsEnabled(kept)).toBe(true);
    // Documented in docs/guided-start.md and docs/public-formats.md: any
    // non-version-1 value, malformed ones included, is kept when it is small.
    for (const malformed of [
      "profile",
      "hello",
      7,
      42,
      true,
      null,
      [],
      ["profile"],
      { goal: "x" },
      { goal: "audit" },
      { version: "1", goal: "audit" },
    ]) {
      expect(validateGuide(malformed)).toEqual(malformed);
      expect(guideGoal(validateGuide(malformed))).toBeNull();
    }
    expect(validateGuide(validateGuide(future))).toEqual(future);
  });
  it("replaces an unknown guide larger than 1 KB, or unserializable, with the default", () => {
    const big = { version: 2, note: "x".repeat(GUIDE_LIMIT) };
    expect(validateGuide(big)).toEqual(defaultGuide());
    const edge = { version: 2, note: "" };
    edge.note = "x".repeat(GUIDE_LIMIT - JSON.stringify(edge).length);
    expect(JSON.stringify(edge).length).toBe(GUIDE_LIMIT);
    expect(validateGuide(edge)).toEqual(edge);
    const circular = { version: 3 };
    circular.self = circular;
    expect(validateGuide(circular)).toEqual(defaultGuide());
    expect(validateGuide(() => 1)).toEqual(defaultGuide());
    expect(recoverGuide(circular)).toEqual(defaultGuide());
    expect(recoverGuide({ version: 1, goal: "repository" }).goal).toBe(
      "repository",
    );
  });
  it("keeps an unknown guide only when an all-drafts backup carries it unchanged", () => {
    let deep = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(JSON.stringify(deep).length).toBeLessThanOrEqual(GUIDE_LIMIT);
    expect(validateGuide(deep)).toEqual(defaultGuide());
    const secret = { version: 2, session: "x", goal: "audit" };
    expect(validateGuide(secret)).toEqual(defaultGuide());
    expect(validateGuide({ version: 2, nested: { token: "x" } })).toEqual(
      defaultGuide(),
    );
    // The deepest guide a backup still accepts is kept unchanged.
    let edge = 1;
    for (let i = 0; i < 59; i++) edge = [edge];
    expect(validateGuide(edge)).toEqual(edge);
    for (const guide of [deep, secret, edge]) {
      const data = validateWorkspace(workspace(guide));
      const backup = createBackup(data);
      expect(backup.guide).toEqual(data.guide);
      expect(recoverWorkspace(JSON.stringify(workspace(guide))).guide).toEqual(
        data.guide,
      );
    }
  });
  it("counts the Goal only in a version 1 guide", () => {
    expect(guideGoal({ version: 1, goal: "repository" })).toBe("repository");
    expect(guideGoal({ version: 2, goal: "repository" })).toBeNull();
    expect(guideGoal(undefined)).toBeNull();
    expect(guideGoal({ version: 1, goal: ["audit"] })).toBeNull();
    expect(nextStepsEnabled({ version: 1, nextSteps: false })).toBe(false);
  });
  it("replaces any guide only through an explicit choice", () => {
    expect(chooseGoal(undefined, "profile")).toEqual({
      version: 1,
      goal: "profile",
      nextSteps: true,
    });
    expect(
      chooseGoal({ version: 1, goal: "profile", nextSteps: false }, "audit"),
    ).toEqual({ version: 1, goal: "audit", nextSteps: false });
    expect(chooseGoal({ version: 9, nextSteps: false }, "repository")).toEqual({
      version: 1,
      goal: "repository",
      nextSteps: true,
    });
    expect(() => chooseGoal(defaultGuide(), "publish")).toThrow(/known Goal/);
    expect(() => chooseGoal(defaultGuide(), "__proto__")).toThrow();
    expect(() => chooseGoal(defaultGuide(), ["audit"])).toThrow(/known Goal/);
  });
});

describe("guide in the workspace", () => {
  it("adds the default guide to an earlier workspace without changing source", () => {
    const data = workspace();
    const valid = validateWorkspace(data, { preserveIds: true });
    expect(valid.guide).toEqual(defaultGuide());
    expect(valid.drafts[0].markdown).toBe(data.drafts[0].markdown);
    expect(valid.settings).not.toHaveProperty("guide");
  });
  it("round-trips the Goal through browser storage", () => {
    const storage = fakeStorage();
    saveDrafts(
      { ...workspace(), guide: chooseGoal(undefined, "repository") },
      storage,
    );
    expect(readDrafts(storage).guide).toEqual({
      version: 1,
      goal: "repository",
      nextSteps: true,
    });
    const future = { version: 2, goal: "profile" };
    saveDrafts({ ...workspace(), guide: future }, storage);
    expect(readDrafts(storage).guide).toEqual(future);
  });
  it("recovers the guide from damaged storage and leaves the original untouched", () => {
    const data = workspace({ version: 1, goal: "audit", nextSteps: false });
    const raw = JSON.stringify({
      ...data,
      drafts: [...data.drafts, { broken: true }],
      badgeCollections: { version: 1, items: [{ broken: true }] },
    });
    const storage = fakeStorage([[STORAGE_KEY, raw]]);
    let error;
    try {
      readDrafts({
        getItem: storage.getItem,
        setItem: () => {
          throw Error("must not write");
        },
      });
    } catch (e) {
      error = e;
    }
    expect(error.raw).toBe(raw);
    expect(storage.map.get(STORAGE_KEY)).toBe(raw);
    expect(error.recovered.guide).toEqual({
      version: 1,
      goal: "audit",
      nextSteps: false,
    });
    const huge = recoverWorkspace(
      JSON.stringify(
        workspace({ version: 4, filler: "x".repeat(GUIDE_LIMIT * 2) }),
      ),
    );
    expect(huge.guide).toEqual(defaultGuide());
    expect(huge.drafts[0].markdown).toBe(data.drafts[0].markdown);
  });
  it("includes the guide in backups; replace uses the backup's, merge keeps the current one", () => {
    const current = validateWorkspace(
      workspace({ version: 1, goal: "profile", nextSteps: false }),
    );
    const backup = createBackup(
      validateWorkspace(workspace({ version: 1, goal: "audit" })),
    );
    expect(backup.guide).toEqual({
      version: 1,
      goal: "audit",
      nextSteps: true,
    });
    expect(restoreWorkspace(current, backup, "replace").guide.goal).toBe(
      "audit",
    );
    expect(restoreWorkspace(current, backup, "merge").guide).toEqual({
      version: 1,
      goal: "profile",
      nextSteps: false,
    });
    const legacy = createBackup(workspace());
    expect(restoreWorkspace(current, legacy, "replace").guide).toEqual(
      defaultGuide(),
    );
  });
  it("keeps the guide out of portable projects, draft JSON, README export and settings", () => {
    const data = validateWorkspace(
      workspace({ version: 1, goal: "repository", nextSteps: false }),
    );
    const draft = data.drafts[0];
    // Hand over everything the app could: stray fields on the draft, the
    // whole workspace as settings and as embedded libraries.
    const project = JSON.stringify(
      createProject({ ...draft, guide: data.guide }, data, data),
    );
    expect(project).toContain("libraries");
    expect(project).not.toContain('"guide"');
    expect(project).not.toContain('"nextSteps"');
    expect(
      workspaceSettings({ ...data.settings, guide: data.guide }),
    ).not.toHaveProperty("guide");
    expect(JSON.stringify(portableData(draft))).not.toContain("guide");
    expect(draft.markdown).toBe("# Hello\r\n\r\nKeep me exactly.\n");
    expect(draft.markdown).not.toContain("repository");
  });
  it("lists Guided start as a command so it can be reopened", () => {
    expect(commands.find((c) => c.id === "guided-start")).toMatchObject({
      name: "Guided start",
      category: "Create",
    });
  });
});
