import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  publicationReviewCountsText,
  publicationReviewSitePlace,
  publicationReviewSiteTarget,
} from "../../web/admin/admin.js";

// The research readiness report (#194, ADR 0150): Admin and the command line show one report. The
// Rust tests write the shared fixtures from the contract (crates/openblog-core/tests/readiness_report.rs);
// these tests read the same files and check that Admin's wording, order and counts are the
// terminal's, so neither can drift from the other.

const fixture = (name) => readFileSync(new URL(`../fixtures/research-readiness/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const report = JSON.parse(fixture("report.json"));
const lines = fixture("report.txt").trimEnd().split("\n");

const terminalCodes = lines.filter((line) => line.startsWith("research ")).map((line) => line.slice(line.lastIndexOf("[") + 1, -1));
const adminCodes = report.groups.flatMap((group) => group.findings.map((position) => `${report.findings[position].validator}: ${report.findings[position].code}`));

test("Admin lists the codes the terminal prints, in the order the terminal prints them", () => {
  assert.deepEqual(adminCodes, terminalCodes);
  assert.ok(adminCodes.length >= 6, "the fixture holds a mixed-severity report");
  assert.deepEqual(
    report.groups.map((group) => group.name),
    ["blocking", "detected", "potential", "needs-review"],
  );
});

test("Admin's counts sentence is the terminal's, outcomes apart and never a total", () => {
  assert.equal(`Research checks: ${publicationReviewCountsText(report)}`, lines.at(-1));
  assert.doesNotMatch(lines.at(-1), /score|total|ready|passed|resolved/i);
  assert.deepEqual(Object.keys(report.counts).sort(), ["detected", "needsReview", "potential"]);
});

test("acknowledged and stale findings stay listed and counted, and the terminal says which", () => {
  const acknowledged = report.findings.find((finding) => finding.acknowledgement === "current");
  const stale = report.findings.find((finding) => finding.acknowledgement === "stale");
  assert.ok(acknowledged && stale);
  assert.equal(report.counts.potential.found, 1, "an acknowledged finding is still counted");
  assert.equal(report.counts.potential.acknowledged, 1);
  assert.equal(report.counts.detected.acknowledged, 0, "a stale acknowledgement counts for nothing");
  assert.ok(lines.some((line) => line.startsWith("research potential (acknowledged):") && line.includes(`[${acknowledged.validator}: ${acknowledged.code}]`)));
  assert.ok(lines.some((line) => line.startsWith("research detected (acknowledgement stale):") && line.includes(`[${stale.validator}: ${stale.code}]`)));
});

test("a finding that blocks cannot be acknowledged, and a withheld one is not blocking", () => {
  const blocking = report.groups.find((group) => group.name === "blocking").findings.map((position) => report.findings[position]);
  assert.deepEqual(blocking.map((finding) => finding.code), ["file-unreadable"]);
  assert.ok(blocking.every((finding) => finding.gate === "refuses" && !finding.acknowledgement));
  const approval = report.findings.find((finding) => finding.code === "stale-approval");
  assert.equal(approval.gate, "withholds");
  assert.ok(!report.groups.find((group) => group.name === "blocking").findings.includes(report.findings.indexOf(approval)));
});

test("the site report names each finding's place and where to repair it, without an open editor", () => {
  const at = (code) => report.findings.find((finding) => finding.code === code);
  assert.equal(publicationReviewSitePlace(at("citation-unresolved")), "posts/cave.md:12:1");
  assert.equal(publicationReviewSitePlace(at("context-link-unpublished")), "posts/cave.md:7");
  assert.equal(publicationReviewSitePlace(at("file-unreadable")), "the Knowledge Atlas");
  assert.equal(publicationReviewSitePlace(at("claim-location-unreviewed")), "claim c1 in posts/cave.md");
  assert.deepEqual(publicationReviewSiteTarget(at("citation-unresolved")), { kind: "panel", href: "#/edit/posts%2Fcave.md", label: "Open the post posts/cave.md" });
  assert.deepEqual(publicationReviewSiteTarget(at("file-unreadable")), { kind: "panel", href: "#/research/atlas", label: "Open the Knowledge Atlas" });
  assert.deepEqual(publicationReviewSiteTarget(at("stale-approval")), { kind: "panel", href: "#/research/compare/cave-places", label: "Open the comparison cave-places in Compare" });
  const claim = { scope: { object: "claim", id: "c1", path: "posts/cave.md" } };
  assert.deepEqual(publicationReviewSiteTarget(claim), { kind: "panel", href: "#/edit/posts%2Fcave.md?pane=evidence", label: "Open posts/cave.md in Evidence Studio" });
  assert.equal(publicationReviewSiteTarget({ scope: { object: "claims-file" } }), null, "nothing to open without a post");
});

test("the fixture carries no statement, note or excerpt, only ids, fields and the validators' sentences", () => {
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /ZqxLeak|"facts"/);
  for (const finding of report.findings) {
    assert.deepEqual(
      Object.keys(finding).filter((key) => !["validator", "check", "code", "category", "outcome", "gate", "scope", "related", "message", "repair", "fingerprint", "place", "acknowledgement"].includes(key)),
      [],
    );
    assert.match(finding.fingerprint, /^[0-9a-f]{32}$/);
  }
});

test("the site report says the next build, and a post's review says publishing", () => {
  assert.match(publicationReviewCountsText(report), /^1 must be fixed before the next build\./);
  assert.match(publicationReviewCountsText({ ...report, scope: "post" }), /^1 must be fixed before publishing\./);
});

test("Admin names each place in the terminal's words", () => {
  const places = lines
    .filter((line) => line.startsWith("research "))
    .map((line) => line.slice(line.indexOf(": ") + 2));
  const listed = report.groups.flatMap((group) => group.findings.map((position) => report.findings[position]));
  assert.equal(listed.length, places.length);
  listed.forEach((finding, index) => {
    assert.ok(places[index].startsWith(`${publicationReviewSitePlace(finding)}: `), `${places[index]} names ${publicationReviewSitePlace(finding)}`);
  });
});
