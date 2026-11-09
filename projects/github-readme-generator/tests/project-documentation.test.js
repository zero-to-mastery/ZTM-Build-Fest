import { it, expect } from "vitest";
import { marked } from "marked";
import {
  documentationProfiles,
  documentationProfile,
  projectTemplateSections,
} from "../src/documentation/project-types.js";
import {
  documentationDefaults,
  serializeDocumentation,
} from "../src/documentation/sections.js";
import { buildRepositoryTemplate } from "../src/data/repository-templates.js";
const serialize = (type, settings) =>
  serializeDocumentation(type, { ...documentationDefaults(type), ...settings });

it.each(Object.keys(projectTemplateSections))(
  "builds project-specific %s sections without altering original source",
  (type) => {
    const source = "\ufeff# Existing\r\n\r\nActual user text.\r\n";
    const sections = projectTemplateSections[type];
    const blocks = buildRepositoryTemplate({
      templateId: type,
      values: { name: "Actual project" },
      sections,
      existing: source,
    });
    expect(blocks[0].settings.markdown).toBe(source);
    expect(blocks.length).toBe(sections.length + 2);
    expect(
      blocks.slice(2).filter((b) => b.type.startsWith("doc-")).length,
    ).toBeGreaterThanOrEqual(sections.length - 1);
  },
);
it("maps package and PWA recommendations deterministically without guessing unsupported types", () => {
  expect(documentationProfile("npm-package")).toBe("library");
  expect(documentationProfile("python-package")).toBe("library");
  expect(documentationProfile("pwa")).toBe("web-app");
  expect(documentationProfile("unknown")).toBe("generic");
  expect(documentationProfiles.game.types).toContain("doc-save-data");
  expect(documentationProfiles["web-app"].types).toEqual(
    expect.arrayContaining([
      "doc-demo",
      "doc-screenshots",
      "doc-environment",
      "doc-architecture",
      "doc-testing",
      "doc-deployment",
    ]),
  );
});
it("serializes CLI syntax, command examples and escaped flag rows", () => {
  const source = serialize("doc-cli", {
    syntax: "tool [options] <file>",
    commands: "tool validate",
    examples: "tool validate notes.md",
    items: [
      {
        name: "--output",
        alias: "-o",
        value: "path",
        description: "Output | location",
      },
    ],
  });
  expect(source).toContain("```sh\ntool [options] <file>\n```");
  expect(source).toContain("| --output | -o | path | Output \\| location |");
  expect(
    marked.lexer(source).find((t) => t.type === "table").rows[0],
  ).toHaveLength(4);
});
it("keeps API request/response code literal and parameters explicitly required", () => {
  const source = serialize("doc-endpoint", {
    method: "GET",
    path: "/items/{id}",
    authentication: "Use YOUR_API_TOKEN as a placeholder.",
    request: "GET /items/123 HTTP/1.1",
    response: 'HTTP/1.1 200 OK\n\n{"id":123}',
    items: [
      {
        name: "id",
        location: "path",
        required: true,
        valueType: "string",
        description: "Item identifier",
      },
    ],
  });
  expect(source).toContain("| id | path | Yes | string | Item identifier |");
  expect(marked.lexer(source).filter((t) => t.type === "code")).toHaveLength(2);
  expect(() =>
    serialize("doc-endpoint", {
      items: [
        {
          name: "id",
          location: "path",
          required: "yes",
          valueType: "string",
          description: "",
        },
      ],
    }),
  ).toThrow(/required/);
});
it("uses the selected example language for library imports and retains compatibility prose", () => {
  const source = serialize("doc-library", {
    language: "python",
    import: "from actual_package import parse",
    example: "parse('example')",
    surface: "parse(input)",
    compatibility: "See the tested versions in CI.",
  });
  expect(source).toContain("```python\nfrom actual_package import parse\n```");
  expect(source).toContain(
    "### Compatibility\n\nSee the tested versions in CI.",
  );
});
it("uses TOML and Rust fences without inventing dependency versions or registry data", () => {
  const empty = serialize("doc-cargo", {});
  expect(empty).not.toContain("version =");
  const source = serialize("doc-cargo", {
    dependency: 'actual_crate = "1.2"',
    features: "serde\nasync",
    example: "fn main() {}",
  });
  expect(source).toContain('```toml\nactual_crate = "1.2"\n```');
  expect(source).toContain("```rust\nfn main() {}\n```");
  expect(
    serialize("doc-crate-links", {
      docs: "https://docs.rs/actual_crate",
      crate: "https://crates.io/crates/actual_crate",
    }),
  ).toContain("https://docs.rs/actual_crate");
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<script>",
    "https://user:secret@example.org",
  ])
    expect(() => serialize("doc-crate-links", { docs: value })).toThrow(/safe/);
});
it("outputs game controls and save behavior only from supplied facts", () => {
  expect(
    serialize("doc-controls", {
      items: [{ name: "Space", action: "Jump", device: "Keyboard" }],
    }),
  ).toContain("| Space | Jump | Keyboard |");
  expect(
    serialize("doc-save-data", {
      location: "saves/",
      persistence: "Saved when leaving a level.",
    }),
  ).toContain("Saved when leaving a level.");
  expect(serialize("doc-save-data", {})).not.toMatch(/cloud|autosave/);
});
it("validates screenshots, requires alt text and safely serializes paths and captions", () => {
  const items = [
    {
      name: "images/my shot(1).png",
      alt: "Player <view>",
      caption: "Example | frame",
    },
  ];
  const source = serialize("doc-screenshots", { items });
  expect(source).toContain("images/my%20shot%281%29.png");
  expect(source).not.toContain("<view>");
  for (const name of ["javascript:alert(1)", "data:text/html,test"])
    expect(() =>
      serialize("doc-screenshots", { items: [{ ...items[0], name }] }),
    ).toThrow(/safe/);
  expect(() =>
    serialize("doc-screenshots", { items: [{ ...items[0], alt: "" }] }),
  ).toThrow(/alt/);
  expect(() =>
    serialize("doc-screenshots", { items: Array(201).fill(items[0]) }),
  ).toThrow(/200/);
});
