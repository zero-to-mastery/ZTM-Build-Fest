// Provider-neutral browser client for an independently hosted execution
// gateway. This module never accepts credentials or executes code locally.

import { normalizeCodeRunnerLanguage } from "./ob-code-runner-language.js";

export const MAX_RUNNER_SOURCE_BYTES = 20_000;
export const MAX_RUNNER_STDIN_BYTES = 8_000;
export const MAX_RUNNER_OUTPUT_BYTES = 64_000;

const MAX_RESPONSE_BYTES = 512_000;
const TRUNCATED = "\n… output truncated by open.blog …\n";
const encoder = new TextEncoder();

function publicEndpoint(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function responseJson(response) {
  const header = response.headers?.get?.("Content-Length");
  const length = header === null || header === undefined ? null : Number(header);
  if (length !== null && Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error("The code runner returned too much data.");
  }
  if (!response.body?.getReader) {
    throw new Error("The browser cannot safely read this code runner response.");
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
      throw new Error("The code runner returned too much data.");
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

function plainTerminalText(value) {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function boundedOutput(stdout, stderr) {
  stdout = plainTerminalText(stdout);
  stderr = plainTerminalText(stderr);
  const combined = stdout && stderr ? `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}` : stdout || stderr;
  const bytes = encoder.encode(combined);
  if (bytes.byteLength <= MAX_RUNNER_OUTPUT_BYTES) return { stdout, stderr };
  const marker = encoder.encode(TRUNCATED);
  const kept = bytes.slice(0, MAX_RUNNER_OUTPUT_BYTES - marker.byteLength - 3);
  return { stdout: `${new TextDecoder().decode(kept)}${TRUNCATED}`, stderr: "" };
}

export async function runCode({ endpoint, language, source = "", stdin = "" }, { fetcher = fetch, signal } = {}) {
  endpoint = publicEndpoint(endpoint);
  language = normalizeCodeRunnerLanguage(language);
  source = String(source);
  stdin = String(stdin);
  if (!endpoint) throw new Error("The code runner must use a public HTTPS endpoint without credentials.");
  if (!language) throw new Error("The code runner language is invalid.");
  if (encoder.encode(source).byteLength > MAX_RUNNER_SOURCE_BYTES) {
    throw new Error("Runnable source is limited to 20,000 bytes.");
  }
  if (encoder.encode(stdin).byteLength > MAX_RUNNER_STDIN_BYTES) {
    throw new Error("Runnable standard input is limited to 8,000 bytes.");
  }

  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
    body: JSON.stringify({ language, source, stdin }),
  });
  if (!response.ok) throw new Error(`The code runner returned HTTP ${response.status || "error"}.`);
  const result = await responseJson(response);
  if (
    typeof result?.success !== "boolean" ||
    typeof result?.stdout !== "string" ||
    typeof result?.stderr !== "string" ||
    !(result?.exitCode === null || Number.isSafeInteger(result?.exitCode))
  ) {
    throw new Error("The code runner returned an unexpected response.");
  }
  return { success: result.success, ...boundedOutput(result.stdout, result.stderr), exitCode: result.exitCode };
}
