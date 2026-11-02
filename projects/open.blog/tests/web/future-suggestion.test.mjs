// Suggestions for future work (#227, ADRs 0153 to 0157): the browser and hosted-function half of the
// contract in crates/openblog-core/src/future_suggestion.rs, held to the Rust side case by case
// through two shared fixtures, plus the pure helpers the form and the function use.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACCEPTANCE_NOTICE, DECLINE_NOTICE, FUTURE_SUGGESTION_KIND, LINK_NOTICE, MAX_ACTOR_CHARS, MAX_CONVERSIONS, MAX_STORED_DETAILS_BYTES, MAX_SUBMISSION_BYTES, identityScrubDue, outcomeOf, planConversion, readConversions, readerStanding, standingOf, storedDetailsBytes, holdsIdentity, isPlainAddress, isSlug, normalizeSuggestionUrl, readClarification, readSuggestionSubmissionJson,
  planCredit, receiveSuggestion, scrubbedIdentity, slugify, suggestionCopyText, suggestionCredit, suggestionDetails,
} from "../../web/components/future-suggestion.js";
import { publicUrlProblem } from "../../web/components/public-url.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const urls = read("../fixtures/public-urls.json");
const fixture = read("../fixtures/future-suggestion-submissions.json");

test("the public address rule gives the build's answer and reason for every address", () => {
  assert.ok(urls.cases.length > 100);
  for (const { url, problem } of urls.cases) assert.equal(publicUrlProblem(url), problem, url);
});

test("a suggestion is read and received exactly as the build reads and receives it", () => {
  assert.ok(fixture.cases.length > 100);
  for (const entry of fixture.cases) {
    const text = entry.text ?? JSON.stringify(entry.request);
    const result = readSuggestionSubmissionJson(text);
    if (entry.expect.code) {
      assert.equal(result.ok, false, `${entry.name}: should be refused`);
      assert.equal(result.error.code, entry.expect.code, entry.name);
      // A refusal names the field and never repeats what the reader wrote.
      for (const word of ["Surveyor", "ada@example.org", "Lovelace"]) assert.ok(!result.error.message.includes(word), entry.name);
      continue;
    }
    assert.equal(result.ok, true, `${entry.name}: ${result.error?.message}`);
    const { record, row } = receiveSuggestion(result.submission, fixture.work, fixture.receivedAt);
    assert.deepEqual(JSON.parse(JSON.stringify(record)), entry.expect.record, entry.name);
    assert.deepEqual(JSON.parse(JSON.stringify(row)), entry.expect.row, entry.name);
  }
});

test("a received suggestion's details are exactly what the row keeps, and the text and name stay in their columns", () => {
  const { submission } = readSuggestionSubmissionJson(JSON.stringify({
    version: 1, kind: "future-suggestion", type: "source", text: "A private archive.", url: "https://example.org/archive",
    attribution: { name: "Ada", publishName: false }, contact: { address: "ada@example.org", followUp: true },
  }));
  const details = suggestionDetails(submission);
  assert.deepEqual(Object.keys(details).sort(), ["contact", "type", "url"]);
  assert.ok(!("text" in details) && !("attribution" in details) && !("name" in details));
  const { row } = receiveSuggestion(submission, "/posts/tides/", "2026-10-26T10:00:00Z");
  assert.equal(row.reader_name, "Ada");
  assert.equal(row.publish_name, false);
  assert.equal(row.revision, null);
  assert.equal(row.target, null);
  assert.equal(row.kind, FUTURE_SUGGESTION_KIND);
  assert.throws(() => receiveSuggestion(submission, "posts/tides", "2026-10-26T10:00:00Z"), TypeError);
  assert.throws(() => receiveSuggestion(submission, "/posts/tides/", "yesterday"), TypeError);
});

