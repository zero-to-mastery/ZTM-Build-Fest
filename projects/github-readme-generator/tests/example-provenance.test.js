import { describe, it, expect } from "vitest";
import {
  exampleMarker,
  inspectExampleMarkers,
  validateExampleProvenance,
} from "../src/documentation/example-provenance.js";
import {
  documentationDefaults,
  serializeDocumentation,
} from "../src/documentation/sections.js";
import { createBlock, serializeBlock } from "../src/markdown/serialize.js";
import "../src/components/example-export-check.js";
import "../src/components/builder-form.js";

describe("example provenance", () => {
  it("serializes exact portable status markers without executing examples", () => {
    const settings = documentationDefaults("doc-testing");
    settings.commands = "npm test";
    settings.exampleProvenance.commands = {
      status: "verified",
      basis: "Matched package.json scripts on 2026-10-23.",
    };
    const source = serializeDocumentation("doc-testing", settings);
    expect(source).toContain(exampleMarker("verified", "npm test"));
    expect(source).toContain("```sh\nnpm test\n```");
    expect(source).not.toContain(settings.exampleProvenance.commands.basis);
    expect(inspectExampleMarkers(source)).toMatchObject({
      checked: 1,
      counts: { verified: 1, "user-confirmed": 0, placeholder: 0 },
      issues: [],
    });
  });

  it("defaults new code fields to placeholders and validates evidence", () => {
    const settings = documentationDefaults("doc-installation");
    expect(settings.exampleProvenance.command).toEqual({
      status: "placeholder",
      basis: "",
    });
    expect(() =>
      validateExampleProvenance({ status: "verified", basis: "" }),
    ).toThrow(/verification note/i);
    expect(
      validateExampleProvenance({
        status: "user-confirmed",
        basis: "Confirmed by the author.",
      }),
    ).toEqual({
      status: "user-confirmed",
      basis: "Confirmed by the author.",
    });
  });

  it("reports placeholder, malformed and bounded marker reviews", () => {
    const source = [
      exampleMarker("placeholder"),
      "```sh\nnpm publish\n```",
      "<!-- readme-studio-example: invented -->",
      "```text\n<!-- readme-studio-example: placeholder -->\n```",
    ].join("\n");
    const report = inspectExampleMarkers(source);
    expect(report.checked).toBe(2);
    expect(report.counts.placeholder).toBe(1);
    expect(report.issues.map((issue) => issue.kind)).toEqual([
      "placeholder",
      "invalid-marker",
    ]);
    expect(inspectExampleMarkers("x".repeat(800_000)).truncatedSource).toBe(
      true,
    );
  });

  it("reports unclassified fences, orphan markers and duplicate markers", () => {
    expect(inspectExampleMarkers("```sh\nnpm test\n```").issues).toEqual([
      { kind: "unclassified" },
    ]);
    expect(
      inspectExampleMarkers(
        `${exampleMarker("verified")}\ntext\n${exampleMarker("verified")}\n${exampleMarker("placeholder")}\n\`\`\`sh\nnpm test\n\`\`\``,
      ).issues.map((issue) => issue.kind),
    ).toEqual(["orphan-marker", "duplicate-marker"]);
    expect(
      inspectExampleMarkers(
        "```text\n<!-- readme-studio-example: verified -->\n```",
      ).issues,
    ).toEqual([{ kind: "unclassified" }]);
  });

  it("inspects quoted and list-contained fences and rejects stale claims", () => {
    const quoted = `> ${exampleMarker("placeholder", "npm publish")}\n> ~~~sh\n> npm publish\n> ~~~`;
    expect(inspectExampleMarkers(quoted).issues).toEqual([
      { kind: "placeholder", status: "placeholder" },
    ]);
    const listed = `- Try this\n\n  ${exampleMarker("verified", "npm test")}\n  ~~~sh\n  npm test\n  ~~~`;
    expect(inspectExampleMarkers(listed).issues).toEqual([]);
    expect(
      inspectExampleMarkers(
        listed.replace("npm test\n  ~~~", "npm run test\n  ~~~"),
      ).issues,
    ).toEqual([{ kind: "stale-provenance", status: "verified" }]);
    expect(
      inspectExampleMarkers(
        `${exampleMarker("user-confirmed")}\n~~~sh\nnpm test\n~~~`,
      ).issues,
    ).toEqual([{ kind: "unbound-marker", status: "user-confirmed" }]);
  });

  it("marks built-in Code Samples and places collapsed markers by their fence", () => {
    const settings = {
      title: "Try it",
      language: "js",
      code: "run()",
      collapsed: true,
      open: false,
      exampleProvenance: { status: "placeholder", basis: "" },
    };
    const source = serializeBlock(createBlock("code", settings));
    expect(source).toContain(
      `${exampleMarker("placeholder", "run()")}\n\`\`\`js\nrun()`,
    );
    expect(inspectExampleMarkers(source).issues).toEqual([
      { kind: "placeholder", status: "placeholder" },
    ]);
  });

  it("does not dirty legacy examples and safely replaces malformed metadata", () => {
    const settings = documentationDefaults("doc-testing");
    settings.commands = "npm test";
    delete settings.exampleProvenance;
    const form = document.createElement("builder-form");
    form.block = createBlock("doc-testing", settings);
    expect(form.isDirty()).toBe(false);
    form.querySelector('[data-path="title"]').value = "Testing locally";
    form
      .querySelector('[data-path="title"]')
      .dispatchEvent(new Event("input", { bubbles: true }));
    expect(form.value.settings.exampleProvenance).toBeUndefined();

    form.value.settings.exampleProvenance = { commands: "verified" };
    form.draw();
    const status = form.querySelector(
      '[data-path="exampleProvenance.commands.status"]',
    );
    status.value = "user-confirmed";
    expect(() =>
      status.dispatchEvent(new Event("input", { bubbles: true })),
    ).not.toThrow();
    expect(form.value.settings.exampleProvenance.commands).toEqual({
      status: "user-confirmed",
    });
  });

  it("downgrades provenance whenever a verified example changes", () => {
    const settings = documentationDefaults("doc-testing");
    settings.commands = "npm test";
    settings.exampleProvenance.commands = {
      status: "verified",
      basis: "Matched package.json.",
    };
    const form = document.createElement("builder-form");
    form.block = createBlock("doc-testing", settings);
    const commands = form.querySelector('[data-path="commands"]');
    commands.value = "npm run test:browser";
    commands.dispatchEvent(new Event("input", { bubbles: true }));
    expect(form.value.settings.exampleProvenance.commands).toEqual({
      status: "placeholder",
      basis: "",
    });
    expect(
      form.querySelector('[data-path="exampleProvenance.commands.status"]')
        .value,
    ).toBe("placeholder");
  });
});

describe("example export review", () => {
  it("renders inert provenance and keeps continuation explicit", () => {
    const panel = document.createElement("example-export-check");
    panel.configure({
      action: "export",
      snapshot: "source-v1",
      report: {
        checked: 1,
        counts: { verified: 0, "user-confirmed": 0, placeholder: 1 },
        issues: [{ kind: "placeholder", status: "placeholder" }],
        truncatedMarkers: 0,
        truncatedSource: false,
      },
    });
    expect(panel.textContent).toContain("1 placeholder");
    let detail;
    panel.addEventListener(
      "example-export-continue",
      (event) => (detail = event.detail),
    );
    panel.querySelector("button").click();
    expect(detail).toEqual({ snapshot: "source-v1" });
  });
});
