// Export, import and privacy controls for the reader's local document (#87, ADR 0243): an export holds
// only what it declares, an import is planned before it is kept, and nothing is repaired or overwritten.
import test from "node:test";
import assert from "node:assert/strict";

import { MAX_DOCUMENT_BYTES, createDocument, readDocumentJson, serializeDocument } from "../../web/components/reader-annotations.js";
import {
  CHANGED_EVENT,
  DISABLED_KEY,
  STORAGE_KEY,
  addAnnotation,
  clearStore,
  commitStore,
  createTrail,
  addTrailStep,
  isDisabled,
  readStore,
  saveSource,
  savedKeys,
  setDisabled,
  writeStore,
} from "../../web/components/reader-annotations-store.js";
import { MAX_IMPORT_BYTES, buildExport, exportFileName, planImport, summarize } from "../../web/components/reader-annotations-transfer.js";

const WORK = { site: "https://example.com", path: "/posts/tea/" };
const OTHER = { site: "https://example.com", path: "/posts/coffee/" };
const REVISION = "p1:0123456789abcdef0123456789abcdef";
const quote = (exact) => ({ version: 1, kind: "quote", section: "brewing", exact, prefix: "Steep the tea for ", suffix: ". Then taste", start: 18 });
const T1 = "2026-10-27T09:00:00Z";
const T2 = "2026-10-27T10:00:00Z";

const ok = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result.problem ?? result.problems));
  return result;
};

function memory() {
  const data = new Map();
  const area = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    key: (index) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  };
  return { data, storage: () => area };
}

function seeded() {
  let document = createDocument();
  const a = ok(addAnnotation(document, { work: WORK, revision: REVISION, target: quote("three minutes"), now: T1, random: () => 0.1 }));
  const b = ok(addAnnotation(a.document, { work: OTHER, revision: REVISION, target: { version: 1, kind: "work" }, text: "Private thought.", now: T1, random: () => 0.2 }));
  const c = ok(addAnnotation(b.document, { work: WORK, revision: REVISION, target: quote("boiling"), text: "Check this.", now: T1, random: () => 0.3 }));
  const s = ok(saveSource(c.document, { title: "Kettle guide", url: "https://example.org/kettles", from: WORK, text: "My source note.", now: T1, random: () => 0.4 }));
  const t = ok(createTrail(s.document, { title: "Learning tea", now: T1, random: () => 0.5 }));
  const u = ok(addTrailStep(t.document, t.id, a.id, T2));
  const v = ok(addTrailStep(u.document, t.id, b.id, T2));
  return { document: v.document, highlight: a.id, section: b.id, quoteNote: c.id, source: s.id, trail: t.id };
}

test("an export without notes holds the highlights and says what it leaves out", () => {
  const data = seeded();
  const file = buildExport(data.document, { date: new Date("2026-10-27T12:00:00Z") });
  assert.equal(file.fileName, "openblog-reading-trail-2026-10-27.json");
  const read = readDocumentJson(file.text);
  assert.equal(read.ok, true);
  assert.equal(read.document.privacy.notes, "omitted");
  assert.equal(file.omittedNotes, 1, "the note on the whole post has nothing left once its words go");
  assert.ok(!file.text.includes("Private thought."));
  assert.ok(!file.text.includes("Check this."));
  assert.ok(!file.text.includes("My source note."));
  assert.ok(file.text.includes("three minutes"), "the quoted words are always in the file");
  assert.equal(file.counts.notes, 0);
  assert.equal(file.counts.highlights, 2, "a note on a quote becomes its highlight");
});

test("an export with notes keeps them and says so", () => {
  const data = seeded();
  const file = buildExport(data.document, { notes: true });
  assert.equal(readDocumentJson(file.text).document.privacy.notes, "included");
  assert.ok(file.text.includes("Private thought."));
  assert.equal(file.omittedNotes, 0);
});

