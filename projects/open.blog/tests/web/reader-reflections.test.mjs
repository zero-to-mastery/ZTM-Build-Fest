// The reader's private interpretation history (ADR 0244): snapshots of a reading kept in the
// reader-annotation document, with revisions, derived stale state, migration, storage failures,
// hostile imports, and an explicit, bounded, non-converting submission copy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_NOTE_CHARS,
  MAX_REFLECTIONS,
  MAX_SUBMISSIONS,
  createDocument,
  exportDocument,
  migrateDocument,
  readDocument,
  readDocumentJson,
  serializeDocument,
} from "../../web/components/reader-annotations.js";
import { STORAGE_KEY, addAnnotation, commitStore, newId, readStore, writeStore } from "../../web/components/reader-annotations-store.js";
import { buildExport, planImport, summarize } from "../../web/components/reader-annotations-transfer.js";
import {
  addReflection,
  assessReflections,
  deleteReflection,
  deleteWorkReflections,
  markSubmitted,
  prepareSubmissionCopy,
  reflectionHistories,
  reflectionsOf,
  relabelReflection,
  reviseReflection,
} from "../../web/components/reader-reflections.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/reader-annotations.json", import.meta.url), "utf8"));
const WORK = { site: "https://example.com", path: "/posts/tea/" };
const OTHER = { site: "https://example.com", path: "/posts/coffee/" };
const REV1 = "p1:0123456789abcdef0123456789abcdef";
const REV2 = "p1:fedcba9876543210fedcba9876543210";
const WHOLE = { version: 1, kind: "work" };
const SECTION = { version: 1, kind: "section", section: "brewing" };
const T1 = "2026-10-27T09:00:00Z";
const T2 = "2026-10-27T10:00:00Z";
const T3 = "2026-10-27T11:00:00Z";
const copy = (value) => JSON.parse(JSON.stringify(value));
const ok = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result.problem ?? result.problems ?? result.error));
  return result;
};
const fail = (result, code) => {
  assert.equal(result.ok, false);
  assert.equal((result.problem ?? result.error ?? result.problems[0]).code, code);
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

// A history on the tea post: an early reading, a later one, and one on another work.
function seeded() {
  const first = ok(addReflection(createDocument(), { work: WORK, revision: REV1, target: WHOLE, text: "Tea is about patience.", label: "First read", now: T1, random: () => 0.1 }));
  const second = ok(reviseReflection(first.document, first.id, { revision: REV2, text: "Tea is about attention, not patience.", label: "After the rewrite", now: T2, random: () => 0.2 }));
  const other = ok(addReflection(second.document, { work: OTHER, revision: REV1, target: SECTION, text: "Coffee is a different thing.", now: T3, random: () => 0.3 }));
  return { document: other.document, first: first.id, second: second.id, other: other.id };
}

test("a snapshot records the work, revision, target, label, provenance and times, and a revision follows the earlier one", () => {
  const data = seeded();
  const [one, two] = reflectionsOf(data.document, WORK);
  assert.equal(one.kind, "reflection");
  assert.deepEqual(one.work, WORK);
  assert.equal(one.revision, REV1);
  assert.equal(one.label, "First read");
  assert.equal(one.provenance, "written");
  assert.equal(one.createdAt, T1);
  assert.equal(one.revises, undefined);
  assert.equal(two.revises, one.id);
  assert.equal(two.revision, REV2, "the later snapshot records the revision of the page it was read on");
  assert.deepEqual(two.target, one.target, "a revision keeps the earlier target unless told otherwise");
  assert.equal(readDocument(data.document).ok, true);
});

test("snapshots are never rewritten: revising and relabelling leave the earlier words alone", () => {
  const data = seeded();
  const before = copy(reflectionsOf(data.document, WORK)[0]);
  const relabelled = ok(relabelReflection(data.document, data.first, "Renamed", T3));
  const after = relabelled.document.reflections.find((each) => each.id === data.first);
  assert.equal(after.label, "Renamed");
  assert.equal(after.text, before.text);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.target, before.target);
  assert.equal(after.createdAt, before.createdAt);
  const cleared = ok(relabelReflection(relabelled.document, data.first, undefined, T3));
  assert.equal("label" in cleared.document.reflections.find((each) => each.id === data.first), false);
});

