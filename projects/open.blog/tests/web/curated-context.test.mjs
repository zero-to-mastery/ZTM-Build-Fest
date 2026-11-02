import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BOUNDARY_KINDS, BOUNDARY_PROJECTIONS, BOUNDARY_REASONS, boundaryCountsText, createBoundaryPreview } from "../../web/admin/admin.js";
import { withDom } from "./dom-shim.mjs";

// The curated research-context projection (#197, ADR 0197 to ADR 0201): the public data file and the
// static section of a post's page, read here from the fixtures the Rust tests pin byte for byte
// (tests/fixtures/curated-context). Reader Discovery consumes these without any private store; this
// pins the contract a consumer, and Admin's preview of it, may rely on.

const read = (name) => readFileSync(new URL(`../fixtures/curated-context/${name}`, import.meta.url), "utf8");
const FILE = read("curated-context.json");
const SECTION = read("cave-section.html");
const data = () => JSON.parse(FILE);

test("the file is versioned, escaped for embedding and says where its sections and anchors are", () => {
  const file = data();
  assert.equal(file.format, "openblog-curated-context-file");
  assert.equal(file.formatVersion, 1);
  assert.equal(file.section, "ob-research-context");
  assert.equal(file.anchorPrefix, "ob-curated-");
  // Nothing in it can close a script element it is later embedded in.
  assert.doesNotMatch(FILE, /[<>&]/);
  assert.ok(FILE.endsWith("\n") && !FILE.includes("\r"), "LF only, one trailing newline");
  // Only the documented members, so a consumer is never handed something it was not told about.
  assert.deepEqual(Object.keys(file).sort(), ["anchorPrefix", "context", "format", "formatVersion", "items", "posts", "section"]);
});

test("every item keeps its attribution, provenance and the revision that was selected, and nothing private", () => {
  const { items } = data();
  assert.ok(items.length >= 6);
  const ids = items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "an item is published once");
  for (const item of items) {
    assert.match(item.id, /^[a-z0-9-]+$/, "an id is a slug, so it is a valid fragment");
    assert.match(item.revision, /^[0-9a-f]{16}$/);
    assert.ok(item.provenance && typeof item.provenance.origin === "string", `${item.id} says where its metadata came from`);
    assert.ok(item.content && typeof item.content === "object");
  }
  const relationship = items.find((item) => item.kind === "relationship");
  for (const field of ["assertedBy", "confidence", "evidence", "standing", "uncertainty", "contestedBy"]) {
    assert.ok(field in relationship.content, `a relationship always carries ${field}`);
  }
  assert.ok("assertedBy" in items.find((item) => item.kind === "timeline").content);
  assert.ok("by" in items.find((item) => item.kind === "source-annotation").content, "a comment is attributed");
  const reference = items.find((item) => item.kind === "reference");
  assert.deepEqual(reference.provenance, { origin: "imported", from: "a library catalogue" });
  assert.ok(reference.missing.length > 0, "a missing detail is listed, never filled in");
  assert.doesNotMatch(FILE, /PRIVATE-CURATION-MARKER|p-burnet|withdrawn comment words|stale comment words/);
  assert.ok(!ids.includes("annotation-withdrawn") && !ids.includes("annotation-stale"));
});

test("every post lists its items in order with the canonical anchor of each, and only ids the file holds", () => {
  const { items, context, posts } = data();
  const ids = new Set(items.map((item) => item.id));
  assert.deepEqual(posts.map((post) => post.post), [...posts.map((post) => post.post)].sort(), "posts are sorted by slug");
  for (const post of posts) {
    assert.match(post.url, /^\/posts\/[a-z0-9-]+\/$/);
    assert.ok(post.items.length > 0, "a post that offers nothing is not listed");
    for (const item of post.items) {
      assert.ok(ids.has(item.id), `${item.id} is an item of the file`);
      assert.equal(item.url, `${post.url}#ob-curated-${item.id}`);
    }
    for (const ref of post.context) {
      assert.ok(context.some((entry) => entry.kind === ref.kind && entry.id === ref.id), `${ref.kind} ${ref.id} is context of the file`);
    }
  }
  // An item that requires another has it published, and context is needed by a published item.
  for (const item of items) for (const required of item.requires || []) assert.ok(ids.has(required), `${item.id} requires ${required}`);
  for (const entry of context) for (const via of entry.via) assert.ok(ids.has(via));
  // The order of a post is that post's own: cave places the entry first and the relationship second.
  const cave = posts.find((post) => post.post === "cave").items.map((item) => item.id);
  assert.deepEqual(cave.slice(0, 2), ["entry-plato", "relationship-authored"]);
  const other = posts.find((post) => post.post === "other").items.map((item) => item.id);
  assert.equal(other[0], "entry-plato", "and `other` has its own place for the shared entry");
});

