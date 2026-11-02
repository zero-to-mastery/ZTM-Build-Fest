// The browser half of the passage-target contract (ADRs 0076 and 0077): the
// same fixtures as crates/openblog-core/tests/passage_targets.rs, so the
// browser and the build agree on duplicate text, Unicode, moved, deleted and
// renumbered passages and versions, plus purity and scoped failures.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_TARGET_JSON_BYTES,
  createQuoteTarget,
  normalizePassageText,
  readTarget,
  readTargetJson,
  resolveTarget,
} from "../../web/components/passage-target.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/passage-targets.json", import.meta.url), "utf8"));

const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};
deepFreeze(fixture);

const documentNamed = (name) => fixture.documents[name];

test("fixture targets resolve or are explicitly stale, as the build resolves them", () => {
  for (const testCase of fixture.resolve) {
    const read = readTarget(testCase.target);
    assert.ok(read.ok, `${testCase.name}: ${JSON.stringify(read.error)}`);
    const seen = testCase.seenDocument ? documentNamed(testCase.seenDocument).revision : testCase.seenRevision;
    const document = documentNamed(testCase.document);
    const resolution = resolveTarget(read.target, document, seen);
    assert.deepEqual(resolution, testCase.expect, testCase.name);
    if (resolution.state !== "stale" && read.target.kind === "quote") {
      // The index names the section; the anchor alone can name two.
      const section = document.sections[resolution.index];
      assert.equal(section.anchor, resolution.section, testCase.name);
      const text = Array.from(section.text).slice(resolution.start, resolution.end).join("");
      assert.equal(text, read.target.exact, `${testCase.name}: points at exactly the quoted text`);
    }
  }
});

test("fixture selections become the same bounded targets the build makes", () => {
  for (const testCase of fixture.create) {
    const result = createQuoteTarget(documentNamed(testCase.document), testCase.section, testCase.start, testCase.end);
    if (testCase.expect.target) {
      assert.ok(result.ok, `${testCase.name}: ${JSON.stringify(result.error)}`);
      assert.deepEqual(result.target, testCase.expect.target, testCase.name);
      const document = documentNamed(testCase.document);
      assert.equal(resolveTarget(result.target, document, document.revision).state, "current", testCase.name);
    } else {
      assert.equal(result.ok, false, testCase.name);
      assert.equal(result.error.code, testCase.expect.error, testCase.name);
    }
  }
});

test("fixture targets are validated without repair, with the build's codes", () => {
  for (const testCase of fixture.invalid) {
    const result = testCase.raw !== undefined ? readTargetJson(testCase.raw) : readTarget(testCase.target);
    if (testCase.error === null) {
      assert.ok(result.ok, `${testCase.name}: ${JSON.stringify(result.error)}`);
      assert.deepEqual(readTargetJson(JSON.stringify(result.target)), result, `${testCase.name}: round trip`);
    } else {
      assert.equal(result.ok, false, testCase.name);
      assert.equal(result.error.code, testCase.error, testCase.name);
    }
  }
});

test("errors name the field and never repeat the reader's text", () => {
  const secret = "<script>alert(1)</script>\u202e";
  const result = readTarget({ version: 1, kind: "quote", exact: secret, prefix: "", suffix: "", start: 0 });
  assert.equal(result.error.code, "forbiddenCharacter");
  assert.doesNotMatch(result.error.message, /script/);
  const unknown = readTarget({ version: 1, kind: "section", "secret-field": 1 });
  assert.doesNotMatch(unknown.error.message, /secret/);
});

test("oversized input is refused before it is parsed, counting UTF-8 bytes", () => {
  assert.equal(readTargetJson(`{${" ".repeat(MAX_TARGET_JSON_BYTES)}}`).error.code, "tooLarge");
  const multibyte = `"${"\u00e9".repeat(MAX_TARGET_JSON_BYTES / 2)}"`;
  assert.equal(readTargetJson(multibyte).error.code, "tooLarge");
});

test("reading copies the target and never changes the value passed in", () => {
  const input = deepFreeze({ version: 1, kind: "quote", section: null, exact: "a", prefix: "", suffix: "", start: 0 });
  const result = readTarget(input);
  assert.ok(result.ok);
  assert.notEqual(result.target, input);
  assert.ok(Object.isFrozen(result.target));
  assert.equal("section" in result.target, false, "a null section is the text before the first heading");
});

test("whitespace collapses as the build collapses it and nothing else changes", () => {
  assert.equal(normalizePassageText("  a\t\nb\u00a0 c\u3000 "), "a b c");
  assert.equal(normalizePassageText("Cafe\u0301 \u00c9"), "Cafe\u0301 \u00c9");
  assert.equal(normalizePassageText("\ufeffx"), "\ufeffx", "a byte-order mark is not whitespace");
});

test("one bad target fails alone", () => {
  const document = documentNamed("original");
  const good = createQuoteTarget(document, 1, 58, 83).target;
  const inputs = [JSON.stringify(good), '{"version":9}', "not json", JSON.stringify(good)];
  const results = inputs.map((input) => {
    const read = readTargetJson(input);
    return read.ok ? resolveTarget(read.target, document, document.revision) : read.error.code;
  });
  assert.deepEqual(results.slice(1, 3), ["unsupportedVersion", "malformed"]);
  assert.equal(results[0].state, "current");
  assert.deepEqual(results[0], results[3]);
});
