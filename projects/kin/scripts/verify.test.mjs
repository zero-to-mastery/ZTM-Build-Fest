import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PROJECT_ROOT,
  collectNodeTests,
  compareVersions,
  parseVersion,
  runCommand,
  firstFailingLine,
  parseArguments,
  runVerification as runRealVerification,
} from "./verify.mjs";

// The WASM comparison reads two build outputs; these tests stand in for them
// (identical bytes) so they don't depend on a build having run first.
// No installed browser is looked for unless a test supplies one.
const runVerification = (options) => runRealVerification({ readBytes: async () => Buffer.from("engine"), engineReady: async () => true, locateBrowser: async () => null, ...options });

test("a failing child command returns its exit status", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.exit(17)"], { capture: true });
  assert.equal(result.code, 17);
});

test("a normally exiting child succeeds", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.exit(0)"], { capture: true });
  assert.equal(result.code, 0);
  assert.equal(result.error, null);
});

test("missing executables return an actionable process error", async () => {
  const result = await runCommand("kin-no-such-executable-verify-test", [], { capture: true });
  assert.equal(result.code, 1);
  assert.match(result.error.message, /spawn|not found|ENOENT/i);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} terminates an active isolated child process tree`, async () => {
    const signalSource = new EventEmitter();
    const source = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('descendant:' + child.pid); setInterval(() => {}, 1000);`;
    const result = await runCommand(process.execPath, ["-e", source], {
      capture: true,
      signalSource,
      spawnImpl: (command, args, options) => {
        const child = spawn(command, args, options);
        // Interrupt once the child reports its descendant, not after a fixed
        // delay: a slow Node start could otherwise be killed before it spawns one.
        let seen = "";
        let sent = false;
        child.stdout.on("data", (chunk) => {
          seen += chunk;
          if (!sent && /descendant:\d+/.test(seen)) { sent = true; signalSource.emit(signal); }
        });
        return child;
      },
    });
    assert.equal(result.interrupted, true);
    assert.equal(result.signal, signal);
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
    const descendantPid = Number(/descendant:(\d+)/.exec(result.stdout)?.[1]);
    assert.ok(descendantPid > 0, "isolated command created a descendant process");
    let descendantAlive = true;
    for (let attempt = 0; attempt < 20 && descendantAlive; attempt += 1) {
      try {
        if (process.platform !== "win32") {
          const stat = await readFile(`/proc/${descendantPid}/stat`, "utf8").catch(() => null);
          if (stat && stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) { descendantAlive = false; break; }
        }
        process.kill(descendantPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") descendantAlive = false;
        else throw error;
      }
      if (descendantAlive) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(descendantAlive, false, `descendant process ${descendantPid} remained after cleanup`);
  });
}

test("interruption cleanup waits for a racing child close and resolves once", async () => {
  const signalSource = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = null;
  child.stderr = null;
  let releaseCleanup;
  let terminations = 0;
  const resultPromise = runCommand("race", [], {
    signalSource,
    spawnImpl: () => child,
    terminateTree: async () => { terminations += 1; await new Promise((resolve) => { releaseCleanup = resolve; }); },
  });
  signalSource.emit("SIGTERM");
  child.emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  releaseCleanup();
  const result = await resultPromise;
  assert.equal(terminations, 1);
  assert.equal(result.code, 143);
  assert.equal(result.signal, "SIGTERM");
});

test("cleanup errors fail the interrupted command and listeners are removed", async () => {
  const signalSource = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = null;
  child.stderr = null;
  const beforeInt = signalSource.listenerCount("SIGINT");
  const beforeTerm = signalSource.listenerCount("SIGTERM");
  const pending = runCommand("cleanup-failure", [], {
    signalSource,
    spawnImpl: () => child,
    terminateTree: async () => { throw new Error("tree cleanup denied"); },
  });
  signalSource.emit("SIGINT");
  child.emit("close", null, "SIGKILL");
  const result = await pending;
  assert.equal(result.code, 1);
  assert.match(result.error.message, /tree cleanup denied/);
  assert.equal(signalSource.listenerCount("SIGINT"), beforeInt);
  assert.equal(signalSource.listenerCount("SIGTERM"), beforeTerm);
});