test("an export holds only the document's own fields: no site data", () => {
  const data = seeded();
  for (const notes of [false, true]) {
    const parsed = JSON.parse(buildExport(data.document, { notes }).text);
    assert.deepEqual(Object.keys(parsed), ["format", "version", "privacy", "annotations", "sources", "trails", "reflections"]);
    assert.deepEqual(Object.keys(parsed.privacy), ["scope", "notes"]);
    assert.equal(parsed.privacy.scope, "reader-private");
  }
  assert.match(exportFileName(new Date("2026-01-02T03:04:05Z")), /^openblog-reading-trail-2026-01-02\.json$/);
});

test("an empty export is still a valid document and exports are byte-stable", () => {
  const empty = buildExport(createDocument());
  assert.equal(readDocumentJson(empty.text).ok, true);
  const data = seeded();
  assert.equal(buildExport(data.document).text, buildExport(data.document).text);
  assert.equal(summarize(data.document).trails, 1);
});

test("export then import into an empty browser restores the document", () => {
  const data = seeded();
  const file = buildExport(data.document, { notes: true });
  const plan = planImport(createDocument(), file.text);
  assert.equal(plan.ok, true);
  assert.equal(plan.text, serializeDocument(data.document), "a lossless round trip");
  assert.deepEqual(plan.added, { annotations: 3, sources: 1, trails: 1, reflections: 0 });
  assert.equal(plan.conflicts.length, 0);
});

test("importing the same file twice changes nothing the second time", () => {
  const data = seeded();
  const file = buildExport(data.document, { notes: true });
  const first = planImport(createDocument(), file.text);
  const second = planImport(first.document, file.text);
  assert.equal(second.ok, true);
  assert.equal(second.changes, false);
  assert.deepEqual(second.added, { annotations: 0, sources: 0, trails: 0, reflections: 0 });
  assert.equal(second.same.annotations + second.same.sources + second.same.trails, 5);
});

test("an import merges after what is saved, in file order, and is deterministic", () => {
  const data = seeded();
  const mine = ok(addAnnotation(createDocument(), { work: OTHER, revision: REVISION, target: quote("steeping"), now: T1, random: () => 0.9 })).document;
  const file = buildExport(data.document, { notes: true }).text;
  const one = planImport(mine, file);
  const two = planImport(mine, file);
  assert.equal(one.text, two.text);
  assert.equal(one.document.annotations[0].target.exact, "steeping");
  assert.deepEqual(one.document.annotations.slice(1).map((record) => record.id), data.document.annotations.map((record) => record.id));
});

test("a record with the same content under another id is not added twice, and trail steps follow it", () => {
  const data = seeded();
  const twin = JSON.parse(JSON.stringify(data.document));
  twin.annotations[0].id = "hl-other";
  twin.trails[0].steps[0].ref = "hl-other";
  const plan = planImport(data.document, JSON.stringify(twin));
  assert.equal(plan.ok, true);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.duplicates[0].of, data.highlight);
  assert.equal(plan.document.annotations.length, data.document.annotations.length);
});

test("a conflict keeps what is saved unless the reader chooses the file's version", () => {
  const data = seeded();
  const theirs = JSON.parse(JSON.stringify(data.document));
  theirs.annotations[1].text = "Their words.";
  theirs.annotations[1].updatedAt = T2;
  const keep = planImport(data.document, JSON.stringify(theirs));
  assert.equal(keep.conflicts.length, 1);
  assert.equal(keep.conflicts[0].id, data.section);
  assert.equal(keep.document.annotations[1].text, "Private thought.");
  assert.equal(keep.changes, false);
  const file = planImport(data.document, JSON.stringify(theirs), { choice: "file" });
  assert.equal(file.document.annotations[1].text, "Their words.");
  assert.equal(file.changes, true);
});

test("a file that leaves out notes never erases saved notes by default", () => {
  const data = seeded();
  const without = buildExport(data.document).text;
  const plan = planImport(data.document, without);
  assert.equal(plan.ok, true);
  assert.equal(plan.notes, "omitted");
  assert.equal(plan.document.annotations.find((record) => record.id === data.section).text, "Private thought.");
});

