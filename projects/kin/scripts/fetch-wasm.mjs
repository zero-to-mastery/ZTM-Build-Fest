// Fetches the Kin engine that CI built for a commit (#330, #331), for a
// machine that can't build WASM itself (no `wasm32-unknown-unknown` target).
//
//   node scripts/fetch-wasm.mjs [--commit SHA] [--repo OWNER/NAME]
//
// Every Kin verification run publishes `kin-engine-wasm`: kin_engine.wasm and
// kin_engine.wasm.sha256. This finds that artifact for the commit (HEAD by
// default), downloads it with a GitHub token (GITHUB_TOKEN, GH_TOKEN, or
// `gh auth token`), checks the engine against its recorded SHA-256, and only
// then writes web/wasm/kin_engine.wasm. Nothing is written on any mismatch.
//
// Artifacts download as ZIP archives; they are read here with Node's own
// zlib (stored and deflated entries), so no unzip tool or package is needed.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = "kin-engine-wasm";
const DEFAULT_REPO = "mnichols08/ZTM-Build-Fest";

export class FetchWasmError extends Error {}

/** The entries of a ZIP archive: { name, bytes }. Supports the stored (0)
 * and deflated (8) methods GitHub uses; refuses anything else. */
export function readZip(archive) {
  const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new FetchWasmError("The artifact is not a ZIP archive.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new FetchWasmError("The artifact's ZIP directory is damaged.");
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (view.getUint32(local, true) !== 0x04034b50) throw new FetchWasmError("The artifact's ZIP entry is damaged.");
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = data.slice();
    else if (method === 8) content = new Uint8Array(inflateRawSync(data));
    else throw new FetchWasmError(`The artifact uses an unsupported ZIP method (${method}).`);
    if (content.length !== size) throw new FetchWasmError("The artifact's ZIP entry has the wrong size.");
    entries.push({ name, bytes: content });
  }
  return entries;
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Picks the engine and its hash out of the artifact's entries and checks
 * them against each other. Returns the engine bytes and hash. */
export function checkedEngine(entries) {
  const engine = entries.find((entry) => entry.name.endsWith("kin_engine.wasm"));
  const record = entries.find((entry) => entry.name.endsWith("kin_engine.wasm.sha256"));
  if (!engine || !record) throw new FetchWasmError("The artifact is missing kin_engine.wasm or its .sha256 file.");
  const expected = new TextDecoder().decode(record.bytes).trim().split(/\s+/)[0]?.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected ?? "")) throw new FetchWasmError("The artifact's .sha256 file is not a SHA-256 hash.");
  const actual = sha256(engine.bytes);
  if (actual !== expected) throw new FetchWasmError(`The downloaded engine's SHA-256 (${actual}) doesn't match the one CI recorded (${expected}).`);
  // A WebAssembly module starts with "\0asm".
  if (engine.bytes[0] !== 0 || engine.bytes[1] !== 0x61 || engine.bytes[2] !== 0x73 || engine.bytes[3] !== 0x6d)
    throw new FetchWasmError("The downloaded engine is not a WebAssembly module.");
  return { bytes: engine.bytes, hash: actual };
}

function token(env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

async function github(path, { auth, binary = false }) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${auth}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "kin-fetch-wasm" },
    redirect: "follow",
  });
  if (!response.ok) throw new FetchWasmError(`GitHub answered ${response.status} for ${path.split("?")[0]}.`);
  return binary ? new Uint8Array(await response.arrayBuffer()) : response.json();
}

export async function fetchWasm({ commit, repo = DEFAULT_REPO, env = process.env, log = console.log } = {}) {
  const head = commit ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new FetchWasmError(`Not a full commit hash: ${head}`);
  const auth = token(env);
  if (!auth) throw new FetchWasmError("Downloading a CI artifact needs a GitHub token: set GITHUB_TOKEN, or sign in with `gh auth login`.");
  const { artifacts } = await github(`/repos/${repo}/actions/artifacts?name=${ARTIFACT}&per_page=100`, { auth });
  const match = artifacts.find((artifact) => !artifact.expired && artifact.workflow_run?.head_sha === head);
  if (!match) throw new FetchWasmError(`No ${ARTIFACT} artifact for ${head.slice(0, 12)} (artifacts are kept 30 days). Push the commit and wait for "Kin verification", or build WASM with build-wasm.sh / build-wasm.ps1.`);
  log(`Downloading ${ARTIFACT} from run ${match.workflow_run.id} (${head.slice(0, 12)})…`);
  const { bytes, hash } = checkedEngine(readZip(await github(`/repos/${repo}/actions/artifacts/${match.id}/zip`, { auth, binary: true })));
  const destination = join(PROJECT_ROOT, "web", "wasm", "kin_engine.wasm");
  await mkdir(dirname(destination), { recursive: true });
  // Written beside it, then moved into place, so a failure never leaves half
  // an engine behind.
  await writeFile(`${destination}.partial`, bytes);
  await rename(`${destination}.partial`, destination);
  log(`Installed web/wasm/kin_engine.wasm (SHA-256 ${hash}).`);
  return { hash, run: match.workflow_run.id };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  fetchWasm({ commit: option("--commit"), repo: option("--repo") }).catch((error) => {
    console.error(error instanceof FetchWasmError ? error.message : error);
    process.exitCode = 1;
  });
}