test("missing required browser is a failure and optional browser stage is NOT RUN", async () => {
  const messages = [];
  const availablePrerequisites = async (command, args) => {
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (/python/.test(command)) return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    return { code: 0, stdout: "tool available", stderr: "" };
  };
  const result = await runVerification({
    browser: true,
    env: { ...process.env, KIN_BROWSER: "" },
    execute: availablePrerequisites,
    nodeVersion: "24.16.0",
    output: (message) => messages.push(message),
  });
  const browserStage = result.stages.find(({ name }) => name.startsWith("E —"));
  assert.equal(browserStage.status, "FAIL");
  assert.match(browserStage.results[0].label, /no Chromium-based browser found\. Install/);
  assert.equal(result.code, 1);

  const missingExecutable = await runVerification({
    browser: true,
    browserExecutable: join(tmpdir(), "kin-missing-browser-executable"),
    execute: availablePrerequisites,
    nodeVersion: "24.16.0",
    output: (message) => messages.push(message),
  });
  assert.equal(missingExecutable.stages.find(({ name }) => name.startsWith("E —")).status, "FAIL");
  assert.ok(messages.some((message) => message.includes("browser executable is not accessible")));

  const optional = await runVerification({
    browser: false,
    execute: availablePrerequisites,
    nodeVersion: "24.16.0",
    output: (message) => messages.push(message),
  });
  assert.equal(optional.stages.find(({ name }) => name.startsWith("E —")).status, "NOT RUN");
  assert.equal(messages.some((message) => message.includes("NOT RUN E — Browser verification")), true);
});

