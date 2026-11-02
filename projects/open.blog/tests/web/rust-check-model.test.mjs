import test from "node:test";
import assert from "node:assert/strict";

import {
  CHECK_MODULE,
  buildCheckProgram,
  interpretCheck,
  parseChecks,
  summarise,
} from "../../web/components/ob-rust-check-model.js";

const CHECKS = `/// Add base and bonus together.
#[test]
fn adds_bonus() {
    assert_eq!(click_damage(5, 3), 8);
}

/// Do not wrap around at the ceiling.
/// Use saturating_add.
#[test]
#[should_panic]
fn stops_at_the_ceiling() {
    assert_eq!(click_damage(u32::MAX, 1), u32::MAX);
}

#[test]
fn no_doc_comment() {}

fn helper_is_not_a_check() {}
`;

test("reads each check's name and its doc-comment feedback", () => {
  assert.deepEqual(parseChecks(CHECKS), [
    { name: "adds_bonus", feedback: "Add base and bonus together." },
    { name: "stops_at_the_ceiling", feedback: "Do not wrap around at the ceiling. Use saturating_add." },
    { name: "no_doc_comment", feedback: 'The check "no doc comment" did not pass.' },
  ]);
});

test("a doc comment does not leak onto a later, unrelated test", () => {
  const checks = parseChecks("/// About a helper.\nfn helper() {}\n\n#[test]\nfn real() {}\n");
  assert.deepEqual(checks, [{ name: "real", feedback: 'The check "real" did not pass.' }]);
});

test("appends the checks in a child module that can see the reader's code", () => {
  const program = buildCheckProgram("fn click_damage(a: u32, b: u32) -> u32 { a + b }\n\n", CHECKS);
  assert.match(program, /^fn click_damage/);
  assert.match(program, new RegExp(`#\\[cfg\\(test\\)\\]\\nmod ${CHECK_MODULE} \\{\\n    #\\[allow\\(unused_imports\\)\\]\\n    use super::\\*;`));
  assert.match(program, /\n {4}fn adds_bonus\(\) \{/);
  assert.match(program, /\}\n$/);
  assert.equal(program.match(/fn click_damage/g).length, 1, "the reader's code appears once");
});

const checks = parseChecks(CHECKS);
const line = (name, status) => `test ${CHECK_MODULE}::${name} ... ${status}`;

test("passes only when every check reports ok", () => {
  const outcome = interpretCheck(
    { success: true, stdout: ["running 3 tests", line("adds_bonus", "ok"), line("stops_at_the_ceiling", "ok"), line("no_doc_comment", "ok"), "test result: ok. 3 passed; 0 failed"].join("\n"), stderr: "" },
    checks,
  );
  assert.equal(outcome.state, "passed");
  assert.equal(outcome.passed, 3);
  assert.equal(summarise(outcome), "All 3 checks passed.");
});

test("a failed check returns the author's feedback, not the raw assertion", () => {
  const outcome = interpretCheck(
    { success: false, stdout: [line("adds_bonus", "FAILED"), line("stops_at_the_ceiling", "ok"), line("no_doc_comment", "ok")].join("\n"), stderr: "assertion `left == right` failed\n  left: 0\n right: 8" },
    checks,
  );
  assert.equal(outcome.state, "failed");
  assert.deepEqual(outcome.failures.map((f) => f.feedback), ["Add base and bonus together."]);
  assert.equal(summarise(outcome), "2 of 3 checks passed.");
});

test("a check that never ran counts as failed", () => {
  const outcome = interpretCheck({ success: false, stdout: line("adds_bonus", "ok"), stderr: "" }, checks);
  assert.equal(outcome.state, "failed");
  assert.deepEqual(outcome.failures.map((f) => f.name), ["stops_at_the_ceiling", "no_doc_comment"]);
});

test("code that does not compile is reported as such, with the compiler text", () => {
  const outcome = interpretCheck(
    { success: false, stdout: "", stderr: "   Compiling playground v0.0.1\nerror[E0425]: cannot find value `x` in this scope\n --> src/lib.rs:2:5" },
    checks,
  );
  assert.equal(outcome.state, "compile-error");
  assert.match(outcome.output, /E0425/);
  assert.equal(summarise(outcome), "Your code does not compile yet.");
});

test("a reader cannot pass by printing a fake result line from their own code", () => {
  // Their program is never run in test mode, so only real test lines count; and a line that is
  // not at the start of a line (for example inside other output) is ignored.
  const outcome = interpretCheck({ success: false, stdout: `noise: ${line("adds_bonus", "ok")}`, stderr: "" }, checks);
  assert.notEqual(outcome.state, "passed");
});

test("a forged result line printed later by a failing test does not override the real one", () => {
  const stdout = [
    "running 1 test",
    line("adds_bonus", "FAILED"),
    "failures:",
    "---- ob_checks::adds_bonus stdout ----",
    line("adds_bonus", "ok"),
    "thread 'ob_checks::adds_bonus' panicked at src/lib.rs:9:5",
  ].join("\n");
  const outcome = interpretCheck({ success: false, stdout, stderr: "" }, parseChecks("#[test]\nfn adds_bonus() {}\n"));
  assert.equal(outcome.state, "failed");
});

test("an unexpected success with no test lines is unknown, not passed", () => {
  const outcome = interpretCheck({ success: true, stdout: "running 0 tests", stderr: "" }, checks);
  assert.equal(outcome.state, "unknown");
});