test("the page section reads in order without JavaScript and every anchor the file names is on it", () => {
  assert.doesNotMatch(SECTION, /<script|\son[a-z]+=|<iframe|javascript:/i);
  assert.match(SECTION, /^<section class="ob-curated" id="ob-research-context" aria-labelledby="ob-research-context-title"/);
  // Reading order is document order: the section's heading, each item's heading, then what they refer to.
  const headings = [...SECTION.matchAll(/<h([23])[^>]*>/g)].map((match) => Number(match[1]));
  assert.equal(headings[0], 2, "one section heading first");
  assert.ok(headings.slice(1).every((level) => level === 3), "items and the reference list follow it");
  const { posts } = data();
  const cave = posts.find((post) => post.post === "cave");
  const order = cave.items.map((item) => SECTION.indexOf(`id="${data().anchorPrefix}${item.id}"`));
  assert.ok(order.every((at) => at > 0), "every anchor of the file is on the page");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "and they sit in the order the file lists");
  // Ids are unique and every in-page link lands on one.
  const anchors = [...SECTION.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(anchors).size, anchors.length);
  for (const [, target] of SECTION.matchAll(/href="#([^"]+)"/g)) assert.ok(anchors.includes(target), `#${target} is on the page`);
  // The words that make a claim readable are text: who asserts it, how firmly, what is doubtful, on what evidence.
  for (const words of ["Who asserts it", "How firmly", "What is doubtful", "Who disputes it", "The evidence"]) {
    assert.ok(SECTION.includes(words), words);
  }
  assert.match(SECTION, /none of it is a verdict/);
  // A notice reads as a sentence for a reader: no backticks, selection words or ids.
  for (const [, notice] of SECTION.matchAll(/<li data-curated-notice="[^"]+">([^<]*)<\/li>/g)) {
    assert.ok(!/[`]|Selection|plato-birth-b/.test(notice), notice);
  }
  assert.match(SECTION, /<ol class="ob-curated-items" role="list">/);
  // Authored markup is text.
  assert.ok(!SECTION.includes("<b>x</b>") && SECTION.includes("&lt;b&gt;x&lt;/b&gt;"));
  // Only this site's pages and https addresses are links.
  for (const [, href] of SECTION.matchAll(/href="([^"#][^"]*)"/g)) assert.match(href, /^(\/(?!\/)|https:\/\/)/);
});

test("Admin names the projection and its file, and never counts the file twice", () => {
  assert.equal(BOUNDARY_PROJECTIONS["curated-context"], "Curated context data");
  assert.equal(BOUNDARY_KINDS["curated-context"], "Curated context file");
  for (const reason of ["over-limit", "inconsistent"]) assert.ok(BOUNDARY_REASONS[reason], `${reason} has words`);
  const manifest = {
    projections: [
      { projection: "curated", published: [{ kind: "selection", id: "a" }, { kind: "selection", id: "b" }], withheld: [] },
      { projection: "curated-context", published: [{ kind: "curated-context", id: "curated-context" }], withheld: [] },
    ],
  };
  assert.equal(boundaryCountsText(manifest), "2 published, 0 withheld.");
  manifest.projections[1] = { projection: "curated-context", published: [], withheld: [{ kind: "curated-context", id: "curated-context", reason: "over-limit" }] };
  assert.equal(boundaryCountsText(manifest), "2 published, 1 withheld.");
});

test("the preview lists the file with its address and says why a refused one is left out", withDom(async () => {
  const manifest = (curatedContext) => ({
    scope: { kind: "site" },
    projections: [{ projection: "curated-context", switch: "curatedContext.publish", enabled: true, ...curatedContext }],
    never: [],
  });
  const listed = createBoundaryPreview({
    manifest: manifest({ published: [{ kind: "curated-context", id: "curated-context", label: "curated-context.json", url: "/curated-context.json", fields: ["items", "context", "posts"], posts: ["cave"] }], withheld: [] }),
    idPrefix: "listed",
    level: 4,
    scope: "site",
  });
  document.body.append(listed);
  const text = listed.textContent.replace(/\s+/g, " ");
  assert.match(text, /Curated context data/);
  assert.match(text, /Curated context file/);
  assert.match(text, /curated-context\.json/);
  const refused = createBoundaryPreview({
    manifest: manifest({ published: [], withheld: [{ kind: "curated-context", id: "curated-context", reason: "over-limit", message: "The curated context file curated-context.json is not written: the curated context projection is 2000000 bytes as published, over the limit of 1048576." }] }),
    idPrefix: "refused",
    level: 4,
    scope: "site",
  });
  document.body.append(refused);
  const said = refused.textContent.replace(/\s+/g, " ");
  assert.match(said, /Over a size or count limit, so the file is left out/);
  assert.match(said, /over the limit of 1048576/);
}));