test("test discovery is deterministic and works from repository and Kin directory paths", async () => {
  const fromProject = await collectNodeTests(PROJECT_ROOT);
  const fromRepository = await collectNodeTests(join(PROJECT_ROOT));
  assert.deepEqual(fromRepository, fromProject);
  assert.ok(fromProject.some((path) => path.endsWith(join("server", "durable-sync-integrity.test.mjs"))));
  assert.ok(fromProject.some((path) => path.endsWith(join("scripts", "v1-compatibility.test.mjs"))));
  assert.ok(fromProject.some((path) => path.endsWith(join("relay", "sni.test.mjs"))), "the connection relay's tests are in the gate (#728)");
  assert.ok(fromProject.every((path) => path.endsWith(".test.mjs")));

  const temporary = await mkdtemp(join(tmpdir(), "kin-test-discovery-"));
  try {
    await mkdir(join(temporary, "server"));
    await mkdir(join(temporary, "web", "nested"), { recursive: true });
    await writeFile(join(temporary, "server", "one.test.mjs"), "");
    await writeFile(join(temporary, "server", "ignored-test.mjs"), "");
    await writeFile(join(temporary, "web", "nested", "two.test.mjs"), "");
    assert.deepEqual((await collectNodeTests(temporary)).map((path) => path.slice(temporary.length + 1)), [
      join("server", "one.test.mjs"),
      join("web", "nested", "two.test.mjs"),
    ], "a missing scripts/ directory is no error");
    await mkdir(join(temporary, "scripts"));
    await writeFile(join(temporary, "scripts", "three.test.mjs"), "");
    await writeFile(join(temporary, "scripts", "four-regression.mjs"), "");
    assert.deepEqual((await collectNodeTests(temporary)).map((path) => path.slice(temporary.length + 1)).at(-1), join("scripts", "three.test.mjs"), "the runner's own tests are part of the gate (#328)");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the entry point resolves paths from the repository root and the Kin directory", async () => {
  const script = join(PROJECT_ROOT, "scripts", "verify.mjs");
  for (const cwd of [join(PROJECT_ROOT, "..", ".."), PROJECT_ROOT]) {
    const result = await new Promise((resolveResult) => {
      const child = spawn(process.execPath, [script], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => resolveResult({ code: 1, stdout, stderr, error }));
      child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    });
    assert.match(result.stdout, /Kin verification report/);
    assert.match(result.stdout, new RegExp(`Runtime: Node ${process.versions.node.replaceAll(".", "\\.")}`));
    if (compareVersions(parseVersion(process.versions.node), [22, 13, 0]) < 0) {
      assert.match(result.stdout, new RegExp(`Node\\.js >=22\\.13\\.0 required; found ${process.versions.node.replaceAll(".", "\\.")}`));
    }
  }
});

test("summary reflects failing prerequisites and does not claim later stages passed", async () => {
  const output = [];
  let prerequisiteCommands = 0;
  const result = await runVerification({
    execute: async () => { prerequisiteCommands += 1; return { code: 1, stdout: "", stderr: "compiler missing", error: new Error("compiler missing") }; },
    output: (message) => output.push(message),
  });
  assert.equal(result.stages[0].status, "FAIL");
  assert.equal(result.stages[1].status, "NOT RUN");
  assert.equal(result.stages[2].status, "NOT RUN");
  assert.equal(result.stages[3].status, "NOT RUN");
  assert.ok(result.stages[0].results.some(({ status }) => status === "NOT RUN"));
  assert.equal(result.code, 1);
  assert.equal(prerequisiteCommands, 1, "environment verification stops at its first failed prerequisite");
  assert.ok(output.some((line) => line.includes("NOT RUN")));
  assert.ok(output.some((line) => line.includes("compiler missing")));
});

test("a failing required child command makes the overall gate fail", async () => {
  const execute = async (command, args) => {
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (/python/.test(command)) return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    if (command === "cargo" && args[0] === "clippy") return { code: 23, stdout: "", stderr: "lint failed" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await runVerification({ execute, nodeVersion: "24.16.0", output: () => {} });
  assert.equal(result.code, 1);
  const staticStage = result.stages.find(({ name }) => name.startsWith("B —"));
  assert.equal(staticStage.status, "FAIL");
  assert.equal(staticStage.results[0].status, "PASS");
  assert.equal(staticStage.results[1].status, "FAIL");
  assert.equal(staticStage.results.length, 4);
  assert.match(staticStage.results[2].label, /Version consistency: skipped after failure in Clippy/);
  assert.match(staticStage.results[3].label, /Kin diff whitespace: skipped after failure in Clippy/);
  assert.ok(staticStage.results.slice(2).every(({ status }) => status === "NOT RUN"));
  assert.equal(result.stages.find(({ name }) => name.startsWith("C —")).status, "NOT RUN");
  assert.equal(result.stages.find(({ name }) => name.startsWith("D —")).status, "NOT RUN");
});

test("an ignored WASM output is explicitly reported without a committed comparison", async () => {
  const execute = async (command, args) => {
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (/python/.test(command)) return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    if (command === "git" && args[0] === "ls-files") return { code: 1, stdout: "", stderr: "path is ignored" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await runVerification({ execute, nodeVersion: "24.16.0", output: () => {} });
  const wasm = result.stages.find(({ name }) => name.startsWith("D —")).results[0];
  assert.equal(wasm.status, "PASS");
  assert.match(wasm.artifactComparison, /NOT RUN.*ignored\/untracked/);
});

test("an interrupted required command stops later stages and yields a failing summary", async () => {
  const commands = [];
  const execute = async (command, args) => {
    commands.push([command, args[0]]);
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (/python/.test(command)) return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    if (command === "cargo" && args[0] === "fmt") return { code: 130, signal: "SIGINT", interrupted: true, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await runVerification({ execute, nodeVersion: "24.16.0", output: () => {} });
  assert.equal(result.code, 1);
  assert.equal(result.stages.find(({ name }) => name.startsWith("B —")).status, "FAIL");
  assert.equal(result.stages.find(({ name }) => name.startsWith("C —")).status, "NOT RUN");
  assert.equal(commands.some(([command, firstArg]) => command === "cargo" && firstArg === "test"), false);
});

test("a failed Node suite prevents Rust tests and WASM build", async () => {
  const commands = [];
  const execute = async (command, args) => {
    commands.push([command, args]);
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (/python/.test(command)) return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    if (command === process.execPath && args[0] === "--test") return { code: 1, stdout: "", stderr: "controlled node failure" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await runVerification({ execute, nodeVersion: "24.16.0", output: () => {} });
  const tests = result.stages.find(({ name }) => name.startsWith("C —"));
  assert.equal(tests.results[0].status, "FAIL");
  assert.equal(tests.results[1].status, "NOT RUN");
  assert.equal(result.stages.find(({ name }) => name.startsWith("D —")).status, "NOT RUN");
  assert.equal(commands.some(([command, args]) => command === "cargo" && args[0] === "build"), false);
  assert.equal(result.code, 1);
});

test("a failed required browser suite marks later browser suites NOT RUN", async () => {
  const executedSuites = [];
  const execute = async (command, args) => {
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (/python/.test(command)) return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    if (command === "git" && args[0] === "ls-files") return { code: 1, stdout: "", stderr: "ignored" };
    if (command === process.execPath && args[0]?.endsWith(".mjs") && args[0].includes("regression")) {
      executedSuites.push(args[0]);
      return { code: 9, stdout: "", stderr: "controlled browser regression failure" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await runVerification({ browser: true, browserExecutable: process.execPath, execute, nodeVersion: "24.16.0", output: () => {} });
  const browser = result.stages.find(({ name }) => name.startsWith("E —"));
  // Retried once (#328), then failed: later suites don't run.
  assert.equal(executedSuites.length, 2);
  assert.equal(executedSuites[0], executedSuites[1]);
  assert.equal(browser.results[0].status, "FAIL");
  assert.ok(browser.results.slice(1).every(({ status }) => status === "NOT RUN"));
  assert.equal(result.code, 1);
});

test("version comparison handles numeric components", () => {
  assert.deepEqual(parseVersion("22.13.0"), [22, 13, 0]);
  assert.ok(compareVersions(parseVersion("22.12.99"), parseVersion("22.13.0")) < 0);
});

/** Answers every prerequisite and command as passing; browser suites answer
 * from `suites(script, attempt)`. */
function scriptedExecute(suites) {
  const attempts = new Map();
  const calls = [];
  const execute = async (command, args, options = {}) => {
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (/python/.test(command)) return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    if (command === "git" && args[0] === "ls-files") return { code: 1, stdout: "", stderr: "ignored" };
    if (command === process.execPath && args[0]?.endsWith("regression.mjs")) {
      const script = args[0].split(/[\\/]/).at(-1);
      const attempt = (attempts.get(script) ?? 0) + 1;
      attempts.set(script, attempt);
      calls.push({ script, attempt, diagnostics: options.env?.KIN_DIAGNOSTICS_DIR });
      return suites(script, attempt);
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { execute, calls };
}

test("a browser suite that fails once and passes on retry is FLAKY, reported, and not a failure (#328)", async () => {
  const diagnostics = await mkdtemp(join(tmpdir(), "kin-verify-flaky-"));
  const summary = join(diagnostics, "summary.md");
  const { execute, calls } = scriptedExecute((script, attempt) => script === "security-ui-regression.mjs" && attempt === 1
    ? { code: 1, stdout: "PASS lock screen\n", stderr: "AssertionError [ERR_ASSERTION]: the unlock button is focused\n    at file.mjs:10\n" }
    : { code: 0, stdout: "PASS all\n", stderr: "" });
  const messages = [];
  const result = await runVerification({
    browser: true, browserExecutable: process.execPath, execute, nodeVersion: "24.16.0", output: (line) => messages.push(line),
    env: { ...process.env, KIN_DIAGNOSTICS_DIR: diagnostics, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary },
  });
  try {
    const browser = result.stages.find(({ name }) => name.startsWith("E —"));
    assert.equal(result.code, 0, "a flake doesn't fail the gate");
    assert.equal(browser.status, "FLAKY");
    const suite = browser.results.find(({ label }) => label === "security UI regression");
    assert.equal(suite.status, "FLAKY");
    assert.equal(suite.firstAttempt, "AssertionError [ERR_ASSERTION]: the unlock button is focused");
    assert.ok(browser.results.filter(({ label }) => label !== "security UI regression").every(({ status }) => status === "PASS"), "every other suite still ran");
    assert.deepEqual(result.flaky, [{ label: "security UI regression", failure: suite.firstAttempt }]);
    assert.ok(messages.some((line) => line.startsWith("RETRY   security UI regression")));
    assert.ok(messages.some((line) => line.startsWith("  FLAKY   security UI regression — failed once, passed on retry: AssertionError")));
    assert.ok(messages.some((line) => line === "::warning title=Flaky browser suite: security UI regression::Failed once, then passed on retry. First failure: AssertionError [ERR_ASSERTION]: the unlock button is focused"));
    assert.ok(!messages.some((line) => /^PASS\s+E —/.test(line)), "the stage is never shown as PASS");
    assert.match(await readFile(summary, "utf8"), /\| security UI regression \| AssertionError \[ERR_ASSERTION\]: the unlock button is focused \|/);
    assert.match(await readFile(join(diagnostics, "security-ui-regression-attempt1.log"), "utf8"), /unlock button is focused/);
    const retried = calls.filter(({ script }) => script === "security-ui-regression.mjs");
    assert.deepEqual(retried.map(({ attempt }) => attempt), [1, 2]);
    assert.deepEqual(retried.map(({ diagnostics: dir }) => dir), [join(diagnostics, "attempt1"), join(diagnostics, "attempt2")], "each attempt saves its screenshots apart");
  } finally {
    await rm(diagnostics, { recursive: true, force: true });
  }
});

test("a browser suite that fails twice FAILs the gate with the second failure (#328)", async () => {
  const { execute, calls } = scriptedExecute((script, attempt) => script === "browser-regression.mjs"
    ? { code: 1, stdout: "", stderr: `Error: Timed out waiting for browser state (attempt ${attempt})\n` }
    : { code: 0, stdout: "", stderr: "" });
  const result = await runVerification({ browser: true, browserExecutable: process.execPath, execute, nodeVersion: "24.16.0", output: () => {}, env: { ...process.env, GITHUB_ACTIONS: "false" } });
  const browser = result.stages.find(({ name }) => name.startsWith("E —"));
  assert.equal(result.code, 1);
  assert.equal(browser.results[0].status, "FAIL");
  assert.equal(browser.results[0].error, "Error: Timed out waiting for browser state (attempt 2)");
  assert.equal(browser.results[0].firstAttempt, "Error: Timed out waiting for browser state (attempt 1)");
  assert.deepEqual(result.flaky, []);
  assert.equal(calls.length, 2, "no third attempt, and later suites don't run");
});

test("a passing browser suite runs once (#328)", async () => {
  const { execute, calls } = scriptedExecute(() => ({ code: 0, stdout: "", stderr: "" }));
  const result = await runVerification({ browser: true, browserExecutable: process.execPath, execute, nodeVersion: "24.16.0", output: () => {} });
  assert.equal(result.code, 0);
  assert.equal(calls.length, 7);
  assert.ok(calls.every(({ attempt }) => attempt === 1));
});

test("the first failing line names the assertion, error or timeout", () => {
  assert.equal(firstFailingLine("PASS a\nPASS b\nAssertionError [ERR_ASSERTION]: x\n  at y"), "AssertionError [ERR_ASSERTION]: x");
  assert.equal(firstFailingLine("starting\nError: Timed out waiting\n"), "Error: Timed out waiting");
  assert.equal(firstFailingLine("one\n\nlast line\n"), "last line");
  assert.equal(firstFailingLine(""), "no output");
});

test("the command line reads --browser, --browser-only and --suite (#329)", () => {
  assert.deepEqual(parseArguments([]), { browser: false, browserExecutable: undefined, browserOnly: false, suites: [] });
  assert.deepEqual(parseArguments(["--browser", "/usr/bin/chrome"]), { browser: true, browserExecutable: "/usr/bin/chrome", browserOnly: false, suites: [] });
  assert.deepEqual(parseArguments(["--browser", "--suite", "passkey-regression"]), { browser: true, browserExecutable: undefined, browserOnly: false, suites: ["passkey-regression"] });
  assert.deepEqual(parseArguments(["--browser-only", "--browser", "edge.exe", "--suite", "browser regression", "--suite", "security-ui-regression.mjs"]),
    { browser: true, browserExecutable: "edge.exe", browserOnly: true, suites: ["browser regression", "security-ui-regression.mjs"] });
  assert.match(parseArguments(["--suite", "passkey-regression"]).error, /needs --browser/);
  assert.match(parseArguments(["--browser", "--suite", "nope"]).error, /Unknown suite "nope"/);
  assert.match(parseArguments(["--browser", "--suite"]).error, /needs a suite name/);
  assert.match(parseArguments(["--fast"]).error, /Unknown argument --fast/);
});

test("--browser-only runs just the chosen suites, with retry, and nothing else (#329)", async () => {
  const { execute, calls } = scriptedExecute((script, attempt) => ({ code: script === "passkey-regression.mjs" && attempt === 1 ? 1 : 0, stdout: "", stderr: "Error: first try" }));
  const others = [];
  const record = async (command, args, options) => {
    if (!(command === process.execPath && args[0]?.endsWith("regression.mjs"))) others.push(command);
    return execute(command, args, options);
  };
  const result = await runVerification({ browser: true, browserOnly: true, suites: ["passkey-regression"], browserExecutable: process.execPath, execute: record, nodeVersion: "24.16.0", output: () => {} });
  assert.deepEqual(others, [], "no environment, static, unit or WASM commands");
  assert.deepEqual(result.stages.map(({ name }) => name), ["E — Browser verification"]);
  assert.deepEqual(calls.map(({ script, attempt }) => [script, attempt]), [["passkey-regression.mjs", 1], ["passkey-regression.mjs", 2]]);
  assert.equal(result.stages[0].results[0].status, "FLAKY");
  assert.equal(result.code, 0);
});

test("--browser-only without an engine fails with how to get one (#329)", async () => {
  const { execute, calls } = scriptedExecute(() => ({ code: 0, stdout: "", stderr: "" }));
  const result = await runVerification({ browser: true, browserOnly: true, browserExecutable: process.execPath, execute, nodeVersion: "24.16.0", output: () => {}, engineReady: async () => false });
  assert.equal(result.code, 1);
  assert.equal(calls.length, 0);
  assert.match(result.stages[0].results[0].label, /kin_engine\.wasm is missing.*fetch-wasm/);
});

test("with no browser named, an installed one is found and used (#331)", async () => {
  const { execute, calls } = scriptedExecute(() => ({ code: 0, stdout: "", stderr: "" }));
  const messages = [];
  const seen = [];
  const result = await runVerification({
    browser: true, browserOnly: true, suites: ["passkey-regression"], env: { ...process.env, KIN_BROWSER: "" },
    execute: async (command, args, options) => { if (args[0]?.endsWith("regression.mjs")) seen.push(args[1]); return execute(command, args, options); },
    locateBrowser: async () => ({ executable: process.execPath, source: "found" }),
    nodeVersion: "24.16.0", output: (line) => messages.push(line),
  });
  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(seen, [process.execPath], "the found browser is the one the suite drives");
  assert.ok(messages.some((line) => line.startsWith(`Using ${process.execPath}`)));
});

test("a missing browser engine is built and installed before the tests that load it (#331)", async () => {
  const { execute } = scriptedExecute(() => ({ code: 0, stdout: "", stderr: "" }));
  const builds = [];
  const installed = [];
  const result = await runVerification({
    execute: async (command, args, options) => { if (command === "cargo" && args[0] === "build") builds.push(args.join(" ")); return execute(command, args, options); },
    engineReady: async () => false,
    installEngine: async (from, to) => { installed.push([from, to]); },
    nodeVersion: "24.16.0", output: () => {},
  });
  const environment = result.stages.find(({ name }) => name.startsWith("A —"));
  const engine = environment.results.find(({ label }) => label.startsWith("Browser engine"));
  assert.equal(engine.status, "PASS");
  assert.equal(engine.artifact, "built for this run (it was missing)");
  assert.equal(installed.length, 1);
  assert.match(installed[0][0], /kin\.wasm$/);
  assert.match(installed[0][1], /kin_engine\.wasm$/);
  assert.ok(builds[0].includes("--target wasm32-unknown-unknown --release"));
  assert.ok(result.stages.find(({ name }) => name.startsWith("C —")).status === "PASS", "then the tests run");
});

test("a failed engine build stops the run before the tests (#331)", async () => {
  const { execute } = scriptedExecute(() => ({ code: 0, stdout: "", stderr: "" }));
  const result = await runVerification({
    execute: async (command, args, options) => command === "cargo" && args[0] === "build" ? { code: 101, stdout: "", stderr: "error: linking failed" } : execute(command, args, options),
    engineReady: async () => false, installEngine: async () => { throw new Error("must not install"); },
    nodeVersion: "24.16.0", output: () => {},
  });
  assert.equal(result.code, 1);
  assert.equal(result.stages.find(({ name }) => name.startsWith("A —")).status, "FAIL");
  assert.equal(result.stages.find(({ name }) => name.startsWith("C —")).status, "NOT RUN");
});
