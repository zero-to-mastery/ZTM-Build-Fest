// Narrow client for the official Rust Playground. Keeping network work outside
// the UI component makes the fixed destination and privacy-sensitive request
// options easy to audit and test.

import { MAX_CHECK_BYTES, buildCheckProgram, interpretCheck, parseChecks } from "./ob-rust-check-model.js";

export const MAX_RUST_SOURCE_BYTES = 20_000;
export const MAX_RUST_OUTPUT_BYTES = 64_000;

const PLAYGROUND = "https://play.rust-lang.org";
const MAX_RESPONSE_BYTES = 512_000;
const TRUNCATED = "\n… output truncated by open.blog …\n";

async function responseJson(response) {
  const lengthHeader = response.headers?.get?.("Content-Length");
  const length = lengthHeader === null || lengthHeader === undefined ? null : Number(lengthHeader);
  if (length !== null && Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error("Rust Playground returned too much data.");
  }
  if (!response.body?.getReader) {
    if (length === null || !Number.isFinite(length)) {
      throw new Error("The browser cannot safely read this Rust Playground response.");
    }
    return response.json();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Rust Playground returned too much data.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function boundedOutput(stdout, stderr) {
  const combined = stdout && stderr ? `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}` : stdout || stderr;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(combined);
  if (bytes.byteLength <= MAX_RUST_OUTPUT_BYTES) return { stdout, stderr };
  const marker = encoder.encode(TRUNCATED);
  // Leave three bytes of slack in case the slice ends inside a UTF-8 sequence
  // and TextDecoder emits a three-byte replacement character.
  const kept = bytes.slice(0, MAX_RUST_OUTPUT_BYTES - marker.byteLength - 3);
  return { stdout: `${new TextDecoder().decode(kept)}${TRUNCATED}`, stderr: "" };
}

export function playgroundUrl(code) {
  const url = new URL(PLAYGROUND);
  url.searchParams.set("version", "stable");
  url.searchParams.set("mode", "debug");
  url.searchParams.set("edition", "2021");
  url.searchParams.set("code", code);
  return url.toString();
}

async function execute(code, { crateType, tests, fetcher, signal }) {
  const response = await fetcher(`${PLAYGROUND}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
    body: JSON.stringify({
      channel: "stable",
      mode: "debug",
      edition: "2021",
      crateType,
      tests,
      code,
      backtrace: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`Rust Playground returned HTTP ${response.status || "error"}.`);
  }

  const result = await responseJson(response);
  if (
    typeof result?.success !== "boolean" ||
    typeof result?.stdout !== "string" ||
    typeof result?.stderr !== "string"
  ) {
    throw new Error("Rust Playground returned an unexpected response.");
  }
  return { success: result.success, ...boundedOutput(result.stdout, result.stderr) };
}

export async function runRust(code, { fetcher = fetch, signal } = {}) {
  if (new TextEncoder().encode(code).byteLength > MAX_RUST_SOURCE_BYTES) {
    throw new Error("Runnable Rust examples are limited to 20,000 bytes.");
  }
  return execute(code, { crateType: "bin", tests: false, fetcher, signal });
}

// Compile the reader's code together with the author's hidden checks in test mode (a library
// crate, so the reader's `fn main` is optional) and turn the result into the author's feedback.
// Only the reader's code and the author's checks are sent, to the same fixed Playground.
export async function runRustChecks(code, checks, { fetcher = fetch, signal } = {}) {
  const encoder = new TextEncoder();
  if (encoder.encode(code).byteLength > MAX_RUST_SOURCE_BYTES) {
    throw new Error("Runnable Rust examples are limited to 20,000 bytes.");
  }
  const program = buildCheckProgram(code, checks);
  if (encoder.encode(program).byteLength > MAX_CHECK_BYTES) {
    throw new Error("This example and its checks are too large to run together.");
  }
  const result = await execute(program, { crateType: "lib", tests: true, fetcher, signal });
  return { ...interpretCheck(result, parseChecks(checks)), success: result.success };
}
