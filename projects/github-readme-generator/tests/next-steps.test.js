import { describe, it, expect } from "vitest";
import {
  ARRIVAL_KINDS,
  NEXT_STEP_COMMANDS,
  NETWORK_COMMANDS,
  createArrival,
  documentFacts,
  nextSteps,
  offlineHidden,
  arrivalContext,
  setNextSteps,
  validateGuide,
  nextStepsEnabled,
} from "../src/workspace/guide.js";
import { commands } from "../src/workspace/commands.js";
import { newDraft } from "../src/state/drafts.js";
import { createBlock } from "../src/markdown/serialize.js";

const arrival = (kind, detail) => createArrival("draft-1", kind, detail);
const facts = (extra = {}) => ({
  goal: null,
  online: true,
  storageBlocked: false,
  blockCount: 1,
  singleCustomBlock: true,
  markdownEmpty: false,
  hasTarget: false,
  group: "local",
  hasImportSource: false,
  ...extra,
});
const shown = (list) => list.map((s) => `${s.label} (${s.command})`);

describe("Arrival", () => {
  it("keeps only known detail values and needs a document and a kind", () => {
    expect(
      createArrival("d", "import", {
        mode: "merge",
        origin: "github",
        existing: true,
        extra: "dropped",
      }),
    ).toEqual({
      draftId: "d",
      kind: "import",
      detail: {
        mode: "merge",
        origin: "github",
        existing: true,
        template: null,
      },
    });
    expect(
      createArrival("d", "template", {
        mode: "overwrite",
        origin: "ftp",
        existing: "yes",
        template: "slides",
      }).detail,
    ).toEqual({ mode: "new", origin: null, existing: false, template: null });
    expect(createArrival("d", "blank", null).detail.mode).toBe("new");
    expect(() => createArrival("", "import")).toThrow("needs a document");
    expect(() => createArrival("d", "publish")).toThrow("Unknown Arrival");
    expect(ARRIVAL_KINDS).toEqual(["import", "audit", "template", "blank"]);
  });
});