test("one shared rule: a link is the build's link rule and nothing of its own", () => {
  assert.equal(normalizeSuggestionUrl("https://Example.ORG/a/../c"), "https://example.org/c");
  for (const url of ["http://[::127.0.0.1]/", "http://[2002:7f00:1::]/", "http://[64:ff9b::7f00:1]/", "http://[fec0::1]/", "http://localhost.localdomain/", "http://x.home/", "http://x.test/", "http://x.corp/", "http://198.18.0.1/", "https://example.org/?access_token=1"]) {
    assert.equal(normalizeSuggestionUrl(url), null, url);
  }
  // The module keeps no private-address rule of its own.
  const source = readFileSync(new URL("../../web/components/future-suggestion.js", import.meta.url), "utf8");
  for (const fragment of ["127.", "169.254", "localhost", "192.168"]) assert.ok(!source.includes(fragment), fragment);
});

test("slugs are the site's own, non-ASCII included", () => {
  assert.equal(slugify("Marées d’été"), "marées-d-été");
  for (const slug of ["marées", "水のいろ", "tides-2026"]) assert.ok(isSlug(slug), slug);
  for (const slug of ["Tides", "a--b", "-a", "a-", "a b", "", "a".repeat(65)]) assert.ok(!isSlug(slug), slug);
});

test("contact addresses are plain mailboxes and nothing else", () => {
  assert.ok(isPlainAddress("a.b+tag@sub.example.org"));
  for (const address of ["", "ada@", "Ada <ada@example.org>", "a@b", "a..b@example.org", "ada@exämple.org", "\"a\"@example.org", `${"a".repeat(250)}@example.org`]) assert.ok(!isPlainAddress(address), address);
});

test("a clarification replaces the text under the same rule", () => {
  assert.equal(readClarification("  Here is what I meant.  "), "Here is what I meant.");
  for (const value of ["", "   ", "x".repeat(2001), "a\u202eb", 5, null]) assert.equal(readClarification(value), null);
});

test("private identity is what retention clears, and nothing else", () => {
  const kept = { details: { type: "text", url: "https://example.org/a", contact: { address: "a@example.org", followUp: true } }, reader_name: "Ada", publish_name: false };
  assert.equal(holdsIdentity(kept), true);
  assert.deepEqual(scrubbedIdentity(kept), { details: { type: "text", url: "https://example.org/a" }, reader_name: null });
  const shown = { details: { type: "text" }, reader_name: "Ada", publish_name: true };
  assert.equal(holdsIdentity(shown), false);
  assert.deepEqual(scrubbedIdentity(shown), { details: { type: "text" }, reader_name: "Ada" });
  assert.equal(holdsIdentity({ details: { type: "text" }, reader_name: null, publish_name: false }), false);
});

test("the copy-and-send text carries the words, the link and the record, and never claims acceptance", () => {
  const { submission } = readSuggestionSubmissionJson(JSON.stringify({
    version: 1, kind: "future-suggestion", type: "video", text: "Worth watching.", url: "https://example.org/v",
    hints: { title: "The survey", creators: ["A. Surveyor"] }, about: { series: "tides" },
  }));
  const copy = suggestionCopyText(submission, "https://blog.example/posts/tides/");
  assert.match(copy, /Worth watching\./);
  assert.match(copy, /Link: https:\/\/example\.org\/v/);
  assert.match(copy, /the series tides/);
  const last = copy.split("\n").at(-1);
  assert.deepEqual(JSON.parse(last), submission);
  assert.ok(!/accepted|approved|endorse/i.test(copy));
  assert.match(ACCEPTANCE_NOTICE, /does not mean they agree/);
});