test("a file that leaves out notes never erases saved notes, even when the file's version is chosen", () => {
  const data = seeded();
  const without = buildExport(data.document).text;
  const plan = ok(planImport(data.document, without, { choice: "file" }));
  const find = (bucket, id) => plan.document[bucket].find((record) => record.id === id);
  assert.equal(find("sources", data.source).text, "My source note.");
  assert.equal(find("annotations", data.quoteNote).kind, "note");
  assert.equal(find("annotations", data.quoteNote).text, "Check this.");
  assert.equal(find("annotations", data.section).text, "Private thought.");
  assert.deepEqual(find("trails", data.trail).steps.map((step) => step.ref), [data.highlight, data.section]);
  assert.equal(plan.conflicts.length, 0, "a missing note is not a disagreement");
  assert.equal(plan.changes, false);
});

test("annotations on the post being read are checked against its text", () => {
  const data = seeded();
  const sections = [{ index: 0, anchor: "brewing", title: "Brewing", text: "Steep the tea for four minutes. Then taste", digest: "d1" }];
  const plan = planImport(createDocument(), buildExport(data.document, { notes: true }).text, { works: { [`${WORK.site}${WORK.path}`]: { revision: REVISION, sections } } });
  assert.equal(plan.ok, true);
  assert.ok(plan.stale.length >= 1, "the words are no longer on the page");
  assert.equal(plan.unchecked, 1, "the note on another post is checked when that post is opened");
});

test("a file that cannot be read is refused with scoped problems and no document", () => {
  const data = seeded();
  const bad = JSON.parse(buildExport(data.document, { notes: true }).text);
  bad.version = 3;
  const newer = planImport(data.document, JSON.stringify(bad));
  assert.equal(newer.ok, false);
  assert.ok(newer.problems.some((problem) => problem.code === "unsupportedVersion"));
  assert.equal(newer.document, undefined);

  const wrong = planImport(data.document, JSON.stringify({ format: "openblog.research-notebook", version: 1 }));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.problems[0].code, "wrongFormat");

  assert.equal(planImport(data.document, "{not json").problems[0].code, "malformed");
  assert.equal(planImport(data.document, "[]").ok, false);
});

test("hostile files are refused: unsafe links, traversal, control characters, unknown fields", () => {
  const data = seeded();
  const base = JSON.parse(buildExport(data.document, { notes: true }).text);
  const mutate = (change) => {
    const copy = JSON.parse(JSON.stringify(base));
    change(copy);
    return planImport(data.document, JSON.stringify(copy));
  };
  const codes = (plan) => plan.problems.map((problem) => problem.code);
  assert.ok(codes(mutate((d) => (d.sources[0].url = "javascript:alert(1)"))).includes("unsafeScheme"));
  assert.ok(codes(mutate((d) => (d.sources[0].url = "https://user:pw@example.org/x"))).some((code) => code === "unsafeScheme" || code === "invalidUrl"));
  assert.ok(codes(mutate((d) => (d.annotations[0].work.path = "/posts/../../etc/passwd"))).includes("invalidPath"));
  assert.ok(codes(mutate((d) => (d.annotations[1].text = `a${String.fromCodePoint(0x202e)}b`))).includes("forbiddenCharacter"));
  assert.ok(codes(mutate((d) => (d.annotations[0].extra = 1))).includes("unknownField"));
  assert.ok(codes(mutate((d) => (d.trails[0].steps[0].ref = "nope"))).includes("danglingRef"));
  const loud = mutate((d) => (d.annotations[1].text = "<img src=x onerror=alert(1)>"));
  assert.equal(loud.ok, true, "markup is only text; it is shown as text");
});

test("messages never repeat reader text and long problem lists are bounded", () => {
  const data = seeded();
  const base = JSON.parse(buildExport(data.document, { notes: true }).text);
  base.annotations = Array.from({ length: 30 }, (_, index) => ({ ...base.annotations[0], id: `bad-${index}`, extra: "SECRET-WORDS" }));
  const plan = planImport(createDocument(), JSON.stringify(base));
  assert.equal(plan.ok, false);
  assert.ok(plan.problems.length <= 8);
  assert.ok(plan.moreProblems > 0);
  assert.ok(!JSON.stringify(plan).includes("SECRET-WORDS"));
});

