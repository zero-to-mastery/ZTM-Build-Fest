// The reader-annotation contract (ADRs 0237-0240): validation, scoped failures,
// stale state, privacy of exports, and purity. Fixtures are in
// tests/fixtures/reader-annotations.json.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_DOCUMENT_BYTES,
  MAX_NOTE_CHARS,
  assessAnnotations,
  canonicalSite,
  createDocument,
  exportDocument,
  migrateDocument,
  readDocument,
  readDocumentJson,
  serializeDocument,
  workKey,
} from "../../web/components/reader-annotations.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/reader-annotations.json", import.meta.url), "utf8"));
const copy = (value) => JSON.parse(JSON.stringify(value));
const base = () => copy(fixture.base);
const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

// Apply { path, value } (or { path, remove: true }) to a copy of the base document.
const patched = (change) => {
  const document = base();
  const keys = change.path;
  const parent = keys.slice(0, -1).reduce((node, key) => node[key], document);
  if (change.remove) delete parent[keys.at(-1)];
  else parent[keys.at(-1)] = change.value;
  return document;
};

test("the base document is valid and round trips through canonical JSON", () => {
  const read = readDocument(fixture.base);
  assert.ok(read.ok, JSON.stringify(read.problems));
  const text = serializeDocument(read.document);
  assert.ok(text.endsWith("}\n"));
  assert.doesNotMatch(text, /\r/);
  const again = readDocumentJson(text);
  assert.ok(again.ok);
  assert.equal(serializeDocument(again.document), text, "serialization is deterministic and lossless");
  assert.deepEqual(again.document, read.document);
});

test("a new document is valid, empty and private", () => {
  const read = readDocument(createDocument());
  assert.ok(read.ok);
  assert.equal(read.document.privacy.scope, "reader-private");
  assert.equal(read.document.annotations.length, 0);
});