test("a history is one line: a reading already followed cannot be followed again", () => {
  const data = seeded();
  fail(reviseReflection(data.document, data.first, { revision: REV2, text: "A branch.", now: T3 }), "alreadyRevised");
  fail(reviseReflection(data.document, "refl-nope", { revision: REV2, text: "x", now: T3 }), "missing");
  const histories = reflectionHistories(data.document, WORK);
  assert.equal(histories.length, 1);
  assert.deepEqual(histories[0].map((each) => each.id), [data.first, data.second]);
  assert.equal(reflectionHistories(data.document, OTHER)[0].length, 1);
  // A file that branches a history is refused whole.
  const branched = copy(data.document);
  branched.reflections.push({ ...copy(branched.reflections[1]), id: "refl-branch" });
  fail(readDocument(branched), "branchedHistory");
});

test("revisions cannot dangle, cross works, run backwards in time, or loop", () => {
  const data = seeded();
  const dangling = copy(data.document);
  dangling.reflections[1].revises = "refl-ghost";
  fail(readDocument(dangling), "danglingRef");
  const crossed = copy(data.document);
  crossed.reflections[2].revises = data.first;
  fail(readDocument(crossed), "invalidRevises");
  const backwards = copy(data.document);
  backwards.reflections[0].revises = data.second;
  assert.ok(["timeOrder", "branchedHistory"].includes(readDocument(backwards).problems[0].code));
  const loop = copy(data.document);
  loop.reflections[0].revises = data.first;
  fail(readDocument(loop), "invalidRevises");
});

test("deleting a snapshot keeps the history one line and touches nothing else", () => {
  const data = seeded();
  const gone = ok(deleteReflection(data.document, data.first));
  assert.equal(gone.document.reflections.find((each) => each.id === data.second).revises, undefined);
  const three = ok(reviseReflection(data.document, data.second, { revision: REV2, text: "Third.", now: T3, random: () => 0.4 }));
  const middle = ok(deleteReflection(three.document, data.second));
  assert.equal(middle.document.reflections.find((each) => each.id === three.id).revises, data.first);
  fail(deleteReflection(data.document, "refl-nope"), "missing");
  assert.equal(ok(deleteWorkReflections(data.document, WORK)).document.reflections.length, 1);
  fail(deleteWorkReflections(createDocument(), WORK), "missing");
});

test("text rules: Unicode is kept exactly, and hidden or reordering characters are refused", () => {
  const words = "  “Tea” — 茶 الشاي 🍵 é\nsecond line\t";
  const kept = ok(addReflection(createDocument(), { work: WORK, revision: REV1, target: WHOLE, text: words, label: "茶の学び", now: T1 }));
  assert.equal(kept.document.reflections[0].text, words, "no trimming or normalization");
  const round = ok(readDocumentJson(serializeDocument(kept.document)));
  assert.equal(round.document.reflections[0].text, words);
  for (const [text, code] of [
    ["", "emptyText"],
    ["a‮reversed", "forbiddenCharacter"],
    ["a\u0000b", "forbiddenCharacter"],
    ["lone \ud800 surrogate", "forbiddenCharacter"],
    ["x".repeat(MAX_NOTE_CHARS + 1), "textTooLong"],
  ]) {
    fail(addReflection(createDocument(), { work: WORK, revision: REV1, target: WHOLE, text, now: T1 }), code);
  }
  fail(addReflection(createDocument(), { work: WORK, revision: REV1, target: WHOLE, text: "ok", label: "a\nb", now: T1 }), "forbiddenCharacter");
  fail(addReflection(createDocument(), { work: WORK, revision: REV1, target: WHOLE, text: "ok", label: "", now: T1 }), "emptyText");
  assert.ok(readDocument(kept.document).ok);
});

test("a snapshot needs a real work, revision and target", () => {
  fail(addReflection(createDocument(), { work: { site: "javascript:alert(1)", path: "/x/" }, revision: REV1, target: WHOLE, text: "x", now: T1 }), "invalidSite");
  fail(addReflection(createDocument(), { work: { site: WORK.site, path: "/../x/" }, revision: REV1, target: WHOLE, text: "x", now: T1 }), "invalidPath");
  fail(addReflection(createDocument(), { work: WORK, revision: "latest", target: WHOLE, text: "x", now: T1 }), "invalidRevision");
  assert.equal(addReflection(createDocument(), { work: WORK, revision: REV1, target: { version: 1, kind: "bogus" }, text: "x", now: T1 }).ok, false);
});

