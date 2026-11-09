import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  existingSections,
  matchTemplateSections,
  readRepositoryFile,
  reviewSignature,
} from "../src/documentation/template-merge.js";
import {
  buildRepositoryTemplate,
  repositoryTemplates,
} from "../src/data/repository-templates.js";
import { serializeBlocks } from "../src/markdown/serialize.js";
const fixture = readFileSync(
  "tests/fixtures/repository-readmes/mixed.md",
  "utf8",
);
describe("repository template merging", () => {
  it("recognizes real HTML content and images without counting HTML badge rows", () => {
    const source = readFileSync(
      "tests/fixtures/repository-readmes/html.md",
      "utf8",
    );
    expect(
      matchTemplateSections(source, [
        "Overview",
        "Screenshots",
        "Testing",
        "Setup",
        "Usage",
      ]).map((m) => m.status),
    ).toEqual(["matched", "matched", "needs-content", "missing", "missing"]);
  });

  it("matches aliases and distinguishes empty and badge-only sections from examples", () => {
    const titles = [
      "Setup",
      "Usage",
      "Testing",
      "Screenshots",
      "Configuration",
      "Deployment",
      "Environment",
      "Architecture",
      "Demo",
    ];
    expect(matchTemplateSections(fixture, titles).map((m) => m.status)).toEqual(
      [
        "matched",
        "matched",
        "needs-content",
        "needs-content",
        "needs-content",
        "missing",
        "missing",
        "missing",
        "missing",
      ],
    );
  });
  it("reports partial matches without claiming completeness or inserting duplicates", () => {
    expect(
      matchTemplateSections(
        "## Commands\n\nRun this command to inspect available options.",
        ["CLI reference"],
      )[0],
    ).toMatchObject({ status: "related", suggested: false });
    expect(
      matchTemplateSections("## Setup notes for contributors\n", ["Setup"])[0]
        .status,
    ).toBe("missing");
  });
  it("supports setext and HTML headings, CRLF, BOM and duplicate evidence", () => {
    const source =
      "\ufeff# App\r\n\r\nInstallation\r\n------------\r\n\r\nInstall with the command documented below here.\r\n\r\n<h2>Installation</h2>\r\n";
    const result = matchTemplateSections(source, ["Setup"])[0];
    expect(result.status).toBe("matched");
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0].line).toBe(3);
    expect(existingSections("## 日本語\n\n説明です。")[0].title).toBe("日本語");
  });
  it("preserves exact source for a no-op merge and prefixes additive merges", () => {
    const existing = "\ufeff# Existing\r\n\r\nUser source  \r\n";
    const options = {
      templateId: "generic",
      values: { name: "App" },
      sections: [],
      existing,
      includeContext: false,
    };
    expect(serializeBlocks(buildRepositoryTemplate(options))).toBe(existing);
    expect(
      serializeBlocks(
        buildRepositoryTemplate({ ...options, sections: ["Setup"] }),
      ).startsWith(existing),
    ).toBe(true);
  });
  it("requires fresh review when any output, source or metadata changes, independent of generated IDs", () => {
    const plan = () => ({
      name: "App",
      metadata: { type: "generic" },
      blocks: buildRepositoryTemplate({
        templateId: "generic",
        values: { name: "App" },
        sections: [],
      }),
    });
    expect(reviewSignature("old", plan())).toBe(reviewSignature("old", plan()));
    expect(reviewSignature("new", plan())).not.toBe(
      reviewSignature("old", plan()),
    );
    expect(reviewSignature("old", { ...plan(), name: "Other" })).not.toBe(
      reviewSignature("old", plan()),
    );
  });
  it("imports UTF-8 byte-for-byte and rejects malformed or oversized files", async () => {
    const source = "\ufeff# 日本語\r\n";
    const file = (bytes) => ({
      size: bytes.length,
      arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    });
    expect(
      await readRepositoryFile(file(new TextEncoder().encode(source))),
    ).toBe(source);
    await expect(readRepositoryFile(file([255]))).rejects.toThrow("UTF-8");
    await expect(readRepositoryFile({ size: 2000001 })).rejects.toThrow("2 MB");
  });
  it.each(repositoryTemplates.map((t) => [t.id, t]))(
    "keeps %s template sections editable and avoids invented instructions",
    (_, template) => {
      const blocks = buildRepositoryTemplate({
        templateId: template.id,
        values: { name: "Reviewed" },
        sections: template.sections,
      });
      expect(blocks).toHaveLength(template.sections.length + 1);
      const source = serializeBlocks(blocks);
      expect(source).not.toMatch(
        /npm install|cargo add|pip install|MIT License|API_KEY=secret/,
      );
      expect(source).toContain("TODO");
    },
  );
});