const S = "annotations[0] (steep)";
const N = "annotations[1] (second-tea)";
const K = "sources[0] (kettle-guide)";
const invalid = [
  ["unknown top-level field", { path: ["extra"], value: 1 }, "unknownField", "document"],
  ["unknown annotation field", { path: ["annotations", 0, "color"], value: "red" }, "unknownField", "annotations[0]"],
  ["highlight with text", { path: ["annotations", 0, "text"], value: "x" }, "unexpectedText", S],
  ["note without text", { path: ["annotations", 1, "text"], remove: true }, "malformed", N],
  ["empty note", { path: ["annotations", 1, "text"], value: "" }, "emptyText", N],
  ["note too long", { path: ["annotations", 1, "text"], value: "x".repeat(MAX_NOTE_CHARS + 1) }, "textTooLong", N],
  ["bidi override in a note", { path: ["annotations", 1, "text"], value: "a‮b" }, "forbiddenCharacter", N],
  ["control character in a note", { path: ["annotations", 1, "text"], value: "a\u0000b" }, "forbiddenCharacter", N],
  ["lone surrogate in a note", { path: ["annotations", 1, "text"], value: "a\ud800b" }, "forbiddenCharacter", N],
  ["highlight of a whole section", { path: ["annotations", 0, "target"], value: { version: 1, kind: "section", section: "brewing" } }, "wrongTarget", S],
  ["target from a newer model", { path: ["annotations", 0, "target", "version"], value: 2 }, "unsupportedVersion", S],
  ["split character in a quote", { path: ["annotations", 2, "target", "exact"], value: "́" }, "splitCharacter", "annotations[2] (cafe)"],
  ["bad revision", { path: ["annotations", 0, "revision"], value: "p1:ABC" }, "invalidRevision", S],
  ["unknown kind", { path: ["annotations", 0, "kind"], value: "comment" }, "unknownKind", S],
  ["upper-case id", { path: ["annotations", 0, "id"], value: "Steep" }, "invalidId", "annotations[0]"],
  ["duplicate id across kinds", { path: ["sources", 0, "id"], value: "steep" }, "duplicateId", "sources[0]"],
  ["site with a path", { path: ["annotations", 0, "work", "site"], value: "https://example.com/posts" }, "invalidSite", S],
  ["site with credentials", { path: ["annotations", 0, "work", "site"], value: "https://user:pw@example.com" }, "invalidSite", S],
  ["javascript site", { path: ["annotations", 0, "work", "site"], value: "javascript:alert(1)" }, "invalidSite", S],
  ["path traversal", { path: ["annotations", 0, "work", "path"], value: "/posts/../admin/" }, "invalidPath", S],
  ["encoded traversal", { path: ["annotations", 0, "work", "path"], value: "/posts/%2e%2e/admin/" }, "invalidPath", S],
  ["path with a query", { path: ["annotations", 0, "work", "path"], value: "/posts/tea/?draft=1" }, "invalidPath", S],
  ["relative path", { path: ["annotations", 0, "work", "path"], value: "posts/tea/" }, "invalidPath", S],
  ["protocol-relative path", { path: ["annotations", 0, "work", "path"], value: "//evil.test/x" }, "invalidPath", S],
  ["file URL source", { path: ["sources", 0, "url"], value: "file:///etc/passwd" }, "unsafeScheme", K],
  ["javascript URL source", { path: ["sources", 0, "url"], value: "javascript:alert(1)" }, "unsafeScheme", K],
  ["data URL source", { path: ["sources", 0, "url"], value: "data:text/html,hi" }, "unsafeScheme", K],
  ["URL with credentials", { path: ["sources", 0, "url"], value: "https://u:p@example.org/" }, "invalidUrl", K],
  ["URL not canonical", { path: ["sources", 0, "url"], value: "HTTPS://EXAMPLE.ORG" }, "invalidUrl", K],
  ["source with both url and work", { path: ["sources", 0, "work"], value: { site: "https://example.com", path: "/a/" } }, "invalidSource", K],
  ["source with neither", { path: ["sources", 1, "work"], remove: true }, "invalidSource", "sources[1] (storage-post)"],
  ["source from a bad site", { path: ["sources", 0, "from"], value: { site: "ftp://example.com", path: "/a/" } }, "invalidSite", K],
  ["source from a work with traversal", { path: ["sources", 0, "from"], value: { site: "https://example.com", path: "/a/../b/" } }, "invalidPath", K],
  ["work source with a from", { path: ["sources", 1, "from"], value: { site: "https://example.com", path: "/a/" } }, "invalidSource", "sources[1] (storage-post)"],
  ["untitled source", { path: ["sources", 0, "title"], value: "" }, "emptyText", K],
  ["newline in a title", { path: ["sources", 0, "title"], value: "a\nb" }, "forbiddenCharacter", K],
  ["trail step that names nothing", { path: ["trails", 0, "steps", 0, "ref"], value: "missing" }, "danglingRef", "trails[0] (tea-trail).steps[0]"],
  ["trail naming a trail", { path: ["trails", 0, "steps", 0, "ref"], value: "tea-trail" }, "danglingRef", "trails[0] (tea-trail).steps[0]"],
  ["trail repeating a step", { path: ["trails", 0, "steps", 1, "ref"], value: "steep" }, "duplicateStep", "trails[0] (tea-trail).steps[1]"],
  ["impossible date", { path: ["annotations", 0, "createdAt"], value: "2026-02-30T00:00:00Z" }, "invalidTimestamp", S],
  ["local-time timestamp", { path: ["annotations", 0, "createdAt"], value: "2026-10-27T09:30:00+02:00" }, "invalidTimestamp", S],
  ["updated before created", { path: ["annotations", 0, "updatedAt"], value: "2020-01-01T00:00:00Z" }, "timeOrder", S],
  ["public scope", { path: ["privacy", "scope"], value: "public" }, "invalidPrivacy", "privacy"],
  ["unstated notes scope", { path: ["privacy", "notes"], value: "maybe" }, "invalidPrivacy", "privacy"],
  ["notes omitted but present", { path: ["privacy", "notes"], value: "omitted" }, "privacyMismatch", "privacy"],
  ["newer version", { path: ["version"], value: 3 }, "unsupportedVersion", "document"],
  ["fractional version", { path: ["version"], value: 1.5 }, "malformed", "document"],
  ["missing version", { path: ["version"], remove: true }, "malformed", "document"],
];

