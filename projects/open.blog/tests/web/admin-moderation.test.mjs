// The moderation inbox in Admin (#225, ADR 0105): its addresses and filters, the request a
// decision sends (what the moderator saw, never who they are), the wording of roles, readers and
// outcomes, counts that never reveal what a viewer may not see, and the published-file mismatch
// B5's view offered.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decisionLine,
  decisionOutcome,
  decisionProblem,
  decisionRequest,
  evidenceReviewLines,
  localDay,
  MODERATION_KINDS,
  answerLines,
  answerPublicationMismatch,
  perspectiveAuditNotices,
  answerOffer,
  answerRequest,
  withdrawAnswerRequest,
  MODERATION_STATES,
  feedbackPreviewText,
  feedbackPublicationMismatch,
  inboxSummary,
  moderationHash,
  moderationOutcome,
  moderationReaderLine,
  moderationRequest,
  moderationRoleLine,
  parseModerationRoute,
  perspectiveLines,
  retentionSummaryLines,
  suggestionLines,
  linkRequest,
  libraryCandidateLines,
} from "../../web/admin/admin.js";

const transitions = JSON.parse(readFileSync(new URL("../fixtures/participation-transitions.json", import.meta.url), "utf8"));
const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");

test("the inbox lists every state of the one state machine, pending first", () => {
  assert.deepEqual([...MODERATION_STATES].sort(), [...new Set(transitions.cases.map((entry) => entry.state))].sort());
  assert.equal(MODERATION_STATES[0], "pending");
  assert.deepEqual(MODERATION_KINDS.map(([id]) => id), ["", "comment", "question", "source-suggestion", "correction-suggestion", "alternative-interpretation", "third-perspective", "future-suggestion", "author-response", "abuse-report"]);
});

test("addresses keep the state and kind, and anything unknown falls back to the defaults", () => {
  assert.equal(moderationHash("approved"), "#/moderation/approved");
  assert.equal(moderationHash("removed", "comment"), "#/moderation/removed?kind=comment");
  assert.equal(moderationHash("deleted", "vote"), "#/moderation/pending");
  const params = (query) => new URLSearchParams(query);
  assert.deepEqual(parseModerationRoute("clarification", params("kind=question")), { state: "clarification", kind: "question" });
  assert.deepEqual(parseModerationRoute("../../etc", params("kind=<script>")), { state: "pending", kind: "" });
  // B5's old address still opens the inbox at the state it named.
  assert.deepEqual(parseModerationRoute("removed", params("")), { state: "removed", kind: "" });
  assert.match(admin, /head === "moderation" \|\| head === "feedback"/);
});

test("a decision names what the moderator saw and nothing about who they are", () => {
  const item = { source: "comment", id: "00000000-0000-4000-8000-000000000001", status: "pending", version: 4, role: "coordinator" };
  assert.deepEqual(moderationRequest(item, "approve"), { source: "comment", id: item.id, action: "approve", from: "pending", version: 4 });
  assert.deepEqual(moderationRequest(item, "reject", "spam"), { source: "comment", id: item.id, action: "reject", from: "pending", version: 4, reason: "spam" });
  for (const key of ["role", "actor", "actorRole", "user"]) assert.equal(key in moderationRequest(item, "approve"), false, key);
  // A passage that moved or changed is approved only with the check the moderator confirmed.
  const stale = { ...item, source: "feedback", passage: { check: "stale", acknowledge: true } };
  assert.equal(moderationRequest(stale, "approve", undefined, false).acknowledge, undefined);
  assert.equal(moderationRequest(stale, "approve", undefined, true).acknowledge, "stale");
  assert.equal(moderationRequest(stale, "reject", "spam", true).acknowledge, undefined, "only an approval confirms a passage");
});