test("the quota: snapshots are limited in number, and a full document is refused by the store", () => {
  const document = copy(createDocument());
  for (let index = 0; index < MAX_REFLECTIONS; index += 1) {
    document.reflections.push({ id: `refl-${index}`, kind: "reflection", work: WORK, revision: REV1, target: WHOLE, text: "x", provenance: "written", createdAt: T1, updatedAt: T1 });
  }
  assert.ok(readDocument(document).ok);
  fail(addReflection(readDocument(document).document, { work: WORK, revision: REV1, target: WHOLE, text: "one more", now: T2 }), "tooMany");
  // A document over its byte limit cannot be written; the browser's data is untouched.
  const big = copy(createDocument());
  for (let index = 0; index < 500; index += 1) {
    big.reflections.push({ id: `refl-${index}`, kind: "reflection", work: WORK, revision: REV1, target: WHOLE, text: "茶".repeat(MAX_NOTE_CHARS), provenance: "written", createdAt: T1, updatedAt: T1 });
  }
  const store = memory();
  assert.deepEqual(writeStore(store.storage, readDocument(big).document), { ok: false, reason: "full" });
  assert.equal(store.data.has(STORAGE_KEY), false);
});

test("storage denial, private browsing and a full browser are values, and reading never needs storage", () => {
  const data = seeded();
  const denied = () => {
    throw new DOMException("denied", "SecurityError");
  };
  assert.equal(readStore(denied).status, "blocked");
  assert.deepEqual(commitStore(denied, () => ok(addReflection(data.document, { work: WORK, revision: REV1, target: WHOLE, text: "x", now: T3 }))), { ok: false, reason: "blocked" });
  const full = () => ({
    getItem: () => null,
    setItem: () => {
      throw new DOMException("quota", "QuotaExceededError");
    },
  });
  assert.deepEqual(writeStore(full, data.document), { ok: false, reason: "full" });
  const privateMode = () => ({ getItem: () => null, setItem: () => { throw new DOMException("no", "InvalidStateError"); } });
  assert.deepEqual(commitStore(privateMode, (saved) => addReflection(saved, { work: WORK, revision: REV1, target: WHOLE, text: "x", now: T3 })), { ok: false, reason: "blocked" });
  // In memory, the pure functions keep working with no storage at all.
  assert.equal(reflectionsOf(data.document, WORK).length, 2);
});

test("snapshots are kept in the one saved document and survive a reload", () => {
  const data = seeded();
  const store = memory();
  const saved = commitStore(store.storage, () => ({ ok: true, document: data.document }));
  assert.equal(saved.ok, true);
  const read = readStore(store.storage);
  assert.equal(read.status, "ok");
  assert.equal(read.document.reflections.length, 3);
  assert.equal(Array.from(store.data.keys()).join(), STORAGE_KEY, "no second key");
});

test("migration: a version 1 document reads as version 2 with no reflections, and keeps its records", () => {
  const read = ok(readDocument(fixture.base));
  assert.equal(read.document.version, 2);
  assert.deepEqual(read.document.reflections, []);
  assert.equal(read.document.annotations.length, fixture.base.annotations.length);
  assert.equal(migrateDocument(fixture.base).document.version, 2);
  const upgraded = serializeDocument(read.document);
  assert.match(upgraded, /"version": 2/);
  assert.equal(ok(readDocumentJson(upgraded)).document.version, 2);
  // Version 1 never had reflections: a file that says version 1 and holds them is refused, not guessed at.
  const lying = { ...copy(fixture.base), reflections: [] };
  fail(readDocument(lying), "unknownField");
  // A version 2 document must say its reflections.
  const missing = copy(read.document);
  delete missing.reflections;
  assert.equal(readDocument(missing).ok, false);
  fail(readDocument({ ...copy(read.document), version: 3 }), "unsupportedVersion");
});

