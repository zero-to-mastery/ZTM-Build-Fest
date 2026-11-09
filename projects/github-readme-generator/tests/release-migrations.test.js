import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { inspectProject, createProject } from "../src/studio-projects/model.js";
import { validateDraft } from "../src/state/drafts.js";
import {
  validateWorkspace,
  recoverWorkspace,
} from "../src/state/workspace-backup.js";
import { render } from "../src/markdown/render.js";

describe("representative pre-1.0 source recovery", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
    "preserves representative 0.%i source through project and backup migration",
    (minor) => {
      const raw = readFileSync(
        `tests/fixtures/migrations/0.${minor}.json`,
        "utf8",
      );
      const original = JSON.parse(raw);
      const source = original.document?.markdown ?? original.markdown;
      const opened = inspectProject(raw);
      expect(opened.mode).toBe("project");
      expect(opened.source).toBe(source);
      expect(
        inspectProject(JSON.stringify(createProject(opened.draft))).source,
      ).toBe(source);
      const draft = validateDraft(opened.draft);
      draft.blocks = [{ type: "unsupported-future-block", settings: {} }];
      const backup = {
        version: 1,
        drafts: [draft],
        active: draft.id,
        settings: {},
      };
      expect(validateWorkspace(backup).drafts[0].markdown).toBe(source);
      backup.drafts.push({ name: "Unreadable" });
      expect(recoverWorkspace(JSON.stringify(backup)).drafts[0].markdown).toBe(
        source,
      );
      const exported = createProject(opened.draft);
      render(source);
      expect(exported.document.markdown).toBe(source);
      exported.schemaVersion = 100;
      const recovered = inspectProject(JSON.stringify(exported));
      expect(recovered.mode).toBe("recovery");
      expect(recovered.source).toBe(source);
      expect(JSON.parse(raw)).toEqual(original);
    },
  );

  for (const entry of readdirSync("examples", { withFileTypes: true }).filter(
    (e) => e.isDirectory(),
  )) {
    it(`opens the ${entry.name} example with exact README export`, () => {
      const dir = `examples/${entry.name}`;
      const source = readFileSync(`${dir}/README.md`, "utf8");
      const result = inspectProject(
        readFileSync(`${dir}/${entry.name}.readme-studio.json`, "utf8"),
      );
      expect(result.mode).toBe("project");
      expect(result.draft.markdown).toBe(source);
      expect(createProject(result.draft).document.markdown).toBe(source);
    });
  }
});
