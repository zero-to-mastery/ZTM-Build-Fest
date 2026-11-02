// The reader's local annotation store (ADR 0241): changes are validated by the contract, storage
// failures are values, and nothing unreadable is ever overwritten.
import test from "node:test";
import assert from "node:assert/strict";

import { createDocument, MAX_ANNOTATIONS, readDocumentJson } from "../../web/components/reader-annotations.js";
import {
  STORAGE_KEY,
  addAnnotation,
  annotationsOf,
  deleteAnnotation,
  newId,
  readStore,
  setNoteText,
  timestamp,
  writeStore,
} from "../../web/components/reader-annotations-store.js";

const WORK = { site: "https://example.com", path: "/posts/tea/" };
const REVISION = "p1:0123456789abcdef0123456789abcdef";
const quote = (exact) => ({ version: 1, kind: "quote", section: "brewing", exact, prefix: "Steep the tea for ", suffix: ". Then taste", start: 18 });
const NOW = "2026-10-27T09:30:00Z";
const LATER = "2026-10-27T10:00:00Z";

const memory = () => {
  const data = new Map();
  return {
    data,
    area: {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => data.set(key, String(value)),
    },
  };
};

test("timestamp is UTC to the second", () => {
  assert.equal(timestamp(new Date("2026-10-27T09:30:00.789Z")), "2026-10-27T09:30:00Z");
});

test("a highlight and a note are added, validated, and keep ids unique", () => {
  const highlight = addAnnotation(createDocument(), { work: WORK, revision: REVISION, target: quote("three minutes"), now: NOW });
  assert.equal(highlight.ok, true);
  assert.match(highlight.id, /^hl-[a-z0-9]{10}$/);
  assert.equal(highlight.document.annotations[0].text, undefined);
  const note = addAnnotation(highlight.document, { work: WORK, revision: REVISION, target: { version: 1, kind: "work" }, text: "Return to this.", now: NOW });
  assert.equal(note.ok, true);
  assert.match(note.id, /^note-/);
  assert.equal(note.document.annotations.length, 2);
  assert.equal(highlight.document.annotations.length, 1, "the earlier document is not changed");
  assert.throws(() => highlight.document.annotations.push({}), TypeError, "results are frozen");
  const first = addAnnotation(createDocument(), { work: WORK, revision: REVISION, target: quote("a"), now: NOW, random: () => 0 });
  // The first draw collides with the saved id, so the next one is used.
  let draws = 0;
  const id = newId(first.document, "hl", () => (draws++ < 10 ? 0 : 0.5));
  assert.notEqual(id, first.id);
});

test("an invalid change is refused and names the problem without repeating reader text", () => {
  const empty = addAnnotation(createDocument(), { work: WORK, revision: REVISION, target: { version: 1, kind: "work" }, text: "", now: NOW });
  assert.equal(empty.ok, false);
  assert.equal(empty.problem.code, "emptyText");
  const secret = "secret <b>words</b>‮";
  const bad = addAnnotation(createDocument(), { work: WORK, revision: REVISION, target: { version: 1, kind: "work" }, text: secret, now: NOW });
  assert.equal(bad.ok, false);
  assert.equal(bad.problem.code, "forbiddenCharacter");
  assert.ok(!JSON.stringify(bad.problem).includes("secret"));
  const wrongTarget = addAnnotation(createDocument(), { work: WORK, revision: REVISION, target: { version: 1, kind: "work" }, now: NOW });
  assert.equal(wrongTarget.problem.code, "wrongTarget");
  const privatePath = addAnnotation(createDocument(), { work: { site: WORK.site, path: "/café/" }, revision: REVISION, target: quote("x"), now: NOW });
  assert.equal(privatePath.ok, false);
  assert.equal(privatePath.problem.code, "invalidPath");
});

test("the document is bounded", () => {
  let document = createDocument();
  const next = (index) => ({ work: WORK, revision: REVISION, target: quote("x"), now: NOW, random: () => (index % 36) / 36 });
  const records = Array.from({ length: MAX_ANNOTATIONS }, (_, index) => ({
    id: `hl-${index}`,
    kind: "highlight",
    work: WORK,
    revision: REVISION,
    target: quote("x"),
    createdAt: NOW,
    updatedAt: NOW,
  }));
  document = readDocumentJson(JSON.stringify({ ...createDocument(), annotations: records })).document;
  const over = addAnnotation(document, next(1));
  assert.equal(over.ok, false);
  assert.equal(over.problem.code, "tooMany");
});