test("stored details are measured as Postgres measures jsonb text, below the column's 16 KiB", () => {
  assert.equal(storedDetailsBytes({ type: "text" }), Buffer.byteLength('{"type": "text"}'));
  assert.equal(storedDetailsBytes({ a: ["x", "y"], b: { c: 1 } }), Buffer.byteLength('{"a": ["x", "y"], "b": {"c": 1}}'));
  assert.ok(MAX_STORED_DETAILS_BYTES < 16 * 1024);
  const wide = `https://example.org/${"漢".repeat(225)}`;
  const text = JSON.stringify({
    version: 1, kind: "future-suggestion", type: "source", text: "x", url: wide,
    hints: { title: "😀".repeat(300), publisher: "😀".repeat(300), creators: Array(7).fill("😀".repeat(200)), identifiers: Array(4).fill({ scheme: "url", value: wide }) },
  });
  assert.ok(Buffer.byteLength(text) <= MAX_SUBMISSION_BYTES);
  const result = readSuggestionSubmissionJson(text);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tooLarge");
});

// ---- Standing, outcomes, links and the clearing of private identity (#228, ADRs 0162 to 0164)

const outcomes = read("../fixtures/future-suggestion-outcomes.json");

test("standing, outcome and the reader's receipt text are the build's, state by state", () => {
  assert.equal(outcomes.standings.length, 12);
  for (const entry of outcomes.standings) {
    const links = entry.linked ? [{ kind: "draft", id: "tide-tables", at: "2026-10-27T10:00:00Z", by: "owner" }] : [];
    const label = `${entry.state} linked=${entry.linked}`;
    assert.deepEqual(standingOf(entry.state, links), entry.expect.standing, label);
    assert.deepEqual(outcomeOf(entry.state, links), entry.expect.outcome, label);
    const reader = readerStanding(entry.state, links);
    assert.equal(reader.note, entry.expect.reader.note, label);
    assert.equal(reader.acceptance, entry.expect.reader.acceptance, label);
  }
  assert.equal(standingOf("nonsense"), null);
  assert.equal(outcomeOf("nonsense"), null);
  assert.equal(readerStanding("nonsense"), null);
});

test("every outcome the editors can record is named, and none is a count, a rank or a verdict", () => {
  const seen = new Set(outcomes.standings.map((entry) => entry.expect.outcome?.id).filter(Boolean));
  assert.deepEqual([...seen].sort(), ["closed", "converted", "declined", "held"]);
  const words = JSON.stringify(outcomes.standings.map((entry) => [entry.expect.standing, entry.expect.outcome, entry.expect.reader]));
  for (const forbidden of [/\bscore\b/i, /\brank/i, /\bvotes?\b/i, /\bpopular/i, /\bmost requested\b/i, /\btrending\b/i, /\bverified\b/i, /\bendorse(d|ment)\b/i, /\bpromise[ds]? to publish\b/i, /\d/]) {
    // The notices may say what a link is not ("not a promise to publish"); nothing else may use these words.
    const text = words.replace(/not a promise to publish/g, "").replace(/or have permission to use it/g, "");
    assert.doesNotMatch(text, forbidden);
  }
  // The receipt's acceptance sentence is exactly the one the editors' screens use.
  assert.equal(readerStanding("approved").note, ACCEPTANCE_NOTICE);
  // A decline is never a verdict on the idea, and a withdrawal says nothing.
  assert.match(readerStanding("rejected").note, /not a judgement of the idea/);
  assert.equal(readerStanding("withdrawn").note, null);
  assert.equal(readerStanding("pending").note, null);
});

test("a link is recorded exactly as the build decides it", () => {
  assert.ok(outcomes.links.length > 25);
  for (const entry of outcomes.links) {
    const plan = planConversion(entry.row, entry.request);
    if (entry.expect.code) {
      assert.equal(plan.ok, false, `${entry.name}: should be refused`);
      assert.equal(plan.code, entry.expect.code, entry.name);
      continue;
    }
    assert.equal(plan.ok, true, `${entry.name}: ${plan.code}`);
    assert.deepEqual(plan.details.conversions, entry.expect.conversions, entry.name);
    assert.deepEqual(plan.conversion, entry.expect.conversions.at(-1), entry.name);
    // The link and the details hold nothing the reader wrote.
    const stored = JSON.stringify(plan.details.conversions);
    for (const private_ of ["Ada", "ada@example.org", "letters"]) assert.ok(!stored.includes(private_), entry.name);
    // The details are otherwise as they were.
    const { conversions, ...rest } = plan.details;
    const { conversions: before, ...was } = entry.row.details;
    assert.deepEqual(rest, was, entry.name);
  }
});

