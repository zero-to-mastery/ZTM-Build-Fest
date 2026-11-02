import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RUST_OUTPUT_BYTES,
  MAX_RUST_SOURCE_BYTES,
  playgroundUrl,
  runRust,
} from "../../web/components/ob-rust-runner.js";

test("builds an editable Rust Playground fallback URL", () => {
  const url = new URL(playgroundUrl('fn main() { println!("Hi"); }'));
  assert.equal(url.origin, "https://play.rust-lang.org");
  assert.equal(url.searchParams.get("version"), "stable");
  assert.equal(url.searchParams.get("mode"), "debug");
  assert.equal(url.searchParams.get("edition"), "2021");
  assert.equal(url.searchParams.get("code"), 'fn main() { println!("Hi"); }');
});

test("runs Rust with a credential-free fixed Playground request", async () => {
  let request;
  const result = await runRust("fn main() {}", {
    fetcher: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        headers: { get: () => "100" },
        json: async () => ({ success: true, stdout: "done\n", stderr: "" }),
      };
    },
  });

  assert.equal(request.url, "https://play.rust-lang.org/execute");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.referrerPolicy, "no-referrer");
  assert.deepEqual(JSON.parse(request.options.body), {
    channel: "stable",
    mode: "debug",
    edition: "2021",
    crateType: "bin",
    tests: false,
    code: "fn main() {}",
    backtrace: false,
  });
  assert.deepEqual(result, { success: true, stdout: "done\n", stderr: "" });
});

test("rejects oversized source and malformed responses", async () => {
  await assert.rejects(() => runRust("x".repeat(MAX_RUST_SOURCE_BYTES + 1)), /20,000 bytes/);
  await assert.rejects(
    () =>
      runRust("fn main() {}", {
        fetcher: async () => ({
          ok: true,
          headers: { get: () => "100" },
          json: async () => ({ success: true, stdout: 4 }),
        }),
      }),
    /unexpected response/,
  );
  await assert.rejects(
    () =>
      runRust("fn main() {}", {
        fetcher: async () => ({
          ok: true,
          json: async () => ({ success: true, stdout: "", stderr: "" }),
        }),
      }),
    /cannot safely read/,
  );
});

test("bounds remote output before handing it to the page", async () => {
  const result = await runRust("fn main() {}", {
    fetcher: async () => ({
      ok: true,
      headers: { get: () => "100" },
      json: async () => ({ success: true, stdout: "x".repeat(MAX_RUST_OUTPUT_BYTES + 100), stderr: "more" }),
    }),
  });
  assert.match(result.stdout, /output truncated by open\.blog/);
  assert.ok(new TextEncoder().encode(result.stdout).byteLength <= MAX_RUST_OUTPUT_BYTES);
  assert.equal(result.stderr, "");
});
