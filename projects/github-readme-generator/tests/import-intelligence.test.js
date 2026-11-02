import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { detectSections, classifySection } from "../src/markdown/sections.js";
import {
  resolveImageUrl,
  resolveLinkUrl,
  resolveSrcset,
} from "../src/markdown/resolve-urls.js";
import { render } from "../src/markdown/render.js";
import {
  compareSections,
  assembleMerge,
  duplicateWarnings,
  contentHash,
} from "../src/markdown/merge.js";
import { importSummary } from "../src/markdown/import-summary.js";
import {
  importGithub,
  githubRepository,
  boundedText,
  sourceChange,
  IMPORT_LIMIT,
} from "../src/state/import.js";
import {
  importPlan,
  splitDraft,
  importedDraft,
  contextAt,
} from "../src/state/import-plan.js";
import { newDraft, validateDraft } from "../src/state/drafts.js";
import { serializeBlocks, createBlock } from "../src/markdown/serialize.js";
import { Store } from "../src/state/store.js";
const fixture = (n) => readFileSync(`tests/fixtures/${n}.md`, "utf8");
const context = {
  type: "github",
  owner: "ada",
  repository: "tools",
  ref: "main",
  readmePath: "docs/README.MD",
  sha: "one",
  fetchedAt: "2026-09-27T00:00:00Z",
};
const raw = (markdown, source = null) => ({
  ...newDraft("Local", [
    { ...createBlock("custom", { markdown }), sourceContext: source },
  ]),
  metadata: source ? { importSource: source, repository: "ada/tools" } : {},
});
const response = (value, status = 200) => ({
  ok: status === 200,
  status,
  text: async () => JSON.stringify(value),
});
const file = (markdown, extra = {}) => ({
  path: "docs/README.MD",
  sha: "one",
  size: new TextEncoder().encode(markdown).length,
  encoding: "base64",
  content: Buffer.from(markdown).toString("base64"),
  ...extra,
});
describe("lossless structural analysis", () => {
  it.each([
    "profile-readme",
    "repository-readme",
    "messy-readme",
    "merge-current",
    "merge-remote",
  ])("preserves %s including original ranges and CRLF", (name) => {
    for (const source of [
      fixture(name),
      fixture(name).replace(/\r?\n/g, "\r\n"),
    ]) {
      const sections = detectSections(source);
      expect(sections.map((s) => s.source).join("")).toBe(source);
      for (const s of sections)
        expect(source.slice(s.start, s.end)).toBe(s.source);
      expect(serializeBlocks(splitDraft(raw(source)))).toBe(source);
    }
  });
  it("ignores fenced, inline, comment and raw HTML headings", () => {
    const s =
      "banner\r\n\r\n# Héllo 🌍\r\n\r\n```md\n## fake\n```\n\n~~~\n# fake\n~~~\n\n<!--\n# fake\n-->\n\n<pre>\n# fake\n</pre>\n\n`# fake`\n\n## Skills\n### Detail\n";
    expect(detectSections(s).map((s) => s.title)).toEqual([
      "Preamble",
      "Héllo 🌍",
      "Skills",
    ]);
    expect(detectSections(s, { levels: [1] })).toHaveLength(2);
    expect(detectSections(s, { levels: [1, 2, 3] }).at(-1).title).toBe(
      "Detail",
    );
    expect(detectSections("no headings")[0].source).toBe("no headings");
    expect(detectSections("")).toHaveLength(1);
  });
  it("keeps reference definitions, indentation and standalone CR offsets", () => {
    const s = "[a]: https://example.com\r\r\tcode\r\r## About\rbody\r";
    const d = detectSections(s);
    expect(d[1].source).toBe("## About\rbody\r");
    expect(d.map((x) => x.source).join("")).toBe(s);
  });
  it.each([
    ["About", "about"],
    ["About Me", "about"],
    ["Skills", "stack"],
    ["Tech Stack", "stack"],
    ["Projects", "projects"],
    ["Writing", "writing"],
    ["Let’s Connect", "contact"],
    ["Currently Learning", "learning"],
    ["Unknown", "custom"],
  ])("classifies %s conservatively", (heading, kind) =>
    expect(classifySection(heading)).toBe(kind),
  );
  it("counts actual content, excluding code examples", () => {
    const a = importSummary(fixture("profile-readme"));
    expect(a.details).toBe(1);
    expect(a.codeBlocks).toBe(1);
    expect(a.images.some((i) => i.url === "./fake.png")).toBe(false);
    expect(a.sections[0].title).toBe("Preamble");
    expect(
      importSummary('```html\n<details><a href="x">x</a>\n```').details,
    ).toBe(0);
  });
});
describe("preview-only URLs", () => {
  it.each([
    ["./image.png", "/docs/image.png"],
    ["../image.png", "/image.png"],
    ["/image.png", "/image.png"],
    [
      "assets/hello world.png?raw=1#x",
      "/docs/assets/hello%20world.png?raw=1#x",
    ],
  ])("resolves %s", (input, path) => {
    expect(resolveImageUrl(input, context)).toBe(
      "https://raw.githubusercontent.com/ada/tools/main" + path,
    );
    expect(resolveLinkUrl(input, context)).toBe(
      "https://github.com/ada/tools/blob/main" + path,
    );
  });
  it("preserves safe absolute URLs, anchors and mailto", () => {
    expect(resolveImageUrl("https://example.com/a.svg", context)).toBe(
      "https://example.com/a.svg",
    );
    expect(resolveLinkUrl("#usage", context)).toBe("#usage");
    expect(resolveLinkUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(resolveImageUrl("mailto:a@example.com")).toBe("");
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "data:image/svg+xml,test",
    "vbscript:foo",
    "file:///a",
    "java\nscript:foo",
    "\\evil.com/a",
  ])("rejects unsafe %s", (url) => {
    expect(resolveImageUrl(url, context)).toBe("");
    expect(resolveLinkUrl(url, context)).toBe("");
  });
  it("resolves srcset independently and rejects invalid descriptors", () => {
    expect(
      resolveSrcset(
        "./a.png 1x, ../b.png 2x, javascript:x 3x, c.png garbage",
        context,
      ),
    ).toBe(
      "https://raw.githubusercontent.com/ada/tools/main/docs/a.png 1x, https://raw.githubusercontent.com/ada/tools/main/b.png 2x",
    );
    expect(resolveImageUrl("./a.png")).toBe("");
    expect(
      resolveImageUrl("./a.png", { ...context, owner: "../../evil" }),
    ).toBe("");
  });
  it("renders sanitized picture URLs without rewriting source", () => {
    const source =
      '<picture><source srcset="./dark.svg 1x"><img src="./light.svg" onerror="evil()"></picture>\n\n[Docs](./guide.md) [Jump](#usage)\n\n## Usage';
    const output = render(source, { sourceContext: context });
    expect(output).toContain(
      "raw.githubusercontent.com/ada/tools/main/docs/dark.svg",
    );
    expect(output).toContain("github.com/ada/tools/blob/main/docs/guide.md");
    expect(output).not.toContain("onerror");
    expect(output).toContain('href="#usage"');
    expect(source).toContain('src="./light.svg"');
    const local = render("![Local](./a.png)");
    expect(local).toContain("Relative image cannot be previewed");
    expect(local).not.toContain('src="./a.png"');
  });
});
describe("explicit merge decisions", () => {
  it("reports aliases, identical bodies, heading changes and embeds", () => {
    const c = compareSections(
      fixture("merge-current"),
      fixture("merge-remote"),
    );
    expect(c.matches[1].candidates[0].reasons).toContain(
      "Different heading, identical content",
    );
    expect(c.matches[3].candidates[0].reasons).toContain(
      "Matching heading, different content",
    );
    expect(c.matches[4].candidates[0].reasons.join(" ")).toContain(
      "identical image/embed URL",
    );
    expect(c.matches[5].candidates).toHaveLength(0);
  });
  it("requires all choices and valid targets; never silently replaces twice", () => {
    const c = compareSections("## A\na", "## A\nb\n## B\nc");
    expect(() => assembleMerge(c, [])).toThrow("every imported");
    expect(() =>
      assembleMerge(c, [{ action: "use", target: "end" }, { action: "keep" }]),
    ).toThrow("current section");
    expect(() =>
      assembleMerge(c, [
        { action: "use", target: 0 },
        { action: "use", target: 0 },
      ]),
    ).toThrow("Two imported");
  });
  it("keeps, replaces, inserts before/after and appends deterministically", () => {
    const c = compareSections(
      "## A\nlocal\n\n## B\nkeep\n",
      "## A\nremote\n\n## C\nnew\n",
    );
    const keep = [{ action: "keep" }, { action: "keep" }];
    expect(assembleMerge(c, keep).markdown).toBe("## A\nlocal\n\n## B\nkeep\n");
    for (const action of ["use", "before", "after"]) {
      const choices = [
        { action, target: 0 },
        { action: "after", target: "end" },
      ];
      const result = assembleMerge(c, choices).markdown;
      expect(result).toContain("remote");
      expect(result).toContain("## B\nkeep\n");
      expect(result).toContain("## C\nnew\n");
      expect(result.includes("local")).toBe(action !== "use");
      expect(assembleMerge(c, choices).markdown).toBe(result);
      if (action === "before")
        expect(result.indexOf("remote")).toBeLessThan(result.indexOf("local"));
      if (action === "after")
        expect(result.indexOf("remote")).toBeGreaterThan(
          result.indexOf("local"),
        );
    }
  });
  it("warns for duplicates and ambiguity without deleting content", () => {
    const text = "## About\nsame\n\n## About\nsame\n";
    expect(duplicateWarnings(text)).toContain(
      "Possible duplicate section content.",
    );
    expect(compareSections(text, "## About\nsame\n").matches[0].ambiguous).toBe(
      true,
    );
    expect(
      compareSections("## A\nsame  \r\n", "## A\nsame\n").matches[0]
        .candidates[0].reasons,
    ).toContain("Possible duplicate: identical section");
    expect(
      duplicateWarnings("![a](https://x.com/a)\n![b](https://x.com/a)"),
    ).toContain("Possible duplicate image or widget embed.");
    expect(contentHash("same")).toBe(contentHash("same"));
  });
  it("does not match relative images from different repositories", () => {
    const a = "## One\n![a](./a.png)",
      b = "## Two\n![b](./a.png)";
    expect(
      compareSections(a, b, {
        currentContext: context,
        importedContext: { ...context, repository: "different" },
      }).matches[0].candidates,
    ).toHaveLength(0);
  });
  it("analyzes a 100 KB README within a generous regression budget", () => {
    const md = Array.from(
      { length: 250 },
      (_, i) => `## Section ${i}\n${"Some useful content. ".repeat(22)}\n\n`,
    ).join("");
    expect(md.length).toBeGreaterThan(100000);
    const start = performance.now();
    const c = compareSections(md, md);
    expect(c.imported).toHaveLength(250);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});
describe("import state and ownership", () => {
  it("does not add join whitespace when appending or merging into an empty raw draft", () => {
    const current = raw(""),
      payload = { name: "Remote", markdown: "# Exact\r\n  ", metadata: {} };
    expect(importPlan(current, payload, "append").markdown).toBe(
      payload.markdown,
    );
    expect(
      importPlan(current, payload, "merge", {
        comparison: compareSections("", payload.markdown),
        decisions: [{ action: "after", target: "end" }],
      }).markdown,
    ).toBe(payload.markdown);
  });
  it.each(["replace", "append", "merge"])(
    "%s is one undoable operation with source context",
    (mode) => {
      const current = raw("## Local\nKeep\n", context),
        payload = {
          name: "Remote",
          markdown: "## Remote\nnew\n",
          metadata: { importSource: { ...context, sha: "two" } },
        };
      const store = new Store(current);
      const before = structuredClone(current);
      const plan = importPlan(current, payload, mode, {
        comparison: compareSections(current.markdown, payload.markdown),
        decisions: [{ action: "after", target: 0 }],
      });
      store.blocks(plan.blocks, plan.metadata);
      expect(store.past).toHaveLength(1);
      expect(store.draft.markdown).toBe(plan.markdown);
      expect(store.draft.metadata.importSource.sha).toBe("two");
      store.undo();
      expect(store.draft).toMatchObject({
        markdown: before.markdown,
        metadata: before.metadata,
      });
      store.redo();
      expect(store.draft.markdown).toBe(plan.markdown);
    },
  );
  it("preserves Studio metadata but assigns no generated ownership to Markdown", () => {
    const backup = raw("## About\nHello");
    backup.blocks[0].profileAutofill = {
      kind: "about",
      markdown: backup.markdown,
    };
    backup.metadata.githubProfile = { username: "ada" };
    const restored = validateDraft(JSON.parse(JSON.stringify(backup)));
    expect(
      importPlan(raw("old"), restored, "new").blocks[0].profileAutofill,
    ).toEqual(backup.blocks[0].profileAutofill);
    const normal = importPlan(
      backup,
      { markdown: backup.markdown, name: "file", metadata: {} },
      "replace",
    );
    expect(normal.metadata).toEqual({});
    expect(normal.blocks[0].profileAutofill).toBeUndefined();
  });
  it("retains per-block local/GitHub origins through append, split and backup", () => {
    const local = raw("## Local\n![a](./a.png)");
    const remote = {
      name: "Remote",
      markdown: "## Remote\n![a](./a.png)",
      metadata: { importSource: context },
    };
    const plan = importPlan(local, remote, "append");
    const combined = { ...local, ...plan };
    const split = splitDraft(combined);
    expect(split[0].sourceContext).toBe(null);
    expect(split[1].sourceContext).toEqual(context);
    expect(contextAt({ ...combined, blocks: split }, 0, 10)).toBe(null);
    expect(
      validateDraft(JSON.parse(JSON.stringify(combined))).blocks[0]
        .sourceContext,
    ).toBe(null);
    const store = new Store(combined);
    // An edit that spans both origins merges them into one mixed-origin block.
    store.raw(
      combined.markdown.replace(
        /a\.png\)(\s+)## Remote/,
        "b.png)$1## Remote 2",
      ),
    );
    expect(store.draft.blocks).toHaveLength(1);
    expect(store.draft.blocks[0].sourceContext).toEqual({ type: "mixed" });
  });
  it("keeps original source context after raw edits to a single-origin import", () => {
    const store = new Store({
      ...raw(""),
      ...importedDraft({
        name: "remote",
        markdown: "## A\r\n",
        metadata: { importSource: context },
      }),
    });
    store.raw("## A\r\nnew");
    expect(store.draft.blocks[0].sourceContext).toEqual(context);
  });
});
describe("bounded public GitHub imports", () => {
  it.each([
    "ada",
    "@ada",
    "https://github.com/ada",
    "https://github.com/ada/ada",
  ])("accepts %s", (input) =>
    expect(githubRepository(input)).toEqual({
      owner: "ada",
      repository: "ada",
    }),
  );
  it.each([
    "https://evil.com/ada",
    "a/b/c",
    "../repo",
    "https://github.com.evil.com/ada",
    "https://user:pass@github.com/ada",
  ])("rejects %s", (input) => expect(() => githubRepository(input)).toThrow());
  it("preserves UTF-8, BOM, CRLF, path, SHA and time", async () => {
    const md = "\uFEFF# Héllo\r\n  exact  \r\n";
    const result = await importGithub("ada/tools", async (url) =>
      response(url.includes("/readme") ? file(md) : { default_branch: "main" }),
    );
    expect(result.markdown).toBe(md);
    expect(result.metadata.importSource).toMatchObject({
      readmePath: "docs/README.MD",
      sha: "one",
      ref: "main",
    });
    expect(Date.parse(result.metadata.importSource.fetchedAt)).not.toBeNaN();
  });
  it.each([
    [404, "Repository not found"],
    [403, "rate limit"],
    [429, "rate limit"],
    [500, "API error"],
  ])("explains status %s", async (status, message) => {
    await expect(
      importGithub("ada", async () => response({}, status)),
    ).rejects.toThrow(message);
  });
  it("distinguishes missing README and malformed responses", async () => {
    await expect(
      importGithub("ada", async (url) =>
        url.includes("/readme")
          ? response({}, 404)
          : response({ default_branch: "main" }),
      ),
    ).rejects.toThrow("Repository exists");
    await expect(
      importGithub("ada", async () => response(null)),
    ).rejects.toThrow("malformed repository");
    await expect(
      importGithub("ada", async (url) =>
        response(url.includes("/readme") ? null : { default_branch: "main" }),
      ),
    ).rejects.toThrow("malformed README");
    await expect(
      importGithub("ada", async () => ({
        ok: true,
        text: async () => "<html>",
      })),
    ).rejects.toThrow("malformed metadata");
  });
  it("rejects large metadata-declared content and UTF-8 byte overflow", async () => {
    await expect(
      importGithub("ada", async (url) =>
        response(
          url.includes("/readme")
            ? file("", { size: IMPORT_LIMIT + 1 })
            : { default_branch: "main" },
        ),
      ),
    ).rejects.toThrow("2 MB");
    await expect(
      boundedText({ text: async () => "🌍".repeat(3) }, 10),
    ).rejects.toThrow("2 MB");
  });
  it("cancels streaming overflow without consuming the entire stream", async () => {
    const cancel = vi.fn(),
      releaseLock = vi.fn(),
      read = vi
        .fn()
        .mockResolvedValue({ done: false, value: new Uint8Array(12) });
    await expect(
      boundedText(
        { body: { getReader: () => ({ read, cancel, releaseLock }) } },
        10,
      ),
    ).rejects.toThrow("2 MB");
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
  it("falls back to bounded raw content and detects a concurrent remote update", async () => {
    const run = async (changed) => {
      let reads = 0;
      return importGithub("ada", async (url, options) => {
        if (!url.includes("/readme"))
          return response({ default_branch: "main" });
        if (options.headers.Accept.includes("raw"))
          return { ok: true, text: async () => "# Raw\n" };
        return response(
          file("", {
            encoding: "none",
            size: 6,
            content: "",
            sha: reads++ && changed ? "two" : "one",
          }),
        );
      });
    };
    expect((await run(false)).markdown).toBe("# Raw\n");
    await expect(run(true)).rejects.toThrow("changed during import");
  });
  it("aborts on timeout and explicit cancellation", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = (_, options) =>
        new Promise((_, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(options.signal.reason),
          ),
        );
      const result = importGithub("ada", fetcher);
      const rejected = expect(result).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(20001);
      await rejected;
      const cancel = new AbortController();
      cancel.abort();
      await expect(
        importGithub("ada", fetcher, cancel.signal),
      ).rejects.toHaveProperty("name", "AbortError");
    } finally {
      vi.useRealTimers();
    }
  });
  it("compares source versions", () => {
    expect(sourceChange(context, context)).toBe("No remote changes");
    expect(sourceChange(context, { ...context, sha: "two" })).toBe(
      "Remote README has changed",
    );
  });
  it("rejects truncated content and unsupported encoding", async () => {
    for (const extra of [{ size: 99 }, { encoding: "unexpected" }])
      await expect(
        importGithub("ada", async (url) =>
          response(
            url.includes("/readme")
              ? file("# A", extra)
              : { default_branch: "main" },
          ),
        ),
      ).rejects.toThrow(/incomplete|malformed/);
  });
});
