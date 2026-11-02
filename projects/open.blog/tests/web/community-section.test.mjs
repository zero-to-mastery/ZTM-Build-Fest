import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The community section (#230, ADRs 0180 to 0184) read from the fixtures the Rust tests share:
// `tests/fixtures/community-features.json` (the fixed notice, every reason Admin states, and the
// editors' notes the lint accepts and refuses) and `tests/fixtures/community-section.html` (the
// section the build writes, byte for byte, for two reflections: one named, one anonymous).

const fixture = JSON.parse(readFileSync(new URL("../fixtures/community-features.json", import.meta.url), "utf8"));
const golden = readFileSync(new URL("../fixtures/community-section.html", import.meta.url), "utf8");
const { featureAuditNotices, featureStandingText } = await import("../../web/admin/admin.js");

const escaped = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const SIGNALS = /popular|rank|score|upvote|likes|reactions|trending|\bmost\b|\btop\b|\bbest\b/i;

test("the section is one labelled region with the fixed notice, one list and an article per feature", () => {
  assert.match(golden, /^<section id="ob-community-perspectives" class="ob-community-perspectives" aria-labelledby="ob-community-perspectives-title">/);
  assert.match(golden, /<h2 id="ob-community-perspectives-title">Community perspectives<\/h2>/);
  assert.ok(golden.includes(`<p class="ob-community-notice">${escaped(fixture.notice)}</p>`), "the fixed plural notice, whole");
  assert.equal((golden.match(/<ul /g) || []).length, 1);
  assert.equal((golden.match(/<ol/g) || []).length, 0, "an order here would read as a rank");
  assert.equal((golden.match(/<article /g) || []).length, 2);
  assert.equal((golden.match(/<li>/g) || []).length, 2);
  assert.equal((golden.match(/Chosen by the editors/g) || []).length, 2, "every item says it was chosen");
  assert.equal((golden.match(/Note from the editors:/g) || []).length, 1, "a note is labelled as the editors' own, and only where there is one");
});

test("every id is unique and every article is named by its own heading, apart from the Third Perspectives ids", () => {
  const ids = [...golden.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids}`);
  assert.ok(ids.every((id) => !id.startsWith("ob-perspective-")), "the reflection's own anchor stays in its list");
  for (const [, id, labelled] of golden.matchAll(/<article class="ob-feature" id="([^"]+)" aria-labelledby="([^"]+)">/g)) {
    assert.equal(labelled, `${id}-title`);
    assert.ok(ids.includes(labelled), `${labelled} names a heading`);
    assert.match(id, /^ob-feature-[0-9a-f-]{36}$/);
  }
  const links = [...golden.matchAll(/<a href="#([^"]+)">/g)].map((match) => match[1]);
  assert.ok(links.some((link) => link.startsWith("ob-perspective-")), "each points to the same reflection among the Third Perspectives");
});

test("no count, rank, popularity or script is written into the section", () => {
  const visible = golden.replace(/<time[^>]*>[^<]*<\/time>/g, "").replace(/ (id|href|datetime|class|aria-labelledby)="[^"]*"/g, "").replace(escaped(fixture.notice), "").replace(/not a vote/g, "");
  assert.doesNotMatch(visible, SIGNALS);
  assert.doesNotMatch(visible, /\b\d+\s+(readers?|people|likes?|votes?|reflections?|responses?)\b/i);
  assert.doesNotMatch(golden, /<script|<form|<ob-|onerror|javascript:/i);
  assert.doesNotMatch(fixture.notice.replace("not a vote", ""), SIGNALS);
});

test("provenance says whose reflection it is, and a name appears only where the reader gave one", () => {
  assert.match(golden, /Third Perspective from Mina Unique, a reader<\/h3>/);
  assert.match(golden, /Third Perspective from a reader<\/h3>/);
  const anonymous = golden.slice(golden.indexOf('id="ob-feature-00000000-0000-4000-8000-000000000002"'));
  assert.doesNotMatch(anonymous, /Mina/);
  assert.equal((golden.match(/approved by the editors\. It is featured here from/g) || []).length, 2);
  assert.ok(golden.includes("&lt;conversation&gt; &amp; a rhythm"), "the reader's words are escaped, never markup");
  assert.ok(golden.indexOf("2026-10-28") < golden.indexOf("2026-10-29"), "by the day each was featured");
});

test("every reason Admin states reads the same everywhere and carries no signal", () => {
  for (const reason of fixture.reasons) {
    const feature = { id: "a", post: "posts/x.md", featured: "2026-10-28", standing: reason.standing, reason: reason.id, explanation: reason.explanation };
    const text = featureStandingText(feature);
    assert.ok(text.includes(reason.explanation), `${reason.id}: ${text}`);
    assert.doesNotMatch(text, SIGNALS);
    const notices = featureAuditNotices({ features: [feature] });
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, reason.standing);
    assert.equal(notices[0].items[0].explanation, reason.explanation);
    assert.doesNotMatch(notices[0].text, SIGNALS);
  }
  const hidden = featureStandingText({ standing: "hidden", explanation: fixture.reasons.find((r) => r.id === "source-gone").explanation });
  assert.match(hidden, /the reader’s agreement still stand/);
  assert.doesNotMatch(featureStandingText({ standing: "mustComeOff", explanation: "x" }), /restores/);
});

test("the editors' notes the fixture lists are plain text, and the refused ones name a claim", () => {
  for (const { note, ok } of fixture.notes) {
    assert.equal(typeof note, "string");
    assert.ok(note.length <= 280);
    if (!ok) assert.match(note, /popular|\d+ readers|agrees|trending/i);
  }
});