test("roles and readers are worded so a private name is never implied to a coordinator", () => {
  assert.match(moderationRoleLine("site-admin"), /site Admin/);
  assert.match(moderationRoleLine("coordinator"), /Only the site Admin sees a reader’s private name or reopens/);
  assert.match(moderationRoleLine("contributing-author"), /A coordinator or the site Admin decides/);
  assert.equal(moderationReaderLine({ name: "Grace", publishName: true }, "comment"), "From Grace, shown with the comment.");
  assert.equal(moderationReaderLine({ publishName: false, private: true }), "The reader gave a name that only the site Admin can see.");
  assert.equal(moderationReaderLine(undefined), "From an anonymous reader.");
  assert.match(moderationReaderLine({ name: "Ada", publishName: true }), /agreed to show this name/);
  assert.match(moderationReaderLine({ name: "Ada", publishName: false }), /stays private/);
});

test("counts say only how many are shown, and clarification and removal read as their own outcomes", () => {
  assert.equal(inboxSummary("pending", 2, false), "2 pending items.");
  assert.equal(inboxSummary("pending", 50, true), "50 pending items. More are listed after these.");
  assert.equal(inboxSummary("clarification", 1, false), "1 item waiting for clarification.");
  assert.equal(inboxSummary("clarification", 0, false), "Nothing is waiting for clarification.");
  assert.equal(inboxSummary("withdrawn", 0, false), "No withdrawn items.");
  const comment = { source: "comment", post: { title: "Tides" }, work: "/posts/tides/" };
  const note = { ...comment, source: "feedback" };
  assert.equal(moderationOutcome(comment, "approve", {}), "Approved. The comment is shown on “Tides”.");
  assert.equal(moderationOutcome(note, "approve", { published: true }), "Approved and published on “Tides”. Rebuild or publish to update the live site.");
  assert.equal(moderationOutcome(note, "request-clarification", {}), "Asked the reader to clarify. Nothing was published or e-mailed.");
  assert.equal(moderationOutcome(note, "reopen", { item: { status: "clarification" } }), "Reopened. It is waiting for clarification again.");
  assert.equal(moderationOutcome(comment, "remove", {}), "Removed from “Tides”.");
  assert.match(moderationOutcome(note, "remove", { published: true, publishError: "reader-feedback.json could not be written" }), /still on the post/);
  assert.equal(moderationOutcome({ ...comment, post: null }, "remove", {}), "Removed from /posts/tides/.");
  // Links that could not be taken off the pages are said, after the decision itself.
  const stuck = "The submission’s continuation links could not be removed.";
  assert.equal(moderationOutcome(note, "reject", { continuationsError: stuck }), `Rejected. Nothing was published. ${stuck}`);
  assert.equal(moderationOutcome(note, "reject", { continuationsDropped: 1, continuationsError: null }), "Rejected. Nothing was published.");
});

test("the public preview never quotes a changed passage, and a mismatch with the published file is offered a fix", () => {
  assert.equal(
    feedbackPreviewText({ quote: "The sun matters too.", stale: false, received: "2026-10-26", name: "Ada" }),
    "On the post it is shown quoting “The sun matters too.”, as from Ada, received 2026-10-26.",
  );
  assert.equal(feedbackPreviewText({ stale: true, received: "2026-10-26" }), "On the post it is shown without a quotation, because the passage has changed, as from a reader, received 2026-10-26.");
  const card = (status, published) => feedbackPublicationMismatch({ status, published });
  assert.deepEqual(card("approved", false), { notice: "Approved, but not on the site yet.", action: "publish", label: "Publish on the post" });
  assert.deepEqual(card("removed", true), { notice: "Removed, but still on the post.", action: "unpublish", label: "Take it off the post" });
  assert.equal(card("approved", null), null);
  assert.equal(card("pending", true), null);
  // The decision on the post is not the one in force: say so, and offer the repair.
  const decision = (decisionPublished) => feedbackPublicationMismatch({ status: "approved", published: true, decisionPublished });
  assert.deepEqual(decision(false), { notice: "The decision on the post is not the one you recorded.", action: "publish-decision", label: "Update the published decision" });
  assert.equal(decision(true), null);
  assert.equal(decision(undefined), null);
  assert.equal(feedbackPublicationMismatch({ status: "approved", published: false, decisionPublished: false }).action, "publish");
});

