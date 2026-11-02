// Saved sources and reading trails in the reader's local store (ADR 0242): every change is checked by
// the contract, duplicates and limits are refused by name, and nothing is saved over unreadable data.
import test from "node:test";
import assert from "node:assert/strict";

import { MAX_TITLE_CHARS, MAX_TRAIL_STEPS, MAX_TRAILS, createDocument, readDocumentJson } from "../../web/components/reader-annotations.js";
import {
  STORAGE_KEY,
  addAnnotation,
  addTrailStep,
  annotatedWorks,
  clearStore,
  commitStore,
  createTrail,
  deleteAnnotation,
  deleteSource,
  deleteWorkAnnotations,
  deleteTrail,
  findSource,
  fitTitle,
  moveTrailStep,
  readStore,
  recentTrails,
  recordById,
  removeTrailStep,
  saveSource,
} from "../../web/components/reader-annotations-store.js";

const WORK = { site: "https://example.com", path: "/posts/tea/" };
const OTHER = { site: "https://example.com", path: "/posts/coffee/" };
const REVISION = "p1:0123456789abcdef0123456789abcdef";
const quote = (exact) => ({ version: 1, kind: "quote", section: "brewing", exact, prefix: "Steep the tea for ", suffix: ". Then taste", start: 18 });
const T1 = "2026-10-27T09:00:00Z";
const T2 = "2026-10-27T10:00:00Z";
const T3 = "2026-10-27T11:00:00Z";

const memory = () => {
  const data = new Map();
  return {
    data,
    area: {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => data.set(key, String(value)),
      removeItem: (key) => data.delete(key),
    },
  };
};

const ok = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result.problem));
  return result;
};

function seeded() {
  let document = createDocument();
  const a = ok(addAnnotation(document, { work: WORK, revision: REVISION, target: quote("three minutes"), now: T1 }));
  const b = ok(addAnnotation(a.document, { work: OTHER, revision: REVISION, target: { version: 1, kind: "work" }, text: "Compare.", now: T2 }));
  const s = ok(saveSource(b.document, { title: "Kettle guide", url: "https://example.org/kettles", from: WORK, now: T2 }));
  const t = ok(createTrail(s.document, { title: "Learning tea", now: T2 }));
  return { document: t.document, annotation: a.id, note: b.id, source: s.id, trail: t.id };
}

test("a source is saved with its bibliographic text and the work it was found in", () => {
  const saved = ok(saveSource(createDocument(), { title: "Kettle guide", url: "https://example.org/kettles", from: WORK, now: T1 }));
  assert.match(saved.id, /^src-[a-z0-9]{10}$/);
  assert.deepEqual(saved.document.sources[0].from, WORK);
  assert.equal(saved.document.sources[0].url, "https://example.org/kettles");
  // A post is a source by its work, which needs no other origin.
  const post = ok(saveSource(saved.document, { title: "Tea", work: WORK, now: T1 }));
  assert.equal(post.document.sources.length, 2);
  assert.equal(saveSource(createDocument(), { title: "x", work: WORK, from: WORK, now: T1 }).problem.code, "invalidSource");
});

test("the same source is not saved twice, and the refusal names the one already saved", () => {
  const first = ok(saveSource(createDocument(), { title: "Kettle guide", url: "https://example.org/kettles", now: T1 }));
  const again = saveSource(first.document, { title: "Another title", url: "https://example.org/kettles", from: OTHER, now: T2 });
  assert.equal(again.ok, false);
  assert.equal(again.problem.code, "alreadySaved");
  assert.equal(again.problem.id, first.id);
  assert.equal(findSource(first.document, { url: "https://example.org/kettles" }).id, first.id);
  assert.equal(findSource(first.document, { url: "https://example.org/other" }), null);
  const post = ok(saveSource(first.document, { title: "Tea", work: WORK, now: T1 }));
  assert.equal(saveSource(post.document, { title: "Tea again", work: { ...WORK }, now: T2 }).problem.code, "alreadySaved");
});

test("unsafe or oversized source input is refused by the contract without repeating it", () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "https://user:pw@example.org/", "HTTPS://EXAMPLE.ORG"]) {
    const bad = saveSource(createDocument(), { title: "x", url, now: T1 });
    assert.equal(bad.ok, false, url);
    assert.ok(!JSON.stringify(bad.problem).includes("alert"), url);
  }
  assert.equal(saveSource(createDocument(), { title: "", url: "https://example.org/", now: T1 }).problem.code, "emptyText");
  assert.equal(saveSource(createDocument(), { title: "x".repeat(MAX_TITLE_CHARS + 1), url: "https://example.org/", now: T1 }).problem.code, "textTooLong");
  assert.equal(saveSource(createDocument(), { title: "a\nb", url: "https://example.org/", now: T1 }).problem.code, "forbiddenCharacter");
});