test("invalid documents are refused whole with a code and the object at fault", () => {
  for (const [name, change, code, object] of invalid) {
    const result = readDocument(patched(change));
    assert.equal(result.ok, false, name);
    assert.ok(
      result.problems.some((p) => p.code === code && p.object === object),
      `${name}: expected ${code} at ${object}, got ${JSON.stringify(result.problems)}`,
    );
  }
});

test("a research notebook and other JSON are not annotation documents", () => {
  const notebook = { version: 1, passages: [], notes: [] };
  assert.equal(readDocument(notebook).problems[0].code, "wrongFormat");
  assert.equal(readDocument({ ...notebook, format: "openblog.research-notebook" }).problems[0].code, "wrongFormat");
  for (const value of [null, [], "text", 7]) assert.equal(readDocument(value).problems[0].code, "malformed");
});

test("every problem in a document is listed, each scoped to its own record", () => {
  const document = base();
  document.annotations[0].work.path = "/x/../y/";
  document.sources[0].url = "javascript:1";
  const result = readDocument(document);
  assert.deepEqual(
    result.problems.map((p) => [p.code, p.object]),
    [
      ["invalidPath", S],
      ["unsafeScheme", K],
    ],
  );
});

test("problems name the object and never repeat the reader's text", () => {
  const document = base();
  document.annotations[1].text = "SECRET-NOTE‮";
  document.sources[0].title = "SECRET-TITLE\u0000";
  document.sources[1].work.path = "/SECRET-PATH/../";
  const text = JSON.stringify(readDocument(document).problems);
  assert.doesNotMatch(text, /SECRET/);
});

test("oversized input is refused before it is parsed, counting UTF-8 bytes", () => {
  assert.equal(readDocumentJson(`{${" ".repeat(MAX_DOCUMENT_BYTES)}}`).problems[0].code, "tooLarge");
  assert.equal(readDocumentJson(`"${"é".repeat(MAX_DOCUMENT_BYTES / 2)}"`).problems[0].code, "tooLarge");
  assert.equal(readDocumentJson("not json").problems[0].code, "malformed");
});

test("too many records are refused", () => {
  const document = base();
  const when = "2026-10-27T09:30:00Z";
  document.trails = Array.from({ length: 51 }, (_, i) => ({ id: `t${i}`, kind: "trail", title: "t", steps: [], createdAt: when, updatedAt: when }));
  assert.equal(readDocument(document).problems[0].code, "tooMany");
});

test("reading copies the document and never changes the value passed in", () => {
  const input = deepFreeze(base());
  const result = readDocument(input);
  assert.ok(result.ok);
  assert.notEqual(result.document, input);
  assert.ok(Object.isFrozen(result.document));
  assert.ok(Object.isFrozen(result.document.annotations[0].target));
  assert.deepEqual(input, base());
});

test("migration accepts the current version and names a newer one", () => {
  assert.ok(migrateDocument(fixture.base).ok);
  assert.equal(migrateDocument({ ...base(), version: 7 }).problems[0].code, "unsupportedVersion");
});

test("identity: site is an origin, work is origin plus path, paths are canonical", () => {
  assert.equal(canonicalSite("https://example.com"), "https://example.com");
  assert.equal(canonicalSite("https://example.com/"), null);
  assert.equal(canonicalSite("http://localhost:4000"), "http://localhost:4000");
  assert.equal(canonicalSite("ftp://example.com"), null);
  assert.equal(workKey({ site: "https://example.com", path: "/posts/tea/" }), fixture.workKey);
  const document = base();
  document.sources[1].work.path = "/posts/%E5%8F%B0%E6%B9%BE/";
  assert.ok(readDocument(document).ok);
  document.sources[1].work.path = "/posts/台湾/";
  assert.equal(readDocument(document).ok, false, "a path is stored in its canonical percent-encoded form");
});

test("Unicode quotes and notes are kept exactly, without normalization", () => {
  const read = readDocument(base());
  const cafe = read.document.annotations.find((a) => a.id === "cafe");
  assert.equal(cafe.target.exact, "Café", "decomposed form is kept");
  const note = read.document.annotations.find((a) => a.id === "second-tea");
  assert.equal(note.text, "Taste test: éè ☃\nsecond line");
});