describe("Next steps rules", () => {
  // The whole rules table, as the author sees it. Order is deterministic;
  // change it only on purpose and update docs/next-steps.md with it.
  it("matches the rules table for every Arrival", () => {
    const table = {
      "template/profile": nextSteps(
        arrival("template", { template: "profile" }),
        facts({ singleCustomBlock: false, blockCount: 6 }),
      ),
      "template/repository without target": nextSteps(
        arrival("template", { template: "repository" }),
        facts({ singleCustomBlock: false, group: "repository" }),
      ),
      "template/repository with target": nextSteps(
        arrival("template", { template: "repository" }),
        facts({ singleCustomBlock: false, hasTarget: true }),
      ),
      "import new, one custom block, no target": nextSteps(
        arrival("import", { mode: "new", origin: "file" }),
        facts(),
      ),
      "import new, one custom block, with target": nextSteps(
        arrival("import", { mode: "new", origin: "github" }),
        facts({ hasTarget: true, hasImportSource: true }),
      ),
      "import replace, one custom block": nextSteps(
        arrival("import", { mode: "replace", origin: "file", existing: true }),
        facts(),
      ),
      "import new, structured blocks, no target": nextSteps(
        arrival("import", { mode: "new", origin: "project" }),
        facts({ singleCustomBlock: false, blockCount: 4 }),
      ),
      "import new, structured blocks, with target": nextSteps(
        arrival("import", { mode: "new", origin: "project" }),
        facts({ singleCustomBlock: false, hasTarget: true }),
      ),
      "import new, empty README": nextSteps(
        arrival("import", { mode: "new", origin: "file" }),
        facts({ markdownEmpty: true }),
      ),
      "import append": nextSteps(
        arrival("import", { mode: "append", existing: true }),
        facts({ singleCustomBlock: false }),
      ),
      "import merge": nextSteps(
        arrival("import", { mode: "merge", origin: "github", existing: true }),
        facts({ hasTarget: true }),
      ),
      "audit with target": nextSteps(
        arrival("audit", { origin: "github" }),
        facts({ hasTarget: true }),
      ),
      "audit without target": nextSteps(arrival("audit"), facts()),
      blank: nextSteps(arrival("blank"), facts({ markdownEmpty: true })),
    };
    expect(
      Object.fromEntries(
        Object.entries(table).map(([name, list]) => [name, shown(list)]),
      ),
    ).toEqual({
      "template/profile": [
        "Edit your sections (sections)",
        "Autofill from GitHub (profile)",
        "Preview README (show-preview)",
      ],
      "template/repository without target": [
        "Replace writing prompts (sections)",
        "README Health (show-health)",
        "Set repository target (documents)",
      ],
      "template/repository with target": [
        "Replace writing prompts (sections)",
        "README Health (show-health)",
        "Preview README (show-preview)",
      ],
      "import new, one custom block, no target": [
        "Split into sections (split)",
        "README Health (show-health)",
        "Preview README (show-preview)",
      ],
      "import new, one custom block, with target": [
        "Split into sections (split)",
        "README Health (show-health)",
        "Drift check (drift-check)",
      ],
      "import replace, one custom block": [
        "Split into sections (split)",
        "README Health (show-health)",
        "Preview README (show-preview)",
      ],
      "import new, structured blocks, no target": [
        "Preview README (show-preview)",
        "README Health (show-health)",
        "Compatibility Lab (compatibility)",
      ],
      "import new, structured blocks, with target": [
        "Preview README (show-preview)",
        "README Health (show-health)",
        "Drift check (drift-check)",
      ],
      "import new, empty README": [
        "Preview README (show-preview)",
        "README Health (show-health)",
        "Compatibility Lab (compatibility)",
      ],
      "import append": [
        "Preview README (show-preview)",
        "README Health (show-health)",
        "Compatibility Lab (compatibility)",
      ],
      "import merge": [
        "Preview README (show-preview)",
        "README Health (show-health)",
        "Compatibility Lab (compatibility)",
      ],
      "audit with target": [
        "README Health (show-health)",
        "Drift check (drift-check)",
        "README Attention Queue (readme-attention)",
      ],
      "audit without target": [
        "README Health (show-health)",
        "README Attention Queue (readme-attention)",
      ],
      blank: [
        "Add a section (library)",
        "Start from a template (templates)",
        "Import existing README (import)",
      ],
    });
    for (const list of Object.values(table))
      for (const step of list) expect(step.reason.length).toBeGreaterThan(10);
  });

  it("picks the template row from the Arrival, then the document, then the Goal", () => {
    const first = (a, f) => nextSteps(a, facts(f))[0].label;
    expect(first(arrival("template"), { group: "repository" })).toBe(
      "Replace writing prompts",
    );
    expect(first(arrival("template"), { group: "profile" })).toBe(
      "Edit your sections",
    );
    expect(first(arrival("template"), { goal: "repository" })).toBe(
      "Replace writing prompts",
    );
    expect(first(arrival("template"), { goal: "audit" })).toBe(
      "Edit your sections",
    );
    expect(
      first(arrival("template", { template: "profile" }), {
        group: "repository",
      }),
    ).toBe("Edit your sections");
  });

  it("returns nothing without a known Arrival", () => {
    expect(nextSteps(null, facts())).toEqual([]);
    expect(nextSteps(undefined)).toEqual([]);
    expect(nextSteps({ draftId: "d", kind: "publish" }, facts())).toEqual([]);
    expect(arrivalContext(null)).toBe("");
  });

  it("hides GitHub steps offline and says so only when something was hidden", () => {
    const offline = facts({ online: false, hasTarget: true });
    expect(shown(nextSteps(arrival("audit"), offline))).toEqual([
      "README Health (show-health)",
    ]);
    expect(offlineHidden(arrival("audit"), offline)).toBe(true);
    expect(
      shown(nextSteps(arrival("template", { template: "profile" }), offline)),
    ).toEqual([
      "Edit your sections (sections)",
      "Preview README (show-preview)",
    ]);
    expect(shown(nextSteps(arrival("import"), offline)).map((s) => s)).toEqual([
      "Split into sections (split)",
      "README Health (show-health)",
    ]);
    expect(offlineHidden(arrival("blank"), offline)).toBe(false);
    expect(offlineHidden(arrival("audit"), facts({ hasTarget: true }))).toBe(
      false,
    );
    // Online is the default when the fact is missing.
    expect(nextSteps(arrival("audit"), { hasTarget: true })).toHaveLength(3);
  });

  it("offers an export last when storage is blocked", () => {
    const list = nextSteps(
      arrival("template", { template: "profile" }),
      facts({ storageBlocked: true }),
    );
    expect(shown(list)).toEqual([
      "Edit your sections (sections)",
      "Autofill from GitHub (profile)",
      "Export README (download)",
    ]);
    expect(
      shown(
        nextSteps(
          arrival("audit"),
          facts({ storageBlocked: true, online: false }),
        ),
      ),
    ).toEqual(["README Health (show-health)", "Export README (download)"]);
  });

  it("never offers a write, publish or unknown command for any input", () => {
    const known = new Set([
      ...commands.map((c) => c.id),
      "show-health",
      "show-preview",
      "split",
      "download",
      "sections",
      "library",
    ]);
    const writes = [
      "publish-github",
      "backup-all",
      "restore",
      "copy",
      "undo",
      "redo",
      "batch-review",
      "cross-readme-updates",
      "refactors",
      "writing-assistant",
      "save-project",
      "workflows",
    ];
    for (const command of NEXT_STEP_COMMANDS) {
      expect(known.has(command), command).toBe(true);
      expect(writes).not.toContain(command);
    }
    for (const command of NETWORK_COMMANDS)
      expect(
        commands.some((c) => c.id === command),
        command,
      ).toBe(true);
    // Every combination of Arrival and facts, checked without per-case
    // expect calls so the sweep stays fast; problems are listed together.
    const values = {
      kind: [...ARRIVAL_KINDS, "unknown"],
      mode: ["new", "replace", "append", "merge", "bogus"],
      origin: ["github", "file", "project", undefined],
      template: ["profile", "repository", undefined],
      online: [true, false],
      storageBlocked: [true, false],
      hasTarget: [true, false],
      singleCustomBlock: [true, false],
      markdownEmpty: [true, false],
      goal: [null, "profile", "repository", "audit"],
    };
    let cases = [{}];
    for (const [key, options] of Object.entries(values))
      cases = cases.flatMap((c) => options.map((v) => ({ ...c, [key]: v })));
    const problems = [];
    for (const c of cases) {
      const { kind, mode, origin, template, ...rest } = c;
      const list = nextSteps(
        { draftId: "d", kind, detail: { mode, origin, template } },
        facts(rest),
      );
      const ids = list.map((s) => s.command);
      if (
        list.length > 3 ||
        new Set(ids).size !== ids.length ||
        (kind === "unknown" ? list.length : !list.length) ||
        ids.some(
          (id) =>
            !NEXT_STEP_COMMANDS.includes(id) ||
            writes.includes(id) ||
            (!c.online && NETWORK_COMMANDS.includes(id)),
        )
      )
        problems.push({ ...c, ids });
    }
    expect(cases.length).toBeGreaterThan(10000);
    expect(problems).toEqual([]);
  });

  it("is deterministic and does not mutate its inputs", () => {
    const a = arrival("import", { mode: "new", origin: "github" }),
      f = facts({ hasTarget: true });
    const before = JSON.stringify([a, f]);
    expect(nextSteps(a, f)).toEqual(nextSteps(a, f));
    expect(JSON.stringify([a, f])).toBe(before);
  });
});