test("stored links are read as the build reads them", () => {
  assert.ok(outcomes.details.length > 12);
  for (const entry of outcomes.details) {
    const read = readConversions(entry.details);
    if (entry.expect.code) assert.equal(read, null, entry.name);
    else assert.deepEqual(read, entry.expect.conversions, entry.name);
  }
});

test("private identity is cleared when the period has passed and at once when linked, as the build decides", () => {
  assert.ok(outcomes.scrub.length > 100);
  for (const entry of outcomes.scrub) {
    assert.equal(identityScrubDue(entry.row, entry.periodPassed), entry.expect, `${entry.status} ${entry.identity} linked=${entry.linked} passed=${entry.periodPassed} purged=${entry.purged}`);
  }
});

test("the worst a suggestion and its links can store fits the column with room to spare", () => {
  const links = Array.from({ length: MAX_CONVERSIONS }, (_, index) => ({ kind: "library-source", id: `${"x".repeat(60)}-${index}`.slice(0, 64), at: "2026-10-27T10:00:00Z", by: "\u{1F600}".repeat(MAX_ACTOR_CHARS) }));
  const largest = { type: "source", hints: { title: "x" }, conversions: links };
  // The submission side is held to MAX_STORED_DETAILS_BYTES; the links are the rest of the 16 KiB.
  const linksOnly = storedDetailsBytes({ conversions: links, creditRevision: 2147483647 });
  assert.ok(MAX_STORED_DETAILS_BYTES + linksOnly < 16 * 1024, `${MAX_STORED_DETAILS_BYTES} + ${linksOnly}`);
  assert.ok(storedDetailsBytes(largest) < 16 * 1024);
  const slugs = Array.from({ length: MAX_CONVERSIONS }, (_, index) => ({ kind: "draft", id: `${"\u{6F22}".repeat(60)}-${index}`.slice(0, 64), at: "2026-10-27T10:00:00Z", by: "\u{1F600}".repeat(MAX_ACTOR_CHARS) }));
  assert.ok(MAX_STORED_DETAILS_BYTES + storedDetailsBytes({ conversions: slugs }) < 16 * 1024);
});

test("scrubbing a linked suggestion keeps its links, and a receipt's details never carry them", () => {
  const row = { details: { type: "text", contact: { address: "ada@example.org", followUp: true }, conversions: [{ kind: "draft", id: "tide-tables", at: "2026-10-27T10:00:00Z", by: "owner" }] }, reader_name: "Ada", publish_name: false };
  const cleared = scrubbedIdentity(row);
  assert.deepEqual(cleared.details, { type: "text", conversions: row.details.conversions });
  assert.equal(cleared.reader_name, null);
});

test("a reader's receipt words an accepted, linked, closed or declined suggestion honestly and never as published", async () => {
  const { receiptStateText } = await import("../../web/components/feedback-receipt.js");
  const say = (status, standing, extra = {}) => receiptStateText({ kind: "future-suggestion", status, standing: standing === null ? undefined : readerStanding(status, standing), ...extra });
  const link = [{ kind: "draft", id: "tide-tables", at: "2026-10-27T10:00:00Z", by: "owner" }];
  const accepted = say("approved", []);
  assert.ok(accepted.includes(ACCEPTANCE_NOTICE));
  assert.ok(!accepted.includes("Linked to future work"));
  const converted = say("approved", link);
  assert.match(converted, /^Linked to future work\. Accepted means the editors are interested/);
  assert.ok(converted.includes(LINK_NOTICE));
  assert.match(say("removed", link), /closed it, after linking it to future work/);
  assert.match(say("removed", []), /closed it\. Not taking an idea forward is about this site/);
  assert.match(say("rejected", []), /decided not to take it forward\. Not taking an idea forward/);
  assert.equal(say("pending", []), "Waiting for the editors’ review. It is private to them: nothing about it is shown on the site.");
  // Nothing in any of them says published, ranks, counts or names what it was linked to.
  for (const text of [accepted, converted, say("removed", link), say("removed", []), say("rejected", []), say("withdrawn", [])]) {
    assert.doesNotMatch(text.replace(/is not shown on the site/g, "").replace(/not a promise to publish/g, ""), /published|shown on the site|rank|popular|vote|tide-tables|\d/i);
  }
  // A receipt from a service that does not send the standing reads exactly as it did.
  assert.equal(say("approved", null), "Accepted means the editors are interested in exploring this. It does not mean they agree with it, have checked it, or have permission to use it. It is private to them and is not shown on the site.");
  assert.equal(say("rejected", null), "The editors decided not to take it forward.");
  assert.equal(say("removed", null, { purged: true }).startsWith("The editors closed it."), true);
});

