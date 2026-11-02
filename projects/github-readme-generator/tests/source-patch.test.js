// Golden cases for source-preserving raw edits (#77, ADR epic63-01/02).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  changedRange,
  patchBlocks,
  moveBlock,
  readDetachments,
  isRestorable,
  detachmentNotice,
  ownershipKind,
  DETACHMENT_LIMIT,
} from "../src/markdown/source-patch.js";
import { documentSegments } from "../src/markdown/source-context.js";
import {
  createBlock,
  serializeBlock,
  serializeBlocks,
} from "../src/markdown/serialize.js";
import { splitDraft } from "../src/state/import-plan.js";
import { newDraft, validateDraft } from "../src/state/drafts.js";
import { Store } from "../src/state/store.js";
import { generatedRegistry } from "../src/generated/registry.js";
import { createProject, inspectProject } from "../src/studio-projects/model.js";
import { createBackup } from "../src/state/workspace-backup.js";
import { withoutDetachedCopies } from "../src/state/drafts.js";
import { newBanner } from "../src/banners/banner-model.js";

const fixture = (name) =>
  readFileSync(`tests/fixtures/round-trip/${name}`, "utf8");
const FIXTURES = [
  "crlf.md",
  "mixed-eol.md",
  "bom.md",
  "no-final-newline.md",
  "trailing-whitespace.md",
  "fences.md",
  "html.md",
];
const custom = (markdown) =>
  newDraft("Doc", [createBlock("custom", { markdown })]);
const split = (markdown, levels = [1, 2]) => {
  const d = custom(markdown);
  return { ...d, blocks: splitDraft(d, levels) };
};
const apply = (source, { start, end, text }) =>
  source.slice(0, start) + text + source.slice(end);
const typed = () => {
  const blocks = [
    createBlock("hero", { name: "Ada", subtitle: "Builds things." }),
    createBlock("stack", { items: [{ name: "JavaScript" }], style: "text" }),
    {
      ...createBlock("component", {
        name: "Banner",
        markdown: '<p align="center">Banner</p>',
      }),
    },
    {
      ...createBlock("custom", { markdown: "## Repositories\n\n- demo" }),
      githubGenerated: {
        version: 1,
        repositories: ["example-user/demo"],
        options: { action: "summary" },
        generatedValue: "## Repositories\n\n- demo",
      },
    },
    createBlock("custom", { markdown: "Closing note." }),
  ];
  return newDraft("Typed", blocks);
};
const at = (draft, index) => documentSegments(draft)[index];

// Runs one golden case through Store.raw and checks the shared invariants:
// exact bytes, untouched Blocks deep-equal, and an exact Undo snapshot.
function golden(draft, edit, touchedIds = null) {
  const before = structuredClone(draft);
  const store = new Store(structuredClone(draft));
  const next = apply(before.markdown, edit);
  const result = store.raw(next);
  expect(store.draft.markdown).toBe(next);
  expect(serializeBlocks(store.draft.blocks)).toBe(next);
  if (next !== before.markdown) {
    expect(store.past.at(-1)).toEqual(before);
    expect(result.fallback).toBe(false);
  }
  const range = changedRange(before.markdown, next);
  const touched =
    touchedIds ||
    (range
      ? documentSegments(before)
          .map((s, i) => ({ s, b: before.blocks[i] }))
          .filter(
            ({ s }) =>
              (s.end > range.start && s.start < range.end) ||
              (range.start === range.end &&
                s.start <= range.start &&
                range.start <= s.end),
          )
          .map(({ b }) => b.id)
      : []);
  for (const block of before.blocks.filter((b) => !touched.includes(b.id))) {
    const kept = store.draft.blocks.find((b) => b.id === block.id);
    expect(kept, `untouched ${block.id} kept`).toBeTruthy();
    const { separator: _a, ...rest } = kept;
    const { separator: _b, ...orig } = block;
    expect(rest).toEqual(orig);
  }
  store.undo();
  expect({ ...store.draft, updated: 0 }).toEqual({ ...before, updated: 0 });
  return { store, result, next };
}

describe("changedRange", () => {
  it("returns null for equal text and the minimal range otherwise", () => {
    expect(changedRange("same", "same")).toBe(null);
    expect(changedRange("abc", "abXc")).toEqual({
      start: 2,
      end: 2,
      text: "X",
    });
    expect(changedRange("abc", "")).toEqual({ start: 0, end: 3, text: "" });
    expect(changedRange("", "new")).toEqual({ start: 0, end: 0, text: "new" });
  });
  it("never splits a CRLF pair or a surrogate pair", () => {
    expect(changedRange("a\r\nb", "a\rx\nb")).toEqual({
      start: 1,
      end: 3,
      text: "\rx\n",
    });
    expect(changedRange("a\r\nb", "a\rb")).toEqual({
      start: 1,
      end: 3,
      text: "\r",
    });
    expect(changedRange("a\nb", "a\r\nb")).toEqual({
      start: 1,
      end: 2,
      text: "\r\n",
    });
    const r = changedRange("x😀y", "x😁y");
    expect(r).toEqual({ start: 1, end: 3, text: "😁" });
  });
  it("satisfies the range identity for random edits", () => {
    const pieces = ["a", "\r\n", "\n", "😀", " ", "#"];
    let seed = 7;
    const rand = (n) => (((seed = (seed * 48271) % 2147483647) % n) + n) % n;
    for (let k = 0; k < 300; k++) {
      const make = () =>
        Array.from(
          { length: rand(12) },
          () => pieces[rand(pieces.length)],
        ).join("");
      const a = make(),
        b = make();
      const r = changedRange(a, b);
      if (a === b) expect(r).toBe(null);
      else {
        expect(a.slice(0, r.start) + r.text + a.slice(r.end), `seed ${k}`).toBe(
          b,
        );
        expect(a[r.start - 1] === "\r" && a[r.start] === "\n").toBe(false);
      }
    }
  });
});

describe("golden fixtures keep untouched Blocks byte for byte", () => {
  it.each(FIXTURES)("%s: offset 0, EOF and mid-section edits", (name) => {
    const source = fixture(name);
    for (const levels of [[1], [1, 2], [1, 2, 3]]) {
      const draft = split(source, levels);
      expect(draft.markdown).toBe(source);
      golden(draft, { start: 0, end: 0, text: "Lead " });
      golden(draft, {
        start: source.length,
        end: source.length,
        text: "\nTail",
      });
      const mid = Math.floor(source.length / 2);
      golden(draft, { start: mid, end: mid + 1, text: "Z" });
    }
  });
  it("keeps BOM, CRLF, tabs and hard breaks outside the Edited scope", () => {
    for (const name of FIXTURES) {
      const source = fixture(name),
        draft = split(source);
      const last = draft.blocks.length - 1;
      const seg = at(draft, last);
      const { next, store } = golden(draft, {
        start: seg.end - 1,
        end: seg.end - 1,
        text: "!",
      });
      expect(next.slice(0, seg.start)).toBe(source.slice(0, seg.start));
      expect(store.draft.blocks.length).toBe(draft.blocks.length);
    }
  });
  it("an edit inside a CRLF pair stays exact and touches one section", () => {
    const source = fixture("crlf.md"),
      draft = split(source);
    const k = source.indexOf("\r\n", source.indexOf("## Usage")) + 1;
    const { store } = golden(draft, { start: k, end: k, text: "x" });
    const after = store.draft;
    store.redo();
    expect(store.draft.markdown).toBe(
      source.slice(0, k) + "x" + source.slice(k),
    );
    expect(store.draft.blocks.map((b) => b.id)).toEqual(
      draft.blocks.map((b) => b.id),
    );
    expect(after).toBeTruthy();
  });
  it("a no-op raw edit records nothing", () => {
    const store = new Store(split(fixture("html.md")));
    expect(store.raw(store.draft.markdown)).toBeUndefined();
    expect(store.past).toHaveLength(0);
  });
  it("editing a split section keeps its ID, section and source context", () => {
    const draft = split(fixture("fences.md"));
    const seg = at(draft, 1);
    const { store, result } = golden(draft, {
      start: seg.contentStart + 2,
      end: seg.contentStart + 3,
      text: "q",
    });
    store.redo();
    expect(store.draft.blocks[1].id).toBe(draft.blocks[1].id);
    expect(store.draft.blocks[1].section).toEqual(draft.blocks[1].section);
    expect(result.detachments).toEqual([]);
  });
});

