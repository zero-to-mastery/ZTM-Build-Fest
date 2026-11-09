import { describe, it, expect } from "vitest";
import {
  documentationSuiteTemplates,
  documentationSuiteProjectTypes,
  createDocumentationSuite,
  validateDocumentationSuite,
  planDocumentationSuiteDrafts,
} from "../src/documentation/suites.js";
import { newDraft } from "../src/state/drafts.js";
import "../src/components/documentation-suite.js";

describe("documentation suite templates", () => {
  it("creates a typed manifest from only the documents the owner chose", () => {
    const options = documentationSuiteTemplates("api");
    expect(options.map((item) => item.path)).toEqual([
      "README.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "docs/API.md",
      "docs/ARCHITECTURE.md",
    ]);
    expect(options.every((item) => item.selected === false)).toBe(true);

    const manifest = createDocumentationSuite("api", [
      "readme",
      "api",
      "security",
    ]);

    expect(manifest).toEqual({
      version: 1,
      projectType: "api",
      documents: [
        expect.objectContaining({ id: "readme", path: "README.md" }),
        expect.objectContaining({ id: "security", path: "SECURITY.md" }),
        expect.objectContaining({ id: "api", path: "docs/API.md" }),
      ],
    });
    expect(manifest.documents.map((item) => item.path)).not.toContain(
      "CONTRIBUTING.md",
    );
    expect(manifest.documents.map((item) => item.path)).not.toContain(
      "docs/ARCHITECTURE.md",
    );
  });
  it("offers bounded project-specific choices without fabricated facts", () => {
    const expected = {
      generic: ["README.md", "CONTRIBUTING.md", "SECURITY.md"],
      cli: ["README.md", "CONTRIBUTING.md", "SECURITY.md", "docs/CLI.md"],
      library: ["README.md", "CONTRIBUTING.md", "SECURITY.md", "docs/API.md"],
      game: ["README.md", "CONTRIBUTING.md", "SUPPORT.md", "docs/GAMEPLAY.md"],
      "web-app": [
        "README.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        "docs/ARCHITECTURE.md",
        "docs/DEPLOYMENT.md",
      ],
    };
    for (const [type, paths] of Object.entries(expected)) {
      const options = documentationSuiteTemplates(type);
      expect(options.map((item) => item.path)).toEqual(paths);
      expect(options.length).toBeLessThanOrEqual(8);
      expect(options.every((item) => item.markdown.includes("Describe"))).toBe(
        true,
      );
      expect(JSON.stringify(options)).not.toMatch(
        /npm install|cargo build|support@example|security@example/i,
      );
    }
    expect(
      Object.fromEntries(
        documentationSuiteProjectTypes.map((type) => [
          type,
          documentationSuiteTemplates(type).map((item) => item.path),
        ]),
      ),
    ).toMatchInlineSnapshot(`
      {
        "api": [
          "README.md",
          "CONTRIBUTING.md",
          "SECURITY.md",
          "docs/API.md",
          "docs/ARCHITECTURE.md",
        ],
        "cli": [
          "README.md",
          "CONTRIBUTING.md",
          "SECURITY.md",
          "docs/CLI.md",
        ],
        "game": [
          "README.md",
          "CONTRIBUTING.md",
          "SUPPORT.md",
          "docs/GAMEPLAY.md",
        ],
        "generic": [
          "README.md",
          "CONTRIBUTING.md",
          "SECURITY.md",
        ],
        "library": [
          "README.md",
          "CONTRIBUTING.md",
          "SECURITY.md",
          "docs/API.md",
        ],
        "web-app": [
          "README.md",
          "CONTRIBUTING.md",
          "SECURITY.md",
          "docs/ARCHITECTURE.md",
          "docs/DEPLOYMENT.md",
        ],
      }
    `);
  });
  it("rejects missing, duplicate, unknown and over-limit selections", () => {
    expect(() => createDocumentationSuite("api", [])).toThrow(/at least one/);
    expect(() => createDocumentationSuite("api", ["readme", "readme"])).toThrow(
      /once/,
    );
    expect(() => createDocumentationSuite("api", ["made-up"])).toThrow(
      /unsupported/,
    );
    expect(() => documentationSuiteTemplates("made-up")).toThrow(/supported/);
  });
  it("revalidates an edited manifest without trusting paths or oversized source", () => {
    const manifest = createDocumentationSuite("api", ["readme", "api"]);
    manifest.documents[1].markdown = "# Exact reviewed API\n";
    expect(validateDocumentationSuite(manifest)).toEqual(manifest);

    expect(() =>
      validateDocumentationSuite({
        ...manifest,
        documents: manifest.documents.map((item) =>
          item.id === "api" ? { ...item, path: "README.md" } : item,
        ),
      }),
    ).toThrow(/changed path/);
    expect(() =>
      validateDocumentationSuite({
        ...manifest,
        documents: [manifest.documents[0], manifest.documents[0]],
      }),
    ).toThrow(/once/);
    expect(() =>
      validateDocumentationSuite({
        ...manifest,
        documents: [
          { ...manifest.documents[0], markdown: "x".repeat(100_001) },
        ],
      }),
    ).toThrow(/too large/);
    expect(() =>
      validateDocumentationSuite({
        ...manifest,
        documents: [{ ...manifest.documents[0], markdown: "€".repeat(33_334) }],
      }),
    ).toThrow(/too large/);

    const aggregate = createDocumentationSuite("api", [
      "readme",
      "contributing",
      "security",
      "api",
      "architecture",
    ]);
    aggregate.documents = aggregate.documents.map((item) => ({
      ...item,
      markdown: "€".repeat(30_000),
    }));
    expect(() => validateDocumentationSuite(aggregate)).toThrow(
      /suite is too large/,
    );
  });
  it("plans independent local drafts atomically and refuses path collisions", () => {
    const existing = newDraft("Existing source");
    existing.markdown = "# Existing exact source";
    const manifest = createDocumentationSuite("api", ["readme", "api"]);
    manifest.documents[1].markdown = "# Reviewed API\n";

    const drafts = planDocumentationSuiteDrafts(manifest, [existing]);

    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => draft.markdown)).toEqual([
      manifest.documents[0].markdown,
      "# Reviewed API\n",
    ]);
    expect(
      drafts.map((draft) => draft.metadata.documentationSuite.path),
    ).toEqual(["README.md", "docs/API.md"]);
    expect(
      drafts.every(
        (draft) => draft.metadata.workspaceDocument.kind === "local",
      ),
    ).toBe(true);
    expect(existing.markdown).toBe("# Existing exact source");
    expect(() =>
      planDocumentationSuiteDrafts(manifest, [existing, drafts[1]]),
    ).toThrow(/already exists/);
  });
});

describe("guided documentation suite review", () => {
  it("starts empty and requires an exact reviewed plan plus approval", () => {
    const el = document.createElement("documentation-suite");
    el.configure({ availableSlots: 10, snapshot: "workspace-v1" });
    const review = el.querySelector("[data-review]");
    expect(el.querySelectorAll("[data-document]:checked")).toHaveLength(0);
    expect(review.disabled).toBe(true);

    el.querySelector("[data-project-type]").value = "api";
    el.querySelector("[data-project-type]").dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    for (const id of ["readme", "api"]) {
      const choice = el.querySelector(`[data-document="${id}"]`);
      choice.checked = true;
      choice.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(review.disabled).toBe(false);
    review.click();
    expect(el.plan.documents.map((item) => item.path)).toEqual([
      "README.md",
      "docs/API.md",
    ]);
    expect(el.querySelector("[data-exact]").textContent).toContain(
      "docs/API.md",
    );
    expect(el.canCreate()).toBe(false);
    el.querySelector("[data-approve]").checked = true;
    expect(el.canCreate()).toBe(true);

    const source = el.querySelector('[data-source="api"]');
    source.value += "\nReviewed details.";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    expect(el.plan).toBeNull();
    expect(el.canCreate()).toBe(false);
  });
});
