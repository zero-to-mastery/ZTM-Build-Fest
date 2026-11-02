import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Curated research context in portable copies (#198, ADR 0202): the portable HTML, Markdown and
// text, and the JSON Feed item, are the fixtures the Rust tests pin byte for byte. Here the same
// semantic facts are compared across every format against the public data file, and the copies
// are checked for the links back to the canonical page and for inert markup.

const read = (name) => readFileSync(new URL(`../fixtures/curated-context/${name}`, import.meta.url), "utf8");
const data = JSON.parse(read("curated-context.json"));
const HTML = read("portable-cave.html");
const MARKDOWN = read("portable-cave.md");
const TEXT = read("portable-cave.txt");
const FEED = JSON.parse(read("feed-item-cave.json"));
const CANONICAL = "https://example.test/posts/cave/";

/** Letters and digits only, entities and Markdown escapes gone: a fact is found whatever escaped it. */
const fold = (value) =>
  value
    .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();

const PROSE = new Set(["summary", "text", "by", "note", "uncertainty", "rationale", "label", "title", "inverseLabel", "correspondenceLabel", "confidence", "standing", "name"]);
const leaves = (value, out = []) => {
  if (Array.isArray(value)) value.forEach((inner) => leaves(inner, out));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (typeof inner === "string" && PROSE.has(key)) out.push(inner);
      else leaves(inner, out);
    }
  }
  return out;
};

const cave = data.posts.find((post) => post.post === "cave");
const items = cave.items.map((ref) => data.items.find((item) => item.id === ref.id));

test("every prose fact of every item the post offers is in the portable HTML, Markdown, text and feed", () => {
  const copies = { html: HTML, markdown: MARKDOWN, text: TEXT, "feed content_html": FEED.content_html, "feed content_text": FEED.content_text };
  for (const [name, copy] of Object.entries(copies)) {
    assert.ok(copy, `${name} is present`);
    const folded = fold(copy);
    for (const item of items) {
      for (const words of leaves(item.content)) assert.ok(folded.includes(fold(words)), `${name} lost "${words}" of ${item.id}`);
    }
  }
});

test("each copy links the section and every item's anchor on the canonical page, in the author's order", () => {
  for (const [name, copy] of Object.entries({ html: HTML, markdown: MARKDOWN, text: TEXT })) {
    assert.ok(copy.includes(`${CANONICAL}#${data.section}`), `${name} links the section`);
    let from = 0;
    for (const ref of cave.items) {
      const anchor = `${CANONICAL}#${data.anchorPrefix}${ref.id}`;
      const at = copy.indexOf(anchor, from);
      assert.ok(at >= 0, `${name} links ${ref.id} in order`);
      from = at + anchor.length;
    }
  }
  assert.equal(FEED._openblog.researchContext.url, `${CANONICAL}#${data.section}`);
  assert.deepEqual(FEED._openblog.researchContext.items.map((item) => item.id), cave.items.map((item) => item.id));
});

test("a copy carries no page machinery and no private word, and only absolute or inert links", () => {
  assert.doesNotMatch(HTML, /<script|\son[a-z]+=|\sid=|data-curated|style=|javascript:/i);
  assert.doesNotMatch(MARKDOWN + TEXT, /`|Selection `/);
  assert.doesNotMatch(HTML + MARKDOWN + TEXT + JSON.stringify(FEED), /PRIVATE-CURATION-MARKER|p-burnet|withdrawn comment words|stale comment words/);
  for (const [, href] of HTML.matchAll(/href="([^"]+)"/g)) assert.match(href, /^https:\/\//, "every link in a copy is absolute");
  for (const [, destination] of MARKDOWN.matchAll(/(?<!\\)\]\(([^)]+)\)/g)) assert.match(destination, /^https:\/\//);
  // Authored markup is words.
  assert.ok(!HTML.includes("<b>x</b>") && HTML.includes("&lt;b&gt;x&lt;/b&gt;"));
});

test("attribution, doubt and evidence stay words in every format", () => {
  for (const words of ["Who asserts it", "How firmly", "What is doubtful", "Who disputes it", "The evidence"]) {
    for (const copy of [HTML, MARKDOWN, TEXT]) assert.ok(copy.includes(words), words);
  }
  assert.match(MARKDOWN, /Not recorded|Where this metadata came from|Notice:/);
});
