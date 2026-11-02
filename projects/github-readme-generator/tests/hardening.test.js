import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  newDraft,
  readDrafts,
  saveDrafts,
  STORAGE_KEY,
} from "../src/state/drafts.js";
import {
  workspaceSettings,
  validateWorkspace,
  createBackup,
  restoreWorkspace,
  recoverWorkspace,
} from "../src/state/workspace-backup.js";
import { Store, HISTORY_BYTES, HISTORY_LIMIT } from "../src/state/store.js";
import {
  createBlock,
  serializeBlocks,
  social,
  project,
  badge,
  widget,
  picture,
} from "../src/markdown/serialize.js";
import { safeUrl } from "../src/markdown/url-safety.js";
import { render } from "../src/markdown/render.js";
import { analyze } from "../src/markdown/compatibility.js";
import { analyzeDraft } from "../src/markdown/health-analysis.js";
import { splitDraft } from "../src/state/import-plan.js";
import { safeFilename } from "../src/state/download.js";
import { rateLimitMessage } from "../src/state/network-errors.js";
const draft = (name = "Draft", markdown = "# Hello") =>
  newDraft(name, [createBlock("custom", { markdown })]);
const workspace = () => {
  const d = draft();
  return {
    version: 1,
    drafts: [d],
    active: d.id,
    settings: { theme: "dark", preview: "375" },
  };
};
describe("storage recovery and backups", () => {
  it.each([
    "",
    "{bad",
    JSON.stringify({ version: 2, drafts: [] }),
    JSON.stringify({ version: 1, drafts: [{ name: "Missing source" }] }),
  ])("never overwrites unreadable storage", (raw) => {
    let writes = 0;
    const storage = { getItem: () => raw, setItem: () => writes++ };
    expect(() => readDrafts(storage)).toThrow("original storage is untouched");
    expect(writes).toBe(0);
  });
  it("salvages readable drafts from partial data but retains the original recovery payload", () => {
    const source = {
      ...workspace(),
      drafts: [draft("Good"), { markdown: "# Untitled" }, { name: "Broken" }],
    };
    const raw = JSON.stringify(source);
    try {
      readDrafts({ getItem: () => raw });
      throw new Error("expected failure");
    } catch (e) {
      expect(e.raw).toBe(raw);
      expect(e.recovered.drafts.map((d) => d.name)).toEqual([
        "Good",
        "Recovered draft",
      ]);
    }
    expect(recoverWorkspace("{")).toBe(null);
  });
  it("handles unavailable reads and quota failures without claiming success", () => {
    expect(() =>
      readDrafts({
        getItem: () => {
          throw new DOMException("Denied", "SecurityError");
        },
      }),
    ).toThrow();
    expect(() =>
      saveDrafts(workspace(), {
        setItem: () => {
          throw new DOMException("Full", "QuotaExceededError");
        },
      }),
    ).toThrow("Full");
  });
  it("round-trips source, settings, provenance and creates unique draft/block IDs", () => {
    const current = workspace();
    current.drafts[0].metadata = {
      importSource: { type: "github", owner: "ada", repository: "tools" },
    };
    const backup = createBackup(current);
    const restored = validateWorkspace(JSON.parse(JSON.stringify(backup)));
    expect(restored.drafts[0].markdown).toBe(current.drafts[0].markdown);
    expect(restored.drafts[0].metadata).toEqual(current.drafts[0].metadata);
    expect(restored.settings).toEqual(workspaceSettings(current.settings));
    expect(restored.drafts[0].id).not.toBe(current.drafts[0].id);
    expect(restored.createdAt).toBeTruthy();
  });
  it("resolves duplicate names and IDs deterministically without losing any drafts", () => {
    const w = workspace();
    w.drafts.push(structuredClone(w.drafts[0]), {
      ...structuredClone(w.drafts[0]),
      name: "Draft (2)",
    });
    const restored = validateWorkspace(w, { preserveIds: true });
    expect(new Set(restored.drafts.map((d) => d.id)).size).toBe(3);
    expect(restored.drafts.map((d) => d.name)).toEqual([
      "Draft",
      "Draft (2)",
      "Draft (2) (2)",
    ]);
    const merged = restoreWorkspace(
      workspace(),
      createBackup(workspace()),
      "merge",
    );
    expect(merged.drafts.map((d) => d.name)).toEqual(["Draft", "Draft (2)"]);
    expect(
      restoreWorkspace(workspace(), createBackup(workspace()), "replace")
        .drafts,
    ).toHaveLength(1);
  });
  it("rejects malformed/future backups before mutation", () => {
    const current = workspace(),
      before = JSON.stringify(current);
    expect(() =>
      restoreWorkspace(current, { version: 99, drafts: [] }, "replace"),
    ).toThrow("version");
    expect(JSON.stringify(current)).toBe(before);
  });
});
describe("history and source invariants", () => {
  it("caps history by count and estimated serialized bytes", () => {
    const store = new Store(draft());
    for (let i = 0; i < 120; i++) store.raw("# " + i);
    expect(store.past.length).toBe(HISTORY_LIMIT);
    const large = new Store(draft());
    for (let i = 0; i < 30; i++) large.raw("x".repeat(250000) + i);
    expect(
      large.past.reduce((sum, d) => sum + JSON.stringify(d).length * 2, 0),
    ).toBeLessThanOrEqual(HISTORY_BYTES);
    const last = large.draft.markdown;
    large.undo();
    large.redo();
    expect(large.draft.markdown).toBe(last);
    expect(new Store(draft()).past).toEqual([]);
  });
  it.each([
    "",
    "<div>Only HTML</div>",
    "![Only image](./x.png)",
    "![Badge](https://img.shields.io/badge/a-b-c)",
    "No heading\n\nText",
    "\uFEFF# BOM\r\ntext\nnext\rfinal",
    "# " + "🌍".repeat(4000),
  ])("preserves edge-case source through split and preview", (source) => {
    const d = draft("Edge", source);
    expect(serializeBlocks(splitDraft(d))).toBe(source);
    render(source);
    expect(d.markdown).toBe(source);
  });
});
describe("security boundary", () => {
  it("removes active HTML, unsafe links and application CSS classes without changing export", () => {
    const source = readFileSync("tests/fixtures/malicious-readme.md", "utf8"),
      d = draft("Malicious", source);
    const el = document.createElement("div");
    el.innerHTML = render(source);
    expect(
      el.querySelector(
        "script,iframe,object,embed,form,button,svg,math,input:not([disabled])",
      ),
    ).toBe(null);
    for (const node of el.querySelectorAll("*")) {
      for (const attr of node.attributes) {
        expect(attr.name).not.toMatch(/^on/);
        if (["src", "href", "srcset"].includes(attr.name))
          expect(attr.value).not.toMatch(
            /javascript:|data:text\/html|data:image\/svg/i,
          );
      }
    }
    expect(el.querySelector(".modal,.toast")).toBe(null);
    expect(el.querySelector("details")).not.toBe(null);
    expect(el.querySelector("input[type=checkbox]")?.disabled).toBe(true);
    expect(serializeBlocks(d.blocks)).toBe(source);
  });
  it.each([
    "javascript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,x",
    "file:///x",
    "https://user:pass@example.com",
    "\\example.com",
    "https://",
  ])("rejects unsafe URLs consistently: %s", (url) => {
    expect(safeUrl(url)).toBe("");
    expect(
      social({ items: [{ name: "Bad", url }], style: "plain" }),
    ).not.toContain(url);
    expect(widget({ image: url, link: url })).not.toContain(url);
    expect(picture({ light: url, dark: url, link: url })).not.toContain(url);
  });
  it.each([
    "https://example.com",
    "http://example.com",
    "mailto:a@example.com",
    "./docs/readme.md",
    "#usage",
  ])("supports expected link %s", (url) => expect(safeUrl(url)).toBe(url));
  it("escapes builder image destinations so user text cannot inject a link", () => {
    const output = badge({
      lightUrl: "https://example.com/a) [click](javascript:bad)",
      label: "Demo",
    });
    expect(output).not.toContain(") [click]");
  });
});
describe("health and reliability helpers", () => {
  it("does not treat fenced examples, escaped tags or HTML comments as live markup", () => {
    const a = analyze(
      '# Good\n\n```html\n<script>bad()</script>\n<img src="x">\n```\n\n&lt;iframe&gt;\n\n<!-- <script>bad()</script><img src="x"> -->',
    );
    expect(a.images).toHaveLength(0);
    expect(a.issues.filter((i) => i.category === "Compatibility")).toEqual([]);
  });
  it.each([100, 250])("completes %i KB analysis with bounded results", (kb) => {
    const source =
      "# Large\n\n" +
      "Useful paragraph with Unicode 🌍.\n\n".repeat(
        Math.ceil((kb * 1024) / 34),
      );
    const result = analyzeDraft(draft("Large", source));
    expect(result.analysis.bytes).toBeGreaterThanOrEqual(kb * 1024);
    expect(result.analysis.headings).toHaveLength(1);
    expect(result.warnings.length).toBeLessThan(10);
  });
  it("uses safe filenames and rate-limit reset times", () => {
    expect(safeFilename("../bad:name?.json")).toBe("-bad-name-.json");
    expect(safeFilename("CON.json")).toBe("_CON.json");
    expect(
      rateLimitMessage({
        headers: {
          get: (key) => (key === "x-ratelimit-reset" ? "1790538000" : null),
        },
      }),
    ).toContain("Try again after");
  });
});
