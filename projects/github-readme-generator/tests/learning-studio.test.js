import { describe, expect, it } from "vitest";
import {
  checklistMarkdown,
  lessonReview,
  lineRange,
  writingExamples,
} from "../src/learning/model.js";
import {
  LEARNING_PROGRESS_KEY,
  progressFor,
  readLearningProgress,
  saveChecklistProgress,
  validateLearningProgress,
} from "../src/learning/progress.js";

const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
};

describe("guided writing lessons", () => {
  it("uses heading evidence and keeps accuracy explicitly unknown", () => {
    const review = lessonReview(
      "# Tool\n\n## Installation\n\n## Usage\n",
      "cli",
    );
    expect(review.tasks.map((task) => task.status)).toEqual([
      "observed",
      "observed",
      "not-detected",
    ]);
    expect(review.tasks[0].evidence).toContain("accuracy is still Unknown");
  });
  it("marks ambiguous heading evidence unknown and maps editor ranges exactly", () => {
    const source = "# API\r\n## Usage\r\n## Usage examples\r\n";
    expect(
      lessonReview(source, "api").tasks.find((task) => task.id === "request")
        .status,
    ).toBe("unknown");
    const range = lineRange(source, 1);
    expect(source.slice(range.start, range.end)).toBe("## Usage");
    expect(lineRange(source, null)).toEqual({
      start: source.length,
      end: source.length,
    });
  });
  it("ignores code/comment lookalikes and matches aliases on word boundaries", () => {
    const source =
      "# Tool\n\n```md\n## Installation\n```\n\n<!--\n## Setup\n-->\n\n## Rapid setup\n\n## Authors\n";
    const cli = lessonReview(source, "cli");
    const api = lessonReview(source, "api");
    expect(cli.tasks.find((task) => task.id === "install").status).toBe(
      "observed",
    );
    expect(api.tasks.find((task) => task.id === "auth").status).toBe(
      "not-detected",
    );
    expect(api.tasks.find((task) => task.id === "request").status).toBe(
      "not-detected",
    );
    expect(
      lessonReview("# Tool\rInstallation\r------------\r", "cli").tasks.find(
        (task) => task.id === "install",
      ).status,
    ).toBe("observed");
    expect(lineRange("# Tool\rInstallation\r------------\r", 1)).toEqual({
      start: 7,
      end: 19,
    });
  });
  it("ships synthetic annotated examples without project claims", () => {
    for (const example of writingExamples()) {
      expect(example.after).toContain("[");
      expect(example.annotations.length).toBeGreaterThan(1);
    }
  });
});

describe("portable checklist progress", () => {
  it("persists bounded content-free progress and exports ordinary Markdown", () => {
    const s = storage(),
      next = saveChecklistProgress("draft-1", "cli", ["install"], s, () => 12);
    expect(progressFor(next, "draft-1", "cli")).toEqual(["install"]);
    const raw = s.values.get(LEARNING_PROGRESS_KEY);
    expect(raw).not.toContain("README source");
    expect(checklistMarkdown("cli", ["install"])).toContain(
      "- [x] Explain installation",
    );
    expect(checklistMarkdown("cli", [])).toContain("Advisory checklist");
  });
  it("preserves malformed records and prior data on storage failure", () => {
    const s = storage();
    s.setItem(LEARNING_PROGRESS_KEY, '{"version":99}');
    expect(() => readLearningProgress(s)).toThrow("preserved");
    expect(s.values.get(LEARNING_PROGRESS_KEY)).toBe('{"version":99}');
    const previous = JSON.stringify(validateLearningProgress(null));
    const broken = {
      getItem: () => previous,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() =>
      saveChecklistProgress("draft-1", "api", ["auth"], broken),
    ).toThrow("previous record is unchanged");
  });
  it("rejects duplicate, oversized and unknown progress fields", () => {
    expect(() =>
      validateLearningProgress({
        version: 1,
        documents: [
          {
            documentId: "draft-1",
            type: "unknown",
            completed: [],
            updatedAt: 1,
          },
        ],
      }),
    ).toThrow("unreadable");
    const documents = Array.from({ length: 51 }, (_, index) => ({
      documentId: `draft-${index}`,
      type: "cli",
      completed: [],
      updatedAt: index,
    }));
    expect(() => validateLearningProgress({ version: 1, documents })).toThrow(
      "unreadable",
    );
    documents[0].documentId = "invalid id";
    expect(() => validateLearningProgress({ version: 1, documents })).toThrow(
      "unreadable",
    );
    expect(() =>
      validateLearningProgress({
        version: 1,
        documents: [
          {
            documentId: "draft-1",
            type: "cli",
            completed: ["auth"],
            updatedAt: 1,
          },
        ],
      }),
    ).toThrow("unreadable");
  });
  it("intentionally evicts the oldest valid record when adding a 51st", () => {
    const s = storage();
    s.setItem(
      LEARNING_PROGRESS_KEY,
      JSON.stringify({
        version: 1,
        documents: Array.from({ length: 50 }, (_, index) => ({
          documentId: `draft-${index}`,
          type: "cli",
          completed: [],
          updatedAt: index,
        })),
      }),
    );
    const next = saveChecklistProgress(
      "draft-new",
      "cli",
      ["install"],
      s,
      () => 99,
    );
    expect(next.documents).toHaveLength(50);
    expect(next.documents.some((row) => row.documentId === "draft-0")).toBe(
      false,
    );
    expect(progressFor(next, "draft-new", "cli")).toEqual(["install"]);
  });
});