describe("Arrival context", () => {
  it("says what happened and that nothing changed remotely", () => {
    expect(arrivalContext(arrival("import", { origin: "github" }))).toBe(
      "Imported into a new local draft. Nothing changed on GitHub.",
    );
    expect(arrivalContext(arrival("import", { origin: "file" }))).toBe(
      "Imported into a new local draft. The file is unchanged.",
    );
    expect(
      arrivalContext(arrival("import", { mode: "merge", origin: "github" })),
    ).toBe(
      "Merged the import into this draft. Undo restores the previous version. Nothing changed on GitHub.",
    );
    expect(
      arrivalContext(arrival("import", { mode: "replace", origin: "file" })),
    ).toContain("Replaced this draft with the import. Undo restores");
    expect(
      arrivalContext(arrival("import", { mode: "append", origin: "file" })),
    ).toContain("Appended the import");
    expect(arrivalContext(arrival("import", { origin: "project" }))).toContain(
      "Studio project opened as a new local draft",
    );
    expect(arrivalContext(arrival("audit", { existing: true }))).toContain(
      "Local edits were kept",
    );
    expect(arrivalContext(arrival("audit"))).toContain(
      "Nothing changed on GitHub",
    );
    expect(arrivalContext(arrival("template"))).toContain("from a template");
    expect(arrivalContext(arrival("blank"))).toBe(
      "Started a blank local draft.",
    );
  });
});

describe("document facts", () => {
  it("reads block shape, target and import source cheaply", () => {
    const imported = newDraft("Imported", [
      createBlock("custom", { markdown: "# Tool\n\nText.\n" }),
    ]);
    imported.metadata = {
      importSource: {
        type: "github",
        owner: "ada",
        repository: "tools",
        ref: "main",
        readmePath: "README.md",
      },
    };
    expect(documentFacts(imported)).toEqual({
      blockCount: 1,
      singleCustomBlock: true,
      markdownEmpty: false,
      hasTarget: true,
      group: "repository",
      hasImportSource: true,
    });
    const blank = newDraft("Blank", []);
    blank.metadata = {
      workspaceDocument: { version: 1, kind: "profile", target: null },
    };
    expect(documentFacts(blank)).toEqual({
      blockCount: 0,
      singleCustomBlock: false,
      markdownEmpty: true,
      hasTarget: false,
      group: "profile",
      hasImportSource: false,
    });
    expect(documentFacts(undefined)).toMatchObject({
      blockCount: 0,
      markdownEmpty: true,
      hasTarget: false,
      group: "local",
    });
  });
});

describe("Next steps preference", () => {
  it("is an explicit choice that keeps a known Goal", () => {
    expect(setNextSteps(validateGuide(undefined), false)).toEqual({
      version: 1,
      goal: null,
      nextSteps: false,
    });
    expect(
      setNextSteps({ version: 1, goal: "audit", nextSteps: false }, true),
    ).toEqual({ version: 1, goal: "audit", nextSteps: true });
    // A guide of an unknown version is replaced only by this explicit choice.
    const future = { version: 2, goal: "teams", nextSteps: "sometimes" };
    expect(nextStepsEnabled(future)).toBe(true);
    expect(setNextSteps(future, false)).toEqual({
      version: 1,
      goal: null,
      nextSteps: false,
    });
    expect(setNextSteps(undefined, "yes").nextSteps).toBe(false);
  });
});