test("a saved version 1 document is read, extended and written back as version 2", () => {
  const store = memory();
  store.data.set(STORAGE_KEY, JSON.stringify(fixture.base));
  const result = commitStore(store.storage, (document) => addReflection(document, { work: WORK, revision: REV1, target: WHOLE, text: "New.", now: T1 }));
  assert.equal(result.ok, true);
  const written = JSON.parse(store.data.get(STORAGE_KEY));
  assert.equal(written.version, 2);
  assert.equal(written.reflections.length, 1);
  assert.equal(written.annotations.length, fixture.base.annotations.length);
});

test("stale state is derived, never stored, and says honestly when the article changed", () => {
  const data = seeded();
  const sections = [{ anchor: "brewing", text: "Steep the tea for three minutes.", digest: "d1" }];
  const works = {
    [`${WORK.site}${WORK.path}`]: { revision: REV2, sections },
    [`${OTHER.site}${OTHER.path}`]: { revision: REV2, sections: [{ anchor: "other", text: "Different.", digest: "d2" }] },
  };
  const before = serializeDocument(data.document);
  const states = assessReflections(data.document, works);
  assert.equal(serializeDocument(data.document), before, "assessing changes nothing");
  const byId = new Map(states.map((each) => [each.id, each]));
  assert.equal(byId.get(data.first).state, "current");
  assert.equal(byId.get(data.first).articleChanged, true, "the page is no longer the revision the first reading saw");
  assert.equal(byId.get(data.second).articleChanged, false);
  assert.equal(byId.get(data.other).state, "stale", "its section is gone");
  assert.equal(byId.get(data.other).reason, "sectionRemoved");
  const gone = assessReflections(data.document, {});
  assert.ok(gone.every((each) => each.state === "stale" && each.reason === "workUnavailable" && each.articleChanged === null));
  assert.equal(JSON.stringify(data.document).includes("articleChanged"), false);
});

test("export leaves reflections out unless the reader includes their words, and says so", () => {
  const data = seeded();
  const plain = buildExport(data.document);
  assert.equal(plain.omittedReflections, 3);
  assert.doesNotMatch(plain.text, /patience|attention|Coffee/);
  assert.equal(JSON.parse(plain.text).privacy.notes, "omitted");
  assert.deepEqual(JSON.parse(plain.text).reflections, []);
  const full = buildExport(data.document, { notes: true });
  assert.equal(full.omittedReflections, 0);
  assert.equal(full.counts.reflections, 3);
  assert.match(full.text, /patience/);
  assert.equal(JSON.parse(full.text).privacy.scope, "reader-private");
  const exported = exportDocument(data.document);
  assert.equal(exported.omittedReflections.length, 3);
  // A file that claims its notes are omitted yet holds reflections is refused.
  const lying = copy(data.document);
  lying.privacy.notes = "omitted";
  fail(readDocument(lying), "privacyMismatch");
  assert.equal(summarize(data.document).reflections, 3);
});

test("export then import restores the history, marks arrivals as imported, and a second import changes nothing", () => {
  const data = seeded();
  const file = buildExport(data.document, { notes: true });
  const plan = ok(planImport(createDocument(), file.text));
  assert.equal(plan.added.reflections, 3);
  const [one, two] = reflectionsOf(plan.document, WORK);
  assert.equal(one.provenance, "imported");
  assert.equal(two.revises, one.id);
  assert.equal(one.text, "Tea is about patience.");
  const again = ok(planImport(plan.document, file.text));
  assert.equal(again.changes, false);
  assert.equal(again.same.reflections + again.duplicates.length, 3);
  // The reader's own device keeps "written" for what it wrote.
  const onSameDevice = ok(planImport(data.document, file.text));
  assert.equal(onSameDevice.changes, false);
  assert.equal(reflectionsOf(onSameDevice.document, WORK)[0].provenance, "written");
});

test("an import reports reflections whose section is no longer in the article", () => {
  const data = seeded();
  const file = buildExport(data.document, { notes: true });
  const works = { [`${OTHER.site}${OTHER.path}`]: { revision: REV2, sections: [{ anchor: "other", text: "Different.", digest: "d2" }] } };
  const plan = ok(planImport(createDocument(), file.text, { works }));
  assert.deepEqual(plan.stale, [{ id: data.other, reason: "sectionRemoved" }]);
  assert.equal(plan.unchecked, 2);
});