describe("Owned blocks and Detachment records", () => {
  it("typing between two builder blocks detaches nothing", () => {
    const draft = typed();
    const seam = at(draft, 1);
    const pos = seam.start + 1;
    const { result, store } = golden(draft, {
      start: pos,
      end: pos,
      text: "Hello",
    });
    expect(result.detachments).toEqual([]);
    store.redo();
    expect(store.draft.blocks).toHaveLength(draft.blocks.length + 1);
    expect(store.draft.blocks[1].type).toBe("custom");
    expect(store.draft.metadata.detachments).toBeUndefined();
    // Whitespace typed into a Seam changes only that Seam.
    const blank = golden(draft, { start: pos, end: pos, text: "\n" });
    expect(blank.result.blocks).toHaveLength(draft.blocks.length);
    expect(blank.result.blocks[1].separator).toBe("\n\n\n");
  });
  it("an edit inside one builder block makes a Restorable record", () => {
    const draft = typed();
    const seg = at(draft, 1);
    const k = seg.source.indexOf("JavaScript") + seg.start;
    const { result } = golden(draft, { start: k, end: k + 4, text: "Type" }, [
      draft.blocks[1].id,
    ]);
    const [record] = result.detachments;
    expect(record).toMatchObject({
      version: 1,
      previousBlockIds: [draft.blocks[1].id],
      labels: ["Tech Stack"],
      kinds: ["builder"],
      previous: draft.blocks[1],
    });
    expect(record.blockId).not.toBe(draft.blocks[1].id);
    expect(result.blocks[1].id).toBe(record.blockId);
    expect(result.blocks[1].type).toBe("custom");
    expect(isRestorable(record)).toBe(true);
    expect(Date.parse(record.at)).not.toBeNaN();
    expect(readDetachments(result.metadata)).toEqual([record]);
    expect(detachmentNotice(result)).toBe(
      "Raw edit detached: Tech Stack (builder). Undo restores visual ownership.",
    );
    expect(result.blocks.map(serializeBlock).join("")).not.toContain("version");
  });
  it("bounds Restorable copies by UTF-8 bytes", () => {
    const block = createBlock("about", {
      title: "About",
      body: "界".repeat(12_000),
    });
    const draft = newDraft("Large", [block]);
    const start = draft.markdown.indexOf("界");

    const { result } = golden(draft, { start, end: start + 1, text: "文" }, [
      block.id,
    ]);

    expect(
      new TextEncoder().encode(JSON.stringify(block)).length,
    ).toBeGreaterThan(32 * 1024);
    expect(result.detachments[0].previous).toBe(null);
    expect(isRestorable(result.detachments[0])).toBe(false);
  });
  it("typing at the end of a builder block's text edits that block", () => {
    const draft = typed();
    const seg = at(draft, 1);
    const { result } = golden(
      draft,
      { start: seg.end, end: seg.end, text: ", Rust" },
      [draft.blocks[1].id],
    );
    expect(result.blocks).toHaveLength(draft.blocks.length);
    expect(result.detachments[0].previousBlockIds).toEqual([
      draft.blocks[1].id,
    ]);
    expect(serializeBlock(result.blocks[1])).toContain("JavaScript, Rust");
    // Typing at the start of the next block's text edits that block instead.
    const next = at(draft, 2);
    const start = golden(
      draft,
      { start: next.contentStart, end: next.contentStart, text: "X" },
      [draft.blocks[2].id],
    );
    expect(start.result.detachments[0].kinds).toEqual(["component"]);
  });
  it("an edit inside a component keeps the record Restorable", () => {
    const draft = typed();
    const seg = at(draft, 2);
    const { result } = golden(
      draft,
      { start: seg.contentStart + 3, end: seg.contentStart + 3, text: " " },
      [draft.blocks[2].id],
    );
    expect(result.detachments[0].kinds).toEqual(["component"]);
    expect(result.detachments[0].labels).toEqual(["Banner"]);
    expect(isRestorable(result.detachments[0])).toBe(true);
  });
  it("an edit spanning two Owned blocks merges them without being Restorable", () => {
    const draft = typed();
    const a = at(draft, 0),
      b = at(draft, 1);
    const { result } = golden(
      draft,
      { start: a.end - 3, end: b.contentStart + 4, text: "--" },
      [draft.blocks[0].id, draft.blocks[1].id],
    );
    expect(result.blocks).toHaveLength(draft.blocks.length - 1);
    const [record] = result.detachments;
    expect(record.previousBlockIds).toEqual([
      draft.blocks[0].id,
      draft.blocks[1].id,
    ]);
    expect(record.kinds).toEqual(["builder", "builder"]);
    expect(record.previous).toBe(null);
    expect(isRestorable(record)).toBe(false);
    expect(result.blocks[0].section).toBeUndefined();
  });
  it("detaches only the touched generated section", () => {
    const draft = typed();
    draft.blocks.push({
      ...createBlock("custom", { markdown: "## Other\n\n- tool" }),
      githubGenerated: {
        version: 1,
        repositories: ["example-user/tool"],
        options: { action: "summary" },
        generatedValue: "## Other\n\n- tool",
      },
    });
    draft.markdown = serializeBlocks(draft.blocks);
    const seg = at(draft, 3);
    const { result } = golden(
      draft,
      { start: seg.end - 1, end: seg.end, text: "x" },
      [draft.blocks[3].id],
    );
    expect(result.detachments[0].kinds).toEqual(["generated"]);
    expect(result.metadata.detachedGenerated.map((u) => u.id)).toEqual([
      `repository:${draft.blocks[3].id}`,
    ]);
    const units = generatedRegistry({ ...draft, ...result });
    expect(
      units.find((u) => u.id === `repository:${draft.blocks[5].id}`).ownership,
    ).toBe("generated");
    expect(isRestorable(result.detachments[0])).toBe(false);
  });
  it("drops bannerReference only when the banner block is touched", () => {
    const draft = typed();
    draft.metadata.bannerReference = {
      blockId: draft.blocks[4].id,
      source: "Closing note.",
    };
    const seg = at(draft, 1);
    const elsewhere = golden(draft, {
      start: seg.contentStart + 1,
      end: seg.contentStart + 2,
      text: "!",
    });
    expect(elsewhere.result.metadata.bannerReference).toEqual(
      draft.metadata.bannerReference,
    );
    const banner = at(draft, 4);
    const touched = golden(
      draft,
      { start: banner.end - 1, end: banner.end, text: "!" },
      [draft.blocks[4].id],
    );
    expect(touched.result.metadata.bannerReference).toBeUndefined();
    expect(touched.result.detachments[0].kinds).toEqual(["banner"]);
  });
  it("deleting a whole block leaves no empty block and no record", () => {
    const draft = typed();
    const seg = at(draft, 1);
    const { result } = golden(
      draft,
      { start: seg.start, end: seg.end, text: "" },
      [draft.blocks[1].id],
    );
    expect(result.blocks.map((b) => b.id)).toEqual(
      draft.blocks.filter((_, i) => i !== 1).map((b) => b.id),
    );
    expect(result.detachments).toEqual([]);
  });
  it("an empty document or emptied document makes no records", () => {
    const empty = newDraft("Empty");
    const first = golden(empty, { start: 0, end: 0, text: "Hello" });
    expect(first.result.blocks).toHaveLength(1);
    expect(first.result.detachments).toEqual([]);
    const draft = typed();
    const cleared = golden(
      draft,
      {
        start: 0,
        end: draft.markdown.length,
        text: "",
      },
      draft.blocks.map((b) => b.id),
    );
    expect(cleared.result.blocks).toEqual([]);
    expect(cleared.result.detachments).toEqual([]);
  });
  it("keeps the 20 newest records", () => {
    const draft = typed();
    draft.metadata.detachments = Array.from(
      { length: DETACHMENT_LIMIT },
      (_, i) => ({ version: 1, id: `old-${i}`, blockId: "gone" }),
    );
    const seg = at(draft, 0);
    const { result } = golden(draft, {
      start: seg.contentStart + 2,
      end: seg.contentStart + 3,
      text: "B",
    });
    expect(result.metadata.detachments).toHaveLength(DETACHMENT_LIMIT);
    expect(result.metadata.detachments[0].id).toBe("old-1");
    expect(result.metadata.detachments.at(-1)).toEqual(result.detachments[0]);
    // Malformed entries are ignored by readers but never rewritten.
    expect(readDetachments(result.metadata)).toEqual(result.detachments);
  });
  it("never blocks raw editing when a block cannot be serialized", () => {
    const draft = typed();
    draft.blocks[0] = createBlock("doc-overview", { version: 99 });
    const store = new Store(draft);
    const result = store.raw("Replaced");
    expect(result.fallback).toBe(true);
    expect(store.draft.markdown).toBe("Replaced");
    expect(serializeBlocks(store.draft.blocks)).toBe("Replaced");
  });
  it("keeps standalone banner settings during an unrelated fallback edit", () => {
    const draft = typed();
    draft.blocks[0] = createBlock("doc-overview", { version: 99 });
    draft.metadata.bannerSettings = {
      ...newBanner(),
      name: "Saved banner draft",
    };
    const expected = structuredClone(draft.metadata.bannerSettings);
    const store = new Store(draft);

    const result = store.raw("Replaced");

    expect(result.fallback).toBe(true);
    expect(store.draft.metadata.bannerSettings).toEqual(expected);
  });
  it("falls back to one Custom Markdown block with a non-Restorable record", () => {
    const draft = typed();
    draft.markdown += "drift"; // blocks no longer reproduce the Source
    const result = patchBlocks(draft, draft.markdown + "!");
    expect(result.fallback).toBe(true);
    expect(serializeBlocks(result.blocks)).toBe(draft.markdown + "!");
    expect(result.blocks).toHaveLength(1);
    expect(result.detachments).toHaveLength(1);
    expect(isRestorable(result.detachments[0])).toBe(false);
    expect(detachmentNotice(result)).toBe(
      "All sections became Custom Markdown; Undo restores them.",
    );
    expect(
      detachmentNotice({ ...result, detachments: [], previousCount: 1 }),
    ).toBe("");
  });
});

