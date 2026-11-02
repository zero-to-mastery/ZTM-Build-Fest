import { describe, expect, it } from "vitest";
import {
  AUDIT_DECISIONS_KEY,
  AuditDecisions,
  applyAuditDecisions,
} from "../src/repository-audit/audit-decisions-storage.js";
import { ATTENTION_KEY } from "../src/repository-audit/attention-storage.js";

const now = Date.parse("2026-09-28T12:00:00Z");
const first = `sha:${"a".repeat(40)}`;
const second = `sha:${"b".repeat(40)}`;

function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key) => values.get(key) ?? null,
  };
}

describe("persistent audit decisions", () => {
  it("converts valid legacy attention in memory and leaves its bytes untouched", () => {
    const legacy = JSON.stringify({
      version: 1,
      entries: [
        {
          repository: "Example/Tool",
          kind: "ignore",
          revision: "",
          until: now + 7 * 86400000,
        },
      ],
    });
    const storage = memory({ [ATTENTION_KEY]: legacy });
    const decisions = new AuditDecisions(() => storage);

    expect(decisions.entries).toEqual([
      {
        repository: "example/tool",
        kind: "ignore",
        revision: "",
        until: now + 7 * 86400000,
      },
    ]);
    expect(storage.value(AUDIT_DECISIONS_KEY)).toBeNull();

    decisions.setProjectType("Example/Tool", "cli", first);

    expect(storage.value(ATTENTION_KEY)).toBe(legacy);
    expect(JSON.parse(storage.value(AUDIT_DECISIONS_KEY))).toEqual({
      version: 1,
      repositories: [
        {
          repository: "example/tool",
          attention: {
            kind: "ignore",
            revision: "",
            until: now + 7 * 86400000,
          },
          projectType: { id: "cli", observedRevision: first },
          dismissals: [],
        },
      ],
    });
  });

  it("persists and explicitly restores dismissals", () => {
    const storage = memory();
    const decisions = new AuditDecisions(() => storage);
    decisions.setDismissal("Example/Tool", "topic:setup", first);

    const reloaded = new AuditDecisions(() => storage);
    expect(reloaded.dismissals("example/tool")).toEqual(
      new Map([["topic:setup", first]]),
    );
    reloaded.removeDismissal("example/tool", "topic:setup");
    expect(
      new AuditDecisions(() => storage).dismissals("example/tool"),
    ).toEqual(new Map());
  });

  it("keeps project types across revisions while dismissals remain revision-bound", () => {
    const storage = memory();
    const decisions = new AuditDecisions(() => storage);
    decisions.setProjectType("example/tool", "cli", first);
    decisions.setDismissal("example/tool", "topic:setup", first);
    const state = { typeOverrides: new Map(), dismissed: new Map() };

    expect(
      applyAuditDecisions(state, decisions, "Example/Tool", second),
    ).toEqual({ id: "cli", observedRevision: first });
    expect(state.typeOverrides.get("example/tool")).toBe("cli");
    expect(state.dismissed.get("example/tool")).toEqual(
      new Map([["topic:setup", first]]),
    );
  });

  it("resets repo audit choices without changing its attention preference", () => {
    const storage = memory();
    const decisions = new AuditDecisions(() => storage);
    decisions.set("example/tool", "minimal", first, now);
    decisions.setProjectType("example/tool", "cli", first);
    decisions.setDismissal("example/tool", "topic:setup", first);

    decisions.resetAudit("example/tool");

    const reloaded = new AuditDecisions(() => storage);
    expect(reloaded.projectType("example/tool")).toBeNull();
    expect(reloaded.dismissals("example/tool")).toEqual(new Map());
    expect(reloaded.entries).toEqual([
      {
        repository: "example/tool",
        kind: "minimal",
        revision: first,
        until: 0,
      },
    ]);
  });

  it("returns a project type to automatic without restoring dismissals", () => {
    const storage = memory();
    const decisions = new AuditDecisions(() => storage);
    decisions.setProjectType("example/tool", "cli", first);
    decisions.setDismissal("example/tool", "topic:setup", first);

    decisions.resetProjectType("example/tool");

    expect(decisions.projectType("example/tool")).toBeNull();
    expect(decisions.dismissals("example/tool")).toEqual(
      new Map([["topic:setup", first]]),
    );
  });

  it("blocks writes for damaged new or legacy data until explicit reset", () => {
    for (const key of [AUDIT_DECISIONS_KEY, ATTENTION_KEY]) {
      const storage = memory({ [key]: "damaged" });
      const decisions = new AuditDecisions(() => storage);
      expect(decisions.error).toContain("untouched");
      expect(() =>
        decisions.setProjectType("example/tool", "cli", first),
      ).toThrow();
      expect(storage.value(key)).toBe("damaged");

      decisions.reset();
      if (key === ATTENTION_KEY) expect(storage.value(key)).toBe("damaged");
      expect(JSON.parse(storage.value(AUDIT_DECISIONS_KEY))).toEqual({
        version: 1,
        repositories: [],
      });
      expect(decisions.error).toBe("");
    }
  });

  it("does not apply a decision when browser storage rejects its write", () => {
    const storage = memory();
    storage.setItem = () => {
      throw Error("quota");
    };
    const decisions = new AuditDecisions(() => storage);
    expect(() =>
      decisions.setProjectType("example/tool", "cli", first),
    ).toThrow("not applied");
    expect(decisions.projectType("example/tool")).toBeNull();
  });
});
