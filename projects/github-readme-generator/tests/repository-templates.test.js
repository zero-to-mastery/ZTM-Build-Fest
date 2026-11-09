import { it, expect } from "vitest";
import {
  repositoryTemplates,
  repositorySuggestions,
  repositoryTemplateId,
  buildRepositoryTemplate,
} from "../src/data/repository-templates.js";
import { serializeBlocks } from "../src/markdown/serialize.js";
import { newDraft, validateDraft } from "../src/state/drafts.js";

it.each(repositoryTemplates)(
  "creates editable $name sections without invented instructions",
  (template) => {
    const blocks = buildRepositoryTemplate({
      templateId: template.id,
      values: { name: "Actual project" },
      sections: template.sections,
    });
    const source = serializeBlocks(blocks);
    expect(source).toContain("# Actual project");
    for (const section of template.sections)
      expect(source).toContain(`## ${section}`);
    expect(blocks).toHaveLength(template.sections.length + 1);
    expect(source).toContain("<!-- TODO:");
    expect(source).not.toMatch(/npm install|cargo add|pip install|MIT License/);
    const draft = newDraft("Test", blocks);
    expect(validateDraft(draft).markdown).toBe(source);
  },
);
it("carries factual suggestions without inventing missing metadata", () => {
  expect(
    repositorySuggestions({ name: "hello", topics: ["cli", "rust"] }, "cli"),
  ).toMatchObject({
    name: "hello",
    topics: "cli, rust",
    description: "",
    homepage: "",
    language: "",
    projectType: "cli",
    templateId: "cli",
  });
  expect(repositoryTemplateId("pwa")).toBe("web-app");
  expect(repositoryTemplateId("experiment")).toBe("generic");
  expect(repositoryTemplateId("unknown")).toBe("generic");
});
it("preserves exact existing bytes and permits omitting sections", () => {
  const source = "\ufeff# Mine\r\n\r\n<script>example</script>\r\n";
  const blocks = buildRepositoryTemplate({
    templateId: "game",
    values: { name: "Game" },
    sections: ["Controls"],
    existing: source,
    sourceContext: { type: "github", owner: "me", repository: "game" },
  });
  expect(blocks[0].settings.markdown).toBe(source);
  expect(serializeBlocks(blocks).startsWith(source)).toBe(true);
  expect(serializeBlocks(blocks)).toContain("## Controls");
  expect(serializeBlocks(blocks)).not.toContain("## Build instructions");
  expect(blocks[0].type).toBe("custom");
  expect(blocks.at(-1).type).toBe("doc-controls");
});
it("escapes reviewed metadata and rejects unsafe homepage URLs", () => {
  const build = (homepage) =>
    buildRepositoryTemplate({
      templateId: "generic",
      values: {
        name: "<script>alert(1)</script>",
        description: "[link](javascript:alert(1))",
        homepage,
      },
      sections: [],
    });
  expect(serializeBlocks(build("https://example.com/?a=1&b=2"))).not.toContain(
    "<script>",
  );
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "//example.com",
    'https://example.com" onclick="bad',
  ]) {
    expect(() => build(value)).toThrow();
  }
  expect(() =>
    buildRepositoryTemplate({
      templateId: "unknown",
      values: { name: "x" },
      sections: [],
    }),
  ).toThrow();
  expect(() =>
    buildRepositoryTemplate({
      templateId: "generic",
      values: { name: " " },
      sections: [],
    }),
  ).toThrow();
});