describe("Edits that reach a Seam or change several places", () => {
  it("deleting a section's last line keeps the next builder block", () => {
    const draft = newDraft("Doc", [
      createBlock("custom", { markdown: "## Notes\n\nFirst line\nlast line" }),
      createBlock("stack", { items: [{ name: "JavaScript" }], style: "text" }),
    ]);
    const start = draft.markdown.indexOf("last line");
    const { result } = golden(
      draft,
      { start, end: start + "last line\n".length, text: "" },
      [draft.blocks[0].id],
    );
    expect(result.blocks.map((b) => b.id)).toEqual(
      draft.blocks.map((b) => b.id),
    );
    expect(result.blocks[0].settings.markdown).toBe("## Notes\n\nFirst line");
    expect(result.detachments).toEqual([]);
    expect(detachmentNotice(result)).toBe("");
  });
  it("an edit that ends in the next block's Seam detaches only the edited block", () => {
    const draft = newDraft("Doc", [
      createBlock("hero", { name: "Ada", subtitle: "S" }),
      createBlock("divider", {}),
    ]);
    const next = draft.markdown.replace("\nS\n", "x");
    expect(next).toBe("# Ada\nx\n---");
    const store = new Store(structuredClone(draft));
    const result = store.raw(next);
    expect(result.fallback).toBe(false);
    expect(serializeBlocks(store.draft.blocks)).toBe(next);
    expect(store.draft.blocks[1]).toEqual({
      ...draft.blocks[1],
      separator: "\n",
    });
    expect(result.detachments.map((r) => r.kinds)).toEqual([["builder"]]);
  });
  it("changes on either side of Owned blocks leave those blocks alone", () => {
    const draft = newDraft("Doc", [
      createBlock("custom", { markdown: "## Install\n\nnpm install old-pkg" }),
      createBlock("hero", { name: "Ada", subtitle: "Builds things." }),
      createBlock("stack", { items: [{ name: "JavaScript" }], style: "text" }),
      createBlock("custom", { markdown: "## Usage\n\nRun `old-cmd`" }),
    ]);
    const store = new Store(structuredClone(draft));
    const next = draft.markdown
      .replace("old-pkg", "new-pkg")
      .replace("old-cmd", "new-cmd");
    const result = store.raw(next);
    expect(result.fallback).toBe(false);
    expect(store.draft.markdown).toBe(next);
    expect(store.draft.blocks.map((b) => b.id)).toEqual(
      draft.blocks.map((b) => b.id),
    );
    expect(store.draft.blocks.slice(1, 3)).toEqual(draft.blocks.slice(1, 3));
    expect(result.detachments).toEqual([]);
    store.undo();
    expect(store.draft.blocks).toEqual(draft.blocks);
  });
  it("records one Detachment per changed Owned block", () => {
    const draft = typed();
    const hero = at(draft, 0),
      last = at(draft, 4);
    const store = new Store(structuredClone(draft));
    let next = apply(draft.markdown, {
      start: last.contentStart,
      end: last.contentStart + 7,
      text: "Final",
    });
    next = apply(next, {
      start: hero.contentStart + 2,
      end: hero.contentStart + 5,
      text: "Grace",
    });
    const result = store.raw(next);
    expect(result.fallback).toBe(false);
    expect(serializeBlocks(store.draft.blocks)).toBe(next);
    for (const k of [1, 2, 3])
      expect(store.draft.blocks[k]).toEqual(draft.blocks[k]);
    expect(store.draft.blocks[4].id).toBe(draft.blocks[4].id);
    expect(result.detachments.map((r) => r.previousBlockIds)).toEqual([
      [draft.blocks[0].id],
    ]);
    expect(detachmentNotice(result)).toBe(
      "Raw edit detached: Ada (builder). Undo restores visual ownership.",
    );
  });
  it("seeded edits in two places keep every Owned block between them", () => {
    for (let seed = 1; seed <= 150; seed++) {
      let state = seed;
      const rand = (n) => {
        state = (state * 48271) % 2147483647;
        return state % n;
      };
      const blocks = [
        createBlock("custom", { markdown: "## One\n\nalpha beta" }),
        ...Array.from({ length: 1 + rand(3) }, (_, i) =>
          rand(2)
            ? createBlock("divider", {})
            : createBlock("hero", { name: "Ada" + i, subtitle: "S" }),
        ),
        createBlock("custom", { markdown: "## Two\n\ngamma delta" }),
      ];
      const draft = newDraft("Doc", blocks);
      const segs = documentSegments(draft);
      const pieces = ["x", "", "\nnew line\n", "zz", "😀"];
      const edit = (seg) => {
        const start =
          seg.contentStart + 3 + rand(seg.end - seg.contentStart - 3);
        return {
          start,
          end: Math.min(seg.end, start + rand(3)),
          text: pieces[rand(pieces.length)],
        };
      };
      const second = edit(segs.at(-1)),
        first = edit(segs[0]);
      const next = apply(apply(draft.markdown, second), first);
      if (next === draft.markdown) continue;
      const result = patchBlocks(draft, next);
      expect(result.fallback, `seed ${seed}`).toBe(false);
      expect(serializeBlocks(result.blocks), `seed ${seed}`).toBe(next);
      for (const block of blocks.slice(1, -1))
        expect(
          result.blocks.find((b) => b.id === block.id),
          `seed ${seed}`,
        ).toEqual(block);
      expect(result.detachments, `seed ${seed}`).toEqual([]);
    }
  });
});

