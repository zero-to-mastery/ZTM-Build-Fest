import { describe, it, expect } from "vitest";
import {
  createProject,
  inspectProject,
  migrateProject,
  recoverProjectSource,
  sourceHash,
  projectFilename,
  PROJECT_LIMIT,
} from "../src/studio-projects/model.js";
import { newDraft, validateDraft } from "../src/state/drafts.js";
import { createBlock, serializeBlocks } from "../src/markdown/serialize.js";
import { newBanner } from "../src/banners/banner-model.js";
import { bannerMarkup } from "../src/banners/export.js";
import { baseTheme } from "../src/themes/theme-model.js";
import {
  createBackup,
  validateWorkspace,
} from "../src/state/workspace-backup.js";
const draft = (source = "\ufeff# Héllo 🌍\r\n\n<script>sample</script>\n") =>
  newDraft("Portable", [createBlock("custom", { markdown: source })]);
describe("portable Studio project schema 1", () => {
  it("excludes provider credentials from portable projects without rewriting source", () => {
    const d = draft();
    d.metadata.repository = {
      name: "demo",
      apiKey: "credential-sentinel",
      config: {
        api_key: "credential-sentinel",
        password: "credential-sentinel",
      },
    };
    d.blocks[0].apiKey = "credential-sentinel";
    const exported = createProject(d);
    expect(JSON.stringify(exported)).not.toContain("credential-sentinel");
    expect(exported.document.markdown).toBe(d.markdown);
    expect(d.metadata.repository.apiKey).toBe("credential-sentinel");
  });
  it("round-trips exact source, blocks, theme, ownership and preferences", () => {
    const d = draft();
    d.blocks[0].githubGenerated = {
      version: 1,
      repositories: ["example/test"],
      options: { action: "summary" },
      generatedValue: d.markdown,
      snapshot: [],
    };
    d.metadata.visualTheme = baseTheme;
    const p = createProject(
      d,
      { theme: "dark", pane: "preview" },
      undefined,
      "2026-01-01T00:00:00.000Z",
    );
    const opened = inspectProject(JSON.stringify(p));
    expect(opened.mode).toBe("project");
    expect(opened.draft.markdown).toBe(d.markdown);
    const again = createProject(
      opened.draft,
      opened.settings,
      undefined,
      p.updatedAt,
    );
    expect(again).toEqual(p);
  });
  it("preserves source when future versions, mismatching blocks or metadata fail", () => {
    for (const change of [
      (p) => (p.schemaVersion = 99),
      (p) => (p.document.blocks[0].settings.markdown = "changed"),
      (p) => (p.document.blocks = [null]),
      (p) => (p.assets = [{ source: "<script />" }]),
    ]) {
      const p = createProject(draft());
      change(p);
      const r = inspectProject(JSON.stringify(p));
      expect(r.mode).toBe("recovery");
      expect(r.source).toBe(draft().markdown);
      expect(r.draft.blocks[0].type).toBe("custom");
    }
  });
  it("extracts a complete JSON source string from damaged JSON without evaluation", () => {
    const source = 'line\r\n"quoted" 🌍';
    expect(
      recoverProjectSource(
        '{"document":{"markdown":' + JSON.stringify(source) + ", BROKEN",
      ),
    ).toBe(source);
    expect(
      inspectProject('{"markdown":' + JSON.stringify(source) + ", BROKEN")
        .source,
    ).toBe(source);
    expect(() => inspectProject("not JSON")).toThrow(/Could not recover/);
  });
  it("migrates legacy drafts deterministically without mutating input", () => {
    const d = draft(),
      before = structuredClone(d);
    expect(migrateProject(d)).toEqual(migrateProject(d));
    expect(d).toEqual(before);
    expect(inspectProject(JSON.stringify(d)).mode).toBe("project");
    expect(inspectProject(JSON.stringify(d)).source).toBe(d.markdown);
  });
  it("excludes authentication metadata while preserving user-authored source", () => {
    const d = draft("token in user prose is source");
    d.metadata.token = "do-not-export";
    d.metadata.githubProfile = {
      login: "example",
      access_token: "secret",
      snapshot: { name: "Example", csrf: "secret" },
    };
    const p = createProject(d);
    expect(JSON.stringify(p)).not.toContain("do-not-export");
    expect(JSON.stringify(p)).not.toContain("secret");
    expect(p.document.markdown).toBe(d.markdown);
    expect(p.document.metadata.githubProfile.snapshot.name).toBe("Example");
  });
  it("validates generated SVG manifests and preserves banner ownership across backup IDs", () => {
    const banner = newBanner(baseTheme),
      block = createBlock("custom", { markdown: bannerMarkup(banner) }),
      d = newDraft("Banner", [block]);
    d.metadata = {
      bannerSettings: banner,
      bannerReference: { blockId: block.id, source: block.settings.markdown },
    };
    const p = createProject(d);
    expect(p.assets.length).toBeGreaterThan(0);
    expect(inspectProject(p).mode).toBe("project");
    const imported = validateDraft(d);
    expect(imported.metadata.bannerReference.blockId).toBe(
      imported.blocks[0].id,
    );
    expect(d.metadata.bannerReference.blockId).toBe(block.id);
    const saved = validateWorkspace(
      createBackup({ version: 1, drafts: [d], active: d.id, settings: {} }),
      { preserveIds: true },
    );
    expect(saved.drafts[0].blocks[0].id).toBe(block.id);
    p.assets[0].source += "<script/>";
    expect(inspectProject(p).mode).toBe("recovery");
  });
  it("keeps libraries opt-in and rejects oversized/unreadable files safely", () => {
    const p = createProject(draft());
    expect(p).not.toHaveProperty("libraries");
    expect(
      createProject(draft(), {}, {}).libraries.componentLibrary.snippets,
    ).toEqual([]);
    expect(() => inspectProject(" ".repeat(PROJECT_LIMIT + 1))).toThrow(
      /10 MB/,
    );
    expect(projectFilename("../Unsafe:name")).not.toMatch(/[/:\\]/);
    expect(sourceHash("x")).toBe(sourceHash("x"));
    expect(sourceHash("x")).not.toBe(sourceHash("y"));
  });
  it("rejects duplicate block IDs without losing source", () => {
    const d = draft();
    d.blocks.push({ ...d.blocks[0] });
    d.markdown = serializeBlocks(d.blocks);
    const r = inspectProject(createProject(d));
    expect(r.mode).toBe("recovery");
    expect(r.source).toBe(d.markdown);
  });
});