test("an oversized file is refused", () => {
  assert.equal(MAX_IMPORT_BYTES, MAX_DOCUMENT_BYTES);
  const plan = planImport(createDocument(), " ".repeat(MAX_DOCUMENT_BYTES + 1));
  assert.equal(plan.ok, false);
  assert.equal(plan.problems[0].code, "tooLarge");
});

test("an import that would pass a limit is refused whole", () => {
  const data = seeded();
  const base = JSON.parse(buildExport(data.document, { notes: true }).text);
  base.trails = Array.from({ length: 50 }, (_, index) => ({ id: `t-${index}`, kind: "trail", title: `Trail ${index}`, steps: [], createdAt: T1, updatedAt: T1 }));
  const plan = planImport(data.document, JSON.stringify(base));
  assert.equal(plan.ok, false, "50 new trails and the one already saved are over the limit");
  assert.equal(plan.problems[0].code, "tooMany");
});

test("committing an import writes once and leaves unreadable data alone", () => {
  const data = seeded();
  const mem = memory();
  const file = buildExport(data.document, { notes: true }).text;
  const result = commitStore(mem.storage, (current) => planImport(current, file));
  assert.equal(result.ok, true);
  assert.equal(readStore(mem.storage).document.annotations.length, 3);

  const broken = memory();
  broken.data.set(STORAGE_KEY, "{garbage");
  const refused = commitStore(broken.storage, (current) => planImport(current, file));
  assert.deepEqual(refused, { ok: false, reason: "unreadable" });
  assert.equal(broken.data.get(STORAGE_KEY), "{garbage", "never overwritten");

  // A refused plan changes nothing.
  const before = mem.data.get(STORAGE_KEY);
  const bad = commitStore(mem.storage, (current) => planImport(current, "{nope"));
  assert.equal(bad.ok, false);
  assert.equal(mem.data.get(STORAGE_KEY), before);
});

test("turning the feature off keeps the data, and erasing is verifiable", () => {
  const mem = memory();
  writeStore(mem.storage, seeded().document);
  assert.equal(isDisabled(mem.storage), false);
  assert.deepEqual(setDisabled(mem.storage, true), { ok: true });
  assert.equal(isDisabled(mem.storage), true);
  assert.deepEqual(savedKeys(mem.storage), [STORAGE_KEY, DISABLED_KEY].sort());
  assert.equal(readStore(mem.storage).status, "ok", "turning off removed nothing");
  assert.deepEqual(setDisabled(mem.storage, false), { ok: true });
  assert.equal(isDisabled(mem.storage), false);

  mem.data.set(`${STORAGE_KEY}.future`, "x");
  mem.data.set("unrelated", "keep");
  assert.deepEqual(clearStore(mem.storage), { ok: true });
  assert.deepEqual(savedKeys(mem.storage), [`${STORAGE_KEY}.future`], "the check lists whatever the feature still holds");
  assert.equal(mem.data.get("unrelated"), "keep");
});

test("erasing removes data this version cannot read", () => {
  const mem = memory();
  mem.data.set(STORAGE_KEY, '{"format":"openblog.reader-annotations","version":9}');
  assert.equal(readStore(mem.storage).status, "unreadable");
  assert.deepEqual(clearStore(mem.storage), { ok: true });
  assert.deepEqual(savedKeys(mem.storage), []);
});

test("storage that denies access is reported, not thrown", () => {
  const denied = () => {
    throw new Error("denied");
  };
  assert.equal(isDisabled(denied), false);
  assert.deepEqual(setDisabled(denied, true), { ok: false, reason: "blocked" });
  assert.equal(savedKeys(denied), null);
  assert.equal(typeof CHANGED_EVENT, "string");
});