describe("Edits at a Block boundary never leave a changed line Owned", () => {
  const sample = () =>
    newDraft("Doc", [
      createBlock("custom", { markdown: "# Intro\n\nHello" }),
      createBlock("divider", {}),
      createBlock("custom", { markdown: "## Tech\n\nWords here" }),
      createBlock("custom", { markdown: "## End\n" }),
    ]);
  it("an edit from the end of a builder line into the next block detaches it", () => {
    const draft = sample();
    const start = draft.markdown.indexOf("---") + 3;
    const end = draft.markdown.indexOf("## Tech") + "## Tech".length;
    const { result } = golden(draft, { start, end, text: " more" }, [
      draft.blocks[1].id,
      draft.blocks[2].id,
    ]);
    expect(result.blocks.find((b) => b.id === draft.blocks[1].id)).toBe(
      undefined,
    );
    expect(result.detachments.map((r) => r.previousBlockIds)).toEqual([
      [draft.blocks[1].id],
    ]);
    expect(detachmentNotice(result)).toBe(
      "Raw edit detached: Divider (builder). Undo restores visual ownership.",
    );
    expect(serializeBlock(result.blocks[1])).toBe("--- more\n\nWords here");
    // A multi-place edit whose change starts right after the divider.
    const store = new Store(sample());
    const md = store.draft.markdown;
    const multi = store.raw(md.replace("---", "----").replace("Tech", "Stack"));
    expect(serializeBlocks(store.draft.blocks)).toBe(store.draft.markdown);
    expect(store.draft.blocks.some((b) => b.type === "divider")).toBe(false);
    expect(multi.detachments[0].kinds).toEqual(["builder"]);
  });
  it("an edit that starts a new line after a builder block leaves it Owned", () => {
    const draft = sample();
    const start = draft.markdown.indexOf("---") + 3;
    const end = draft.markdown.indexOf("## Tech") + 2;
    const { result } = golden(draft, { start, end, text: "\n\nNew\n\n##" }, [
      draft.blocks[2].id,
    ]);
    expect(result.blocks[1]).toEqual(draft.blocks[1]);
    expect(result.detachments).toEqual([]);
  });
  it("removing the line break before a builder heading detaches both blocks", () => {
    const store = new Store(
      newDraft("Doc", [
        createBlock("hero", { name: "Ada", subtitle: "Builds things." }),
        createBlock("stack", {
          items: [{ name: "JavaScript" }],
          style: "text",
        }),
      ]),
    );
    const notices = [];
    for (let k = 0; k < 2; k++) {
      const md = store.draft.markdown,
        at = md.indexOf("## Tech");
      notices.push(
        detachmentNotice(store.raw(md.slice(0, at - 1) + md.slice(at))),
      );
    }
    expect(store.draft.markdown).toBe(
      "# Ada\n\nBuilds things.## Tech Stack\n\nJavaScript",
    );
    expect(notices).toEqual([
      "",
      "Raw edit detached: Ada (builder), Tech Stack (builder). Undo restores visual ownership.",
    ]);
    expect(store.draft.blocks.map((b) => b.type)).toEqual(["custom"]);
    // Spaces after the line break only indent the heading: a Seam change.
    store.undo();
    store.undo();
    const md = store.draft.markdown,
      at = md.indexOf("## Tech");
    const indent = store.raw(md.slice(0, at) + " " + md.slice(at));
    expect(indent.detachments).toEqual([]);
    expect(store.draft.blocks.map((b) => b.type)).toEqual(["hero", "stack"]);
    expect(store.draft.blocks[1].separator).toBe("\n\n ");
  });
  it("a single edit that moves an Owned block records its Detachment", () => {
    const blocks = [
      createBlock("custom", { markdown: "# Readme\n\nIntro." }),
      createBlock("divider", {}),
      createBlock("component", {
        name: "Banner",
        markdown: '<p align="center">Banner</p>',
      }),
      createBlock("custom", { markdown: "Closing." }),
    ];
    const store = new Store(newDraft("Doc", blocks));
    const result = store.raw(
      '# Readme\n\nIntro.\n\n<p align="center">Banner</p>\n\n---\n\nClosing.',
    );
    expect(result.fallback).toBe(false);
    expect(store.draft.blocks.some((b) => b.id === blocks[1].id)).toBe(false);
    const [record] = result.detachments;
    expect(record.previousBlockIds).toEqual([blocks[1].id]);
    expect(record.kinds).toEqual(["builder"]);
    expect(isRestorable(record)).toBe(false);
    const host = store.draft.blocks.find((b) => b.id === record.blockId);
    expect(serializeBlock(host)).toContain("---");
    expect(detachmentNotice(result)).toBe(
      "Raw edit detached: Divider (builder). Undo restores visual ownership.",
    );
    expect(readDetachments(store.draft.metadata)).toEqual([record]);
  });
  it("every reorder in one edit keeps or records each Owned block", () => {
    const pool = () => [
      createBlock("custom", { markdown: "# Readme\n\nIntro." }),
      createBlock("hero", { name: "Ada", subtitle: "Builds things." }),
      createBlock("stack", { items: [{ name: "JavaScript" }], style: "text" }),
      createBlock("divider", {}),
      createBlock("custom", { markdown: "Closing." }),
    ];
    const perms = (a) =>
      a.length <= 1
        ? [a]
        : a.flatMap((x, i) =>
            perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]),
          );
    for (const order of perms([0, 1, 2, 3, 4]))
      for (const edit of [false, true]) {
        const blocks = pool();
        const draft = newDraft("Doc", blocks);
        let next = order.map((k) => serializeBlock(blocks[k])).join("\n\n");
        if (edit) next = next.replace("Intro.", "Intro, revised.");
        const result = patchBlocks(draft, next);
        expect(serializeBlocks(result.blocks)).toBe(next);
        const ids = new Set(result.blocks.map((b) => b.id));
        const recorded = new Set(
          result.detachments.flatMap((r) => r.previousBlockIds),
        );
        for (const b of blocks.filter((b) => b.type !== "custom")) {
          const kept = result.blocks.find((x) => x.id === b.id);
          if (kept) expect(serializeBlock(kept)).toBe(serializeBlock(b));
          expect(
            ids.has(b.id) || recorded.has(b.id),
            `${order} ${b.type}`,
          ).toBe(true);
        }
      }
  });
});

