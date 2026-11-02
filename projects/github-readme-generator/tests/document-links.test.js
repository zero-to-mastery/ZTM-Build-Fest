import { describe, it, expect } from "vitest";
import {
  documentPath,
  checkDocumentLinks,
} from "../src/workspace/document-links.js";
import { newDraft } from "../src/state/drafts.js";
import "../src/components/document-link-check.js";

const draftDocument = (path, markdown) => {
  const draft = newDraft(path);
  draft.markdown = markdown;
  draft.metadata.documentationSuite = {
    version: 1,
    projectType: "api",
    id: path,
    path,
  };
  return draft;
};

const repositoryDocument = (repository, branch, path, markdown) => {
  const draft = newDraft(`${repository}:${path}`);
  draft.markdown = markdown;
  draft.metadata.workspaceDocument = {
    version: 1,
    kind: "repository",
    target: { repository, branch, path },
  };
  return draft;
};

describe("cross-document navigation", () => {
  it("checks relative files and anchors against exact workspace source", () => {
    const readme = draftDocument(
      "README.md",
      [
        "# Home",
        "[API](docs/API.md#authentication)",
        "[Missing anchor](docs/API.md#tokens)",
        "[Missing file](docs/GUIDE.md)",
        "[External](https://example.com)",
        "`[Example](docs/EXAMPLE.md)`",
      ].join("\n"),
    );
    const api = draftDocument(
      "docs/API.md",
      '# API\n\n## Authentication\n\n<a id="manual"></a>',
    );
    const before = JSON.stringify([readme, api]);

    const report = checkDocumentLinks([readme, api]);

    expect(report.checked).toBe(3);
    expect(report.issues).toEqual([
      expect.objectContaining({
        sourcePath: "README.md",
        value: "docs/API.md#tokens",
        targetPath: "docs/API.md",
        anchor: "tokens",
        kind: "missing-anchor",
      }),
      expect.objectContaining({
        sourcePath: "README.md",
        value: "docs/GUIDE.md",
        targetPath: "docs/GUIDE.md",
        kind: "missing-document",
      }),
    ]);
    expect(
      checkDocumentLinks([readme, api], { sourceId: api.id }),
    ).toMatchObject({ checked: 0, issues: [] });
    expect(JSON.stringify([readme, api])).toBe(before);
  });

  it("rechecks moved filenames and flags ambiguous workspace paths", () => {
    const readme = draftDocument("README.md", "[API](docs/API.md#api)");
    const api = draftDocument("docs/API.md", "# API");
    expect(checkDocumentLinks([readme, api]).issues).toEqual([]);

    api.metadata.documentationSuite.path = "docs/REFERENCE.md";
    expect(checkDocumentLinks([readme, api]).issues[0]).toMatchObject({
      kind: "missing-document",
      targetPath: "docs/API.md",
    });
    readme.markdown = "[API](docs/REFERENCE.md#api)";
    expect(checkDocumentLinks([readme, api]).issues).toEqual([]);

    const duplicate = draftDocument("docs/REFERENCE.md", "# Other");
    expect(
      checkDocumentLinks([readme, api, duplicate]).issues[0],
    ).toMatchObject({
      kind: "ambiguous-document",
      targetPath: "docs/REFERENCE.md",
    });
  });

  it("keeps fragment-only links bound to their source despite duplicate paths", () => {
    const source = draftDocument(
      "README.md",
      "# Home\n\n[Here](#home) [Qualified](README.md#home)",
    );
    const duplicate = draftDocument("README.md", "# Other");
    const report = checkDocumentLinks([source, duplicate]);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      value: "README.md#home",
      kind: "ambiguous-document",
    });
  });

  it("scopes paths to a repository and branch", () => {
    const source = repositoryDocument(
      "example/one",
      "main",
      "README.md",
      "[API](docs/README.md#one)",
    );
    const wrongRepository = repositoryDocument(
      "example/two",
      "main",
      "docs/README.md",
      "# One",
    );
    expect(
      checkDocumentLinks([source, wrongRepository]).issues[0],
    ).toMatchObject({ kind: "missing-document", targetPath: "docs/README.md" });

    const target = repositoryDocument(
      "EXAMPLE/ONE",
      "main",
      "docs/README.md",
      "# One",
    );
    expect(
      checkDocumentLinks([source, wrongRepository, target]).issues,
    ).toEqual([]);
    target.metadata.workspaceDocument.target.branch = "next";
    expect(checkDocumentLinks([source, target]).issues[0]).toMatchObject({
      kind: "missing-document",
    });
  });

  it("preserves explicit HTML anchor case", () => {
    const readme = draftDocument(
      "README.md",
      "[Exact](docs/API.md#API-V2) [Wrong](docs/API.md#api-v2)",
    );
    const api = draftDocument("docs/API.md", '<a id="API-V2"></a>');
    const report = checkDocumentLinks([readme, api]);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      value: "docs/API.md#api-v2",
      kind: "missing-anchor",
    });
  });

  it("uses repository targets, same-document anchors and safe bounded failures", () => {
    const local = draftDocument(
      "docs/README.md",
      "# Intro\n[Top](#intro) [Root](/README.md) [Out](../../outside.md) [Bad](%E0%A4%A.md)",
    );
    const repository = newDraft("Repository root");
    repository.markdown = "# Root";
    repository.metadata.workspaceDocument = {
      version: 1,
      kind: "repository",
      target: {
        repository: "example/project",
        branch: "main",
        path: "README.md",
      },
    };
    expect(documentPath(repository)).toBe("README.md");
    const root = draftDocument("README.md", "# Root");

    const report = checkDocumentLinks([local, root]);
    expect(report.checked).toBe(4);
    expect(report.issues.map((issue) => issue.kind)).toEqual([
      "outside-workspace",
      "invalid-link",
    ]);
    expect(
      report.issues.every((issue) => issue.sourcePath === "docs/README.md"),
    ).toBe(true);
  });

  it("bounds documents, links and displayed failures without treating omissions as success", () => {
    const source = draftDocument(
      "README.md",
      Array.from(
        { length: 201 },
        (_, index) => `[Missing ${index}](docs/MISSING-${index}.md)`,
      ).join("\n"),
    );
    const extras = Array.from({ length: 500 }, (_, index) =>
      draftDocument(`docs/${index}.md`, `# ${index}`),
    );

    const report = checkDocumentLinks([source, ...extras]);

    expect(report.checked).toBe(200);
    expect(report.issues).toHaveLength(200);
    expect(report.truncatedLinks).toBe(1);
    expect(report.truncatedDocuments).toBe(1);
  });

  it("bounds source parsing before collecting links", () => {
    const oversized = draftDocument(
      "README.md",
      `[Missing](docs/MISSING.md)${"x".repeat(300_000)}`,
    );
    const report = checkDocumentLinks([oversized]);
    expect(report.checked).toBe(0);
    expect(report.issues).toEqual([]);
    expect(report.truncatedSources).toBe(1);

    const aggregate = checkDocumentLinks(
      Array.from({ length: 33 }, (_, index) =>
        draftDocument(`docs/${index}.md`, "x".repeat(250_000)),
      ),
    );
    expect(aggregate.truncatedSources).toBe(1);
  });
});

describe("document link check review", () => {
  it("renders unresolved targets safely and keeps export explicit", () => {
    const panel = document.createElement("document-link-check");
    panel.configure({
      report: {
        checked: 2,
        indexedDocuments: 2,
        skippedDocuments: 0,
        truncatedDocuments: 0,
        truncatedLinks: 0,
        truncatedIssues: 0,
        issues: [
          {
            sourcePath: "README.md",
            value: "<script>alert(1)</script>",
            targetPath: "docs/MISSING.md",
            anchor: "",
            kind: "missing-document",
          },
        ],
      },
      exportSnapshot: "source-v1",
    });
    expect(panel.querySelector("script")).toBeNull();
    expect(panel.textContent).toContain("docs/MISSING.md");
    let detail;
    panel.addEventListener("document-link-export", (event) => {
      detail = event.detail;
    });
    panel.querySelector("[data-export]").click();
    expect(detail).toEqual({ snapshot: "source-v1" });
  });
});
