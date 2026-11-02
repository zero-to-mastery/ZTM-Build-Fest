import test from "node:test";
import assert from "node:assert/strict";

import { MAX_RUST_SOURCE_BYTES, runRustChecks } from "../../web/components/ob-rust-runner.js";

const CHECKS = "/// Add them together.\n#[test]\nfn adds() {\n    assert_eq!(add(2, 3), 5);\n}\n";
const STARTER = "fn add(a: u32, b: u32) -> u32 {\n    // TODO\n    0\n}\n";

function respond(body) {
  return async (url, options) => {
    respond.last = { url, options };
    return { ok: true, headers: { get: () => "100" }, json: async () => body };
  };
}

test("sends the reader's code plus the hidden checks to the fixed Playground in test mode", async () => {
  const fetcher = respond({ success: true, stdout: "test ob_checks::adds ... ok\n", stderr: "" });
  const outcome = await runRustChecks(STARTER, CHECKS, { fetcher });

  assert.equal(respond.last.url, "https://play.rust-lang.org/execute");
  assert.equal(respond.last.options.credentials, "omit");
  assert.equal(respond.last.options.referrerPolicy, "no-referrer");
  const sent = JSON.parse(respond.last.options.body);
  assert.deepEqual({ ...sent, code: undefined }, {
    channel: "stable", mode: "debug", edition: "2021", crateType: "lib", tests: true, code: undefined, backtrace: false,
  });
  assert.match(sent.code, /^fn add\(a: u32, b: u32\)/);
  assert.match(sent.code, /mod ob_checks \{/);
  assert.match(sent.code, /assert_eq!\(add\(2, 3\), 5\);/);
  assert.equal(outcome.state, "passed");
});

test("a wrong answer comes back as the author's feedback", async () => {
  const fetcher = respond({ success: false, stdout: "test ob_checks::adds ... FAILED\n", stderr: "" });
  const outcome = await runRustChecks(STARTER, CHECKS, { fetcher });
  assert.equal(outcome.state, "failed");
  assert.deepEqual(outcome.failures.map((f) => f.feedback), ["Add them together."]);
});

test("a compile error is reported with the compiler output", async () => {
  const fetcher = respond({ success: false, stdout: "", stderr: "error[E0308]: mismatched types\n" });
  const outcome = await runRustChecks("fn add() -> u32 { \"x\" }", CHECKS, { fetcher });
  assert.equal(outcome.state, "compile-error");
  assert.match(outcome.output, /E0308/);
});

test("rejects oversized code, or a program too big once the checks are added", async () => {
  await assert.rejects(() => runRustChecks("x".repeat(MAX_RUST_SOURCE_BYTES + 1), CHECKS, { fetcher: respond({}) }), /20,000 bytes/);
  await assert.rejects(
    () => runRustChecks("//".padEnd(19_000, "x"), `#[test]\nfn big() {}\n// ${"y".repeat(30_000)}\n`, { fetcher: respond({}) }),
    /too large/,
  );
});

test("reports a malformed or failed Playground response as an error, never as a pass", async () => {
  await assert.rejects(() => runRustChecks(STARTER, CHECKS, { fetcher: respond({ success: true }) }), /unexpected response/);
  await assert.rejects(
    () => runRustChecks(STARTER, CHECKS, { fetcher: async () => ({ ok: false, status: 429, headers: { get: () => "1" } }) }),
    /HTTP 429/,
  );
});