describe("Seams belong to positions", () => {
  it("moving the last split section up never glues it to the next heading", () => {
    const source = fixture("no-final-newline.md");
    const draft = split(source);
    const last = draft.blocks.length - 1;
    const moved = moveBlock(draft.blocks, last, "up");
    expect(serializeBlocks(moved)).toBe(
      "## Last\n\nThe file ends without a line break.\n\n# No final newline\n\nIntro.\n\n",
    );
    const { separator: _s, ...first } = moved[1];
    const { separator: _t, ...original } = draft.blocks[0];
    expect(first).toEqual(original);
    // Moving it back keeps the position's blank-line Seam: still nothing glued.
    expect(serializeBlocks(moveBlock(moved, 0, "down"))).toBe(
      "# No final newline\n\nIntro.\n\n\n\n## Last\n\nThe file ends without a line break.",
    );
    // Before Epic 02 the swapped empty separators glued "break.# No final".
    expect(serializeBlocks(moved)).not.toContain("break.#");
  });
  it("keeps other Seams' bytes when moving and removing", () => {
    const draft = split(fixture("crlf.md"));
    const moved = moveBlock(draft.blocks, 1, "down");
    expect(moved.map((b) => b.separator)).toEqual(
      draft.blocks.map((b) => b.separator),
    );
    const removed = moveBlock(draft.blocks, 1, "remove");
    const seg = at(draft, 1);
    expect(serializeBlocks(removed)).toBe(
      draft.markdown.slice(0, seg.start) + draft.markdown.slice(seg.end),
    );
    const typedDraft = typed();
    expect(serializeBlocks(moveBlock(typedDraft.blocks, 0, "down"))).toBe(
      [1, 0, 2, 3, 4]
        .map((i) => serializeBlock(typedDraft.blocks[i]))
        .join("\n\n"),
    );
  });
});

describe("Detachment records travel with the document", () => {
  const detached = () => {
    const draft = typed();
    const seg = at(draft, 1);
    const store = new Store(draft);
    store.raw(
      apply(draft.markdown, {
        start: seg.contentStart + 3,
        end: seg.contentStart + 4,
        text: "!",
      }),
    );
    return store.draft;
  };
  it("remaps blockId when IDs are regenerated and drops orphaned records", () => {
    const d = detached();
    const record = d.metadata.detachments[0];
    d.metadata.detachments.push(
      { ...record, id: "orphan", blockId: "missing" },
      "malformed",
    );
    const copy = validateDraft(JSON.parse(JSON.stringify(d)));
    const index = d.blocks.findIndex((b) => b.id === record.blockId);
    expect(copy.metadata.detachments).toHaveLength(2);
    expect(copy.metadata.detachments[0].blockId).toBe(copy.blocks[index].id);
    expect(copy.metadata.detachments[0].blockId).not.toBe(record.blockId);
    expect(copy.metadata.detachments[1]).toBe("malformed");
    const kept = validateDraft(JSON.parse(JSON.stringify(d)), {
      preserveBlockIds: true,
    });
    expect(kept.metadata.detachments[0]).toEqual(record);
  });
  it("rides along in Studio projects and never appears in Markdown", () => {
    const d = detached();
    const project = createProject(d);
    expect(project.document.markdown).toBe(d.markdown);
    expect(project.document.markdown).not.toContain("previousBlockIds");
    const opened = inspectProject(JSON.stringify(project)).draft;
    // The edit removed "Tech Stack" from the Markdown, so the file names the
    // section generically.
    expect(d.markdown).not.toContain("Tech Stack");
    expect(opened.metadata.detachments).toEqual(
      d.metadata.detachments.map((r) => ({
        ...r,
        labels: ["Builder section"],
        previous: null,
      })),
    );
  });
  it("leaves out removed section names and records of deleted sections", () => {
    const draft = newDraft("Doc", [
      createBlock("about", { title: "Falcon codename plan", body: "Body" }),
      createBlock("custom", { markdown: "End." }),
    ]);
    const store = new Store(draft);
    store.raw(store.draft.markdown.replace("Falcon codename plan", "About"));
    const [record] = store.draft.metadata.detachments;
    expect(record.labels).toEqual(["Falcon codename plan"]);
    const files = () => [
      JSON.stringify(createProject(store.draft)),
      JSON.stringify(createBackup({ drafts: [store.draft], active: "x" })),
      JSON.stringify(withoutDetachedCopies(store.draft)),
    ];
    for (const file of files()) expect(file).not.toContain("Falcon");
    const copy = withoutDetachedCopies(store.draft);
    expect(copy.metadata.detachments).toEqual([
      { ...record, labels: ["Builder section"], previous: null },
    ]);
    // A name that is still in the Markdown is kept.
    const kept = new Store(
      newDraft("Doc", [
        createBlock("about", { title: "Falcon", body: "Body" }),
        createBlock("custom", { markdown: "End." }),
      ]),
    );
    kept.raw(kept.draft.markdown.replace("Body", "Text"));
    expect(
      withoutDetachedCopies(kept.draft).metadata.detachments[0].labels,
    ).toEqual(["Falcon"]);
    // Deleting the detached section drops its record from downloads.
    const md = store.draft.markdown;
    store.raw(md.slice(md.indexOf("End.")));
    expect(store.draft.metadata.detachments).toHaveLength(1);
    expect(withoutDetachedCopies(store.draft).metadata.detachments).toEqual([]);
    for (const file of files()) expect(file).not.toContain("Falcon");
  });
  it("never carries text removed by a raw edit into a download", () => {
    const secret = "Call 555-0100 or private@example.com";
    const draft = newDraft("Doc", [
      createBlock("hero", { name: "Ada", subtitle: secret }),
      createBlock("custom", { markdown: "## Notes" }),
    ]);
    const store = new Store(draft);
    store.raw(draft.markdown.replace(secret, "Hi"));
    const [record] = store.draft.metadata.detachments;
    // The Restorable copy stays in this browser (Undo and autosave).
    expect(isRestorable(record)).toBe(true);
    expect(JSON.stringify(store.draft)).toContain(secret);
    expect(JSON.stringify(createProject(store.draft))).not.toContain(secret);
    expect(
      JSON.stringify(createBackup({ drafts: [store.draft], active: "x" })),
    ).not.toContain(secret);
    const copy = withoutDetachedCopies(store.draft);
    expect(JSON.stringify(copy)).not.toContain(secret);
    expect(copy.metadata.detachments[0]).toEqual({ ...record, previous: null });
    // Preparing a download never changes the live draft.
    expect(store.draft.metadata.detachments[0]).toBe(record);
  });
});

