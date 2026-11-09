import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  markdownTables,
  parseScenarios,
  scenarioBudget,
  parseFindings,
  validateFindings,
  testReferences,
  SECTIONS,
} from "../scripts/usability-docs.mjs";
import {
  sectionMarkdown,
  unsavedSection,
  unsavedSectionPrompt,
  UNSAVED_SECTION_ACTIONS,
} from "../src/workspace/unsaved-section.js";
import { createBlock } from "../src/markdown/serialize.js";
import {
  restoreWorkspace,
  restoreNotice,
  validateWorkspace,
} from "../src/state/workspace-backup.js";

// Paths are relative to the repository root, where the tests run.
const read = (path) => readFileSync(path, "utf8");
const scenarioTable = (rows) =>
  [
    "| ID | Audience | Start state | Success criterion | Step budget |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
const n1 = "| N1 | Novice | First visit. | Exported. | 8 |";
const e1 = "| E1 | Experienced | Saved workspace. | Badge added. | 33 |";
const header =
  "| ID | Scenario | Step | Audience | Found by | Severity | Status | Fix PR/test |\n| --- | --- | --- | --- | --- | --- | --- | --- |";
const tracker = ({ scripted = [], heuristic = [], participants = null }) =>
  [
    "# Usability findings",
    "## Scripted run baseline (automated)",
    header,
    ...scripted,
    "",
    "## Heuristic walkthrough (implementer, not user evidence)",
    header,
    ...heuristic,
    "",
    "## Participant sessions",
    participants ? `${header}\n${participants.join("\n")}` : "None recorded.",
  ].join("\n");
const scenarios = parseScenarios(scenarioTable([n1, e1]));

describe("usability scenario table", () => {
  it("reads every scenario with its audience, states and budget", () => {
    expect(scenarios).toEqual([
      {
        id: "N1",
        audience: "Novice",
        start: "First visit.",
        success: "Exported.",
        budget: 8,
      },
      {
        id: "E1",
        audience: "Experienced",
        start: "Saved workspace.",
        success: "Badge added.",
        budget: 33,
      },
    ]);
    expect(scenarioBudget(scenarios, "E1")).toBe(33);
    expect(() => scenarioBudget(scenarios, "N9")).toThrow(
      "Scenario N9 is not documented.",
    );
  });

  it("keeps tables apart and records the section each is under", () => {
    const tables = markdownTables(
      "## One\n\n| A | B |\n| - | - |\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n## Two\n\n| C |\n| --- |\n| 3 |",
    );
    expect(tables.map((t) => [t.section, t.rows])).toEqual([
      ["One", []],
      ["One", [{ a: "1", b: "2" }]],
      ["Two", [{ c: "3" }]],
    ]);
  });

  it("fails loudly on a missing table, a wrong audience, a bad budget or a duplicate", () => {
    expect(() => parseScenarios("# No table")).toThrow(
      "No scenario table with a Step budget column.",
    );
    expect(() => parseScenarios(scenarioTable([]))).toThrow(
      "The scenario table is empty.",
    );
    let error;
    try {
      parseScenarios(
        scenarioTable([
          "| N1 | Experienced | First visit. | Exported. | 0 |",
          "| N1 | Novice | | Exported. | 8 |",
          "| X1 | Novice | Start. | Done. | 2.5 |",
        ]),
      );
    } catch (e) {
      error = e.message;
    }
    expect(error.split("\n")).toEqual([
      "Scenario N1 must be Novice.",
      "Scenario N1 needs a whole-number step budget.",
      "Scenario N1 is listed twice.",
      "Scenario N1 has no start state.",
      'Scenario ID "X1" is invalid.',
      "Scenario X1 must be known.",
      "Scenario X1 needs a whole-number step budget.",
    ]);
  });
});

describe("Friction tracker", () => {
  const fixed =
    "| F1 | N1 | 7 · Export | Novice | Scripted run | 1 | Fixed | #76 · `tests/browser/usability-fixes.spec.js` |";
  const open =
    "| F2 | E1 | 8 · Tab | Experienced | Heuristic walkthrough | 3 | Open | |";

  it("reads findings with their section and accepts a consistent tracker", () => {
    const parsed = parseFindings(
      tracker({ scripted: [fixed], heuristic: [open] }),
    );
    expect(parsed.participantSessionsRecorded).toBe(false);
    expect(parsed.findings).toEqual([
      {
        id: "F1",
        scenario: "N1",
        step: "7 · Export",
        audience: "Novice",
        foundBy: "Scripted run",
        severity: 1,
        status: "Fixed",
        fix: "#76 · `tests/browser/usability-fixes.spec.js`",
        section: "Scripted run baseline (automated)",
      },
      {
        id: "F2",
        scenario: "E1",
        step: "8 · Tab",
        audience: "Experienced",
        foundBy: "Heuristic walkthrough",
        severity: 3,
        status: "Open",
        fix: "",
        section: "Heuristic walkthrough (implementer, not user evidence)",
      },
    ]);
    expect(validateFindings(parsed, scenarios)).toEqual([]);
  });

  it("requires all three sections", () => {
    expect(() =>
      parseFindings("## Scripted run baseline (automated)\n"),
    ).toThrow(
      "Missing tracker sections: Heuristic walkthrough (implementer, not user evidence), Participant sessions.",
    );
  });

  it("never lets automated or implementer findings pass as participant results", () => {
    const asParticipant =
      "| F3 | N1 | 2 · Template | Novice | Participant session | 3 | Open | |";
    expect(
      validateFindings(
        parseFindings(tracker({ scripted: [asParticipant] })),
        scenarios,
      ),
    ).toEqual([
      'F3 (Participant session) is filed under "Scripted run baseline (automated)".',
      'Participant sessions say "None recorded" but list findings.',
    ]);
    const mislabelled =
      "| F4 | N1 | 2 · Template | Novice | Scripted run | 3 | Open | |";
    expect(
      validateFindings(
        parseFindings(tracker({ participants: [mislabelled] })),
        scenarios,
      ),
    ).toEqual(['F4 (Scripted run) is filed under "Participant sessions".']);
  });

  it("reports findings tables under any other heading instead of skipping them", () => {
    const extra = [
      "## Session notes",
      header,
      "| F9 | N1 | 1 · Start | Novice | Participant session | 1 | Open | |",
      "| F10 | N1 | 2 · Template | Novice | Scripted run | 1 | Open | |",
      "",
    ].join("\n");
    const text = tracker({ scripted: [fixed] }).replace(
      "## Participant sessions",
      `${extra}\n## Participant sessions`,
    );
    const parsed = parseFindings(text);
    expect(parsed.findings.map((f) => [f.id, f.section])).toEqual([
      ["F1", "Scripted run baseline (automated)"],
      ["F9", "Session notes"],
      ["F10", "Session notes"],
    ]);
    expect(validateFindings(parsed, scenarios)).toEqual([
      'F9 (Participant session) is filed under "Session notes".',
      'F10 (Scripted run) is filed under "Session notes".',
      "F10 is severity 1 and still open.",
      'Participant sessions say "None recorded" but list findings.',
    ]);
    // A table before the first section heading is reported too.
    const top = parseFindings(
      `${header}\n| F11 | N1 | 1 · Start | Novice | Scripted run | 3 | Open | |\n\n${tracker({})}`,
    );
    expect(validateFindings(top, scenarios)).toEqual([
      'F11 (Scripted run) is filed under "no section".',
    ]);
  });

  it("accepts real participant rows once sessions are recorded, open at any severity", () => {
    const participant =
      "| F5 | E1 | 4 · Palette | Experienced | Participant session | 1 | Open | |";
    const parsed = parseFindings(tracker({ participants: [participant] }));
    expect(parsed.participantSessionsRecorded).toBe(true);
    expect(validateFindings(parsed, scenarios)).toEqual([]);
  });

  it("rejects open severity 1-2 items, fixes without tests and malformed rows", () => {
    const rows = [
      "| F1 | N1 | 7 · Export | Novice | Scripted run | 2 | Open | |",
      "| F1 | E1 | 1 · Palette | Novice | Scripted run | 3 | Fixed | #76 |",
      "| G7 | N9 | | Novice | Guess | 5 | Done | |",
    ];
    expect(
      validateFindings(parseFindings(tracker({ scripted: rows })), scenarios),
    ).toEqual([
      "F1 is severity 2 and still open.",
      "Finding F1 is listed twice.",
      "F1 audience must match E1.",
      "F1 is Fixed but links no regression test.",
      'Finding ID "G7" is invalid.',
      'G7 names unknown scenario "N9".',
      "G7 names no step.",
      'G7 has unknown "found by" "Guess".',
      "G7 needs a severity from 1 to 4.",
      'G7 has unknown status "Done".',
    ]);
  });

  it("finds test references written as tests/ paths", () => {
    expect(
      testReferences(
        "#76 · `tests/usability.test.js`, `tests/browser/a.spec.js`, `src/x.js`",
      ),
    ).toEqual(["tests/usability.test.js", "tests/browser/a.spec.js"]);
  });
});

describe("the committed usability docs", () => {
  const documented = parseScenarios(read("docs/usability-scripts.md"));
  const tracked = parseFindings(read("docs/usability-findings.md"));

  it("document N1-N4 and E1-E3, each with a Scripted run", () => {
    expect(documented.map((s) => s.id)).toEqual([
      "N1",
      "N2",
      "N3",
      "N4",
      "E1",
      "E2",
      "E3",
    ]);
    const spec = read("tests/browser/usability-scenarios.spec.js");
    for (const { id } of documented)
      expect(spec).toContain(`scenario(\n  "${id}",`);
  });

  it("keep the tracker consistent, with every linked regression test present", () => {
    expect(validateFindings(tracked, documented)).toEqual([]);
    for (const finding of tracked.findings)
      for (const path of testReferences(finding.fix))
        expect(existsSync(path), path).toBe(true);
    expect(Object.keys(SECTIONS)).toHaveLength(3);
  });

  it("record no Participant sessions that have not happened", () => {
    expect(tracked.participantSessionsRecorded).toBe(false);
    expect(
      tracked.findings.filter((f) => f.foundBy === "Participant session"),
    ).toEqual([]);
  });
});

describe("unsaved section edits (F1)", () => {
  const hero = createBlock("hero", { name: "Your Name", subtitle: "Hi" });

  it("counts only edits that change the section's Markdown", () => {
    const opened = sectionMarkdown(hero);
    expect(opened).toBe("# Your Name\n\nHi");
    expect(unsavedSection(opened, structuredClone(hero))).toBe(false);
    const renamed = structuredClone(hero);
    renamed.settings.name = "Ada Example";
    expect(unsavedSection(opened, renamed)).toBe(true);
    // A settings change that produces the same Markdown leaves nothing out.
    const same = structuredClone(hero);
    same.settings.unused = "x";
    expect(unsavedSection(opened, same)).toBe(false);
  });

  it("treats fields that cannot produce Markdown as unsaved, not as a crash", () => {
    const broken = { type: "hero", settings: null };
    expect(sectionMarkdown(broken)).toBeNull();
    expect(unsavedSection(sectionMarkdown(hero), broken)).toBe(true);
    expect(unsavedSection(null, broken)).toBe(false);
  });

  it("words the question for export, copy and a section not added yet", () => {
    expect(unsavedSectionPrompt("download", { title: "Hero" })).toEqual({
      heading: "Save your section edits first?",
      body: "The Hero section has edits that are not in your README yet. Export README uses only saved sections.",
      save: "Save section and export",
      skip: "Export without these edits",
      keep: "Keep editing",
      closed:
        "The section form closed before its edits were saved, so nothing was saved and Export README did not run. Open the section again to redo the edits.",
    });
    expect(
      unsavedSectionPrompt("copy", { title: "Badge", added: false }),
    ).toMatchObject({
      body: "The Badge section has edits that are not in your README yet. Copy Markdown uses only saved sections.",
      save: "Add section and copy",
      skip: "Copy without these edits",
    });
    expect(unsavedSectionPrompt("unknown").body).toMatch(
      /^This section has edits.*Export README/,
    );
  });

  it("asks before every download of the saved Source, not only Export README", () => {
    expect(UNSAVED_SECTION_ACTIONS).toEqual([
      "download",
      "copy",
      "save-project",
      "backup-all",
      "backup",
    ]);
    expect(
      unsavedSectionPrompt("save-project", { title: "Hero" }),
    ).toMatchObject({
      body: "The Hero section has edits that are not in your README yet. Save Studio project uses only saved sections.",
      save: "Save section and continue",
      skip: "Continue without these edits",
    });
    expect(unsavedSectionPrompt("backup-all", { title: "Hero" })).toMatchObject(
      {
        body: "The Hero section has edits that are not in your README yet. Download all drafts backup uses only saved sections.",
        save: "Save section and download",
        skip: "Download without these edits",
      },
    );
    expect(unsavedSectionPrompt("backup").body).toContain(
      "Download draft backup uses only saved sections.",
    );
  });

  it("offers no save choice when the fields cannot be saved", () => {
    expect(
      unsavedSectionPrompt("download", {
        title: "Badge",
        added: false,
        valid: false,
      }),
    ).toMatchObject({
      body: "The Badge section has edits that are not in your README yet. Export README uses only saved sections. Some of its fields need fixing before it can be saved.",
      save: null,
      skip: "Export without these edits",
      keep: "Keep editing",
    });
  });
});

describe("merge restore (F2)", () => {
  const current = validateWorkspace({
    version: 1,
    drafts: [{ name: "Mine", markdown: "# Mine\n", blocks: [] }],
  });
  const backup = {
    version: 1,
    drafts: [
      { id: "a", name: "Notes", markdown: "# Notes\n", blocks: [] },
      { id: "b", name: "Mine", markdown: "# Kept\n", blocks: [] },
    ],
    active: "b",
  };

  it("names the opened draft in the notice, also when evidence snapshots overflow", () => {
    expect(restoreNotice({ mode: "merge", opened: "Kept safe" })).toBe(
      "Workspace backup restored. Opened Kept safe; your other drafts are still under Current draft.",
    );
    expect(
      restoreNotice({ mode: "merge", opened: "Kept safe", notRestored: 3 }),
    ).toBe(
      "Workspace backup restored. Opened Kept safe; your other drafts are still under Current draft. Local evidence snapshots were kept; 3 incoming evidence snapshot(s) did not fit the 100-snapshot workspace limit and remain only in the backup file.",
    );
    expect(restoreNotice({ mode: "replace", opened: "Kept safe" })).toBe(
      "Workspace backup restored.",
    );
  });

  it("opens the backup's active draft and keeps every local draft", () => {
    const merged = restoreWorkspace(current, backup, "merge");
    expect(merged.drafts.map((d) => d.name)).toEqual([
      "Mine",
      "Notes",
      "Mine (2)",
    ]);
    expect(merged.drafts.find((d) => d.id === merged.active).markdown).toBe(
      "# Kept\n",
    );
    expect(merged.drafts[0]).toEqual(current.drafts[0]);
    // The current workspace object is not changed.
    expect(current.active).toBe(current.drafts[0].id);
  });

  it("opens the backup's first draft when it names no active draft, and still rejects bad backups", () => {
    const merged = restoreWorkspace(
      current,
      { ...backup, active: "missing" },
      "merge",
    );
    expect(merged.drafts.find((d) => d.id === merged.active).name).toBe(
      "Notes",
    );
    expect(() =>
      restoreWorkspace(current, { version: 2, drafts: [] }, "merge"),
    ).toThrow("Unsupported workspace backup version");
    expect(() => restoreWorkspace(current, backup, "other")).toThrow(
      "Choose replace or merge.",
    );
  });
});
