import { it, expect } from "vitest";
import {
  documentationSections,
  documentationDefaults,
  documentationType,
  serializeDocumentation,
} from "../src/documentation/sections.js";
import { createBlock, serializeBlock } from "../src/markdown/serialize.js";
import { newDraft, validateDraft } from "../src/state/drafts.js";
import { Store } from "../src/state/store.js";
import { buildRepositoryTemplate } from "../src/data/repository-templates.js";
import { marked } from "marked";

it.each(Object.entries(documentationSections))(
  "serializes and round trips %s as ordinary Markdown",
  (type, definition) => {
    const settings = documentationDefaults(type);
    expect(settings.version).toBe(1);
    for (const field of definition.fields)
      settings[field.key] =
        field.kind === "link"
          ? "https://example.com/docs"
          : field.kind === "code"
            ? "echo project-example"
            : "Verified project detail";
    const block = createBlock(type, settings),
      source = serializeBlock(block);
    expect(source.startsWith(`## ${definition.name}`)).toBe(true);
    if (definition.fields.some((field) => field.kind === "code"))
      expect(source).toContain("readme-studio-example: placeholder");
    else expect(source).not.toContain("readme-studio-example");
    const draft = newDraft("Docs", [block]);
    expect(
      validateDraft(JSON.parse(JSON.stringify(draft))).blocks[0].settings,
    ).toEqual(settings);
    expect(validateDraft(draft).markdown).toBe(source);
  },
);
it("installation and testing do not fabricate commands or requirements", () => {
  expect(
    serializeDocumentation(
      "doc-installation",
      documentationDefaults("doc-installation"),
    ),
  ).not.toMatch(/npm install|Node.js|Prerequisites/);
  const source = serializeDocumentation("doc-installation", {
    ...documentationDefaults("doc-installation"),
    packageManager: "pnpm",
    command: "pnpm add my-package",
    prerequisites: "Use the project's documented runtime.",
    notes: "Confirm the package name.",
  });
  expect(source).toContain("```sh\npnpm add my-package\n```");
  expect(source).toContain("### Package manager\n\npnpm");
  const tests = serializeDocumentation("doc-testing", {
    ...documentationDefaults("doc-testing"),
    commands: "npm test\nnpm run test:browser",
    testTypes: "Unit\nBrowser",
    coverage: "Coverage is measured locally.",
  });
  expect(tests).toContain("- Unit\n- Browser");
  expect(tests).not.toContain("100%");
});
it("keeps code fence characters inside examples and escapes titles", () => {
  const code = "```\n<script>alert(1)</script>\n````";
  const source = serializeDocumentation("doc-examples", {
    ...documentationDefaults("doc-examples"),
    title: "<img src=x onerror=bad>",
    language: "html",
    example: code,
  });
  const tokens = marked.lexer(source);
  expect(tokens.find((t) => t.type === "code").text).toBe(code);
  expect(
    tokens
      .filter((t) => t.type === "html")
      .every((t) => /readme-studio-example/.test(t.text)),
  ).toBe(true);
  expect(source).toContain("## \\<img src=x onerror=bad\\>");
});
it("serializes environment rows with boolean requirements and safe table cells", () => {
  const settings = {
    ...documentationDefaults("doc-environment"),
    items: [
      {
        name: "API_TOKEN",
        required: true,
        description: "First | second\n<script>",
        placeholder: "<YOUR_API_TOKEN>",
      },
      {
        name: "PORT",
        required: false,
        description: "Local port",
        placeholder: "3000",
      },
    ],
  };
  const source = serializeDocumentation("doc-environment", settings);
  expect(source).toContain("Keep real secrets outside version control");
  expect(source).toContain("| API\\_TOKEN | Yes |");
  expect(source).toContain("| PORT | No | Local port | 3000 |");
  const table = marked.lexer(source).find((t) => t.type === "table");
  expect(table.rows).toHaveLength(2);
  expect(table.rows[0]).toHaveLength(4);
  expect(source).not.toContain("<script>");
  expect(() =>
    serializeDocumentation("doc-environment", {
      ...settings,
      items: [{ ...settings.items[0], name: "123-invalid" }],
    }),
  ).toThrow(/Variable names/);
  expect(() =>
    serializeDocumentation("doc-environment", {
      ...settings,
      items: [{ ...settings.items[0], required: "false" }],
    }),
  ).toThrow(/required/);
  expect(() =>
    serializeDocumentation("doc-environment", {
      ...settings,
      items: Array(201).fill(settings.items[0]),
    }),
  ).toThrow(/200/);
});
it("uses structured sections for new templates without converting existing source", () => {
  const source = "# Existing\n\n## Installation\n\nCustom instructions";
  const blocks = buildRepositoryTemplate({
    templateId: "library",
    values: { name: "Library" },
    sections: ["Installation", "Library guide"],
    existing: source,
  });
  expect(blocks[0].type).toBe("custom");
  expect(blocks[0].settings.markdown).toBe(source);
  expect(blocks.slice(2).map((b) => b.type)).toEqual([
    "doc-installation",
    "doc-library",
  ]);
  expect(documentationType("Setup")).toBe("doc-installation");
});
it("supports undo/redo and raw edit detachment without losing source", () => {
  const store = new Store(newDraft("Docs", []));
  store.blocks([
    createBlock("doc-testing", {
      ...documentationDefaults("doc-testing"),
      commands: "npm test",
    }),
  ]);
  const source = store.draft.markdown;
  store.undo();
  expect(store.draft.markdown).toBe("");
  store.redo();
  expect(store.draft.markdown).toBe(source);
  // Text appended after a builder block never detaches it.
  store.raw(source + "\nManual addition");
  expect(store.draft.blocks[0].type).toBe("doc-testing");
  expect(store.draft.blocks[1].type).toBe("custom");
  expect(store.draft.markdown).toBe(source + "\nManual addition");
  // Editing inside the builder block detaches it.
  store.raw(source.replace("npm test", "pnpm test") + "\nManual addition");
  expect(store.draft.blocks[0].type).toBe("custom");
  expect(store.draft.metadata.detachments).toHaveLength(1);
  store.undo();
  store.undo();
  expect(store.draft.blocks[0].type).toBe("doc-testing");
});
it("rejects future settings while portable draft recovery retains original source", () => {
  const draft = newDraft("Docs", [
    createBlock("doc-overview", documentationDefaults("doc-overview")),
  ]);
  draft.blocks[0].settings.version = 99;
  expect(() => serializeBlock(draft.blocks[0])).toThrow(/version/);
  expect(validateDraft(draft).markdown).toBe(draft.markdown);
  expect(validateDraft(draft).blocks[0].type).toBe("custom");
});