// ---- Credit is opt-in and bound to the revision it was agreed for (ADR 0167)

test("a credit is offered only for the revision the reader agreed to be credited for", () => {
  const sent = readSuggestionSubmissionJson(JSON.stringify({ version: 1, kind: "future-suggestion", type: "text", text: "Her letters.", attribution: { name: "Ada", publishName: true } }));
  const { record, row } = receiveSuggestion(sent.submission, "/posts/tides/", "2026-10-26T10:00:00Z");
  assert.equal(record.creditRevision, 1);
  assert.equal(row.details.creditRevision, 1);
  const current = { ...row, kind: FUTURE_SUGGESTION_KIND, item_revision: 1, purged_at: null };
  assert.equal(suggestionCredit(current), "Ada");
  // A clarification that changed the text raises the revision and leaves the agreement behind.
  const clarified = { ...current, item_revision: 2 };
  assert.equal(suggestionCredit(clarified), null);
  // Fresh consent binds it to the new text; a second clarification leaves it behind again.
  const again = planCredit(clarified, true);
  assert.equal(again.ok, true);
  assert.equal(again.publish_name, true);
  assert.equal(again.details.creditRevision, 2);
  assert.equal(suggestionCredit({ ...clarified, ...again }), "Ada");
  assert.equal(suggestionCredit({ ...clarified, ...again, item_revision: 3 }), null);
  // Withdrawn, it is gone with its binding, and the rest of the details stay.
  const withdrawn = planCredit({ ...clarified, ...again }, false);
  assert.deepEqual(withdrawn, { ok: true, publish_name: false, details: { type: "text" } });
  assert.equal(suggestionCredit({ ...clarified, ...withdrawn }), null);
  // Never without agreement, a name, a kept row or the right kind.
  assert.equal(suggestionCredit({ ...current, publish_name: false }), null);
  assert.equal(suggestionCredit({ ...current, reader_name: null }), null);
  assert.equal(suggestionCredit({ ...current, purged_at: "2026-10-27T00:00:00Z" }), null);
  assert.equal(suggestionCredit({ ...current, kind: "question" }), null);
  assert.equal(suggestionCredit({ ...current, details: { type: "text" } }), null, "an agreement with no binding offers none");
  assert.equal(planCredit({ ...current, reader_name: null }, true).code, "consentWithoutName");
  assert.equal(planCredit(current, "yes").code, "invalid");
  assert.equal(planCredit({ ...current, purged_at: "x" }, true).code, "notAllowed");
  // A name given but not agreed to has nothing bound.
  const quiet = readSuggestionSubmissionJson(JSON.stringify({ version: 1, kind: "future-suggestion", type: "text", text: "Her letters.", attribution: { name: "Ada" } }));
  const quietRow = receiveSuggestion(quiet.submission, "/posts/tides/", "2026-10-26T10:00:00Z");
  assert.equal("creditRevision" in quietRow.record, false);
  assert.equal("creditRevision" in quietRow.row.details, false);
});