test("fitTitle makes a page's words a plain, bounded title", () => {
  assert.equal(fitTitle("  Steep   the\ttea\n for ‮three‬ minutes "), "Steep the tea for three minutes");
  assert.equal(fitTitle("\ud800 lone"), "� lone");
  const long = fitTitle("é".repeat(500));
  assert.equal(Array.from(long).length, MAX_TITLE_CHARS);
  assert.ok(long.endsWith("…"));
  assert.equal(fitTitle("😀".repeat(MAX_TITLE_CHARS + 5)).endsWith("…"), true);
  assert.equal(fitTitle(undefined), "");
  // Whatever it makes passes the contract.
  assert.equal(saveSource(createDocument(), { title: fitTitle("a\u0000b" + "x".repeat(400)), url: "https://example.org/", now: T1 }).ok, true);
});

test("a trail keeps steps in order, once each, and may be reordered by one place", () => {
  const { document, annotation, note, source, trail } = seeded();
  let next = ok(addTrailStep(document, trail, source, T2)).document;
  next = ok(addTrailStep(next, trail, annotation, T3)).document;
  next = ok(addTrailStep(next, trail, note, T3)).document;
  assert.deepEqual(next.trails[0].steps.map((step) => step.ref), [source, annotation, note]);
  assert.equal(next.trails[0].updatedAt, T3);
  assert.equal(addTrailStep(next, trail, annotation, T3).problem.code, "duplicateStep");
  assert.equal(addTrailStep(next, trail, "nope", T3).problem.code, "danglingRef");
  assert.equal(addTrailStep(next, trail, trail, T3).problem.code, "danglingRef", "a trail cannot name a trail");
  assert.equal(addTrailStep(next, "nope", annotation, T3).problem.code, "missing");

  next = ok(moveTrailStep(next, trail, note, -1, T3)).document;
  assert.deepEqual(next.trails[0].steps.map((step) => step.ref), [source, note, annotation]);
  next = ok(moveTrailStep(next, trail, source, -1, T3)).document;
  assert.deepEqual(next.trails[0].steps.map((step) => step.ref), [source, note, annotation], "the first step stays first");
  next = ok(moveTrailStep(next, trail, annotation, 1, T3)).document;
  assert.deepEqual(next.trails[0].steps.map((step) => step.ref), [source, note, annotation], "the last step stays last");
  assert.equal(moveTrailStep(next, trail, "nope", 1, T3).problem.code, "missing");

  next = ok(removeTrailStep(next, trail, note, T3)).document;
  assert.deepEqual(next.trails[0].steps.map((step) => step.ref), [source, annotation]);
  assert.ok(recordById(next, note), "removing a step keeps the record");
  assert.equal(removeTrailStep(next, trail, note, T3).problem.code, "missing");
});

test("a trail is bounded in steps and in number, and a change that fails leaves the document as it was", () => {
  let document = createDocument();
  const records = Array.from({ length: MAX_TRAIL_STEPS + 1 }, (_, index) => ({
    id: `hl-${index}`,
    kind: "highlight",
    work: WORK,
    revision: REVISION,
    target: quote("x"),
    createdAt: T1,
    updatedAt: T1,
  }));
  document = readDocumentJson(JSON.stringify({ ...createDocument(), annotations: records })).document;
  const made = ok(createTrail(document, { title: "Long", now: T1 }));
  let trail = made.document;
  for (let index = 0; index < MAX_TRAIL_STEPS; index += 1) trail = ok(addTrailStep(trail, made.id, `hl-${index}`, T1)).document;
  const over = addTrailStep(trail, made.id, `hl-${MAX_TRAIL_STEPS}`, T1);
  assert.equal(over.problem.code, "tooMany");
  assert.equal(trail.trails[0].steps.length, MAX_TRAIL_STEPS);

  let many = createDocument();
  for (let index = 0; index < MAX_TRAILS; index += 1) many = ok(createTrail(many, { title: `Trail ${index}`, now: T1 })).document;
  assert.equal(createTrail(many, { title: "One too many", now: T1 }).problem.code, "tooMany");
  assert.equal(createTrail(createDocument(), { title: "", now: T1 }).problem.code, "emptyText");
});

test("deleting a source or an annotation leaves every trail valid; deleting a trail keeps what it named", () => {
  const { document, annotation, source, trail } = seeded();
  const full = ok(addTrailStep(ok(addTrailStep(document, trail, source, T2)).document, trail, annotation, T2)).document;
  const withoutSource = ok(deleteSource(full, source)).document;
  assert.deepEqual(withoutSource.trails[0].steps, [{ ref: annotation }]);
  assert.equal(withoutSource.sources.length, 0);
  assert.equal(deleteSource(withoutSource, source).problem.code, "missing");
  const withoutAnnotation = ok(deleteAnnotation(full, annotation)).document;
  assert.deepEqual(withoutAnnotation.trails[0].steps, [{ ref: source }]);
  const withoutTrail = ok(deleteTrail(full, trail)).document;
  assert.equal(withoutTrail.trails.length, 0);
  assert.equal(withoutTrail.sources.length, 1);
  assert.equal(withoutTrail.annotations.length, 2);
  assert.equal(deleteTrail(withoutTrail, trail).problem.code, "missing");
});