// Regressions from the #77 verification: the editor calls Store.raw on every
// keystroke, so an edit typed one key at a time must detach exactly what the
// same edit pasted at once would.
const typeKeys = (store, at, text) => {
  const notices = [];
  for (const [n, key] of [...text].entries()) {
    const md = store.draft.markdown;
    notices.push(
      detachmentNotice(store.raw(md.slice(0, at + n) + key + md.slice(at + n))),
    );
  }
  return notices;
};
// What runs on before an Owned block's text on its first line, and after it
// on its last line, ignoring whitespace.
const lineEdges = (markdown, start, end) => {
  let s = start,
    e = end;
  if (start < end && !/[\r\n]/.test(markdown[start]))
    while (s > 0 && !/[\r\n]/.test(markdown[s - 1])) s--;
  if (start < end && !/[\r\n]/.test(markdown[end - 1]))
    while (e < markdown.length && !/[\r\n]/.test(markdown[e])) e++;
  return [markdown.slice(s, start).trim(), markdown.slice(end, e).trim()];
};
// Every Owned block either survives on unchanged lines or has a record.
function expectOwnedSettled(before, store, records) {
  const was = documentSegments(before);
  const now = documentSegments(store.draft);
  const recorded = new Set(records.flatMap((r) => r.previousBlockIds));
  before.blocks.forEach((block, i) => {
    if (!ownershipKind(block, before.metadata)) return;
    const k = store.draft.blocks.findIndex((b) => b.id === block.id);
    if (k < 0) {
      expect(recorded.has(block.id), `${block.type} recorded`).toBe(true);
      return;
    }
    expect(serializeBlock(store.draft.blocks[k])).toBe(serializeBlock(block));
    expect(
      lineEdges(store.draft.markdown, now[k].contentStart, now[k].end),
      `${block.type} keeps its lines`,
    ).toEqual(lineEdges(before.markdown, was[i].contentStart, was[i].end));
  });
}

describe("Edits typed one key at a time", () => {
  const dividerDoc = () =>
    newDraft("Doc", [
      createBlock("custom", { markdown: "# Intro\n\nHello" }),
      createBlock("divider", {}),
      createBlock("custom", { markdown: "## Tech\n\nWords here" }),
    ]);
  it("typing after a divider's line detaches it as pasting would", () => {
    const draft = dividerDoc();
    const store = new Store(structuredClone(draft));
    const at = draft.markdown.indexOf("---") + 3;
    const notices = typeKeys(store, at, " more");
    expect(store.draft.markdown).toBe(
      "# Intro\n\nHello\n\n--- more\n\n## Tech\n\nWords here",
    );
    // The space alone only changes the Seam; the first letter detaches.
    expect(notices).toEqual([
      "",
      "Raw edit detached: Divider (builder). Undo restores visual ownership.",
      "",
      "",
      "",
    ]);
    expect(store.draft.blocks.some((b) => b.type === "divider")).toBe(false);
    const records = readDetachments(store.draft.metadata);
    expect(records.map((r) => r.previousBlockIds)).toEqual([
      [draft.blocks[1].id],
    ]);
    expect(serializeBlock(store.draft.blocks[1])).toBe("--- more");
    expect(store.draft.blocks[1].id).toBe(records[0].blockId);
    // The next section keeps its ID: the same result as one pasted edit.
    expect(store.draft.blocks[2].id).toBe(draft.blocks[2].id);
    const pasted = patchBlocks(
      dividerDoc(),
      apply(dividerDoc().markdown, { start: at, end: at, text: " more" }),
    );
    expect(pasted.blocks.map(serializeBlock)).toEqual(
      store.draft.blocks.map(serializeBlock),
    );
  });
  it("typing after the hero subtitle before a builder section detaches the hero", () => {
    const draft = newDraft("Doc", [
      createBlock("hero", { name: "Ada", subtitle: "Builds things." }),
      createBlock("stack", { items: [{ name: "JavaScript" }], style: "text" }),
    ]);
    const store = new Store(structuredClone(draft));
    typeKeys(store, draft.markdown.indexOf("things.") + 7, " Also");
    expect(store.draft.markdown).toBe(
      "# Ada\n\nBuilds things. Also\n\n## Tech Stack\n\nJavaScript",
    );
    expect(store.draft.blocks.map((b) => b.type)).toEqual(["custom", "stack"]);
    expect(store.draft.blocks[1].id).toBe(draft.blocks[1].id);
    const [record] = readDetachments(store.draft.metadata);
    expect(record.previousBlockIds).toEqual([draft.blocks[0].id]);
    expect(isRestorable(record)).toBe(true);
  });
  it("typing at the very end of the document after an Owned block detaches it", () => {
    const store = new Store(
      newDraft("Doc", [
        createBlock("custom", { markdown: "# Intro" }),
        createBlock("divider", {}),
      ]),
    );
    const divider = store.draft.blocks[1].id;
    const result = store.raw(store.draft.markdown + "x");
    expect(store.draft.markdown).toBe("# Intro\n\n---x");
    expect(serializeBlocks(store.draft.blocks)).toBe("# Intro\n\n---x");
    expect(store.draft.blocks.map(serializeBlock)).toEqual(["# Intro", "---x"]);
    expect(result.detachments.map((r) => r.previousBlockIds)).toEqual([
      [divider],
    ]);
    expect(detachmentNotice(result)).toBe(
      "Raw edit detached: Divider (builder). Undo restores visual ownership.",
    );
    // A line break typed first starts a new line and detaches nothing.
    store.undo();
    expect(store.raw(store.draft.markdown + "\n").detachments).toEqual([]);
    expect(store.draft.blocks[1].id).toBe(divider);
  });
  it("typing at the very start of the document before an Owned block detaches it", () => {
    const draft = newDraft("Doc", [
      createBlock("hero", { name: "Ada", subtitle: "Builds things." }),
      createBlock("custom", { markdown: "End" }),
    ]);
    const store = new Store(structuredClone(draft));
    const result = store.raw("x" + store.draft.markdown);
    expect(store.draft.blocks.map(serializeBlock)).toEqual([
      "x# Ada\n\nBuilds things.",
      "End",
    ]);
    expect(store.draft.blocks[0].type).toBe("custom");
    expect(result.detachments.map((r) => r.previousBlockIds)).toEqual([
      [draft.blocks[0].id],
    ]);
    expect(detachmentNotice(result)).toBe(
      "Raw edit detached: Ada (builder). Undo restores visual ownership.",
    );
    // Text on its own line before the hero leaves it Owned.
    store.undo();
    expect(store.raw("Hi\n\n" + store.draft.markdown).detachments).toEqual([]);
    expect(store.draft.blocks.some((b) => b.id === draft.blocks[0].id)).toBe(
      true,
    );
  });
  it("whitespace typed in a Seam keeps every block's text and ownership", () => {
    const draft = dividerDoc();
    const store = new Store(structuredClone(draft));
    const at = draft.markdown.indexOf("---") + 3;
    expect(typeKeys(store, at, "  \n")).toEqual(["", "", ""]);
    expect(store.draft.blocks.map((b) => b.id)).toEqual(
      draft.blocks.map((b) => b.id),
    );
    expect(readDetachments(store.draft.metadata)).toEqual([]);
  });
  it("typing two keys at every position never leaves a changed line Owned", () => {
    for (const make of [typed, dividerDoc]) {
      const base = make();
      for (let at = 0; at <= base.markdown.length; at++) {
        if (base.markdown[at - 1] === "\r" && base.markdown[at] === "\n")
          continue;
        const before = structuredClone(base);
        const store = new Store(structuredClone(before));
        typeKeys(store, at, " x");
        expect(serializeBlocks(store.draft.blocks)).toBe(store.draft.markdown);
        try {
          expectOwnedSettled(
            before,
            store,
            readDetachments(store.draft.metadata),
          );
        } catch (error) {
          error.message = `${make.name} at ${at}: ${error.message}`;
          throw error;
        }
      }
    }
  });
});

