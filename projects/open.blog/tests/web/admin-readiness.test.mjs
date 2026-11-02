import assert from "node:assert/strict";
import test from "node:test";

import { analyzeReadiness } from "../../web/admin/admin.js";

const base = {
  kind: "posts",
  title: "A practical guide to durable content",
  description: "A concise explanation of how to create durable content that stays useful, attributable, and easy to discover.",
  slug: "durable-content",
  canonical: "",
  tags: ["content design"],
  cover: "/images/durable.png",
  coverAlt: "A content lifecycle diagram",
  authorReady: true,
};

test("readiness analysis rewards a structured, sourced answer", () => {
  const body = [
    "Durable content answers the reader’s main question immediately, then supplies enough context to verify and apply that answer.",
    "## How it works",
    `${"Evidence and practical context help readers act with confidence. ".repeat(18)}[Primary documentation](https://example.com/docs).`,
  ].join("\n\n");
  const result = analyzeReadiness({ ...base, body });
  assert.equal(result.score, 100);
  assert.equal(result.ready, result.total);
  assert.deepEqual(result.groups.map((group) => group.name), ["Search", "Answer readiness", "Trust & access"]);
});

test("readiness flags only a subtitle that is too long for one line", () => {
  const body = "Durable content answers the reader’s main question immediately.";
  const subtitleChecks = (result) => result.groups.flatMap((group) => group.checks).filter((check) => check.label === "Subtitle");
  assert.deepEqual(subtitleChecks(analyzeReadiness({ ...base, body })), []);
  assert.equal(subtitleChecks(analyzeReadiness({ ...base, body, subtitle: "A short line" }))[0].ready, true);
  assert.equal(subtitleChecks(analyzeReadiness({ ...base, body, subtitle: "x".repeat(161) }))[0].ready, false);
});

test("readiness analysis exposes specific weak signals without claiming rank", () => {
  const result = analyzeReadiness({
    ...base,
    title: "Short",
    description: "",
    slug: "",
    canonical: "/relative",
    tags: [],
    coverAlt: "",
    authorReady: false,
    body: "Read [here](https://example.com).",
  });
  assert.ok(result.score < 30);
  const weak = result.groups.flatMap((group) => group.checks).filter((check) => !check.ready).map((check) => check.label);
  for (const label of ["Search title", "Search description", "Readable URL", "Canonical URL", "Topic signals", "Direct opening", "Scannable sections", "Answer depth", "Accessible social image", "Descriptive links", "Author identity"]) {
    assert.ok(weak.includes(label), label);
  }
});

test("non-post content omits post-only canonical, tag, image, and author checks", () => {
  const result = analyzeReadiness({ ...base, kind: "pages", tags: [], authorReady: false, body: "A useful opening paragraph that is long enough to explain the page clearly to a reader." });
  const labels = result.groups.flatMap((group) => group.checks).map((check) => check.label);
  for (const label of ["Canonical URL", "Topic signals", "Accessible social image", "Author identity"]) assert.ok(!labels.includes(label), label);
});

test("code examples in every supported block form do not affect content signals", () => {
  const examples = [
    "```md\n## Example heading\n[Documentation](https://example.com/docs)\n[here](https://example.com)\n```",
    "````md\n## Example heading\n[Documentation](https://example.com/docs)\n[here](https://example.com)\n````",
    "~~~md\n## Example heading\n[Documentation](https://example.com/docs)\n[here](https://example.com)\n~~~",
    "    ## Example heading\n    [Documentation](https://example.com/docs)\n    [here](https://example.com)",
    "`code begins\n## Example heading\n[Documentation](https://example.com/docs)\n[here](https://example.com)\ncode ends`",
  ];
  for (const example of examples) {
    const result = analyzeReadiness({ ...base, body: `A short real paragraph.\n\n${example}` });
    const checks = new Map(result.groups.flatMap((group) => group.checks).map((check) => [check.label, check.ready]));
    assert.equal(checks.get("Scannable sections"), false, example);
    assert.equal(checks.get("External source link"), false, example);
    assert.equal(checks.get("Descriptive links"), true, example);
  }
});

test("escaped backticks remain prose and do not hide real structure", () => {
  const body = "A useful opening paragraph that clearly answers the reader’s question before the detailed sections.\n\n\\`\n## Real heading\n[Documentation](https://example.com/docs)\n\\`";
  const result = analyzeReadiness({ ...base, body });
  const checks = new Map(result.groups.flatMap((group) => group.checks).map((check) => [check.label, check.ready]));
  assert.equal(checks.get("Scannable sections"), true);
  assert.equal(checks.get("External source link"), true);
});