test("trails are listed most recently changed first, and annotated works most recently annotated first", () => {
  let document = createDocument();
  const first = ok(createTrail(document, { title: "First", now: T1 }));
  const second = ok(createTrail(first.document, { title: "Second", now: T2 }));
  const third = ok(createTrail(second.document, { title: "Third", now: T2 }));
  assert.deepEqual(recentTrails(third.document).map((each) => each.title), ["Third", "Second", "First"]);
  const saved = ok(saveSource(third.document, { title: "S", work: WORK, now: T1 }));
  const touched = ok(addTrailStep(saved.document, first.id, saved.id, T3));
  assert.equal(recentTrails(touched.document)[0].title, "First");

  const a = ok(addAnnotation(createDocument(), { work: WORK, revision: REVISION, target: quote("one"), now: T1 }));
  const b = ok(addAnnotation(a.document, { work: OTHER, revision: REVISION, target: quote("two"), now: T2 }));
  const c = ok(addAnnotation(b.document, { work: WORK, revision: REVISION, target: { version: 1, kind: "work" }, text: "n", now: T3 }));
  assert.deepEqual(annotatedWorks(c.document), [
    { work: WORK, highlights: 1, notes: 1, updatedAt: T3 },
    { work: OTHER, highlights: 1, notes: 0, updatedAt: T2 },
  ]);
  assert.deepEqual(annotatedWorks(createDocument()), []);
});

test("commitStore keeps a change only if it is saved, and never writes over unreadable data", () => {
  const store = memory();
  const get = () => store.area;
  const made = ok(commitStore(get, (document) => createTrail(document, { title: "Tea", now: T1 })));
  assert.equal(readStore(get).document.trails[0].id, made.id);
  const before = store.data.get(STORAGE_KEY);

  // A refused change reports the problem and writes nothing.
  const refused = commitStore(get, (document) => addTrailStep(document, made.id, "nope", T2));
  assert.deepEqual([refused.ok, refused.reason, refused.problem.code], [false, "problem", "danglingRef"]);
  assert.equal(store.data.get(STORAGE_KEY), before);

  // A full store leaves what was saved.
  const full = { getItem: (key) => store.area.getItem(key), setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem: () => {} };
  assert.equal(commitStore(() => full, (document) => createTrail(document, { title: "More", now: T2 })).reason, "full");
  assert.equal(store.data.get(STORAGE_KEY), before);

  // Denied storage and unreadable data are named, and the unreadable text is untouched.
  assert.equal(commitStore(() => { throw new DOMException("no", "SecurityError"); }, (document) => ({ ok: true, document })).reason, "blocked");
  for (const text of ["{ not json", JSON.stringify({ format: "openblog.research-notebook", version: 1 }), JSON.stringify({ ...createDocument(), version: 99 })]) {
    const other = memory();
    other.data.set(STORAGE_KEY, text);
    let called = false;
    const result = commitStore(() => other.area, (document) => { called = true; return createTrail(document, { title: "x", now: T1 }); });
    assert.deepEqual([result.ok, result.reason], [false, "unreadable"]);
    assert.equal(called, false);
    assert.equal(other.data.get(STORAGE_KEY), text);
  }
});

test("clearStore removes everything saved, even what cannot be read, and reports a store that keeps it", () => {
  const store = memory();
  const get = () => store.area;
  ok(commitStore(get, (document) => createTrail(document, { title: "Tea", now: T1 })));
  assert.deepEqual(clearStore(get), { ok: true });
  assert.equal(store.data.has(STORAGE_KEY), false);
  assert.equal(readStore(get).status, "empty");
  assert.deepEqual(clearStore(get), { ok: true }, "clearing an empty store is fine");
  store.data.set(STORAGE_KEY, "{ not json");
  assert.deepEqual(clearStore(get), { ok: true });
  assert.equal(store.data.has(STORAGE_KEY), false);
  assert.deepEqual(clearStore(() => { throw new DOMException("no", "SecurityError"); }), { ok: false, reason: "blocked" });
  assert.deepEqual(clearStore(() => undefined), { ok: false, reason: "blocked" });
  const sticky = { getItem: () => "kept", removeItem: () => {} };
  assert.deepEqual(clearStore(() => sticky), { ok: false, reason: "blocked" });
});

test("removing a post's highlights and notes removes them from trails and leaves other posts alone", () => {
  const { document, annotation, note, trail } = seeded();
  const full = ok(addTrailStep(ok(addTrailStep(document, trail, annotation, T2)).document, trail, note, T2)).document;
  const next = ok(deleteWorkAnnotations(full, WORK)).document;
  assert.deepEqual(next.annotations.map((each) => each.id), [note]);
  assert.deepEqual(next.trails[0].steps, [{ ref: note }]);
  assert.equal(deleteWorkAnnotations(next, WORK).problem.code, "missing");
});