test("annotations stay current on an unchanged work and say so when the work is gone", () => {
  const read = readDocument(base());
  const { v1 } = fixture.works[fixture.workKey];
  const states = assessAnnotations(read.document, { [fixture.workKey]: v1 });
  assert.deepEqual(
    states.map((s) => [s.id, s.state]),
    [["steep", "current"], ["second-tea", "current"], ["cafe", "current"], ["whole-post", "current"]],
  );
  const gone = assessAnnotations(read.document, {});
  assert.ok(gone.every((s) => s.state === "stale" && s.reason === "workUnavailable"));
});

test("after an edit, duplicates reanchor by context, removed text is stale, and nothing points at other text", () => {
  const read = readDocument(base());
  const { v2 } = fixture.works[fixture.workKey];
  const states = Object.fromEntries(assessAnnotations(read.document, { [fixture.workKey]: v2 }).map((s) => [s.id, s]));
  assert.equal(states.steep.state, "stale");
  assert.equal(states.steep.reason, "quoteNotFound");
  assert.equal(states["second-tea"].state, "reanchored");
  const section = Array.from(v2.sections[1].text);
  assert.equal(section.slice(states["second-tea"].start, states["second-tea"].end).join(""), "the tea");
  assert.ok(states["second-tea"].start > section.indexOf("."), "the second occurrence, not the first");
  assert.equal(states.cafe.state, "reanchored");
  assert.equal(states["whole-post"].state, "current", "a whole-post note survives any revision");
});

test("assessment changes nothing: a stale annotation keeps its record", () => {
  const read = readDocument(base());
  const before = serializeDocument(read.document);
  assessAnnotations(read.document, { [fixture.workKey]: fixture.works[fixture.workKey].v2 });
  assert.equal(serializeDocument(read.document), before);
});

test("the default export leaves note text out and says so", () => {
  const { document } = readDocument(base());
  const { document: out, omittedNotes } = exportDocument(document);
  assert.deepEqual(out.privacy, { scope: "reader-private", notes: "omitted" });
  assert.doesNotMatch(JSON.stringify(out), /Taste test|Check the boiling|Return to this|In order/);
  assert.deepEqual(omittedNotes, ["whole-post"], "a whole-post note is only its text, so it is left out and reported");
  assert.equal(out.annotations.find((a) => a.id === "second-tea").kind, "highlight");
  assert.deepEqual(out.trails[0].steps.map((s) => s.ref), ["steep", "kettle-guide", "storage-post"]);
  assert.ok(readDocument(out).ok, "an export is itself a valid document");
});

test("an export with notes says notes are included, and is still private", () => {
  const { document } = readDocument(base());
  const { document: out } = exportDocument(document, { notes: true });
  assert.deepEqual(out.privacy, { scope: "reader-private", notes: "included" });
  assert.match(JSON.stringify(out), /Taste test/);
  assert.ok(readDocument(out).ok);
});

test("an export never grows: it holds only what the document holds", () => {
  const { document } = readDocument(base());
  const { document: out } = exportDocument(document);
  const ids = (d) => [...d.annotations, ...d.sources, ...d.trails].map((r) => r.id);
  for (const id of ids(out)) assert.ok(ids(document).includes(id));
});

test("a linked source may say which work it was found in, and the field survives the canonical form", () => {
  const document = patched({ path: ["sources", 0, "from"], value: { path: "/posts/tea/", site: "https://example.com" } });
  const read = readDocument(document);
  assert.ok(read.ok, JSON.stringify(read.problems));
  const text = serializeDocument(read.document);
  const source = text.slice(text.indexOf("\"sources\""));
  assert.ok(source.indexOf("\"from\"") > source.indexOf("\"url\"") && source.indexOf("\"from\"") < source.indexOf("\"text\""), "from follows url in the canonical order");
  assert.deepEqual(readDocumentJson(text).document.sources[0].from, { site: "https://example.com", path: "/posts/tea/" });
  // The origin is not a note, so a default export keeps it.
  assert.deepEqual(exportDocument(read.document).document.sources[0].from, { site: "https://example.com", path: "/posts/tea/" });
});
