import { it, expect } from "vitest";
import { analyzeDocument } from "../src/analysis/analyze.js";
import { publishDiff } from "../src/publishing/diff.js";
import { searchWorkspace } from "../src/workspace/commands.js";
import { createProject, inspectProject } from "../src/studio-projects/model.js";
import { newDraft } from "../src/state/drafts.js";
import { createBlock } from "../src/markdown/serialize.js";
it.each([100, 250, 500, 1024])(
  "%s KB source completes analysis, diff and portable round-trip",
  (kb) => {
    const source =
      "# Large\n\n" +
      "Ordinary paragraph with a [relative link](./guide.md).\n\n".repeat(
        Math.ceil((kb * 1024) / 55),
      );
    expect(analyzeDocument(source).stats).toBeTruthy();
    expect(publishDiff(source, source + "\nEnd").text).toContain("+End");
    const d = newDraft("Large", [createBlock("custom", { markdown: source })]);
    expect(inspectProject(JSON.stringify(createProject(d))).source).toBe(
      source,
    );
  },
  30000,
);
it("bounds search results across large reusable libraries", () => {
  expect(
    searchWorkspace(
      Array.from({ length: 2000 }, (_, i) => ({
        id: i,
        name: "Reusable " + i,
        category: "Components",
      })),
      "reusable",
    ),
  ).toHaveLength(50);
});
it("source-preserving raw edits stay O(n) per keystroke on 250 KB", async () => {
  const { splitDraft } = await import("../src/state/import-plan.js");
  const { Store } = await import("../src/state/store.js");
  const section = (i) =>
    `## Section ${i}\n\nParagraph text for section ${i}.\n\n`;
  let source = "";
  for (let i = 0; source.length < 250 * 1024; i++) source += section(i);
  const d = newDraft("Large", [createBlock("custom", { markdown: source })]);
  const store = new Store({ ...d, blocks: splitDraft(d) });
  const started = performance.now();
  for (let k = 0; k < 20; k++) {
    const at = Math.floor(store.draft.markdown.length / 2);
    store.raw(
      store.draft.markdown.slice(0, at) + "x" + store.draft.markdown.slice(at),
    );
  }
  expect(store.draft.blocks.length).toBeGreaterThan(1000);
  expect((performance.now() - started) / 20).toBeLessThan(250);
}, 30000);