describe("Moving and editing an Owned block in one change", () => {
  const pool = () => [
    createBlock("custom", { markdown: "# Readme\n\nIntro." }),
    createBlock("divider", {}),
    createBlock("hero", { name: "Ada", subtitle: "Builds things." }),
    createBlock("custom", { markdown: "Closing." }),
    createBlock("stack", { items: [{ name: "JavaScript" }], style: "text" }),
    createBlock("custom", { markdown: "Bye." }),
  ];
  it("records the moved hero when its subtitle also changes", () => {
    const blocks = pool();
    const store = new Store(newDraft("Doc", blocks));
    const text = blocks.map(serializeBlock);
    const next = [
      text[0],
      text[2].replace("things.", "things!"),
      text[1],
      text[3],
      text[4],
      text[5],
    ].join("\n\n");
    const result = store.raw(next);
    expect(serializeBlocks(store.draft.blocks)).toBe(next);
    expect(store.draft.blocks.some((b) => b.id === blocks[2].id)).toBe(false);
    const recorded = result.detachments.flatMap((r) => r.previousBlockIds);
    expect(recorded).toContain(blocks[2].id);
    expect(detachmentNotice(result)).toContain("Ada (builder)");
    // The untouched stack section keeps its ownership.
    expect(store.draft.blocks.some((b) => b.id === blocks[4].id)).toBe(true);
  });
  it("every reorder that also edits an Owned block keeps or records each one", () => {
    const perms = (a) =>
      a.length <= 1
        ? [a]
        : a.flatMap((x, i) =>
            perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]),
          );
    const edits = [
      ["things.", "things!"],
      ["JavaScript", "JavaScript, Rust"],
      ["---", "***"],
    ];
    for (const order of perms([0, 1, 2, 3, 4]))
      for (const [from, to] of edits) {
        const blocks = pool().slice(0, 5);
        const draft = newDraft("Doc", blocks);
        const next = order
          .map((k) => serializeBlock(blocks[k]))
          .join("\n\n")
          .replace(from, to);
        const store = new Store(structuredClone(draft));
        const result = store.raw(next);
        expect(serializeBlocks(store.draft.blocks)).toBe(next);
        try {
          expectOwnedSettled(draft, store, result.detachments);
        } catch (error) {
          error.message = `${order} ${from}: ${error.message}`;
          throw error;
        }
      }
  });
});

