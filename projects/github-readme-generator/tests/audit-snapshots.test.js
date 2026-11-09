import { describe, expect, it } from "vitest";
import {
  AUDIT_SNAPSHOTS_KEY,
  AuditSnapshots,
  compareAuditSnapshots,
  createAuditSnapshot,
} from "../src/repository-audit/audit-snapshots.js";

const sha = (letter) => `sha:${letter.repeat(40)}`;
const record = (
  name,
  revision = sha("a"),
  findings = ["placeholder:todo"],
  checkedAt = 100,
) => ({
  repo: { full_name: `Example/${name}` },
  checkedAt,
  readme: { sha: revision.slice(4) },
  result: {
    state: "basic",
    suggestion: { id: "generic" },
    findings: findings.map((id) => ({ id, message: id })),
  },
});
const memory = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key) => values.get(key),
  };
};

describe("audit snapshots", () => {
  it("captures only identities from successful on-screen audit results", () => {
    const snapshot = createAuditSnapshot({
      account: "Example",
      capturedAt: 200,
      records: [
        record("Tool"),
        { repo: { full_name: "Example/Failed" }, error: "no" },
      ],
      typeOverrides: new Map([["example/tool", "cli"]]),
    });
    expect(snapshot).toMatchObject({
      account: "example",
      capturedAt: 200,
      auditRules: 1,
      planRules: 1,
      repositories: [
        {
          repository: "example/tool",
          revision: sha("a"),
          observedAt: 100,
          state: "basic",
          projectType: "cli",
          manualType: true,
          historyChecked: false,
          linksChecked: false,
        },
      ],
    });
    expect(snapshot.repositories[0].findings).toContainEqual({
      id: "placeholder:todo",
    });
    expect(JSON.stringify(snapshot)).not.toContain("message");
  });

  it("reports changes only for comparable fresh observations", () => {
    const before = createAuditSnapshot({
      account: "example",
      capturedAt: 200,
      records: [record("tool", sha("a"), ["placeholder:todo"])],
    });
    const after = createAuditSnapshot({
      account: "example",
      capturedAt: 300,
      records: [record("tool", sha("b"), ["starter:vite"], 250)],
    });
    expect(compareAuditSnapshots(before, after)).toMatchObject({
      added: [{ repository: "example/tool", id: "starter:vite" }],
      resolved: [{ repository: "example/tool", id: "placeholder:todo" }],
      unknown: [],
    });

    after.repositories[0].observedAt = 100;
    expect(compareAuditSnapshots(before, after).unknown[0].reason).toContain(
      "not re-read",
    );

    after.repositories[0].observedAt = 250;
    after.auditRules = 2;
    expect(compareAuditSnapshots(before, after).unknown[0].reason).toContain(
      "rules changed",
    );
  });

  it("marks partial link evidence unknown instead of claiming a change", () => {
    const before = createAuditSnapshot({
      account: "example",
      capturedAt: 200,
      records: [record("tool", sha("a"), [], 100)],
    });
    const laterRecord = record("tool", sha("b"), [], 250);
    laterRecord.review = {
      historyChecked: true,
      linksChecked: true,
      findings: [
        {
          id: "link:unavailable:abc",
          message: "unavailable",
          url: "https://example.test/missing",
        },
      ],
    };
    const after = createAuditSnapshot({
      account: "example",
      capturedAt: 300,
      records: [laterRecord],
    });
    expect(compareAuditSnapshots(before, after)).toMatchObject({
      added: [],
      resolved: [],
      unknown: [
        {
          repository: "example/tool",
          id: "link:unavailable:abc",
          reason: "Links were not checked in both snapshots.",
        },
      ],
    });
  });

  it("does not resolve a link that moved beyond capped later coverage", () => {
    const earlierRecord = record("tool", sha("a"), [], 100);
    earlierRecord.review = {
      historyChecked: true,
      linksChecked: true,
      findings: [
        {
          id: "link:unavailable:abc",
          message: "unavailable",
          url: "https://example.test/moved-beyond-cap",
        },
      ],
    };
    const laterRecord = record("tool", sha("b"), [], 250);
    laterRecord.review = {
      historyChecked: true,
      linksChecked: false,
      findings: [],
    };
    const before = createAuditSnapshot({
      account: "example",
      capturedAt: 200,
      records: [earlierRecord],
    });
    const after = createAuditSnapshot({
      account: "example",
      capturedAt: 300,
      records: [laterRecord],
    });
    expect(compareAuditSnapshots(before, after)).toMatchObject({
      added: [],
      resolved: [],
      unknown: [
        {
          repository: "example/tool",
          id: "link:unavailable:abc",
          reason: "Links were not checked in both snapshots.",
        },
      ],
    });
  });

  it("records plan identities and distinguishes history from link coverage", () => {
    const audited = record("tool", sha("a"), []);
    audited.result.state = "minimal";
    audited.result.metrics = {
      meaningfulWords: 10,
      headings: 1,
      topicHeadings: 0,
      setup: false,
      usage: false,
    };
    audited.result.evidence = ["README is short"];
    audited.review = {
      historyChecked: true,
      linksChecked: false,
      findings: [
        { id: "history:activity-after-readme", message: "history" },
        {
          id: "link:unavailable:abc",
          message: "link",
          url: "https://example.test/missing",
        },
      ],
    };
    const [repository] = createAuditSnapshot({
      account: "example",
      records: [audited],
    }).repositories;
    expect(repository).toMatchObject({
      historyChecked: true,
      linksChecked: false,
    });
    expect(repository.findings).toEqual(
      expect.arrayContaining([
        { id: "readme:thin" },
        { id: "history:activity-after-readme" },
        {
          id: "link:unavailable:abc",
          url: "https://example.test/missing",
        },
      ]),
    );
  });

  it("keeps five snapshots per account without evicting another account", () => {
    const storage = memory();
    const snapshots = new AuditSnapshots(() => storage);
    for (let i = 0; i < 6; i++)
      snapshots.save(
        createAuditSnapshot({
          account: "example",
          capturedAt: i + 1,
          records: [],
        }),
      );
    snapshots.save(
      createAuditSnapshot({ account: "other", capturedAt: 20, records: [] }),
    );
    expect(
      snapshots.items.filter((item) => item.account === "example"),
    ).toHaveLength(5);
    expect(snapshots.items.some((item) => item.account === "other")).toBe(true);
    expect(JSON.parse(storage.value(AUDIT_SNAPSHOTS_KEY)).version).toBe(1);
  });

  it("deletes explicitly and preserves damaged storage until reset", () => {
    const storage = memory();
    const snapshots = new AuditSnapshots(() => storage);
    const saved = snapshots.save(
      createAuditSnapshot({ account: "example", capturedAt: 1, records: [] }),
    ).snapshot;
    snapshots.remove(saved.id);
    expect(snapshots.items).toEqual([]);

    storage.setItem(AUDIT_SNAPSHOTS_KEY, "not json");
    const damaged = new AuditSnapshots(() => storage);
    expect(damaged.error).toContain("could not be read");
    expect(damaged.raw).toBe("not json");
    expect(() => damaged.save(saved)).toThrow(/could not be read/);
    damaged.reset();
    expect(damaged.error).toBe("");
    expect(damaged.items).toEqual([]);
  });

  it("allowlists stored fields instead of rewriting untrusted extras", () => {
    const storage = memory();
    const snapshot = createAuditSnapshot({
      account: "example",
      capturedAt: 1,
      records: [record("tool")],
    });
    snapshot.readmeSource = "secret source";
    snapshot.repositories[0].evidence = "secret evidence";
    snapshot.repositories[0].findings[0].message = "secret message";
    storage.setItem(
      AUDIT_SNAPSHOTS_KEY,
      JSON.stringify({ version: 1, items: [snapshot] }),
    );
    const snapshots = new AuditSnapshots(() => storage);
    expect(snapshots.error).toBe("");
    snapshots.save(
      createAuditSnapshot({ account: "other", capturedAt: 2, records: [] }),
    );
    expect(storage.value(AUDIT_SNAPSHOTS_KEY)).not.toContain("secret");
  });

  it("rejects duplicate identities and over-limit account history", () => {
    const storage = memory();
    const item = createAuditSnapshot({
      account: "example",
      capturedAt: 1,
      records: [],
    });
    storage.setItem(
      AUDIT_SNAPSHOTS_KEY,
      JSON.stringify({ version: 1, items: [item, item] }),
    );
    expect(new AuditSnapshots(() => storage).error).toContain(
      "could not be read",
    );

    storage.setItem(
      AUDIT_SNAPSHOTS_KEY,
      JSON.stringify({
        version: 1,
        items: Array.from({ length: 6 }, (_, index) =>
          createAuditSnapshot({
            account: "example",
            capturedAt: index + 1,
            records: [],
          }),
        ),
      }),
    );
    expect(new AuditSnapshots(() => storage).error).toContain(
      "could not be read",
    );
  });

  it("rejects timestamps outside the renderable Date range", () => {
    const storage = memory();
    const item = createAuditSnapshot({
      account: "example",
      capturedAt: 1,
      records: [record("tool")],
    });
    item.capturedAt = 8_640_000_000_000_001;
    item.id = `example:${item.capturedAt}`;
    storage.setItem(
      AUDIT_SNAPSHOTS_KEY,
      JSON.stringify({ version: 1, items: [item] }),
    );
    expect(new AuditSnapshots(() => storage).error).toContain(
      "could not be read",
    );

    item.capturedAt = 1;
    item.id = "example:1";
    item.repositories[0].observedAt = 8_640_000_000_000_001;
    storage.setItem(
      AUDIT_SNAPSHOTS_KEY,
      JSON.stringify({ version: 1, items: [item] }),
    );
    expect(new AuditSnapshots(() => storage).error).toContain(
      "could not be read",
    );
  });
});
