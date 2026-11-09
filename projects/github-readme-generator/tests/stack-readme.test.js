import { describe, it, expect } from "vitest";
import { analyzeManifest } from "../src/stack-intelligence/manifests.js";
import { normalizeDependencies } from "../src/stack-intelligence/dependencies.js";
import { readmeSuggestions } from "../src/stack-intelligence/readme-suggestions.js";
import { createBlock, serializeBlocks } from "../src/markdown/serialize.js";
import "../src/components/stack-readme-review.js";

const OBSERVED_AT = Date.parse("2026-10-22T12:00:00Z");
const record = (...sources) => {
  const manifests = sources.map(([path, source]) => ({
    ...analyzeManifest(path, source),
    sha: "a".repeat(40),
    project: "",
  }));
  return {
    repository: "example/app",
    status: "read",
    ref: "main",
    observedAt: OBSERVED_AT,
    checkedAt: OBSERVED_AT,
    manifests,
    dependencies: normalizeDependencies("example/app", manifests, {
      branch: "main",
      observedAt: OBSERVED_AT,
    }),
  };
};
const node = (data) => record(["package.json", JSON.stringify(data)]);

describe("reviewable stack documentation", () => {
  it("retains only safe allowlisted metadata, never script bodies or secrets", () => {
    const r = node({
      name: "@example/app",
      packageManager: "pnpm@10.0.0",
      scripts: {
        test: "echo secret; throw Error()",
        build: "evil()",
        postinstall: "secret",
      },
      description: "secret",
      token: "secret",
    });
    expect(r.manifests[0].readme).toEqual({
      packageName: "@example/app",
      packageManager: "pnpm",
      scripts: ["test", "build"],
    });
    expect(JSON.stringify(r)).not.toMatch(/secret|evil|postinstall/);
    const suggestions = readmeSuggestions(r);
    expect(
      suggestions.find((s) => s.id === "package.json:test").markdown,
    ).toContain("pnpm run test");
    expect(
      suggestions.find((s) => s.id === "package.json:link").markdown,
    ).toContain("%40example%2Fapp");
  });
  it("does not invent test/build scripts or publication for private packages", () => {
    const suggestions = readmeSuggestions(
      node({ private: true, name: "private", scripts: { test: 2, build: "" } }),
    );
    expect(suggestions.map((s) => s.id)).toEqual([
      "package.json:manager",
      "package.json:install",
    ]);
    expect(suggestions[0].evidence.join()).toContain("not detected");
  });
  it("bounds scoped package identifiers", () => {
    const r = node({ name: "@" + "x".repeat(220) + "/package" });
    expect(r.manifests[0].readme.packageName).toBeUndefined();
  });
  it("rejects injected package/manager identifiers", () => {
    const r = node({ name: "x)<script>", packageManager: "npm@1;evil()" });
    expect(r.manifests[0].readme).toEqual({ scripts: [] });
    expect(JSON.stringify(readmeSuggestions(r))).not.toContain("evil()");
  });
  it("offers deterministic known technology badges with evidence, not unknown packages", () => {
    const r = node({
      dependencies: { react: "19", mystery: "1" },
      devDependencies: { vitest: "4" },
    });
    const result = readmeSuggestions(r);
    expect(result.find((s) => s.id === "stack").markdown).toContain("React");
    expect(result.find((s) => s.id === "stack").markdown).not.toContain(
      "mystery",
    );
    expect(result.find((s) => s.id === "badge:react").markdown).toContain(
      "img.shields.io",
    );
    expect(result.every((s) => s.evidence.length && s.caveat)).toBe(true);
    expect(readmeSuggestions(r)).toEqual(result);
  });
  it("keeps technologies with only uncertain evidence out of the Detected stack and badges", () => {
    const r = node({
      dependencies: { react: "19" },
      peerDependencies: { vue: "3" },
    });
    const result = readmeSuggestions(r);
    const stack = result.find((s) => s.id === "stack");
    expect(stack.markdown).toBe("## Detected stack\n\n- Core: React");
    expect(stack.evidence).toEqual([
      "React: package.json · dependencies · basis: explicit",
    ]);
    expect(result.find((s) => s.id === "badge:react").evidence).toEqual([
      "package.json · dependencies · basis: explicit",
    ]);
    expect(result.some((s) => s.id === "badge:vue")).toBe(false);
    // Shown, never hidden: offered separately with its basis and a caveat.
    const uncertain = result.find((s) => s.id === "stack:uncertain");
    expect(uncertain.title).toBe("Technologies with only uncertain evidence");
    expect(uncertain.markdown).toBe("## Possibly in the stack\n\n- Core: Vue");
    expect(uncertain.evidence).toEqual([
      "Vue: package.json · peerDependencies · basis: conditional",
    ]);
    expect(uncertain.caveat).toContain(
      "every declaration of Vue is conditional or ambiguous",
    );
    // No basis or scan metadata goes into the Markdown (ADR epic65-03).
    expect(result.map((s) => s.markdown).join()).not.toMatch(
      /basis|conditional|ambiguous|uncertain/i,
    );
    const peerOnly = readmeSuggestions(record(["requirements.txt", "flask\n"]));
    expect(peerOnly.some((s) => s.id === "stack")).toBe(false);
    expect(peerOnly.some((s) => s.id.startsWith("badge:"))).toBe(false);
    expect(peerOnly.find((s) => s.id === "stack:uncertain").evidence).toEqual([
      "Flask: requirements.txt · requirements.txt (line 1) · basis: ambiguous",
    ]);
  });
  it("offers Rust conventions and declared crate links, suppressing private registries", () => {
    const r = record(["Cargo.toml", '[package]\nname="my-crate"\nversion="1"']);
    const result = readmeSuggestions(r);
    expect(
      result.find((s) => s.id === "Cargo.toml:install").markdown,
    ).toContain("cargo fetch");
    expect(result.find((s) => s.id === "Cargo.toml:link").markdown).toContain(
      "docs.rs/my-crate",
    );
    for (const publish of ["false", "[]", '["internal"]'])
      expect(
        readmeSuggestions(
          record([
            "Cargo.toml",
            `[package]\nname="private"\npublish=${publish}`,
          ]),
        ).some((s) => s.id.endsWith(":link")),
      ).toBe(false);
  });
  it("handles Python, requirements and Go without assuming build scripts", () => {
    const result = readmeSuggestions(
      record(
        [
          "pyproject.toml",
          '[project]\nname="sample"\ndependencies=["pytest>=8"]',
        ],
        ["requirements.txt", "requests>=2"],
        ["go.mod", "module example.com/app\ngo 1.23"],
      ),
    );
    const markdown = result.map((s) => s.markdown).join("\n");
    expect(markdown).toContain("python -m pip install .");
    expect(markdown).toContain("python -m pip install -r requirements.txt");
    expect(markdown).toContain("python -m pytest");
    expect(markdown).toContain("go test ./...");
    expect(markdown).toContain("go build ./...");
    expect(markdown).toContain("pypi.org/project/sample");
  });
  it("produces no suggestions for failed scans and does not mutate partial evidence", () => {
    expect(readmeSuggestions({ status: "failed" })).toEqual([]);
    const r = node({ dependencies: { react: "19" } });
    r.status = "partial";
    const before = JSON.stringify(r);
    expect(readmeSuggestions(r).length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).toBe(before);
  });
});