test("repairing the published decision is posted to its own route and announced", () => {
  assert.match(admin, /"feedback"\}\/\$\{mismatch\.action\}`/);
  assert.match(admin, /mismatch\.action === "publish-decision"/);
});

test("the view builds every control as text with its own label, and never as markup", () => {
  const view = admin.slice(admin.indexOf("async showModeration("), admin.indexOf("// ---- editor"));
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(view, /h\("label", \{ for: "oba-moderation-kind" \}, "Kind"\)/);
  assert.match(view, /h\("label", \{ for: selectId \}/);
  assert.match(view, /"aria-describedby": guidanceId/);
  assert.match(view, /role: "status", "aria-live": "polite", tabindex: "-1"/);
  assert.match(view, /cards\[0\]\?\.querySelector\("h3"\)\?\.focus\(\)/);
});

// ---- Engagement protection (#226, ADRs 0107 and 0108)

test("abuse reports, upheld reports and deletions are worded without naming any reader", () => {
  assert.equal(moderationReaderLine({ publishName: false }, "report"), "Reports are anonymous: nothing about the reader who sent it is kept.");
  const report = { source: "report", post: { title: "Tides" }, work: "/posts/tides/" };
  assert.equal(moderationOutcome(report, "uphold-report", { removedTarget: true }), "Report upheld. The reported item was removed from “Tides”.");
  assert.match(moderationOutcome(report, "uphold-report", { removedTarget: false }), /already out of public view/);
  assert.match(moderationOutcome(report, "uphold-report", { removedTarget: true, published: true, publishError: "Disk full." }), /still on the post\. Disk full\./);
  assert.equal(moderationOutcome({ source: "comment" }, "erase", {}), "Its text and name were deleted. Only the private record of decisions remains.");
  // A note its reader withdrew and asked to delete must come off the post.
  const withdrawn = feedbackPublicationMismatch({ status: "withdrawn", published: true });
  assert.equal(withdrawn.action, "unpublish");
  assert.match(withdrawn.notice, /asked for it to be deleted/);
  assert.equal(feedbackPublicationMismatch({ status: "withdrawn", published: false }), null);
});

test("the retention dry run says what would happen, and that comments are kept unless opted in", () => {
  const report = {
    periods: { auditDays: 365, comments: false },
    summary: [{ step: "expire", kind: "question", kindLabel: "Question", count: 2 }, { step: "purge-content", kind: "abuse-report", kindLabel: "Abuse report", count: 1 }],
    audit: { comment: 3, feedback: 0, report: 1 },
    truncated: true,
  };
  assert.deepEqual(retentionSummaryLines(report), [
    "2 question items would expire without a decision.",
    "1 abuse report item would have their text, details and names deleted.",
    "4 private records of decisions older than 365 days would be deleted.",
    "Comments are kept until you act, because participation.retention is not set in openblog.json.",
    "More items are due than one run takes; run it again afterwards.",
  ]);
  assert.deepEqual(retentionSummaryLines({ periods: { auditDays: 365, comments: true }, summary: [], audit: {} }), ["Nothing is due: retention would change nothing now."]);
  // The run is a separate, confirmed step after the dry run.
  assert.match(admin, /"GET", "engagement\/retention"/);
  assert.match(admin, /"POST", "engagement\/retention", \{ json: \{ asOf: report\.asOf, audit: auditBox\.checked \} \}/);
  assert.match(admin, /I understand that purged text, details and names cannot be recovered\./);
});

// ---- Correction decisions and evidence (ADRs 0116 and 0117)

const OUTCOMES = [
  { id: "accepted-as-correction", accepted: true },
  { id: "accepted-as-clarification", accepted: true },
  { id: "accepted-as-evidence", accepted: true },
  { id: "declined", accepted: false },
  { id: "already-addressed", accepted: false },
];
const decidable = (extra = {}) => ({
  id: "a1111111-1111-4111-8111-11111111111a",
  recordDecision: { expectedDecisions: 2, itemRevision: 3, outcomes: OUTCOMES, post: "posts/tides.md", ...extra },
});

test("a decision sends what the author saw and only the fields its outcome takes, never who decides", () => {
  const item = decidable();
  const full = { outcome: "declined", extent: "full", declineReason: "maintains-reading", rationale: "Neap tides.", revisionNote: "2026-10-27: x", claimEvidence: "tides tides-noaa", addressedBy: "b", confirmed: true, decided: "2026-10-27" };
  assert.deepEqual(decisionRequest(item, full), {
    id: item.id, expectedDecisions: 2, itemRevision: 3, outcome: "declined", decided: "2026-10-27", declineReason: "maintains-reading", rationale: "Neap tides.",
  });
  assert.deepEqual(decisionRequest(item, { ...full, outcome: "accepted-as-evidence", extent: "partial" }), {
    id: item.id, expectedDecisions: 2, itemRevision: 3, outcome: "accepted-as-evidence", decided: "2026-10-27", extent: "partial", rationale: "Neap tides.",
    revisionNote: { post: "posts/tides.md", note: "2026-10-27: x" }, claimEvidence: { claim: "tides", link: "tides-noaa" },
  });
  assert.equal(decisionRequest(item, { ...full, outcome: "already-addressed", addressedBy: " b1 " }).addressedBy, "b1");
  // The passage check goes only when the passage moved and the author confirmed it.
  assert.equal(decisionRequest(item, full).confirmCheck, undefined);
  assert.equal(decisionRequest(decidable({ confirmCheck: "stale:quoteNotFound" }), full).confirmCheck, "stale:quoteNotFound");
  assert.equal(decisionRequest(decidable({ confirmCheck: "reanchored" }), { ...full, confirmed: false }).confirmCheck, undefined);
  for (const key of ["actor", "role", "actorRole", "account", "decidedBy"]) assert.ok(!(key in decisionRequest(item, full)), key);
  assert.match(localDay(new Date(2026, 9, 7, 23, 59)), /^2026-10-07$/);
});

test("what a decision is missing is named on its own field before anything is sent", () => {
  const item = decidable({ confirmCheck: "reanchored" });
  const cases = [
    [{}, "outcome"],
    [{ outcome: "accepted-as-correction" }, "extent"],
    [{ outcome: "accepted-as-correction", extent: "partial" }, "rationale"],
    [{ outcome: "accepted-as-correction", extent: "full" }, "revisionNote"],
    [{ outcome: "accepted-as-evidence", extent: "full", revisionNote: "n" }, "claimEvidence"],
    [{ outcome: "declined" }, "declineReason"],
    [{ outcome: "declined", declineReason: "other", rationale: "  " }, "rationale"],
    [{ outcome: "already-addressed" }, "revisionNote"],
    [{ outcome: "already-addressed", addressedBy: "b" }, "confirmed"],
  ];
  for (const [values, field] of cases) assert.equal(decisionProblem(item, values)?.field, field, JSON.stringify(values));
  assert.equal(decisionProblem(item, { outcome: "declined", declineReason: "other", rationale: "Why.", confirmed: true }), null);
});

test("decisions and evidence are worded as the author's and the reader's statements, never verdicts", () => {
  assert.equal(
    decisionLine({ label: "Correction", extent: "partial", decided: "2026-10-27", decidedBy: { role: "coordinator", account: "grace" }, inForce: true }),
    "Correction (in part), 2026-10-27 by grace as coordinator",
  );
  assert.match(decisionLine({ label: "Declined by the author", declineReasonLabel: "The author keeps the passage as written", decided: "2026-10-28", decidedBy: { role: "site-admin", account: "@moderation-token" }, inForce: false }), /^Declined by the author: The author keeps the passage as written, 2026-10-28 \(superseded/);
  assert.match(decisionOutcome({ decision: { label: "Clarification" } }), /^Decision recorded: Clarification\. The post, its citations and the Source Library were not changed/);
  // A note already on its post shows the new outcome there; one that is not stays off it.
  assert.match(decisionOutcome({ decision: { label: "Correction" }, outcomePublished: true }), /The outcome now shows on the published note\. Rebuild or publish to update the live site\.$/);
  assert.doesNotMatch(decisionOutcome({ decision: { label: "Correction" }, outcomePublished: false }), /published note/);
  assert.match(decisionOutcome({ decision: { label: "Correction" }, publishError: "reader-feedback.json could not be written" }), /The published note could not be updated: reader-feedback\.json could not be written$/);
  const lines = evidenceReviewLines({
    claim: { id: "cave", published: true, label: "Claim 1", statement: "The cave educates." },
    evidenceLink: { id: "h1", published: false },
    citation: { id: "noaa", published: true, label: "NOAA (2020)" },
    source: { id: "slings", published: true, label: "Slings (2003)" },
    locators: [{ kind: "page", value: "40", to: "41" }],
    stanceLabel: "The reader says it contradicts the passage",
  });
  assert.deepEqual(lines, [
    "Claim: Claim 1, “The cave educates.”.",
    "Evidence for it the reader questions: “h1”, which this post does not publish now.",
    "Cited source the reader questions: NOAA (2020).",
    "Source the reader offers: Slings (2003), at page 40–41.",
    "The reader says it contradicts the passage.",
  ]);
  for (const line of lines) assert.doesNotMatch(line, /private|verified|incorrect|false/i);
  assert.deepEqual(evidenceReviewLines(null), []);
  // The inbox never calls a suggestion a correction on its own: that label comes only from the
  // server's standing, which only the author's decision sets.
  assert.doesNotMatch(admin, /"Correction"|label: "Correction/);
});

test("a Third Perspective's approval names the text revision and consent record shown, and its card says what binds", () => {
  const item = {
    source: "feedback", id: "00000000-0000-4000-8000-000000000001", kind: "third-perspective", status: "pending", version: 3, revision: 2,
    details: { category: "connection", categoryLabel: "A connection", prompt: "What does this bring to mind: another work, idea or source?" },
    perspective: { about: "section", section: "methods", check: "stale", consent: { number: 4, publish: true, showName: false, clarification: true, feature: false }, nameMatchesCredit: true },
    post: { title: "Tides" },
  };
  assert.deepEqual(moderationRequest(item, "approve"), { source: "feedback", id: item.id, action: "approve", from: "pending", version: 3, seenRevision: 2, seenConsent: 4 });
  assert.deepEqual(moderationRequest(item, "reject", "spam"), { source: "feedback", id: item.id, action: "reject", from: "pending", version: 3, reason: "spam" });
  const lines = perspectiveLines(item);
  assert.match(lines[0], /About the section #methods\. That section has changed/);
  assert.match(lines[1], /Prompt: A connection/);
  assert.match(lines[2], /Consent record 4: the reader agrees to publish it without their name, and may be asked to clarify it\. Approving binds this record/);
  assert.match(lines[3], /never shown with the reflection/);
  assert.deepEqual(perspectiveLines({ source: "feedback" }), []);
  assert.match(moderationOutcome(item, "approve", {}), /consent record 4, as a reader’s reflection on “Tides”/);
  assert.equal(moderationReaderLine({ name: "Ada", publishName: true }, "feedback", "third-perspective"), "From Ada, who agreed to show this name if you publish the reflection.");
});

// ---- Author responses (#223, ADR 0132)

const PARENT = "00000000-0000-4000-8000-000000000001";
const perspective = (extra = {}) => ({
  id: PARENT, source: "feedback", kind: "third-perspective", status: "approved", version: 3, revision: 1,
  perspective: { about: "section", section: "ob-by-mina-0", check: "current", consent: { number: 1, publish: true, showName: false, clarification: false }, attributed: { contributor: "mina", author: "MINA", standing: { state: "current", moved: false } } },
  ...extra,
});

test("a reflection about one author's section is worded by author, never by an anchor or a side", () => {
  const lines = perspectiveLines(perspective());
  assert.match(lines[0], /^About one author’s section by MINA\.$/);
  assert.doesNotMatch(lines.join(" "), /ob-by-|left|right|column/);
  const changed = perspectiveLines(perspective({ perspective: { ...perspective().perspective, check: "stale", attributed: { author: "MINA", standing: { state: "stale", reason: "section-changed-or-removed" } } } }));
  assert.match(changed[0], /That author’s section has changed or been removed since the reader read it\./, "never claims which");
  const absent = perspectiveLines(perspective({ perspective: { ...perspective().perspective, check: "stale", attributed: { author: null, standing: { state: "stale", reason: "author-absent" } } } }));
  assert.match(absent[0], /No section by that author is published now\./);
  // An ordinary heading keeps its own wording.
  assert.match(perspectiveLines({ perspective: { about: "section", section: "methods", check: "current", consent: { number: 1, publish: true } } })[0], /^About the section #methods\./);
});

test("an answer's author is offered a form only when the server offered one, and the request names no one", () => {
  assert.equal(answerOffer(perspective()), null, "no offer, no form");
  const offer = answerOffer(perspective({ answerAs: { contributor: "mina", author: "MINA", standing: { state: "current", moved: false } } }));
  assert.equal(offer.heading, "Answer as MINA");
  assert.match(offer.hint, /once a coordinator approves it\. You cannot approve it yourself/);
  assert.doesNotMatch(offer.hint, /changed or been removed/);
  const stale = answerOffer(perspective({ answerAs: { contributor: "mina", author: "MINA", standing: { state: "stale", reason: "section-changed-or-removed" } } }));
  assert.match(stale.hint, /changed or been removed since the reader read it; your answer says so/);
  const request = answerRequest(perspective(), "I meant the harbour.");
  assert.deepEqual(request, { parent: PARENT, parentVersion: 3, body: "I meant the harbour." });
  for (const key of ["actor", "user", "contributor", "participant", "author", "role", "account"]) assert.equal(key in request, false, key);
  assert.deepEqual(withdrawAnswerRequest({ id: "x", version: 2, status: "approved" }), { id: "x", version: 2 });
});

test("a moderator reads whose answer it is, never a participant, and an author is told it is their own", () => {
  const item = { kind: "author-response", response: { parent: PARENT, contributor: "mina", author: "MINA", standing: { state: "current", moved: false }, mine: false } };
  const lines = answerLines(item);
  assert.match(lines[0], /Written by MINA, the author of the section the reader’s reflection is about; the section is still published as the reader read it\./);
  assert.match(lines[1], /never approved by the account that wrote it/);
  assert.equal(lines.length, 2, "no account unless the server sent one");
  const own = answerLines({ ...item, response: { ...item.response, account: "mina-admin", mine: true, standing: { state: "stale", reason: "ambiguous" } } });
  assert.match(own[0], /identical sections, so which was meant cannot be told/);
  assert.ok(own.includes("Written by the account mina-admin."));
  assert.ok(own.includes("This is your own answer."));
  assert.doesNotMatch(own.join(" "), /p-mina|participant/);
  assert.match(moderationReaderLine({ publishName: false }, "feedback", "author-response"), /Written by the author of that section/);
  assert.deepEqual(answerLines({}), []);
});

test("the inbox draws the answer form and the withdrawal as native, labelled controls that keep what was written", () => {
  assert.match(admin, /oba-answer-form/);
  assert.match(admin, /label", \{ for: textId \}, "Your answer, in plain text"/);
  assert.match(admin, /api\.call\("POST", "engagement\/author-response"/);
  assert.match(admin, /api\.call\("PATCH", "engagement\/author-response"/);
  assert.match(admin, /answerRequest\(item, body\)/);
  assert.match(admin, /else text\.focus\(\)/, "a refused answer keeps its text and focus");
  assert.match(admin, /I understand that my answer is taken off the post for good/);
});

test("an answer's card and the audit say when it is on the post and when it must come off (ADR 0137)", () => {
  // Approved but not on the post yet: the site Admin may publish it.
  assert.deepEqual(answerPublicationMismatch({ status: "approved", published: false, mayBeShown: true }), { notice: "Approved, but not on the post yet.", action: "publish", label: "Publish the answer on the post" });
  assert.equal(answerPublicationMismatch({ status: "approved", published: true, mayBeShown: true }), null);
  assert.equal(answerPublicationMismatch({ status: "pending", published: false, mayBeShown: true }), null, "only an approved answer is offered for publication");
  // A withdrawn, removed or rejected answer that is still on the post must come off.
  for (const status of ["withdrawn", "removed", "rejected"]) {
    const mismatch = answerPublicationMismatch({ status, published: true, mayBeShown: false });
    assert.equal(mismatch.action, "unpublish", status);
    assert.match(mismatch.notice, /still on the post under the reader’s reflection/);
  }
  assert.equal(feedbackPublicationMismatch({ kind: "author-response", status: "withdrawn", published: true, mayBeShown: false }).action, "unpublish");
  assert.equal(answerPublicationMismatch({ status: "withdrawn", published: false, mayBeShown: false }), null);
  // The banner counts answers apart from reflections, and says the reflection stays.
  const notices = perspectiveAuditNotices({ mustComeOff: [], unknown: [], answersMustComeOff: [{ id: "a" }, { id: "b" }] });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "answersMustComeOff");
  assert.match(notices[0].text, /^2 published author responses must come off their posts: the author withdrew them/);
  assert.match(notices[0].text, /The reader’s reflection stays\./);
  assert.match(perspectiveAuditNotices({ answersMustComeOff: [{ id: "a" }] })[0].text, /^1 published author response must come off its post/);
  assert.deepEqual(perspectiveAuditNotices({ mustComeOff: [], unknown: [], answersMustComeOff: [] }), []);
  // The wording promises only what publication now does.
  const lines = answerLines({ kind: "author-response", response: { author: "MINA", standing: { state: "current", moved: false } } });
  assert.match(lines[1], /^Approving publishes it on the post, after that author’s section and under the reader’s reflection, labelled as the author’s response\./);
  assert.match(lines[1], /comes off the post whenever the reflection does or the author withdraws it/);
  assert.match(admin, /author-responses/);
});

// ---- Suggestions for future work (RD13)

const suggestionCard = {
  typeLabel: "Text to read", url: "https://example.org/letters",
  hints: { title: "The survey letters", creators: ["A. Surveyor"], year: "c. 1850", publisher: "Admiralty", identifiers: [{ scheme: "doi", value: "10.1234/abc" }] },
  about: { series: "tides" }, missing: [], notice: "Accepted means the editors are interested in exploring this. It does not mean they agree with it, have checked it, or have permission to use it.",
  standing: { id: "interested", label: "Editors are interested" },
};

test("a suggestion is worded as the reader's own unchecked statements, with the link left for the editor to open", () => {
  const lines = suggestionLines(suggestionCard);
  assert.deepEqual(lines[0], { text: "Kind: Text to read." });
  assert.deepEqual(lines[1], { label: "The reader’s link", link: "https://example.org/letters" });
  const text = lines.map((line) => line.text ?? "").join("\n");
  assert.match(text, /Title \(the reader’s words\): The survey letters/);
  assert.match(text, /DOI \(not checked\): 10\.1234\/abc/);
  assert.match(text, /About the series: tides/);
  assert.match(text, /Stands as: Editors are interested\./);
  assert.ok(!/verified|true|endorse|approved/i.test(text.replace(/not checked/g, "")), text);
  assert.deepEqual(suggestionLines(null), []);
  assert.match(suggestionLines({ ...suggestionCard, missing: ["a creator"] }).map((line) => line.text ?? "").join(" "), /Still to find: a creator\./);
});

test("a suggestion's readers, outcomes and mismatches never speak of publication", () => {
  assert.match(moderationReaderLine({ name: "Ada", publishName: true }, "feedback", "future-suggestion"), /agreed to be credited by this name for this text/);
  assert.match(moderationReaderLine({ name: "Ada", publishName: false }, "feedback", "future-suggestion"), /name stays private/);
  assert.match(moderationReaderLine({ private: true }, "feedback", "future-suggestion"), /only the site Admin can see/);
  const item = { source: "feedback", kind: "future-suggestion", suggestion: suggestionCard, status: "approved", published: false, post: { title: "Tides" }, work: "/posts/tides/" };
  assert.match(moderationOutcome(item, "approve", {}), /^Accepted into the editors’ list\. Nothing was published or e-mailed\./);
  assert.match(moderationOutcome(item, "approve", {}), /not that you agree with it, have checked it or may use it/);
  assert.match(moderationOutcome(item, "reject", {}), /^Not taken forward\. Nothing was published/);
  assert.match(moderationOutcome(item, "remove", {}), /^Closed\. It was never shown/);
  // Approved and "not published" is not a mismatch to repair, whatever the file says.
  assert.equal(feedbackPublicationMismatch(item), null);
  assert.equal(feedbackPublicationMismatch({ ...item, published: true, status: "removed" }), null);
  // Every other kind keeps its wording.
  assert.equal(feedbackPublicationMismatch({ source: "feedback", kind: "question", status: "approved", published: false }).action, "publish");
});

test("retention's summary words the clearing of a kept suggestion's private contact and name", () => {
  const report = { summary: [{ step: "scrub-identity", kind: "future-suggestion", kindLabel: "Suggestion for future work", count: 2 }], audit: {}, periods: { comments: true, auditDays: 365 } };
  assert.deepEqual(retentionSummaryLines(report), ["2 suggestion for future work items would have their private contact and unshown name cleared, and nothing else."]);
  assert.match(admin, /result\.scrubbed/);
  assert.match(admin, /contact and private name cleared/);
});

test("the export is the author's own explicit action and sends only the item and its version", () => {
  assert.match(admin, /"POST", "engagement\/suggestions\/export", \{ json: \{ id: item\.id, version: item\.version \} \}/);
  assert.match(admin, /item\.suggestion\?\.export/);
  assert.match(admin, /Nothing was published, fetched or e-mailed, and the suggestion is unchanged\./);
});

test("a suggestion's outcome and links read as the author's own records, never opened, counted or ranked", () => {
  const linked = {
    ...suggestionCard,
    standing: { id: "converted", label: "Linked to future work" },
    outcome: { id: "converted", label: "Converted" },
    conversions: [{ kind: "draft", id: "tide-tables", at: "2026-10-28T10:00:00Z", by: "mikey" }, { kind: "library-source", id: "survey-1850", at: "2026-10-29T10:00:00Z", by: "mikey" }],
  };
  const text = suggestionLines(linked).map((line) => line.text ?? "").join("\n");
  assert.match(text, /Outcome: Converted\./);
  assert.match(text, /Linked to the draft tide-tables, recorded 2026-10-28 by mikey\. Nothing opened or checked it\./);
  assert.match(text, /Linked to the Source Library record survey-1850, recorded 2026-10-29/);
  assert.ok(!/\b(rank|popular|votes?|most requested|trending|score)\b/i.test(text), text);
  // Without an outcome or links the lines are as they were.
  assert.ok(!suggestionLines(suggestionCard).some((line) => /Outcome|Linked/.test(line.text ?? "")));
});

test("a link request is read before anything is sent, and names the item as it was loaded", () => {
  const item = { id: "00000000-0000-4000-8000-000000000001", version: 4 };
  assert.deepEqual(linkRequest(item, "draft", "  tide-tables "), { ok: true, body: { id: item.id, version: 4, conversion: { kind: "draft", id: "tide-tables" } } });
  assert.equal(linkRequest(item, "", "tides").ok, false);
  assert.equal(linkRequest(item, "page", "tides").ok, false);
  assert.equal(linkRequest(item, "series", "   ").ok, false);
  assert.match(linkRequest(item, "series", "").message, /Name it/);
});

test("library hints are plain lines marked unverified, with nothing the reader did not say about the source", () => {
  assert.deepEqual(libraryCandidateLines(null), []);
  const lines = libraryCandidateLines({ type: "video", url: "https://example.org/watch", title: "The survey", creators: ["A. Surveyor"], year: "1850", publisher: "Admiralty", identifiers: [{ scheme: "doi", value: "10.1234/abc" }], unverified: true });
  assert.match(lines[0], /Unverified/);
  assert.deepEqual(lines.slice(1), ["Link: https://example.org/watch", "Title: The survey", "Creators: A. Surveyor", "Year: 1850", "Publisher: Admiralty", "DOI: 10.1234/abc"]);
  assert.deepEqual(libraryCandidateLines({ type: "text", unverified: true }).length, 1);
});

test("the role line's description sits directly above the function it describes", () => {
  const source = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
  assert.match(source, /\/\*\* What the signed-in account can do with an item, from the role the server resolved\. \*\/\nexport function moderationRoleLine\(/);
  assert.doesNotMatch(source, /resolved\. \*\/\nfunction conversionKindName/);
});