test("setting note text turns a highlight into a note and keeps its identity", () => {
  const added = addAnnotation(createDocument(), { work: WORK, revision: REVISION, target: quote("three minutes"), now: NOW });
  const noted = setNoteText(added.document, added.id, "Check this.", LATER);
  assert.equal(noted.ok, true);
  const record = noted.document.annotations[0];
  assert.deepEqual([record.id, record.kind, record.text, record.createdAt, record.updatedAt], [added.id, "note", "Check this.", NOW, LATER]);
  assert.deepEqual(record.target, added.document.annotations[0].target);
  assert.equal(setNoteText(noted.document, added.id, "", LATER).problem.code, "emptyText");
  assert.equal(setNoteText(noted.document, "nope", "x", LATER).problem.code, "missing");
  // A note on the whole post, edited, never becomes a highlight and stays valid.
  const whole = addAnnotation(createDocument(), { work: WORK, revision: REVISION, target: { version: 1, kind: "work" }, text: "a", now: NOW });
  assert.equal(setNoteText(whole.document, whole.id, "b", LATER).document.annotations[0].text, "b");
  // The clock going backwards never makes updatedAt precede createdAt.
  assert.equal(setNoteText(noted.document, added.id, "later", "2020-01-01T00:00:00Z").document.annotations[0].updatedAt, NOW);
});

test("deleting removes the annotation and the trail steps that named it", () => {
  const first = addAnnotation(createDocument(), { work: WORK, revision: REVISION, target: quote("three minutes"), now: NOW });
  const second = addAnnotation(first.document, { work: WORK, revision: REVISION, target: quote("taste"), now: NOW });
  const withTrail = readDocumentJson(
    JSON.stringify({
      ...second.document,
      trails: [{ id: "tea", kind: "trail", title: "Tea", steps: [{ ref: first.id }, { ref: second.id }], createdAt: NOW, updatedAt: NOW }],
    }),
  );
  assert.equal(withTrail.ok, true);
  const deleted = deleteAnnotation(withTrail.document, first.id);
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.document.trails[0].steps, [{ ref: second.id }]);
  assert.equal(deleteAnnotation(deleted.document, first.id).problem.code, "missing");
});

test("annotationsOf returns one work's annotations in order", () => {
  const a = addAnnotation(createDocument(), { work: WORK, revision: REVISION, target: quote("one"), now: NOW });
  const b = addAnnotation(a.document, { work: { site: WORK.site, path: "/other/" }, revision: REVISION, target: quote("two"), now: NOW });
  const c = addAnnotation(b.document, { work: WORK, revision: REVISION, target: quote("three"), now: NOW });
  assert.deepEqual(annotationsOf(c.document, WORK).map((each) => each.target.exact), ["one", "three"]);
});

test("storage round trips the canonical document and reports each failure as a value", () => {
  const store = memory();
  const get = () => store.area;
  assert.equal(readStore(get).status, "empty");
  const added = addAnnotation(createDocument(), { work: WORK, revision: REVISION, target: quote("three minutes"), now: NOW });
  assert.deepEqual(writeStore(get, added.document), { ok: true });
  assert.equal(readStore(get).status, "ok");
  assert.deepEqual(readStore(get).document, added.document);
  assert.ok(store.data.get(STORAGE_KEY).endsWith("\n"));

  // Denied: the accessor throws, or there is no storage.
  const denied = () => {
    throw new DOMException("denied", "SecurityError");
  };
  assert.equal(readStore(denied).status, "blocked");
  assert.deepEqual(writeStore(denied, added.document), { ok: false, reason: "blocked" });
  assert.equal(readStore(() => undefined).status, "blocked");
  assert.deepEqual(writeStore(() => null, added.document), { ok: false, reason: "blocked" });

  // Full: a quota error, whatever the browser calls it.
  for (const error of [new DOMException("full", "QuotaExceededError"), Object.assign(new Error("x"), { name: "NS_ERROR_DOM_QUOTA_REACHED" }), Object.assign(new Error("x"), { code: 22 })]) {
    const full = { getItem: () => null, setItem: () => { throw error; } };
    assert.deepEqual(writeStore(() => full, added.document), { ok: false, reason: "full" });
  }
  // A different failure is not mistaken for a full store.
  assert.deepEqual(writeStore(() => ({ getItem: () => null, setItem: () => { throw new Error("nope"); } }), added.document), { ok: false, reason: "blocked" });
});

test("unreadable or foreign saved data is reported and nothing is written over it", () => {
  for (const text of ["{ not json", JSON.stringify({ format: "openblog.research-notebook", version: 1 }), JSON.stringify({ ...createDocument(), version: 99 })]) {
    const store = memory();
    store.data.set(STORAGE_KEY, text);
    const read = readStore(() => store.area);
    assert.equal(read.status, "unreadable");
    assert.ok(read.problems.length > 0);
    assert.deepEqual(read.document, createDocument());
    assert.equal(store.data.get(STORAGE_KEY), text);
  }
});

test("a document over the size limit is not written", () => {
  const store = memory();
  const big = { ...createDocument() };
  // Too large to serialize into the 4 MiB limit without hitting record limits first: fake the size.
  const huge = { ...big, annotations: Array.from({ length: 1 }, () => ({ id: "x", kind: "note", work: WORK, revision: REVISION, target: { version: 1, kind: "work" }, text: "é".repeat(2_200_000), createdAt: NOW, updatedAt: NOW })) };
  assert.deepEqual(writeStore(() => store.area, huge), { ok: false, reason: "full" });
  assert.equal(store.data.size, 0);
});