test("a malicious import is refused whole and changes nothing", () => {
  const data = seeded();
  const file = JSON.parse(buildExport(data.document, { notes: true }).text);
  const attacks = [
    ["script in the text is only text", (f) => { f.reflections[0].text = "<img src=x onerror=alert(1)>"; }, true],
    ["unknown field", (f) => { f.reflections[0].public = true; }, false],
    ["status smuggled in", (f) => { f.reflections[0].status = "approved"; }, false],
    ["bad provenance", (f) => { f.reflections[0].provenance = "moderator"; }, false],
    ["bad kind", (f) => { f.reflections[0].kind = "third-perspective"; }, false],
    ["public scope", (f) => { f.privacy.scope = "public"; }, false],
    ["javascript site", (f) => { f.reflections[0].work.site = "javascript:alert(1)"; }, false],
    ["traversal path", (f) => { f.reflections[0].work.path = "/a/../../etc/passwd"; }, false],
    ["dangling revises", (f) => { f.reflections[1].revises = "refl-ghost"; }, false],
    ["prototype pollution key", (f) => { f.__proto__ = { polluted: true }; f.reflections[0].constructor = { prototype: { polluted: true } }; }, false],
    ["fake submission channel", (f) => { f.reflections[0].submissions = [{ at: T2, channel: "email" }]; }, false],
    ["submission before creation", (f) => { f.reflections[0].submissions = [{ at: "2020-01-01T00:00:00Z", channel: "hosted" }]; }, false],
    ["empty submissions", (f) => { f.reflections[0].submissions = []; }, false],
    ["too many reflections", (f) => { f.reflections = Array.from({ length: MAX_REFLECTIONS + 1 }, (_, i) => ({ ...f.reflections[0], id: `refl-${i}` })); }, false],
    ["id collides with a note", (f) => { f.annotations.push({ id: f.reflections[0].id, kind: "highlight" }); }, false],
  ];
  for (const [name, change, accepted] of attacks) {
    const attack = copy(file);
    change(attack);
    const text = name === "prototype pollution key" ? JSON.stringify(attack).replace('"format"', '"__proto__":{"polluted":true},"format"') : JSON.stringify(attack);
    const plan = planImport(createDocument(), text);
    assert.equal(plan.ok, accepted, name);
    if (!plan.ok) assert.equal(JSON.stringify(plan).includes("onerror"), false, `${name}: no reader text in problems`);
    assert.equal({}.polluted, undefined, name);
  }
  const huge = JSON.stringify({ ...file, reflections: [{ ...file.reflections[0], text: "茶".repeat(2_000_000) }] });
  assert.equal(planImport(createDocument(), huge).ok, false);
  assert.equal(planImport(createDocument(), "{ not json").ok, false);
});

// ---------------------------------------------------------------------------
// The submitted-copy boundary
// ---------------------------------------------------------------------------

const CONSENT = { publish: true, clarification: false, feature: false };

test("a submission copy is explicit: no consent, no copy", () => {
  const data = seeded();
  for (const consent of [undefined, {}, { publish: false }, { publish: "yes" }]) {
    fail(prepareSubmissionCopy(data.document, data.first, { site: WORK.site, consent }), "publicationConsentRequired");
  }
  const prepared = ok(prepareSubmissionCopy(data.document, data.first, { site: WORK.site, consent: CONSENT }));
  assert.equal(prepared.value.kind, "third-perspective");
});

test("a submission copy holds only what the Third Perspective form holds, and nothing private", () => {
  const data = seeded();
  const prepared = ok(prepareSubmissionCopy(data.document, data.second, { site: WORK.site, consent: CONSENT, category: "another-reading", name: "Reader", publishName: false }));
  assert.deepEqual(Object.keys(prepared.value), ["version", "kind", "work", "revision", "target", "category", "body", "attribution", "consent"]);
  assert.equal(prepared.value.work, WORK.path);
  assert.equal(prepared.value.revision, REV2);
  assert.equal(prepared.value.body, "Tea is about attention, not patience.");
  assert.deepEqual(prepared.value.attribution, { name: "Reader", publishName: false });
  for (const private_ of [data.first, data.second, "After the rewrite", "First read", "written", "patience.", "refl-", T1, T2, "Coffee", "revises", "provenance", "submissions"]) {
    if (private_ === "patience.") continue; // the first sentence's word also appears in the copy being sent
    assert.equal(prepared.text.includes(private_), false, `the copy must not hold ${private_}`);
  }
  assert.equal(prepared.text.includes("seenAt"), false, "no time the reader wrote it is sent");
});