describe("exact source review", () => {
  const setup = () => {
    const el = document.createElement("stack-readme-review");
    const blocks = [
      createBlock("custom", { markdown: "# Original\r\n\r\nExact source\n" }),
    ];
    const draft = {
      id: "draft",
      name: "Original",
      blocks,
      markdown: serializeBlocks(blocks),
      metadata: {},
    };
    el.configure(node({ scripts: { test: "test" } }), draft);
    return { el, draft };
  };
  const selectAndConfirm = (el, index = 0) => {
    const choice = el.querySelector(`[data-choice="${index}"]`);
    choice.checked = true;
    choice.dispatchEvent(new Event("change", { bubbles: true }));
    const confirmation = el.querySelector(`[data-confirm="${index}"]`);
    confirmation.checked = true;
    confirmation.dispatchEvent(new Event("change", { bubbles: true }));
  };
  it("requires a per-item Confirmation before reviewing a selected command", () => {
    const { el } = setup();
    const index = el.suggestions.findIndex(
      (suggestion) => suggestion.id === "package.json:test",
    );
    el.querySelector(`[data-choice="${index}"]`).checked = true;

    el.preview();

    expect(el.plan).toBeNull();
    expect(el.querySelector("[data-status]").textContent).toContain(
      "Confirm each selected suggestion",
    );
  });
  it("names each Confirmation and shows its full review-only Provenance", () => {
    const { el, draft } = setup();
    const index = el.suggestions.findIndex(
      (suggestion) => suggestion.id === "package.json:test",
    );
    const confirmation = el.querySelector(`[data-confirm="${index}"]`);
    const item = confirmation.closest("section");

    expect(confirmation.parentElement.textContent).toContain(
      "I confirm Testing command is true for this repository.",
    );
    expect(item.textContent).toContain("example/app");
    expect(item.textContent).toContain("Repository root");
    expect(item.textContent).toContain("package.json");
    expect(item.textContent).toContain("scripts.test");
    expect(item.textContent).toContain("main");
    expect(item.textContent).toContain(new Date(OBSERVED_AT).toLocaleString());
    expect(item.querySelector("[data-blob] .sr-only").textContent).toBe(
      "SHA " + "a".repeat(40),
    );
    expect(JSON.stringify(draft)).not.toContain("a".repeat(40));
  });
  it("disambiguates every review control when two Manifests produce the same title", () => {
    const el = document.createElement("stack-readme-review");
    const blocks = [createBlock("custom", { markdown: "# Python" })];
    el.configure(
      record(
        ["pyproject.toml", '[project]\nname="sample"'],
        ["requirements.txt", "requests>=2"],
      ),
      {
        id: "python-draft",
        name: "Python",
        blocks,
        markdown: serializeBlocks(blocks),
        metadata: {},
      },
    );

    const labels = [...el.querySelectorAll("label")].map((label) =>
      label.textContent.trim(),
    );
    for (const manifest of ["pyproject.toml", "requirements.txt"]) {
      expect(labels).toContain(
        `Python package manager suggestion — ${manifest}`,
      );
      expect(labels).toContain(
        `Python package manager suggestion — ${manifest} Markdown`,
      );
      expect(labels).toContain(
        `I confirm Python package manager suggestion — ${manifest} is true for this repository.`,
      );
    }
  });
  it("enables exact review only while every selected item is confirmed", () => {
    const { el } = setup();
    const index = el.suggestions.findIndex(
      (suggestion) => suggestion.id === "package.json:test",
    );
    const choice = el.querySelector(`[data-choice="${index}"]`);
    const confirmation = el.querySelector(`[data-confirm="${index}"]`);
    const source = el.querySelector(`[data-source="${index}"]`);
    const preview = el.querySelector("[data-preview]");

    expect(preview.disabled).toBe(true);
    choice.checked = true;
    choice.dispatchEvent(new Event("change", { bubbles: true }));
    expect(confirmation.disabled).toBe(false);
    expect(preview.disabled).toBe(true);
    confirmation.checked = true;
    confirmation.dispatchEvent(new Event("change", { bubbles: true }));
    expect(preview.disabled).toBe(false);

    source.value += "\nReviewed locally.";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    expect(confirmation.checked).toBe(false);
    expect(preview.disabled).toBe(true);
  });
  it("starts unselected and requires exact approval after reviewing source", () => {
    const { el, draft } = setup();
    expect(el.selection()).toEqual([]);
    expect(el.querySelector("[data-preview]").disabled).toBe(true);
    expect(el.canApply()).toBe(false);
    selectAndConfirm(el);
    el.preview();
    expect(el.canApply()).toBe(false);
    el.querySelector("[data-approve]").checked = true;
    expect(el.canApply()).toBe(true);
    expect(el.plan.markdown.startsWith(draft.markdown)).toBe(true);
    expect(el.plan.blocks[0]).toEqual(draft.blocks[0]);
    el.querySelector('[data-source="0"]').value += " changed";
    expect(el.canApply()).toBe(false);
    el.invalidate();
    expect(el.plan).toBeNull();
  });
  it("keeps edited suggestion HTML inert in the review UI", () => {
    const { el } = setup();
    selectAndConfirm(el);
    el.querySelector('[data-source="0"]').value =
      "<script>globalThis.evil=true</script>";
    el.querySelector('[data-source="0"]').dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    const confirmation = el.querySelector('[data-confirm="0"]');
    confirmation.checked = true;
    confirmation.dispatchEvent(new Event("change", { bubbles: true }));
    el.preview();
    expect(el.querySelector("script")).toBeNull();
    expect(el.plan.markdown).toContain("<script>");
    expect(globalThis.evil).toBeUndefined();
  });
  it("refuses stale builder/source synchronization instead of replacing source", () => {
    const { el } = setup();
    el.draft.markdown = "# Original";
    selectAndConfirm(el);
    el.preview();
    expect(el.plan).toBeNull();
    expect(el.querySelector("[data-status]").textContent).toContain("differ");
  });
});
