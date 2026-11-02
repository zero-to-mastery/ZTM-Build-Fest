import { describe, it, expect } from "vitest";
import {
  createBatch,
  validateBatch,
  decideBatch,
  nextBatchIndex,
  recoverBatch,
  recordBatchOpen,
  reviewBatchRecovery,
} from "../src/workspace/batch-review.js";
import {
  createBackup,
  validateWorkspace,
  restoreWorkspace,
} from "../src/state/workspace-backup.js";
import { newDraft } from "../src/state/drafts.js";
import "../src/components/batch-review.js";
const repos = Array.from({ length: 12 }, (_, i) => ({
  full_name: `example/repo-${i}`,
  default_branch: "main",
}));
describe("batch review progression", () => {
  it("migrates legacy progress and classifies recovered documents by exact local freshness", () => {
    const created = createBatch(repos);
    const legacy = {
      version: 1,
      current: created.current,
      items: created.items.map(({ checkpoint: _checkpoint, ...item }) => item),
    };
    const batch = validateBatch(legacy);
    expect(batch.journal).toEqual([]);
    const draft = newDraft("repo 0", []);
    draft.markdown = "line one\r\nline two";
    draft.metadata = {
      workspaceDocument: { kind: "repository", target: batch.items[0] },
    };
    const opened = recordBatchOpen(batch, 0, draft, "2026-10-23T12:00:00.000Z");

    expect(opened.version).toBe(2);
    expect(opened.journal).toEqual([
      {
        action: "opened",
        index: 0,
        at: "2026-10-23T12:00:00.000Z",
        documentId: draft.id,
        sourceHash: "fnv1a32:ccc8d840",
        targetIdentity: '["example/repo-0","main","README.md"]',
      },
    ]);
    expect(reviewBatchRecovery(opened, [draft]).items[0].status).toBe(
      "current",
    );
    draft.markdown = "line one\nline two";
    expect(reviewBatchRecovery(opened, [draft]).items[0].status).toBe(
      "changed",
    );
    expect(reviewBatchRecovery(opened, []).items[0].status).toBe("missing");
    expect(reviewBatchRecovery(opened, [draft]).items[1].status).toBe(
      "not-opened",
    );
  });
  it("keeps a bounded allowlisted journal of explicit progress decisions", () => {
    let batch = createBatch(repos);
    for (let i = 0; i < 501; i++)
      batch = decideBatch(
        batch,
        0,
        i % 2 ? "pending" : "skipped",
        `2026-10-23T12:${String(i % 60).padStart(2, "0")}:00.000Z`,
      );
    expect(batch.journal).toHaveLength(500);
    expect(batch.journal.at(-1)).toEqual({
      action: "skipped",
      index: 0,
      at: "2026-10-23T12:20:00.000Z",
    });
    const sanitized = validateBatch({
      ...batch,
      journal: [
        {
          action: "pending",
          index: 0,
          at: "2026-10-23T13:00:00.000Z",
          token: "must-not-survive",
          source: "must-not-survive",
        },
      ],
    });
    expect(sanitized.journal).toEqual([
      { action: "pending", index: 0, at: "2026-10-23T13:00:00.000Z" },
    ]);
    const draft = newDraft("bounded");
    draft.metadata = {
      workspaceDocument: { kind: "repository", target: batch.items[0] },
    };
    const opened = recordBatchOpen(batch, 0, draft);
    expect(() =>
      validateBatch({
        ...opened,
        items: [
          {
            ...opened.items[0],
            checkpoint: {
              ...opened.items[0].checkpoint,
              documentId: "x".repeat(201),
            },
          },
          ...opened.items.slice(1),
        ],
      }),
    ).toThrow("Invalid batch checkpoint");
    expect(() =>
      validateBatch({
        ...opened,
        journal: [
          {
            ...opened.journal.at(-1),
            targetIdentity: '["other/repository","main","README.md"]',
          },
        ],
      }),
    ).toThrow("Invalid batch journal target");
  });
  it("preserves queue order, deduplicates and progresses only after explicit decisions", () => {
    const batch = createBatch([...repos, repos[0]]);
    expect(batch.items).toHaveLength(12);
    expect(nextBatchIndex(batch)).toBe(0);
    const next = decideBatch(batch, 0, "reviewed");
    expect(batch.items[0].state).toBe("pending");
    expect(nextBatchIndex(next)).toBe(1);
    expect(nextBatchIndex(decideBatch(next, 1, "skipped"))).toBe(2);
    expect(nextBatchIndex(decideBatch(next, 0, "pending"))).toBe(0);
    const done = {
      ...batch,
      items: batch.items.map((item) => ({ ...item, state: "reviewed" })),
    };
    expect(nextBatchIndex(done)).toBe(-1);
  });
  it("rejects malformed targets, unknown versions, invalid decisions and oversized batches", () => {
    expect(() => createBatch([])).toThrow();
    expect(() =>
      createBatch([{ full_name: "<script>", default_branch: "main" }]),
    ).toThrow();
    expect(() =>
      validateBatch({ ...createBatch(repos), version: 3 }),
    ).toThrow();
    expect(() => decideBatch(createBatch(repos), 50, "reviewed")).toThrow();
    expect(() =>
      createBatch(
        Array.from({ length: 201 }, (_, i) => ({
          full_name: `example/r${i}`,
          default_branch: "main",
        })),
      ),
    ).toThrow();
    expect(recoverBatch({ version: 99 })).toBeNull();
    expect(() =>
      validateBatch({ ...createBatch(repos), journal: "damaged" }),
    ).toThrow("Invalid review batch journal");
    expect(
      recoverBatch({ ...createBatch(repos), journal: "damaged" }),
    ).toBeNull();
  });
  it("backs up progress and preserves the current session during merge restore", () => {
    const draft = newDraft("local");
    draft.metadata = {
      workspaceDocument: {
        kind: "repository",
        target: createBatch(repos).items[0],
      },
    };
    const reviewBatch = recordBatchOpen(
      decideBatch(createBatch(repos), 0, "reviewed"),
      0,
      draft,
    );
    const workspace = {
      drafts: [draft],
      active: draft.id,
      settings: {},
      reviewBatch,
    };
    const backup = validateWorkspace(createBackup(workspace));
    expect(backup.reviewBatch.items[0].checkpoint.documentId).toBe(
      backup.drafts[0].id,
    );
    expect(backup.reviewBatch.items[0].checkpoint.documentId).not.toBe(
      draft.id,
    );
    expect(
      restoreWorkspace(workspace, { ...backup, reviewBatch: null }, "merge")
        .reviewBatch,
    ).toEqual(workspace.reviewBatch);
    expect(
      restoreWorkspace(workspace, { ...backup, reviewBatch: null }, "replace")
        .reviewBatch,
    ).toBeNull();
  });
  it("renders local review status without any publishing action and requires batch selection", () => {
    const el = document.createElement("batch-review");
    el.configure({ drafts: [], reviewBatch: createBatch(repos) });
    expect(el.querySelectorAll("[data-include]:checked")).toHaveLength(0);
    expect(el.textContent).toContain("12 READMEs pending");
    expect(
      [...el.querySelectorAll("button")].some((button) =>
        /publish/i.test(button.textContent),
      ),
    ).toBe(false);
  });
  it("shows a local-only recovery review without opening or changing documents", () => {
    const draft = newDraft("repo 0");
    draft.markdown = "saved source";
    draft.metadata = {
      workspaceDocument: {
        kind: "repository",
        target: createBatch(repos).items[0],
      },
    };
    const batch = recordBatchOpen(
      createBatch(repos),
      0,
      draft,
      "2026-10-23T12:00:00.000Z",
    );
    draft.markdown = "changed locally";
    const el = document.createElement("batch-review");
    el.configure({ drafts: [draft], reviewBatch: batch });
    expect(el.textContent).toContain("Recovery review");
    expect(el.textContent).toContain("Changed since last opened");
    expect(el.textContent).toContain("Not yet opened");
    expect(el.textContent).toContain("does not fetch or publish");
    expect(draft.markdown).toBe("changed locally");
  });
});