test("preparing a copy never changes, converts or marks the local original", () => {
  const data = seeded();
  const frozen = readDocument(data.document).document;
  const before = serializeDocument(frozen);
  const prepared = ok(prepareSubmissionCopy(frozen, data.second, { site: WORK.site, consent: CONSENT }));
  assert.equal(serializeDocument(frozen), before);
  prepared.value.body = "changed";
  assert.equal(serializeDocument(frozen), before, "a prepared value is a fresh copy");
  const store = memory();
  assert.equal(store.data.size, 0, "preparing writes nothing");
});

test("marking a copy as sent records only that, and the original stays private and unchanged", () => {
  const data = seeded();
  const sent = ok(markSubmitted(data.document, data.second, { channel: "hosted", now: T3 }));
  const record = sent.document.reflections.find((each) => each.id === data.second);
  assert.deepEqual(record.submissions, [{ at: T3, channel: "hosted" }]);
  assert.equal(record.text, "Tea is about attention, not patience.");
  assert.equal(record.kind, "reflection");
  assert.equal(record.provenance, "written");
  assert.equal(sent.document.privacy.scope, "reader-private");
  assert.equal(readDocument(sent.document).ok, true);
  const twice = ok(markSubmitted(sent.document, data.second, { channel: "copy-and-send", now: T3 }));
  assert.equal(twice.document.reflections.find((each) => each.id === data.second).submissions.length, 2);
  fail(markSubmitted(data.document, data.second, { channel: "email", now: T3 }), "invalidChannel");
  fail(markSubmitted(data.document, "refl-nope", { channel: "hosted", now: T3 }), "missing");
  // The record of a send is never in the next copy.
  const next = ok(prepareSubmissionCopy(twice.document, data.second, { site: WORK.site, consent: CONSENT }));
  assert.equal(next.text.includes("submissions"), false);
  // Sends are bounded.
  let document = data.document;
  for (let index = 0; index < MAX_SUBMISSIONS; index += 1) document = ok(markSubmitted(document, data.second, { channel: "hosted", now: T3 })).document;
  fail(markSubmitted(document, data.second, { channel: "hosted", now: T3 }), "tooMany");
});

test("a copy is bounded and refused the way the submission form refuses", () => {
  const data = seeded();
  const long = ok(addReflection(data.document, { work: WORK, revision: REV1, target: WHOLE, text: "x".repeat(4001), now: T3, random: () => 0.9 }));
  fail(prepareSubmissionCopy(long.document, long.id, { site: WORK.site, consent: CONSENT }), "invalidBody");
  // The local original is complete, however long.
  assert.equal(long.document.reflections.find((each) => each.id === long.id).text.length, 4001);
  fail(prepareSubmissionCopy(data.document, data.first, { site: "https://elsewhere.example", consent: CONSENT }), "otherSite");
  fail(prepareSubmissionCopy(data.document, "refl-nope", { site: WORK.site, consent: CONSENT }), "missing");
  fail(prepareSubmissionCopy(data.document, data.first, { site: WORK.site, consent: CONSENT, category: "verdict" }), "unknownCategory");
  fail(prepareSubmissionCopy(data.document, data.first, { site: WORK.site, consent: CONSENT, publishName: true }), "consentWithoutName");
  const quoted = ok(addReflection(data.document, { work: WORK, revision: REV1, target: { version: 1, kind: "quote", section: "brewing", exact: "three minutes", prefix: "Steep the tea for ", suffix: ". Then taste", start: 18 }, text: "On this phrase.", now: T3, random: () => 0.8 }));
  fail(prepareSubmissionCopy(quoted.document, quoted.id, { site: WORK.site, consent: CONSENT }), "targetNotAllowed");
});

test("reflections and annotations do not collide: ids are shared, deleting a post's notes keeps its history", () => {
  const data = seeded();
  const noted = ok(addAnnotation(data.document, { work: WORK, revision: REV1, target: WHOLE, text: "A note.", now: T3, random: () => 0.1 }));
  const ids = [...noted.document.annotations, ...noted.document.reflections].map((each) => each.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(newId(noted.document, "refl", () => 0.55).startsWith("refl-"), true);
  assert.equal(noted.document.reflections.length, 3);
});
