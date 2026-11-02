import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LIMITS,
  SECTION_CATALOG,
  addSection,
  addressProblem,
  fieldProblem,
  landingErrorText,
  moveSection,
  newSection,
  pageFrom,
  pagePayload,
  pageProblems,
  pageSame,
  removeSection,
  restoreSection,
  sectionProblems,
  sectionSummary,
  sectionTitle,
  serverProblemsBySection,
  setHidden,
  uniqueId,
} from "../../web/admin/landing.js";

// The server's section types, read from the Rust source so the picker can never miss one.
const rust = readFileSync(new URL("../../crates/openblog-core/src/landing.rs", import.meta.url), "utf8");
const serverTypes = [...rust.match(/pub const SECTION_TYPES: \[&str; \d+\] = \[([\s\S]*?)\];/)[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);

const page = (...ids) => ({ sections: ids.map((id) => ({ id, type: "series", heading: id })) });
const ids = (sections) => sections.map((section) => section.id);

test("the picker offers every section type the server knows, each with a plain description and sample", () => {
  assert.deepEqual(SECTION_CATALOG.map((entry) => entry.type).sort(), [...serverTypes].sort());
  for (const entry of SECTION_CATALOG) {
    assert.ok(entry.label && entry.description && entry.sample && entry.icon, entry.type);
    assert.ok(entry.fields.length > 0, entry.type);
  }
});

test("no field takes markup or styling: no html section, style, class or script field exists", () => {
  const names = [];
  const walk = (specs) => specs.forEach((spec) => { names.push(spec.name); if (spec.fields) walk(spec.fields); });
  for (const entry of SECTION_CATALOG) walk(entry.fields);
  for (const bad of ["html", "css", "style-sheet", "script", "class", "classes", "attributes"]) assert.ok(!names.includes(bad), bad);
  assert.ok(!SECTION_CATALOG.some((entry) => entry.type === "html" || entry.type === "custom-html"));
});

test("a new section gets an id no other section has", () => {
  assert.equal(uniqueId("welcome", []), "welcome");
  assert.equal(uniqueId("welcome", [{ id: "welcome" }]), "welcome-2");
  assert.equal(uniqueId("welcome", [{ id: "welcome" }, { id: "welcome-2" }]), "welcome-3");
  const added = addSection([newSection("welcome", [])], "welcome");
  assert.deepEqual(ids(added.sections), ["welcome", "welcome-2"]);
  assert.equal(added.added.heading, "Welcome to my blog");
});

test("a page holds at most the server's number of sections", () => {
  let sections = [];
  for (let i = 0; i < LIMITS.sections; i += 1) sections = addSection(sections, "series").sections;
  const full = addSection(sections, "series");
  assert.equal(full.full, true);
  assert.equal(full.sections.length, LIMITS.sections);
});

test("moving a section swaps it with its neighbour and stops at the ends", () => {
  const sections = page("a", "b", "c").sections;
  assert.deepEqual(ids(moveSection(sections, "b", -1).sections), ["b", "a", "c"]);
  assert.deepEqual(ids(moveSection(sections, "b", 1).sections), ["a", "c", "b"]);
  const top = moveSection(sections, "a", -1);
  assert.equal(top.sections, sections);
  assert.equal(top.from, top.to);
  assert.equal(moveSection(sections, "c", 1).from, 2);
});

test("hiding keeps the section and showing removes the flag", () => {
  const sections = page("a", "b").sections;
  const hidden = setHidden(sections, "a", true);
  assert.equal(hidden[0].hidden, true);
  assert.equal(hidden.length, 2);
  assert.ok(!("hidden" in setHidden(hidden, "a", false)[0]));
  assert.equal(sections[0].hidden, undefined, "the original is not changed");
});

test("deleting is undone into the same position, even after other changes", () => {
  const sections = page("a", "b", "c", "d").sections;
  const { sections: after, removed } = removeSection(sections, "c");
  assert.deepEqual(ids(after), ["a", "b", "d"]);
  assert.equal(removed.index, 2);
  assert.deepEqual(ids(restoreSection(after, removed)), ["a", "b", "c", "d"]);
  // Restoring at the end and into a shorter list stays in range.
  const last = removeSection(sections, "d");
  assert.deepEqual(ids(restoreSection(page("a").sections, last.removed)), ["a", "d"]);
  // A taken id gets a new one rather than a duplicate.
  const clash = restoreSection([{ id: "c", type: "series", heading: "x" }], removed);
  assert.equal(new Set(ids(clash)).size, 2);
  assert.equal(removeSection(sections, "zzz").removed, null);
});

test("cards say what they hold in plain words", () => {
  assert.equal(sectionTitle({ type: "welcome" }), "Welcome banner");
  assert.equal(sectionSummary({ type: "welcome", heading: "Hello there" }), "Hello there");
  assert.equal(sectionSummary({ type: "welcome", heading: "" }), "No heading yet");
  assert.equal(sectionSummary({ type: "latest-posts", heading: "News", count: 3 }), "News (3 posts)");
  assert.equal(sectionSummary({ type: "buttons", items: [{ label: "Read" }, { label: "Email" }] }), "2 buttons: Read, Email");
  assert.equal(sectionSummary({ type: "faq", items: [] }), "No questions yet");
  assert.equal(sectionSummary({ type: "featured-post", post: "" }), "No post chosen yet");
  assert.ok(sectionSummary({ type: "rich-text", markdown: "x".repeat(300) }).length <= 80);
});

test("required fields and limits are explained inline in plain words", () => {
  assert.deepEqual(sectionProblems({ id: "w", type: "welcome", heading: "Hi" }), []);
  assert.equal(sectionProblems({ id: "w", type: "welcome", heading: " " })[0].message, "Welcome heading is needed. Fill it in before you save.");
  const long = sectionProblems({ id: "w", type: "welcome", heading: "x".repeat(LIMITS.heading + 1) })[0].message;
  assert.match(long, /the most is 120/);
  assert.match(sectionProblems({ id: "i", type: "image", src: "/a.png", alt: "" })[0].message, /Describe the picture is needed/);
  assert.match(sectionProblems({ id: "m", type: "map", label: "Here", lat: null, lon: 5 })[0].message, /Enter a number for latitude/);
  assert.match(sectionProblems({ id: "m", type: "map", label: "Here", lat: 91, lon: 5 })[0].message, /at most 90/);
  assert.match(sectionProblems({ id: "v", type: "video", provider: "youtube", video: "short", title: "T" })[0].message, /11 letters/);
  assert.match(sectionProblems({ id: "c", type: "contact", email: "", phone: "", address: "" })[0].message, /Add an email/);
  assert.match(sectionProblems({ id: "c", type: "contact", email: "nope" })[0].message, /email address/);
  assert.match(sectionProblems({ id: "f", type: "faq", items: [] })[0].message, /Add at least one question/);
  assert.equal(sectionProblems({ id: "f", type: "faq", items: [{ question: "Q", answer: "" }] })[0].path, "items.0.answer");
  assert.equal(sectionProblems({ id: "w", type: "welcome", heading: "Hi", button: { label: "Go", href: "http://x.com" } })[0].path, "button.href");
  assert.match(sectionProblems({ id: "z", type: "mystery" })[0].message, /does not know/);
});

test("addresses follow the server's rules and say what to change", () => {
  for (const ok of ["/archive/", "#top", "https://example.com/a", "mailto:me@example.com", "tel:+15550100"]) assert.equal(addressProblem(ok, "links"), "", ok);
  assert.match(addressProblem("http://example.com"), /https/);
  assert.match(addressProblem("javascript:alert(1)"), /not allowed/);
  assert.match(addressProblem("//evil.example"), /https:\/\//);
  assert.match(addressProblem("has space"), /spaces/);
  assert.match(addressProblem("mailto:me@example.com", "pictures"), /not allowed/);
  assert.match(addressProblem("/local", "https"), /https:\/\//);
  assert.match(addressProblem("https://"), /site's name/);
});

test("a count is a whole number in range, and blank means the usual number", () => {
  const spec = SECTION_CATALOG.find((entry) => entry.type === "latest-posts").fields[1];
  assert.equal(fieldProblem(spec, null), "");
  assert.equal(fieldProblem(spec, 5), "");
  assert.match(fieldProblem(spec, 0), /at least 1/);
  assert.match(fieldProblem(spec, 51), /at most 50/);
  assert.match(fieldProblem(spec, 2.5), /whole number/);
  assert.match(fieldProblem(spec, "abc"), /must be a number/);
});

test("the payload drops blank optional numbers and never changes the page it came from", () => {
  const draft = pageFrom({ format: "openblog-landing", version: 1, "x-future": { keep: 1 }, sections: [{ id: "l", type: "latest-posts", heading: "News", count: null }] });
  assert.equal(draft["x-future"].keep, 1);
  assert.ok(!("format" in draft) && !("version" in draft));
  const payload = pagePayload(draft);
  assert.deepEqual(payload.sections[0], { id: "l", type: "latest-posts", heading: "News" });
  assert.equal(payload["x-future"].keep, 1);
  assert.equal(draft.sections[0].count, null);
});

test("a preview can leave out the sections that have problems", () => {
  const draft = { sections: [{ id: "a", type: "series", heading: "Series" }, { id: "b", type: "welcome", heading: "" }] };
  assert.deepEqual(ids(pagePayload(draft, { leaveOut: true }).sections), ["a"]);
  assert.deepEqual([...pageProblems(draft).keys()], ["b"]);
});

test("the page compares by value and the server's problems are grouped by section", () => {
  assert.ok(pageSame(page("a"), page("a")));
  assert.ok(!pageSame(page("a"), page("b")));
  const grouped = serverProblemsBySection([{ section: "a", message: "one" }, { section: "a", message: "two" }, { section: null, message: "page" }]);
  assert.deepEqual(grouped.get("a"), ["one", "two"]);
  assert.deepEqual(grouped.get(""), ["page"]);
});

test("a failed request is worded for a person, not a developer", () => {
  assert.match(landingErrorText({ status: 409, data: { conflict: true } }), /changed somewhere else/);
  assert.match(landingErrorText({ status: 409, data: { newerVersion: true } }), /newer version/);
  assert.match(landingErrorText({ status: 401 }), /Sign in again/);
  assert.match(landingErrorText({ status: 413 }), /too big/);
  assert.match(landingErrorText(new TypeError("Failed to fetch")), /Could not reach the server\. Your changes are kept on this device/);
});

test("the preview has phone, tablet and desktop sizes and shrinks a frame to fit, never enlarging it", async () => {
  const { PREVIEW_SIZES, previewScale, previewSize, previewLeftOutText } = await import("../../web/admin/landing.js");
  assert.deepEqual(PREVIEW_SIZES.map((size) => size.label), ["Phone", "Tablet", "Desktop"]);
  assert.deepEqual(PREVIEW_SIZES.map((size) => size.width), [375, 768, 1280]);
  assert.equal(previewSize("tablet").width, 768);
  assert.equal(previewSize("nonsense").id, "phone");
  assert.equal(previewScale(320, 1280), 0.25);
  assert.equal(previewScale(2000, 375), 1);
  assert.equal(previewScale(0, 375), 1);
  assert.equal(previewLeftOutText(0), "");
  assert.match(previewLeftOutText(1), /1 section needs attention and is left out/);
  assert.match(previewLeftOutText(3), /3 sections need attention and are left out/);
});

const fakeStorage = () => {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
};

test("a draft is kept with the revision it was based on, and cleared when nothing is unsaved", async () => {
  const { createDraftStore } = await import("../../web/admin/landing.js");
  const storage = fakeStorage();
  const store = createDraftStore("k1", () => storage);
  assert.equal(store.load(), null);
  const page = { sections: [{ id: "a", type: "series", heading: "Series" }], "x-future": 1 };
  const record = store.save(page, "rev-1", new Date("2026-10-28T12:30:00Z"));
  assert.equal(record.base, "rev-1");
  page.sections[0].heading = "changed after";
  const loaded = store.load();
  assert.equal(loaded.page.sections[0].heading, "Series", "the draft is a copy");
  assert.equal(loaded.page["x-future"], 1);
  assert.equal(loaded.savedAt, "2026-10-28T12:30:00.000Z");
  assert.equal(store.inMemoryOnly, false);
  store.clear();
  assert.equal(store.load(), null);
  assert.equal(storage.data.size, 0);
});

test("a draft survives when the device refuses storage, for the life of the page", async () => {
  const { createDraftStore } = await import("../../web/admin/landing.js");
  const blocked = () => {
    throw new DOMException("denied", "SecurityError");
  };
  const store = createDraftStore("k2", blocked);
  assert.doesNotThrow(() => store.save({ sections: [] }, null));
  assert.equal(store.inMemoryOnly, true);
  assert.deepEqual(store.load().page, { sections: [] });
  assert.doesNotThrow(() => store.clear());
  assert.equal(store.load(), null);
  // A full or read-only store behaves the same.
  const full = { getItem: () => null, setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem: () => {} };
  const second = createDraftStore("k3", () => full);
  second.save({ sections: [{ id: "x", type: "series", heading: "H" }] }, "r");
  assert.equal(second.inMemoryOnly, true);
  assert.equal(second.load().base, "r");
});

test("a damaged stored draft is ignored, not trusted", async () => {
  const { createDraftStore } = await import("../../web/admin/landing.js");
  const storage = fakeStorage();
  const store = createDraftStore("k4", () => storage);
  for (const bad of ["not json", "{}", JSON.stringify({ v: 9, base: null, page: { sections: [] } }), JSON.stringify({ v: 1, base: 5, page: { sections: [] } }), JSON.stringify({ v: 1, base: null, page: { sections: "no" } })]) {
    storage.setItem("k4", bad);
    assert.equal(store.load(), null, bad);
  }
});

test("Compare says in plain words what differs between your page and the newer one", async () => {
  const { compareSections } = await import("../../web/admin/landing.js");
  const mine = [
    { id: "hello", type: "welcome", heading: "Mine" },
    { id: "text", type: "rich-text", markdown: "Same" },
    { id: "extra", type: "series", heading: "Only mine" },
  ];
  const theirs = [
    { id: "text", type: "rich-text", markdown: "Same" },
    { id: "hello", type: "welcome", heading: "Theirs", subheading: "New line" },
    { id: "added", type: "callout", tone: "info", body: "Only theirs" },
  ];
  const { rows, order } = compareSections(mine, theirs);
  assert.equal(order, true);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.hello.status, "different");
  assert.deepEqual(byId.hello.changed.sort(), ["a line underneath", "welcome heading"]);
  assert.equal(byId.hello.mine, "Mine");
  assert.equal(byId.hello.theirs, "Theirs");
  assert.equal(byId.extra.status, "only-mine");
  assert.equal(byId.added.status, "only-theirs");
  assert.ok(!byId.text, "identical sections are not listed");
  const same = compareSections(mine, structuredClone(mine));
  assert.deepEqual(same, { rows: [], order: false });
});

test("the Text section is a rich text field and a picture without a description is a problem", () => {
  const info = SECTION_CATALOG.find((entry) => entry.type === "rich-text");
  assert.equal(info.fields.length, 1);
  assert.equal(info.fields[0].kind, "richtext");
  assert.equal(fieldProblem(info.fields[0], "line one\n\nline two"), "");
  assert.match(fieldProblem(info.fields[0], "x".repeat(LIMITS.markdown + 1)), /the most is/);
  const bad = sectionProblems({ id: "t", type: "rich-text", markdown: "Look ![](https://example.com/a.png)" });
  assert.deepEqual(bad.map((p) => p.path), ["markdown"]);
  assert.match(bad[0].message, /needs a description/);
  assert.deepEqual(sectionProblems({ id: "t", type: "rich-text", markdown: "Look ![Tea](https://example.com/a.png)" }), []);
});

// ---------------------------------------------------------------- starter layouts (ADR 0258, #338)

import { STARTERS, applyLayout, replacingNeedsConfirm, starterSections } from "../../web/admin/landing.js";
import { writeFileSync as writeFixture } from "node:fs";

const withPosts = { posts: [{ slug: "one", title: "One" }] };
const starterCases = () => [
  ...STARTERS.map((starter) => [starter.id, starter.build({ posts: [] })]),
  ["portfolio-with-post", starterSections("portfolio", withPosts)],
];

test("every starter is a valid list of sections with its own ids and clearly marked sample words", () => {
  assert.deepEqual(STARTERS.map((s) => s.id), ["welcome", "small-business", "portfolio", "newsletter"]);
  for (const [name, sections] of starterCases()) {
    assert.ok(sections.length >= 3 && sections.length <= LIMITS.sections, name);
    assert.equal(new Set(sections.map((s) => s.id)).size, sections.length, `${name}: ids are unique`);
    for (const section of sections) {
      assert.deepEqual(sectionProblems(section), [], `${name}/${section.id}`);
      assert.ok(serverTypes.includes(section.type), `${name}/${section.id}`);
    }
    assert.match(JSON.stringify(sections), /Sample/, name);
    assert.equal(sections[0].id, "sample-note", `${name}: starts with a note that says it is a sample`);
  }
});

test("a starter is data only: no markup, and a fresh copy each time", () => {
  for (const [name, sections] of starterCases()) assert.doesNotMatch(JSON.stringify(sections), /<[a-z!/]|javascript:|style=/i, name);
  const a = starterSections("welcome");
  a[0].body = "changed";
  assert.notEqual(starterSections("welcome")[0].body, "changed");
  assert.deepEqual(starterSections("scratch"), []);
  assert.deepEqual(starterSections("nonsense"), []);
});

test("the portfolio features a post only when there is one to feature", () => {
  assert.ok(!starterSections("portfolio").some((s) => s.type === "featured-post"));
  assert.equal(starterSections("portfolio", withPosts).find((s) => s.type === "featured-post").post, "one");
});

test("applying a layout swaps the sections, keeps the rest of the page and hands back the old sections for Undo", () => {
  const before = { custom: 1, sections: [{ id: "a", type: "series", heading: "A" }] };
  const { page: after, previous } = applyLayout(before, starterSections("welcome"));
  assert.equal(after.custom, 1);
  assert.equal(after.sections.length, 4);
  assert.deepEqual(previous, before.sections);
  assert.equal(before.sections.length, 1, "the original page is not changed");
});

test("an existing page is never replaced without asking", () => {
  assert.equal(replacingNeedsConfirm([], { exists: true, dirty: true }), false);
  assert.equal(replacingNeedsConfirm([{ id: "a" }], { exists: true }), true);
  assert.equal(replacingNeedsConfirm([{ id: "a" }], { dirty: true }), true);
  assert.equal(replacingNeedsConfirm([{ id: "a" }], {}), false, "an untouched home-page start can be replaced, with Undo");
});

test("the starters shared with the Rust render test are up to date", () => {
  const path = new URL("../../crates/openblog-core/tests/fixtures/landing-starters.json", import.meta.url);
  const expected = JSON.stringify(Object.fromEntries(starterCases()), null, 2) + "\n";
  if (process.env.UPDATE_STARTERS) writeFixture(path, expected);
  assert.equal(readFileSync(path, "utf8").replace(/\r\n/g, "\n"), expected, "run UPDATE_STARTERS=1 node --test tests/web/admin-landing.test.mjs");
});

// ---------------------------------------------------------------- plain-language copy and the tour (ADR 0259, #339)

import { EMPTY_STATE_TEXT, GLOSSARY, TOUR_STEPS, createTourStore, previewLeftOutText } from "../../web/admin/landing.js";

// Words a person who has never built a web page does not know. They may appear in the Help words
// (marked "also called") and in addresses, never in a label, hint, message or button.
const JARGON = /\b(url|urls|uri|markdown|html|css|json|slug|block|blocks|api|schema|payload|metadata|revision|endpoint|markup|token|dom|parse|hex|alt text|id|ids|csrf)\b/i;

/** Every sentence-like string literal in a source text. */
const prose = (source) => [...source.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2]).filter((text) => /[A-Za-z]+ [A-Za-z]+/.test(text) && text !== "Edit in Markdown" && !/[{}]|\.oba-|\[data-/.test(text));

test("no jargon in the words the landing builder shows: labels, hints, samples, messages, starters and the tour", () => {
  const landing = readFileSync(new URL("../../web/admin/landing.js", import.meta.url), "utf8");
  // The model file minus the Help words, which explain the technical terms on purpose.
  const withoutGlossary = landing.replace(/export const GLOSSARY[\s\S]*?\]\);/, "");
  const found = prose(withoutGlossary).filter((text) => JARGON.test(text));
  assert.deepEqual(found, []);
  const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
  const start = admin.indexOf("// ---- landing page (ADR 0249");
  const end = admin.indexOf("// ---- customize look");
  assert.ok(start > 0 && end > start);
  assert.deepEqual(prose(admin.slice(start, end)).filter((text) => JARGON.test(text)), []);
  // The form fields, lists and the rich text toolbar.
  const fieldsStart = admin.indexOf("function landingFields(");
  const fieldsEnd = admin.indexOf("export function previewFrame");
  assert.ok(fieldsStart > 0 && fieldsEnd > fieldsStart);
  assert.deepEqual(prose(admin.slice(fieldsStart, fieldsEnd)).filter((text) => JARGON.test(text)), []);
});

test("every message about a problem says what happened and what to do next", () => {
  const messages = [
    addressProblem("a b"), addressProblem("a\\b"), addressProblem("//x"), addressProblem("http://x.org"), addressProblem("ftp://x.org"),
    addressProblem("https://"), addressProblem("tel:abc"), addressProblem("mailto:"), addressProblem("x.org", "https"),
    fieldProblem({ kind: "number", label: "Count", min: 1, max: 5, integer: true }, "x"),
    fieldProblem({ kind: "number", label: "Count", min: 1, max: 5, integer: true }, "2.5"),
    fieldProblem({ kind: "number", label: "Count", min: 1, max: 5 }, "0"),
    fieldProblem({ kind: "number", label: "Count", min: 1, max: 5 }, "9"),
    fieldProblem({ kind: "number", label: "Count", required: true }, ""),
    fieldProblem({ kind: "text", label: "Name", required: true }, ""),
    fieldProblem({ kind: "text", label: "Name", max: 3 }, "abcdef"),
    fieldProblem({ kind: "text", label: "Name" }, "a\nb"),
    fieldProblem({ kind: "email", label: "Email" }, "nope"),
    fieldProblem({ kind: "tel", label: "Phone" }, "abc"),
    fieldProblem({ kind: "post", label: "Post", required: true }, ""),
    ...sectionProblems({ id: "v", type: "video", provider: "youtube", video: "x", title: "T" }).map((p) => p.message),
    ...sectionProblems({ id: "v", type: "video", provider: "vimeo", video: "x", title: "T" }).map((p) => p.message),
    ...sectionProblems({ id: "c", type: "contact" }).map((p) => p.message),
    ...sectionProblems({ id: "u", type: "nope" }).map((p) => p.message),
    ...sectionProblems(null).map((p) => p.message),
    ...sectionProblems({ id: "r", type: "rich-text", markdown: "![](x.png)" }).map((p) => p.message),
    ...sectionProblems({ id: "b", type: "buttons", items: [] }).map((p) => p.message),
    ...[401, 403, 409, 413, 422, undefined].map((status) => landingErrorText({ status })),
    landingErrorText({ status: 409, data: { newerVersion: true } }),
    previewLeftOutText(2),
  ];
  const doing = /\b(open|fix|enter|add|use|remove|choose|start|write|shorten|fill|type|copy|check|try|sign in|reload|update|delete|describe|stay|look for|leave|save)\b/i;
  for (const message of messages) {
    assert.ok(message && message.length > 0);
    assert.doesNotMatch(message, JARGON, message);
    assert.match(message, doing, `says what to do: ${message}`);
  }
});

test("the empty state, the Help words and the tour are short real text", () => {
  assert.match(EMPTY_STATE_TEXT, /ready-made layout/);
  assert.match(EMPTY_STATE_TEXT, /Add a section/);
  assert.equal(TOUR_STEPS.length, 3);
  for (const step of TOUR_STEPS) {
    assert.ok(step.title.length < 60 && step.body.length < 260, step.title);
    assert.doesNotMatch(`${step.title} ${step.body}`, JARGON);
    assert.doesNotMatch(`${step.title} ${step.body}`, /[<>]/);
  }
  const terms = GLOSSARY.map((entry) => entry.term);
  for (const need of ["Section", "Layout", "Hide", "Preview", "Save", "Publish (make it live)", "Web address", "Picture description"]) assert.ok(terms.includes(need), need);
});

test("the tour never comes back once dismissed, even when the device will not keep anything", () => {
  const kept = new Map();
  const storage = () => ({ getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value) });
  const tour = createTourStore("tour-a", storage);
  assert.equal(tour.dismissed(), false);
  tour.dismiss();
  assert.equal(tour.dismissed(), true);
  assert.equal(createTourStore("tour-a", storage).dismissed(), true, "a later visit remembers");
  assert.equal(createTourStore("tour-b", storage).dismissed(), false, "another account does not");
  const blocked = () => { throw new Error("blocked"); };
  const memory = createTourStore("tour-c", blocked);
  assert.equal(memory.dismissed(), false);
  memory.dismiss();
  assert.equal(memory.dismissed(), true, "remembered for the visit");
});
