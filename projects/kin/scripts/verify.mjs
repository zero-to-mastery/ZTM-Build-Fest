#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { browserInstallHint, findBrowser } from "./find-browser.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// No single Node test may hang the gate (#106): network and process tests
// that stall fail after this long instead of blocking CI until its timeout.
const NODE_TEST_TIMEOUT_MS = 120_000;

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLCHAIN_FILE = join(PROJECT_ROOT, "rust-toolchain.toml");
const BROWSER_RUNNERS = [
  ["browser regression", "browser-regression.mjs"],
  ["security storage regression", "security-storage-regression.mjs"],
  ["security UI regression", "security-ui-regression.mjs"],
  ["passkey regression", "passkey-regression.mjs"],
  ["household authority regression", "household-authority-regression.mjs"],
  // A page that loads while the service worker installs still comes under it (#770).
  ["worker claim regression", "worker-claim-regression.mjs"],
  // The home server's control panel (#718): setup through the real relay.
  ["control panel regression", "control-panel-regression.mjs"],
];

async function terminateProcessTree(child, signal) {
  if (!child.pid) throw new Error("cannot terminate child process tree: child has no process id");
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => {
      let killer;
      try { killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
      catch (error) { reject(error); return; }
      killer.once("error", reject);
      killer.once("close", (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited with code ${code}`)));
    });
    return;
  }
  // detached gives this command its own process group, so the negative PID
  // targets only this command and descendants it started in that group.
  process.kill(-child.pid, signal);
}

export function runCommand(command, args, { cwd = PROJECT_ROOT, env = process.env, spawnImpl = spawn, capture = false, signalSource = process, terminateTree = terminateProcessTree } = {}) {
  return new Promise((resolveResult) => {
    let child;
    let stdout = "";
    let stderr = "";
    let interruption = null;
    let cleanupError = null;
    let cleanupPending = false;
    let closed = false;
    let closeResult;
    let settled = false;
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    } catch (error) {
      resolveResult({ code: 1, signal: null, error });
      return;
    }
    const onInterrupt = (signal) => {
      if (interruption || closed) return;
      interruption = signal;
      cleanupPending = true;
      Promise.resolve().then(() => terminateTree(child, signal)).catch((error) => { cleanupError = error; }).finally(() => {
        cleanupPending = false;
        complete();
      });
    };
    const onSigint = () => onInterrupt("SIGINT");
    const onSigterm = () => onInterrupt("SIGTERM");
    signalSource.once("SIGINT", onSigint);
    signalSource.once("SIGTERM", onSigterm);
    child.stdout?.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; if (!capture) process.stdout.write(chunk); });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; if (!capture) process.stderr.write(chunk); });
    function complete() {
      if (settled || !closed || cleanupPending) return;
      settled = true;
      signalSource.removeListener("SIGINT", onSigint);
      signalSource.removeListener("SIGTERM", onSigterm);
      const result = closeResult;
      if (interruption) {
        const code = interruption === "SIGINT" ? 130 : 143;
        resolveResult({ stdout, stderr, code: cleanupError ? 1 : code, signal: interruption, error: cleanupError ?? null, interrupted: true });
      } else resolveResult({ stdout, stderr, ...result });
    }
    const finishError = (error) => {
      if (settled) return;
      closed = true;
      closeResult = { code: 1, signal: null, error };
      complete();
    };
    child.once("error", finishError);
    child.once("close", (code, signal) => {
      closed = true;
      closeResult = { code: code ?? 1, signal, error: null };
      complete();
    });
  });
}

export async function collectNodeTests(root = PROJECT_ROOT) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(fullPath);
    }
  }
  // relay/ is the connection relay (ADR 0025, #728). scripts/ holds the
  // runner's own tests and the documentation and compatibility checks; they
  // are part of the gate too (#328).
  for (const directory of ["server", "web", "relay", "scripts"]) await visit(join(root, directory));
  return files;
}

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? "");
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

async function toolchainChannel() {
  const contents = await readFile(TOOLCHAIN_FILE, "utf8");
  return /^channel\s*=\s*"([^"]+)"/m.exec(contents)?.[1] ?? null;
}

function choosePython(env) {
  return env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
}

async function checkEnvironment({ execute, env, nodeVersion }) {
  const check = async (label, command, args, validate = () => null) => {
    const result = await execute(command, args, { cwd: PROJECT_ROOT, env, capture: true });
    if (result.code !== 0) return { label, status: "FAIL", code: result.code, signal: result.signal, interrupted: result.interrupted, error: result.error?.message ?? result.stderr ?? "command failed" };
    const problem = await validate(result);
    return problem ? { label, status: "FAIL", code: 1, error: problem } : { label, status: "PASS", code: 0 };
  };
  const packageJson = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8"));
  const minimumNode = /(?:>=\s*)?(\d+\.\d+\.\d+)/.exec(packageJson.engines?.node ?? "")?.[1];
  const actualNode = nodeVersion;
  if (!minimumNode || !parseVersion(actualNode) || compareVersions(parseVersion(actualNode), parseVersion(minimumNode)) < 0) {
    const reason = "skipped after Node.js version prerequisite failure";
    return [
      { label: `Node.js ${minimumNode ? `>=${minimumNode}` : "minimum from package.json"} required; found ${actualNode}.`, status: "FAIL", code: 1 },
      ...["Rust compiler", "Cargo", "rustup pinned toolchain", "Git", "WASM target", "Python version"].map((label) => ({ label: `${label}: ${reason}`, status: "NOT RUN" })),
    ];
  }
  const checks = [];
  const add = async (...args) => { const result = await check(...args); checks.push(result); return result.status === "PASS"; };
  const tools = [
    ["rustc", ["--version"], "Rust compiler"],
    ["cargo", ["--version"], "Cargo"],
    ["rustup", ["show", "active-toolchain"], "rustup pinned toolchain"],
    ["git", ["--version"], "Git"],
  ];
  for (let index = 0; index < tools.length; index += 1) {
    const [command, args, label] = tools[index];
    const validate = command === "rustup" ? async (result) => {
      const expected = await toolchainChannel();
      const active = result.stdout.trim().split(/[\s-]+/)[0];
      return !expected || active !== expected ? `Pinned Rust toolchain ${expected ?? "in rust-toolchain.toml"} is required; active toolchain is ${result.stdout.trim() || "unknown"}.` : null;
    } : undefined;
    if (!await add(label, command, args, validate)) {
      checks.push(...tools.slice(index + 1).map(([, , skipped]) => ({ label: `${skipped}: skipped after prerequisite failure in ${label}`, status: "NOT RUN" })));
      checks.push({ label: `WASM target: skipped after prerequisite failure in ${label}`, status: "NOT RUN" });
      checks.push({ label: "Python version: skipped after prerequisite failure in ${label}", status: "NOT RUN" });
      return checks;
    }
  }
  if (!await add("WASM target", "rustup", ["target", "list", "--installed"], (result) => result.stdout.split(/\s+/).includes("wasm32-unknown-unknown") ? null : "Rust target wasm32-unknown-unknown is required; install it with `rustup target add wasm32-unknown-unknown`.")) {
    checks.push({ label: "Python version: skipped after prerequisite failure in WASM target", status: "NOT RUN" });
    return checks;
  }
  const pythonCommand = choosePython(env);
  await add("Python version", pythonCommand, ["--version"], (result) => {
    const version = parseVersion(/Python\s+(\d+\.\d+\.\d+)/i.exec(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)?.[1]);
    return !version || compareVersions(version, [3, 11, 0]) < 0 ? "Python >=3.11 is required for the existing TOML version checker; set PYTHON to its executable." : null;
  });
  return checks;
}

function statusOf(results) {
  if (results.some((result) => result.status === "FAIL")) return "FAIL";
  if (results.some((result) => result.status === "NOT RUN")) return "NOT RUN";
  // Passed only on its retry (#328): not a failure, never shown as PASS.
  if (results.some((result) => result.status === "FLAKY")) return "FLAKY";
  return "PASS";
}

/** The first line of a failed run that says what failed: an assertion, an
 * error, or a "Timed out" line; otherwise its last non-empty line. */
export function firstFailingLine(text = "") {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const named = lines.find((line) => /^(AssertionError|Error|TypeError|RangeError)\b|Timed out|^not ok\b|✖/.test(line));
  return (named ?? lines.at(-1) ?? "no output").slice(0, 300);
}

/** Escapes a GitHub Actions workflow-command value. */
const actionsValue = (value) => String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export async function runVerification({ browser = false, browserExecutable, env = process.env, execute = runCommand, output = console.log, nodeVersion = process.versions.node, readBytes = readFile, browserOnly = false, suites = null, engineReady = () => access(join(PROJECT_ROOT, "web", "wasm", "kin_engine.wasm")).then(() => true, () => false),
  installEngine = (from, to) => copyFile(from, to), locateBrowser = findBrowser } = {}) {
  const started = Date.now();
  const stages = [];
  let interrupted = false;
  let firstFailure = null;
  const stage = (name, results) => {
    const record = { name, results, status: statusOf(results) };
    stages.push(record);
    return record;
  };
  const commandResult = async (label, command, args, options = {}) => {
    output(`$ ${command} ${args.join(" ")}`);
    const result = await execute(command, args, { cwd: PROJECT_ROOT, env, ...options });
    if (result.interrupted) interrupted = true;
    const testCount = /(?:# tests\s+|ℹ tests\s+|tests\s+)(\d+)/i.exec(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)?.[1]
      ?? (command === "cargo" && args.includes("test") ? /(?:\d+) passed/i.exec(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)?.[0]?.match(/\d+/)?.[0] : undefined);
    const assertionMatches = [...`${result.stdout ?? ""}\n${result.stderr ?? ""}`.matchAll(/PASS\s+(\d+)\s+[^\r\n]*assertions/gi)];
    const assertionCount = assertionMatches.at(-1)?.[1];
    const check = { label, status: result.code === 0 ? "PASS" : "FAIL", code: result.code, signal: result.signal, error: result.error?.message ?? (result.code ? result.stderr?.trim() : undefined), testCount, assertionCount };
    if (check.status === "FAIL" && !firstFailure) firstFailure = check;
    return check;
  };

  // A browser suite that fails is run once more (#328). Passing then makes
  // it FLAKY: reported, annotated in CI, but not a failure. Each attempt's
  // output, and the suite's own screenshots, go to KIN_DIAGNOSTICS_DIR.
  const diagnostics = env.KIN_DIAGNOSTICS_DIR ?? null;
  const flaky = [];
  const saveAttempt = async (label, attempt, result) => {
    if (!diagnostics) return;
    try {
      await mkdir(diagnostics, { recursive: true });
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      await writeFile(join(diagnostics, `${slug}-attempt${attempt}.log`), `${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`);
    } catch { /* diagnostics never change the outcome */ }
  };
  const browserSuite = async (label, script, executable) => {
    const run = async (attempt) => {
      output(`$ node scripts/${script}${attempt > 1 ? " (retry)" : ""}`);
      const result = await execute(process.execPath, [join(PROJECT_ROOT, "scripts", script), executable], {
        cwd: PROJECT_ROOT, env: diagnostics ? { ...env, KIN_DIAGNOSTICS_DIR: join(diagnostics, `attempt${attempt}`) } : env,
      });
      if (result.interrupted) interrupted = true;
      if (result.code !== 0) await saveAttempt(label, attempt, result);
      return result;
    };
    const first = await run(1);
    const failing = (result) => firstFailingLine(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
    let result = first, status = first.code === 0 ? "PASS" : "FAIL", firstAttempt = null;
    if (status === "FAIL" && !first.interrupted) {
      firstAttempt = failing(first);
      output(`RETRY   ${label}: first attempt failed (${firstAttempt}); running it once more`);
      result = await run(2);
      if (result.code === 0) {
        status = "FLAKY";
        flaky.push({ label, failure: firstAttempt });
      }
    }
    const check = { label, status, code: result.code, signal: result.signal, error: status === "FAIL" ? failing(result) : undefined, firstAttempt };
    if (status === "FAIL" && !firstFailure) firstFailure = check;
    return check;
  };

  // The suites this run covers: all of them, or those named with --suite
  // (#329: CI runs one suite per job).
  const runners = suites?.length
    ? BROWSER_RUNNERS.filter(([label, script]) => suites.some((name) => [label, script, script.replace(/\.mjs$/, "")].includes(name)))
    : BROWSER_RUNNERS;
  // --browser-only runs just stage E against an engine already in place
  // (built, or fetched for this commit); stages A–D run in their own job.
  let environmentPassed = true;
  if (!browserOnly) {
    const environmentChecks = await checkEnvironment({ execute, env, nodeVersion });
    interrupted = environmentChecks.some(({ interrupted: wasInterrupted }) => wasInterrupted === true);
    environmentPassed = environmentChecks.every(({ status }) => status === "PASS");
    if (!environmentPassed) firstFailure = environmentChecks.find(({ status }) => status === "FAIL");
    // The engine tests in stage C and the browser suites load the browser
    // engine. A fresh checkout has none: build it now (as build-wasm does)
    // rather than fail later (#331).
    if (environmentPassed && !(await engineReady())) {
      const engine = await commandResult("Browser engine (web/wasm/kin_engine.wasm)", "cargo", ["build", "--manifest-path", join(PROJECT_ROOT, "Cargo.toml"), "--target", "wasm32-unknown-unknown", "--release"]);
      if (engine.status === "PASS") {
        try {
          await mkdir(join(PROJECT_ROOT, "web", "wasm"), { recursive: true });
          await installEngine(join(PROJECT_ROOT, "target", "wasm32-unknown-unknown", "release", "kin.wasm"), join(PROJECT_ROOT, "web", "wasm", "kin_engine.wasm"));
          engine.artifact = "built for this run (it was missing)";
        } catch (error) {
          engine.status = "FAIL";
          engine.error = `could not install the built engine: ${error.message}`;
          firstFailure ??= engine;
        }
      }
      environmentChecks.push(engine);
      environmentPassed = engine.status === "PASS";
    }
    stage("A — Environment", environmentChecks);
    const skipStage = (name, reason, labels = [name]) => stage(name, labels.map((label) => ({ label: `${label}: ${reason}`, status: "NOT RUN" })));

    if (!environmentPassed) {
      const reason = `blocked by environment failure: ${firstFailure.label}`;
      skipStage("B — Static verification", reason, ["Rust format", "Clippy", "Version consistency", "Kin diff whitespace"]);
      skipStage("C — Unit and integration tests", reason, ["Complete Node server and web suites", "Rust unit tests"]);
      skipStage("D — WASM", reason, ["Release wasm32 build"]);
    } else {
      const python = choosePython(env);
      const staticResults = [];
      const staticCommands = [
        ["Rust format", "cargo", ["fmt", "--manifest-path", join(PROJECT_ROOT, "Cargo.toml"), "--", "--check"]],
        ["Clippy", "cargo", ["clippy", "--manifest-path", join(PROJECT_ROOT, "Cargo.toml"), "--all-targets", "--", "-D", "warnings"]],
        ["Version consistency", python, [join(PROJECT_ROOT, "scripts", "check_version.py")]],
        ["Kin diff whitespace", "git", ["diff", "--check", "--", "."]],
      ];
      for (let index = 0; index < staticCommands.length; index += 1) {
        const [label, command, args, options] = staticCommands[index];
        const check = await commandResult(label, command, args, options);
        staticResults.push(check);
        if (check.status === "FAIL") {
          staticResults.push(...staticCommands.slice(index + 1).map(([skipped]) => ({ label: `${skipped}: skipped after failure in ${check.label}`, status: "NOT RUN" })));
          break;
        }
      }
      stage("B — Static verification", staticResults);

      if (staticResults.some(({ status }) => status === "FAIL")) {
        const reason = `blocked by failure in ${firstFailure.label}`;
        skipStage("C — Unit and integration tests", reason, ["Complete Node server and web suites", "Rust unit tests"]);
        skipStage("D — WASM", reason, ["Release wasm32 build"]);
      } else {
        const testFiles = await collectNodeTests();
        const testResults = [];
        const nodeTest = await commandResult(`Complete Node server and web suites (${testFiles.length} files)`, process.execPath, ["--test", `--test-timeout=${NODE_TEST_TIMEOUT_MS}`, ...testFiles], { env: { ...env, NODE_NO_WARNINGS: "1" } });
        testResults.push(nodeTest);
        if (nodeTest.status === "FAIL") testResults.push({ label: `Rust unit tests: skipped after failure in ${nodeTest.label}`, status: "NOT RUN" });
        else testResults.push(await commandResult("Rust unit tests", "cargo", ["test", "--manifest-path", join(PROJECT_ROOT, "Cargo.toml")]));
        stage("C — Unit and integration tests", testResults);

        if (testResults.some(({ status }) => status === "FAIL")) skipStage("D — WASM", `blocked by failure in ${firstFailure.label}`, ["Release wasm32 build"]);
        else {
      const wasm = await commandResult("Release wasm32 build", "cargo", ["build", "--manifest-path", join(PROJECT_ROOT, "Cargo.toml"), "--target", "wasm32-unknown-unknown", "--release"]);
      if (wasm.status === "PASS") {
        const built = join(PROJECT_ROOT, "target", "wasm32-unknown-unknown", "release", "kin.wasm");
        const committed = join(PROJECT_ROOT, "web", "wasm", "kin_engine.wasm");
        const tracked = await execute("git", ["ls-files", "--error-unmatch", "--", "web/wasm/kin_engine.wasm"], { cwd: PROJECT_ROOT, env, capture: true });
        if (tracked.code !== 0) {
          if (browser) {
            try {
              const [builtBytes, browserBytes] = await Promise.all([readBytes(built), readBytes(committed)]);
              const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
              if (hash(builtBytes) !== hash(browserBytes)) wasm.status = "FAIL", wasm.artifact = `browser WASM is stale (built ${hash(builtBytes)}, web asset ${hash(browserBytes)}); runner did not replace it`;
              else wasm.artifact = `matches generated browser WASM (${hash(browserBytes)})`;
            } catch (error) {
              wasm.status = "FAIL";
              wasm.artifact = `browser WASM is missing; run build-wasm.ps1 or build-wasm.sh (or node scripts/fetch-wasm.mjs) before browser verification (${error.message})`;
            }
            wasm.artifactComparison = "local browser asset compared to this build; no committed expected artifact exists";
          } else {
            wasm.artifactComparison = "NOT RUN — generated WASM is ignored/untracked; no committed expected artifact exists";
          }
        } else {
          try {
            const [builtBytes, committedBytes] = await Promise.all([readBytes(built), readBytes(committed)]);
            const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
            if (hash(builtBytes) !== hash(committedBytes)) wasm.status = "FAIL", wasm.artifact = `stale committed WASM (built ${hash(builtBytes)}, committed ${hash(committedBytes)}); runner did not replace it`;
            else wasm.artifact = `matches committed WASM (${hash(committedBytes)})`;
          } catch (error) {
            wasm.status = "FAIL";
            wasm.artifact = `could not compare build artifact: ${error.message}`;
          }
        }
      }
      if (wasm.status === "FAIL" && !firstFailure) firstFailure = wasm;
      stage("D — WASM", [wasm]);
        }
      }
    }
  }

  // No browser named: use an installed Edge, Chrome or Chromium (#331).
  const located = browser && !browserExecutable && !env.KIN_BROWSER ? await locateBrowser({ env }) : null;
  const executable = browserExecutable || env.KIN_BROWSER || located?.executable;
  if (located) output(`Using ${located.executable} (set KIN_BROWSER to choose another browser)`);
  const engineMissing = browserOnly && !(await engineReady());
  if (engineMissing) {
    stage("E — Browser verification", runners.map(([label]) => ({ label: `${label}: web/wasm/kin_engine.wasm is missing; build it (build-wasm.sh / build-wasm.ps1) or fetch this commit's (node scripts/fetch-wasm.mjs)`, status: "FAIL", code: 1 })));
    firstFailure ??= stages.at(-1).results[0];
  } else if (browser && !environmentPassed) {
    const reason = `blocked by environment failure: ${firstFailure.label}`;
    stage("E — Browser verification", runners.map(([label]) => ({ label: `${label}: ${reason}`, status: "NOT RUN" })));
  } else if (browser && stages.some((item) => ["B — Static verification", "C — Unit and integration tests", "D — WASM"].includes(item.name) && item.status !== "PASS")) {
    const reason = firstFailure ? `blocked by failure in ${firstFailure.label}` : "blocked because an earlier required stage did not pass";
    stage("E — Browser verification", runners.map(([label]) => ({ label: `${label}: ${reason}`, status: "NOT RUN" })));
  } else if (browser && !executable) {
    stage("E — Browser verification", runners.map(([label]) => ({ label: `${label}: no Chromium-based browser found. ${browserInstallHint()}`, status: "FAIL", code: 1 })));
  } else if (browser && !(await access(executable).then(() => true, () => false))) {
    stage("E — Browser verification", runners.map(([label]) => ({ label: `${label}: browser executable is not accessible at ${executable}`, status: "FAIL", code: 1 })));
  } else if (browser) {
    const results = [];
    for (const [label, script] of runners) {
      const check = await browserSuite(label, script, executable);
      results.push(check);
      if (check.status === "FAIL") {
        results.push(...runners.slice(results.length).map(([remaining]) => ({ label: `${remaining}: skipped after failure in ${check.label}`, status: "NOT RUN" })));
        break;
      }
    }
    stage("E — Browser verification", results);
  } else stage("E — Browser verification", runners.map(([label]) => ({ label: `${label}: browser mode not requested; run verify:browser`, status: "NOT RUN" })));

  output("\nKin verification report");
  for (const item of stages) {
    output(`${item.status.padEnd(7)} ${item.name}`);
    for (const result of item.results) {
      if (result.status !== "PASS" || item.results.length > 1 || result.artifactComparison) output(`  ${result.status.padEnd(7)} ${result.label}${result.status === "FLAKY" ? ` — failed once, passed on retry: ${result.firstAttempt}` : ""}${result.testCount ? ` (${result.testCount} tests)` : result.assertionCount ? ` (${result.assertionCount} assertions)` : ""}${result.code !== undefined ? ` (exit ${result.code}${result.signal ? `, signal ${result.signal}` : ""})` : ""}${result.error ? `: ${result.error}` : ""}${result.artifact ? ` — ${result.artifact}` : ""}${result.artifactComparison ? `; ${result.artifactComparison}` : ""}`);
    }
  }
  output(`Runtime: Node ${nodeVersion}; browser ${browser ? executable ?? "missing" : "NOT RUN"}`);
  output(`Elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (firstFailure) output(`First failure: ${firstFailure.label}${firstFailure.signal ? ` (signal ${firstFailure.signal})` : firstFailure.code !== undefined ? ` (exit ${firstFailure.code})` : ""}${firstFailure.error ? ` — ${firstFailure.error}` : ""}`);
  if (interrupted) output("Verification interrupted; remaining checks are NOT RUN.");
  if (flaky.length) {
    output(`Flaky: ${flaky.map(({ label }) => label).join(", ")} (passed on retry; see docs/TESTING.md, "Flaky browser suites")`);
    if (env.GITHUB_ACTIONS === "true") {
      for (const { label, failure } of flaky) output(`::warning title=Flaky browser suite: ${actionsValue(label)}::${actionsValue(`Failed once, then passed on retry. First failure: ${failure}`)}`);
      if (env.GITHUB_STEP_SUMMARY) {
        const rows = flaky.map(({ label, failure }) => `| ${label} | ${failure.replace(/\|/g, "\\|")} |`).join("\n");
        await appendFile(env.GITHUB_STEP_SUMMARY, `### Flaky browser suites\n\nThese failed once and passed on retry; the build is not failed for them. Diagnostics are in the \`kin-browser-diagnostics\` artifact.\n\n| Suite | First failure |\n| --- | --- |\n${rows}\n`).catch(() => {});
      }
    }
  }
  const failed = stages.some(({ status }) => status === "FAIL");
  const notRunMandatory = !browserOnly && stages.slice(0, 4).some(({ status }) => status === "NOT RUN");
  const code = failed || notRunMandatory || interrupted ? 1 : 0;
  output(`Verification exit status: ${code}`);
  return { code, stages, elapsedMs: Date.now() - started, interrupted, firstFailure, flaky };
}

export const USAGE = "Usage: node scripts/verify.mjs [--browser [EXECUTABLE]] [--browser-only] [--suite NAME ...]";

/** Reads the command line: `--browser [EXECUTABLE]`, `--browser-only` (just
 * the browser suites, against an engine already in place; implies
 * --browser) and `--suite NAME` (repeatable: a suite's label or script name).
 * Returns the options, or { error }. */
export function parseArguments(args) {
  const options = { browser: false, browserExecutable: undefined, browserOnly: false, suites: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--browser") {
      options.browser = true;
      if (next !== undefined && !next.startsWith("--")) { options.browserExecutable = next; index += 1; }
    } else if (arg === "--browser-only") {
      options.browser = true;
      options.browserOnly = true;
    } else if (arg === "--suite") {
      if (next === undefined || next.startsWith("--")) return { error: "--suite needs a suite name" };
      const known = BROWSER_RUNNERS.some(([label, script]) => [label, script, script.replace(/\.mjs$/, "")].includes(next));
      if (!known) return { error: `Unknown suite "${next}". Suites: ${BROWSER_RUNNERS.map(([, script]) => script.replace(/\.mjs$/, "")).join(", ")}` };
      options.suites.push(next);
      index += 1;
    } else return { error: `Unknown argument ${arg}` };
  }
  if (options.suites.length && !options.browser) return { error: "--suite needs --browser or --browser-only" };
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options.error) {
    console.error(`${options.error}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    const result = await runVerification(options);
    process.exitCode = result.code;
  }
}
