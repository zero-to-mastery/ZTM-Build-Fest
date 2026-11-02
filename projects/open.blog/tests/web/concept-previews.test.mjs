// The data side of <ob-concept-previews> (ADR 0174): what it reads from the atlas query file, what
// it refuses, and what each preview says. The same fixtures are checked against a real projection
// by crates/openblog-core/tests/concept_links.rs, so the component and the Rust side cannot drift.
// The keyboard, pointer, touch and layout behaviour is covered in a browser by
// tests/browser/concept-previews.spec.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The module defines its element when it loads; node has no DOM, so only the registry is faked.
globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define() {} };
const { MAX_QUERY_LENGTH, leadsToEntry, previewModel, readQuery, sitePath } = await import(
  "../../web/components/ob-concept-previews.js"
);

const fixtures = JSON.parse(readFileSync(new URL("../fixtures/concept-previews.json", import.meta.url), "utf8"));
const query = readQuery(JSON.stringify(fixtures.query));

test("the fixture query is read, and the malformed entries lose only themselves", () => {
  assert.ok(query);
  assert.deepEqual([...query.entries.keys()].sort(), ["cave", "ethics", "hub", "plato", "republic", "stray"]);
  assert.equal(query.edges.size, 5);
  assert.equal(query.sources.get("plato-republic"), "Politeia");
});

test("previewModel says what the fixtures say, in the file's own wording", () => {
  assert.ok(fixtures.cases.length >= 8);
  for (const { name, id, expected } of fixtures.cases) {
    assert.deepEqual(previewModel(query, id), expected, name);
  }
  assert.equal(previewModel(null, "plato"), null);
  assert.equal(previewModel({}, "plato"), null);
});

test("a file it does not know is not read at all", () => {
  const doc = fixtures.query;
  assert.equal(readQuery("{ not json"), null);
  assert.equal(readQuery(""), null);
  assert.equal(readQuery(undefined), null);
  assert.equal(readQuery("[]"), null);
  assert.equal(readQuery(JSON.stringify({ ...doc, formatVersion: 2 })), null, "a newer version");
  assert.equal(readQuery(JSON.stringify({ ...doc, formatVersion: "1" })), null);
  assert.equal(readQuery(JSON.stringify({ ...doc, format: "openblog-atlas" })), null, "atlas.json is not this file");
  assert.equal(readQuery(" ".repeat(MAX_QUERY_LENGTH + 1)), null, "an oversized file");
  // Missing lists are empty, not an error.
  const bare = readQuery(JSON.stringify({ format: doc.format, formatVersion: 1 }));
  assert.equal(bare.entries.size, 0);
});

test("hostile text is only ever text, and an entry or relationship that is wrong is dropped", () => {
  const hostile = `<img src=x onerror="window.__x=1">`;
  const doc = {
    format: "openblog-atlas-query",
    formatVersion: 1,
    entries: [
      { id: "a", kindLabel: hostile, label: hostile, url: "/atlas/a/", preview: hostile, out: ["e1", 7, null], in: "x" },
      { id: "b", kindLabel: "Concept", label: "B", url: "/atlas/b/" },
      { id: "c", kindLabel: "Concept", label: "C", url: "javascript:alert(1)" },
      { id: "d", kindLabel: "Concept", label: "", url: "/atlas/d/" },
      { id: "e", kindLabel: 5, label: "E", url: "/atlas/e/" },
      { id: "f", kindLabel: "Concept", label: "F", url: "//evil.test/atlas/f/" },
      { id: "g", kindLabel: "Concept", label: "G", url: "/atlas/g/", source: "nowhere", moreOut: -5, moreIn: "x" },
      null,
      "x",
    ],
    edges: [
      { id: "e1", from: "a", to: "b", label: hostile, inverseLabel: "x", assertedByText: hostile, evidence: [null, { text: hostile }, { text: 3 }] },
      { id: "e2", from: "a", to: 5, label: "x", inverseLabel: "y" },
    ],
    sources: [{ id: "s", text: hostile }, { id: 3, text: "x" }, null],
  };
  const read = readQuery(JSON.stringify(doc));
  assert.deepEqual([...read.entries.keys()], ["a", "b", "g"]);
  assert.deepEqual([...read.edges.keys()], ["e1"]);
  const model = previewModel(read, "a");
  assert.equal(model.label, hostile);
  assert.equal(model.summary, hostile);
  assert.equal(model.relationships[0].text, `${hostile} ${hostile} B`);
  assert.deepEqual(model.relationships[0].evidence, [hostile]);
  assert.equal(model.more, 0);
  const plain = previewModel(read, "g");
  assert.equal(plain.source, null);
  assert.equal(plain.more, 0, "a negative or non-numeric count is not a count");
});

test("sitePath keeps only an address on the site's own origin", () => {
  assert.equal(sitePath("/atlas/plato/"), "/atlas/plato/");
  assert.equal(sitePath("/blog/atlas/plato/"), "/blog/atlas/plato/");
  assert.equal(sitePath("/atlas/plato/?x=1#y"), "/atlas/plato/");
  for (const bad of ["https://example.com/atlas/", "//example.com/atlas/", "atlas/plato/", "javascript:alert(1)", "/\\evil.test", "", null, undefined, 3]) {
    assert.equal(sitePath(bad), null, String(bad));
  }
});

test("only a link that still goes to the entry's own page is enhanced, under any base path", () => {
  const link = (href) => ({ getAttribute: (name) => (name === "href" ? href : null) });
  const page = "https://site.test/posts/cave/";
  const model = { url: "/atlas/plato/" };
  assert.equal(leadsToEntry(link("/atlas/plato/"), model, page), true);
  assert.equal(leadsToEntry(link("https://site.test/atlas/plato/"), model, page), true);
  assert.equal(leadsToEntry(link("/atlas/aristotle/"), model, page), false);
  assert.equal(leadsToEntry(link("https://evil.test/atlas/plato/"), model, page), false);
  assert.equal(leadsToEntry(link("javascript:alert(1)"), model, page), false);
  assert.equal(leadsToEntry(link(null), model, page), false);
  assert.equal(leadsToEntry(link("/atlas/plato/"), null, page), false);
  const blog = { url: "/blog/atlas/plato/" };
  assert.equal(leadsToEntry(link("/blog/atlas/plato/"), blog, "https://site.test/blog/posts/cave/"), true);
  assert.equal(leadsToEntry(link("/atlas/plato/"), blog, "https://site.test/blog/posts/cave/"), false);
});
