import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBlock, serializeBlocks } from "../src/markdown/serialize.js";
import { newDraft } from "../src/state/drafts.js";
import {
  createBackup,
  validateWorkspace,
} from "../src/state/workspace-backup.js";
import { createProject, inspectProject } from "../src/studio-projects/model.js";

const root = join(process.cwd(), "tests", "fixtures", "round-trip");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = (name) => readFileSync(join(root, name));
const normalizeIds = (value, ids) => {
  const visit = (item) => {
    if (typeof item === "string") return ids.get(item) || item;
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item).map(([key, child]) => [key, visit(child)]),
    );
  };
  return visit(value);
};
function normalizedBackup(backup) {
  const copy = structuredClone(backup);
  delete copy.appVersion;
  delete copy.createdAt;
  copy.drafts.forEach((draft) => delete draft.updated);
  const ids = new Map();
  copy.drafts.forEach((draft, draftIndex) => {
    ids.set(draft.id, `draft:${draftIndex}`);
    draft.blocks.forEach((block, blockIndex) =>
      ids.set(block.id, `block:${draftIndex}:${blockIndex}`),
    );
  });
  return normalizeIds(copy, ids);
}
function normalizedProject(project) {
  const copy = structuredClone(project);
  delete copy.appVersion;
  delete copy.updatedAt;
  const ids = new Map(
    copy.document.blocks.map((block, index) => [block.id, `block:${index}`]),
  );
  return normalizeIds(copy, ids);
}

describe("round-trip gate", () => {
  it("pins every fixture byte-for-byte and rejects unlisted corpus files", () => {
    expect(manifest.version).toBe(2);
    const markdownFixtures = manifest.fixtures.filter(
      ({ kind }) => kind === "markdown",
    );
    const projectFixtures = manifest.fixtures.filter(
      ({ kind }) => kind === "studio-project",
    );
    expect(markdownFixtures.length).toBeGreaterThan(0);
    expect(projectFixtures.length).toBeGreaterThan(0);
    expect(
      projectFixtures.some(({ blockTypes = [] }) =>
        ["hero", "custom", "component"].every((type) =>
          blockTypes.includes(type),
        ),
      ),
    ).toBe(true);
    const listed = manifest.fixtures.map((entry) => entry.name).sort();
    const present = readdirSync(root)
      .filter((name) => name !== "manifest.json")
      .sort();
    expect(listed).toEqual(present);
    for (const entry of manifest.fixtures) {
      expect(["markdown", "studio-project"]).toContain(entry.kind);
      expect(entry.covers).toEqual(expect.any(String));
      expect(sha256(fixture(entry.name)), entry.name).toBe(entry.sha256);
    }
  });

  it.each(manifest.fixtures.filter(({ kind }) => kind === "markdown"))(
    "$name survives Markdown, project, and workspace round trips",
    ({ name }) => {
      const source = fixture(name).toString("utf8");
      const draft = newDraft("Round trip", [
        createBlock("custom", { markdown: source }),
      ]);
      expect(serializeBlocks(draft.blocks)).toBe(source);

      const savedAt = "2026-10-22T00:00:00.000Z";
      const project = createProject(draft, {}, undefined, savedAt);
      const opened = inspectProject(JSON.stringify(project));
      expect(opened.mode).toBe("project");
      expect(opened.draft.markdown).toBe(source);
      expect(
        createProject(opened.draft, opened.settings, undefined, savedAt),
      ).toEqual(project);

      const seed = createBackup({
        version: 1,
        drafts: [draft],
        active: draft.id,
        settings: { pane: "preview", theme: "dark", editorFont: "15" },
      });
      const restored = validateWorkspace(seed);
      expect(restored.drafts[0].markdown).toBe(source);
      expect(serializeBlocks(restored.drafts[0].blocks)).toBe(source);
      const first = createBackup(restored);
      const reopened = validateWorkspace(first);
      const second = createBackup(reopened);
      expect(normalizedBackup(second)).toEqual(normalizedBackup(first));
      expect(normalizedBackup(second)).toMatchObject({
        version: 1,
        active: "draft:0",
        settings: { pane: "preview", theme: "dark", editorFont: "15" },
        drafts: [
          {
            id: "draft:0",
            markdown: source,
            blocks: [{ id: "block:0:0" }],
          },
        ],
      });
    },
  );

  it.each(manifest.fixtures.filter(({ kind }) => kind === "studio-project"))(
    "$name preserves Studio JSON source, structure, ownership, and settings",
    ({ name, blockTypes }) => {
      const raw = fixture(name).toString("utf8");
      const pinned = JSON.parse(raw);
      const opened = inspectProject(raw);
      expect(opened.mode).toBe("project");
      expect(opened.source).toBe(pinned.document.markdown);
      expect(serializeBlocks(opened.draft.blocks)).toBe(opened.source);
      expect(opened.settings).toEqual(pinned.settings);
      expect(opened.draft.blocks.map((block) => block.type)).toEqual(
        blockTypes,
      );

      const recreated = createProject(
        opened.draft,
        opened.settings,
        undefined,
        pinned.updatedAt,
      );
      expect(normalizedProject(recreated)).toEqual(normalizedProject(pinned));
      const reopened = inspectProject(JSON.stringify(recreated));
      expect(reopened.mode).toBe("project");
      expect(reopened.source).toBe(opened.source);
      expect(reopened.draft.blocks).toEqual(opened.draft.blocks);

      const backup = createBackup({
        version: 1,
        drafts: [opened.draft],
        active: opened.draft.id,
        settings: opened.settings,
      });
      const restored = validateWorkspace(backup, { preserveIds: true });
      expect(restored.drafts[0].markdown).toBe(opened.source);
      expect(restored.drafts[0].blocks).toEqual(opened.draft.blocks);
      expect(restored.settings).toEqual(opened.settings);
      expect(normalizedBackup(createBackup(restored))).toEqual(
        normalizedBackup(createBackup(validateWorkspace(backup))),
      );
    },
  );
});