describe("Downloads never carry text removed by a raw edit", () => {
  it("leaves detached banner settings and assets out of portable files", () => {
    const source =
      '<picture><img src="assets/falcon-banner-light.svg" alt="Project Falcon — Secret launch"></picture>';
    const block = createBlock("custom", { markdown: source });
    const draft = newDraft("Doc", [block]);
    draft.metadata.bannerSettings = {
      ...newBanner(),
      name: "Project Falcon",
      title: "Secret launch",
      alt: "Project Falcon — Secret launch",
      filename: "falcon-banner",
    };
    draft.metadata.bannerReference = { blockId: block.id, source };
    const store = new Store(draft);

    store.raw("# Public README");

    expect(store.draft.markdown).not.toContain("Falcon");
    for (const file of [
      createProject(store.draft),
      createBackup({ drafts: [store.draft], active: "x" }),
      withoutDetachedCopies(store.draft),
    ]) {
      const text = JSON.stringify(file);
      expect(text).not.toContain("Falcon");
      expect(text).not.toContain("Secret launch");
      expect(text).not.toContain("falcon-banner");
    }
    expect(createProject(store.draft).assets).toEqual([]);
  });

  it("drops unknown imported fields from portable detachment metadata", () => {
    const draft = custom("# Public README\n\n- demo");
    draft.metadata.detachments = [
      {
        version: 1,
        id: "detachment-1",
        blockId: draft.blocks[0].id,
        previousBlockIds: ["old-block"],
        labels: ["Custom Markdown"],
        kinds: ["builder"],
        at: "2026-10-22T00:00:00.000Z",
        previous: null,
        importedUnknown: "DETACHMENT-SECRET",
      },
    ];
    draft.metadata.detachedGenerated = [
      {
        id: "repository:old-block",
        kind: "repository",
        source: ["u/demo"],
        ownership: "detached",
        options: { action: "summary" },
        importedUnknown: "GENERATED-SECRET",
      },
    ];

    for (const file of [
      createProject(draft),
      createBackup({ drafts: [draft], active: draft.id }),
      withoutDetachedCopies(draft),
    ]) {
      const text = JSON.stringify(file);
      expect(text).not.toContain("DETACHMENT-SECRET");
      expect(text).not.toContain("GENERATED-SECRET");
      expect(text).not.toContain("importedUnknown");
    }
  });

  it("leaves removed repositories and generated text out of detachedGenerated", () => {
    const generated = {
      ...createBlock("custom", {
        markdown: "## Repositories\n\n- secret-repo-xyz\n- demo",
      }),
      githubGenerated: {
        version: 1,
        repositories: ["u/secret-repo-xyz", "u/demo"],
        options: { action: "summary" },
        generatedValue: "## Repositories\n\n- secret-repo-xyz\n- demo",
      },
    };
    const store = new Store(
      newDraft("Doc", [
        createBlock("custom", { markdown: "# Hi" }),
        generated,
        createBlock("custom", { markdown: "End." }),
      ]),
    );
    store.raw(store.draft.markdown.replace("- secret-repo-xyz\n", ""));
    expect(store.draft.markdown).not.toContain("secret-repo-xyz");
    // This browser keeps the detached source for Undo and recreation.
    expect(JSON.stringify(store.draft.metadata.detachedGenerated)).toContain(
      "secret-repo-xyz",
    );
    for (const file of [
      createProject(store.draft),
      createBackup({ drafts: [store.draft], active: "x" }),
      withoutDetachedCopies(store.draft),
    ])
      expect(JSON.stringify(file)).not.toContain("secret-repo-xyz");
    expect(store.draft.metadata.detachedGenerated).toHaveLength(1);
  });
  it("keeps a detached source still named in the Markdown, without its text", () => {
    const generated = {
      ...createBlock("custom", { markdown: "## Repositories\n\n- demo" }),
      githubGenerated: {
        version: 1,
        repositories: ["u/demo"],
        options: { action: "summary" },
        generatedValue: "## Repositories\n\n- demo",
        snapshot: [{ name: "demo", description: "Private plans" }],
      },
    };
    const store = new Store(newDraft("Doc", [generated]));
    store.raw("## Repos\n\n- demo");
    const [unit] = withoutDetachedCopies(store.draft).metadata
      .detachedGenerated;
    expect(unit).toMatchObject({ kind: "repository", source: ["u/demo"] });
    expect(unit).not.toHaveProperty("generatedValue");
    expect(unit).not.toHaveProperty("snapshot");
    expect(unit).not.toHaveProperty("label");
    // The project still offers to recreate it.
    const opened = inspectProject(
      JSON.stringify(createProject(store.draft)),
    ).draft;
    expect(
      generatedRegistry(opened).filter((u) => u.ownership === "detached"),
    ).toHaveLength(1);
  });
  it("leaves options that name removed text out of a detached source", () => {
    const markdown = "## Falcon codename repos\n\n- demo";
    const generated = {
      ...createBlock("custom", { markdown }),
      githubGenerated: {
        version: 1,
        repositories: ["u/demo"],
        options: {
          action: "summary",
          layout: "compact",
          title: "Falcon codename repos",
          technologies: ["SecretTech", "Demo"],
          workflow: "falcon-deploy.yml",
          badges: ["stars", "license"],
        },
        generatedValue: markdown,
      },
    };
    const store = new Store(newDraft("Doc", [generated]));
    store.raw("## Repos\n\n- demo");
    // This browser keeps every option for Undo and recreation.
    expect(store.draft.metadata.detachedGenerated[0].options.title).toBe(
      "Falcon codename repos",
    );
    for (const file of [
      createProject(store.draft),
      createBackup({ drafts: [store.draft], active: "x" }),
      withoutDetachedCopies(store.draft),
    ]) {
      const text = JSON.stringify(file);
      expect(text).not.toContain("Falcon");
      expect(text).not.toContain("SecretTech");
      expect(text).not.toContain("falcon-deploy");
    }
    const [unit] = withoutDetachedCopies(store.draft).metadata
      .detachedGenerated;
    expect(unit.options).toEqual({
      action: "summary",
      layout: "compact",
      technologies: ["Demo"],
      badges: ["stars", "license"],
    });
  });
  it("blanks generated profile text whose section a raw edit removed", () => {
    const about = createBlock("about", {
      title: "About",
      body: "Ask me about Project Falcon.",
    });
    about.profileAutofill = { kind: "bio", markdown: serializeBlock(about) };
    const kept = createBlock("about", { title: "Languages", body: "- JS" });
    kept.profileAutofill = {
      kind: "languages",
      markdown: serializeBlock(kept),
    };
    const draft = newDraft("Doc", [
      createBlock("custom", { markdown: "# Hi" }),
      about,
      kept,
      createBlock("custom", { markdown: "End." }),
    ]);
    draft.metadata.githubProfile = {
      login: "ada",
      sections: {
        bio: serializeBlock(about),
        languages: serializeBlock(kept),
      },
    };
    const store = new Store(draft);
    store.raw(store.draft.markdown.replace(serializeBlock(about) + "\n\n", ""));
    expect(store.draft.markdown).not.toContain("Falcon");
    for (const file of [
      createProject(store.draft),
      createBackup({ drafts: [store.draft], active: "x" }),
      withoutDetachedCopies(store.draft),
    ])
      expect(JSON.stringify(file)).not.toContain("Falcon");
    const opened = inspectProject(
      JSON.stringify(createProject(store.draft)),
    ).draft;
    expect(opened.metadata.githubProfile.sections).toEqual({
      bio: "",
      languages: serializeBlock(kept),
    });
    // The removed section is still known, so Autofill does not add it back.
    const units = generatedRegistry(opened);
    expect(units.find((u) => u.option === "bio")?.ownership).toBe("detached");
    expect(units.find((u) => u.option === "languages")?.ownership).toBe(
      "generated",
    );
  });
  it("renames a split section after its edited heading and drops a removed one", () => {
    const store = new Store(
      split(
        "# Readme\n\nIntro.\n\n## Falcon codename plan\n\nBody.\n\n## End\n\nBye.",
      ),
    );
    expect(store.draft.blocks.map((b) => b.section?.title)).toEqual([
      "Readme",
      "Falcon codename plan",
      "End",
    ]);
    store.raw(store.draft.markdown.replace("Falcon codename plan", "Plan"));
    expect(store.draft.blocks.map((b) => b.section?.title)).toEqual([
      "Readme",
      "Plan",
      "End",
    ]);
    for (const file of [
      createProject(store.draft),
      createBackup({ drafts: [store.draft], active: "x" }),
      withoutDetachedCopies(store.draft),
    ])
      expect(JSON.stringify(file)).not.toContain("Falcon");
    // Removing the heading line entirely drops the section name.
    store.raw(store.draft.markdown.replace("## Plan\n\n", ""));
    expect(store.draft.blocks.map((b) => b.section?.title)).toEqual([
      "Readme",
      undefined,
      "End",
    ]);
    // Older drafts with a stale name lose it in downloads.
    const stale = split("## Secret plan\n\nBody.");
    stale.blocks[0].settings.markdown = "## Plan\n\nBody.";
    stale.markdown = "## Plan\n\nBody.";
    expect(JSON.stringify(createProject(stale))).not.toContain("Secret");
  });
});

describe("seeded single-range edits", () => {
  it("stay exact, keep untouched Blocks and never fall back", () => {
    const pieces = ["x", " ", "\n", "\r\n", "## H\n", "😀", "<b>", ""];
    const layouts = [
      typed(),
      ...FIXTURES.map((name) => split(fixture(name), [1, 2, 3])),
    ];
    for (let seed = 1; seed <= 200; seed++) {
      let state = seed;
      const rand = (n) => {
        state = (state * 48271) % 2147483647;
        return state % n;
      };
      const draft = layouts[seed % layouts.length];
      const length = draft.markdown.length;
      let start = rand(length + 1),
        end = Math.min(length, start + rand(40));
      // Keep the requested range on whole CRLF and surrogate pairs.
      const pair = (i) =>
        (draft.markdown[i - 1] === "\r" && draft.markdown[i] === "\n") ||
        /[\udc00-\udfff]/.test(draft.markdown[i] || "");
      if (pair(start)) start--;
      if (pair(end)) end++;
      const text = Array.from(
        { length: rand(3) },
        () => pieces[rand(pieces.length)],
      ).join("");
      const touched = documentSegments(draft)
        .map((s, i) => ({ s, id: draft.blocks[i].id }))
        .filter(({ s }) => s.end >= start - 65 && s.start <= end + 1)
        .map(({ id }) => id);
      try {
        golden(draft, { start, end, text }, touched);
      } catch (error) {
        error.message = `seed ${seed}: ${error.message}`;
        throw error;
      }
    }
  });
});
