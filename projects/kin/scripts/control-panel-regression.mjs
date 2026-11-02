// The home server's setup page in a real browser (#719, #720, #721): a Kin
// server in home mode with its control panel, the real connection relay in
// test mode and the in-process ACME server (server/home/home-test-utils.mjs).
// The browser opens the address the launcher prints, enters the printed
// code, checks and chooses a name, agrees to the terms and connects; the
// runner restarts Kin on the same port as the launcher would; the page
// follows the certificate to "Kin is ready" and the status page. Then it
// backs up now and restores that backup, each confirmed with the printed
// code, through a second restart. Along the way it checks labels, focus,
// live regions and 320 px reflow.
//
//   node scripts/control-panel-regression.mjs <browser executable>
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { applyRegressionDefaults, captureFailure } from "./cdp-page.mjs";
import { setViewport } from "./cdp-viewport.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startHomeHarness } from "../server/home/home-test-utils.mjs";

const POLL_MS = 50;
const STEP_TIMEOUT_MS = 30_000;

/** Waits until `expression` is truthy in the page; returns its value. */
async function waitInPage(client, expression, what, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      last = await client.evaluate(expression);
      if (last) return last;
    } catch (error) {
      // A navigation or reload can drop the context; keep waiting.
      last = error.message;
    }
    if (Date.now() > deadline) {
      const page = await client.evaluate("document.body?.innerText?.slice(0, 2000) ?? ''").catch(() => "");
      throw new Error(`Timed out waiting for ${what}; last: ${JSON.stringify(last)}; page: ${page}`);
    }
    await delay(POLL_MS);
  }
}

/** Accessibility checks the panel must pass on every screen. */
const A11Y_CHECKS = `(() => {
  const problems = [];
  if (document.querySelectorAll("h1").length !== 1) problems.push("one h1");
  for (const control of document.querySelectorAll("input:not([type=hidden]), select, textarea")) {
    if (control.closest("[hidden]")) continue;
    if (!control.labels?.length && !control.getAttribute("aria-label") && !control.getAttribute("aria-labelledby")) problems.push("unlabelled " + (control.id || control.name || control.type));
  }
  for (const button of document.querySelectorAll("button, a[href]")) {
    if (!(button.textContent.trim() || button.getAttribute("aria-label"))) problems.push("nameless " + button.outerHTML.slice(0, 80));
    const box = button.getBoundingClientRect();
    if (button.matches("button") && box.height && box.height < 40) problems.push("small target " + button.textContent.trim());
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) problems.push("horizontal scroll at " + innerWidth + "px: " + document.documentElement.scrollWidth);
  return problems;
})()`;

export async function controlPanelRegressions(client, harness, first) {
  let checks = 0;
  const check = async (label) => {
    for (const width of [320, 1024]) {
      await setViewport(client, { width, height: 720, deviceScaleFactor: 1, mobile: width < 600 });
      const problems = await client.evaluate(A11Y_CHECKS);
      assert.deepEqual(problems, [], `${label} at ${width}px`);
      checks += 1;
    }
  };
  // The address the launcher prints leads to the panel.
  const port = first.port;
  await client.send("Page.navigate", { url: `http://localhost:${port}/` });
  await waitInPage(client, `location.pathname === "/control/" && document.querySelector("kin-control-sign-in h2")?.textContent === "Enter the setup code"`, "the setup code screen");
  await check("the code screen");

  // A wrong code is announced; the printed one opens setup.
  const printed = first.printed.at(-1).code;
  const wrong = printed.startsWith("2") ? `3${printed.slice(1)}` : `2${printed.slice(1)}`;
  await client.evaluate(`(() => { const input = document.querySelector("#control-code"); input.value = ${JSON.stringify(wrong)}; input.form.requestSubmit(); })()`);
  await waitInPage(client, `document.querySelector("kin-control-sign-in .control-message[role=alert]")?.textContent.includes("isn't right")`, "the wrong-code alert");
  assert.equal(await client.evaluate(`document.querySelector("#control-code").getAttribute("aria-invalid")`), "true");
  await client.evaluate(`(() => { const input = document.querySelector("#control-code"); input.value = ${JSON.stringify(printed.toLowerCase())}; input.form.requestSubmit(); })()`);
  await waitInPage(client, `document.querySelector("kin-control-setup h2")?.textContent === "Choose this home server's name"`, "the name step");
  await check("the name step");
  checks += 2;

  // The live check through the relay, then choosing.
  await client.evaluate(`(() => { const input = document.querySelector("#control-name"); input.focus(); input.value = "fern"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await waitInPage(client, `document.querySelector(".control-availability")?.textContent === "fern.home.test: Available."`, "the availability check");
  assert.equal(await client.evaluate(`document.querySelector(".control-availability").getAttribute("role")`), "status");
  await client.evaluate(`document.querySelector("#control-name").form.requestSubmit()`);
  await waitInPage(client, `document.querySelector("kin-control-setup h2")?.textContent === "Agree to Let's Encrypt's terms"`, "the terms step");
  await waitInPage(client, `document.activeElement?.id === "control-step-title"`, "focus on the new step's heading");
  await waitInPage(client, `document.querySelector("kin-control-setup a[target=_blank]")?.href.endsWith("/terms")`, "the CA's terms link");
  await check("the terms step");
  checks += 3;

  // Submitting without agreeing is refused in place.
  await client.evaluate(`document.querySelector("#control-terms").form.requestSubmit()`);
  await waitInPage(client, `document.querySelector("kin-control-setup .control-message[role=alert]")?.textContent.includes("agreement")`, "the agreement alert");
  await client.evaluate(`(() => { const box = document.querySelector("#control-terms"); box.checked = true; box.form.requestSubmit(); })()`);
  await waitInPage(client, `document.querySelector("kin-control-setup h2")?.textContent === "Connect"`, "the connect step");
  await check("the connect step");
  checks += 2;

  // Connect: Kin writes its settings and asks for a restart; start it
  // again on the same port, as the launcher does.
  await client.evaluate(`[...document.querySelectorAll("kin-control-setup button")].find((button) => button.textContent === "Connect").click()`);
  assert.equal(await first.restarted, "setup");
  await first.stop();
  const second = await harness.boot(port);
  await waitInPage(client, `document.querySelector("#control-ready-title")?.textContent === "Kin is ready"`, "Kin is ready", 60_000);
  assert.equal(await client.evaluate(`document.querySelector(".control-ready a.primary-action").href`), "https://fern.home.test/");
  const sections = await client.evaluate(`[...document.querySelectorAll("kin-control-status section[data-section]")].map((section) => section.dataset.section).join(",")`);
  assert.equal(sections, "relay,name,certificate,backups,storage,counts,updates");
  assert.equal(await client.evaluate(`document.querySelector(".control-headline").textContent`), "Everything is working.");
  await check("the status page");
  checks += 4;

  // Moving a household here (#739): a move code, printed on this computer.
  await client.evaluate(`[...document.querySelectorAll("kin-control-move button")].find((button) => button.textContent === "Get a move code").click()`);
  await waitInPage(client, `document.querySelector("kin-control-move .control-message")?.textContent.includes("printed a move code")`, "the move code");
  assert.equal(second.printed.at(-1)?.purpose, "move");
  checks += 1;

  // Backups (#721): each change asks for the code Kin prints.
  const confirmWith = async (instance) => {
    await waitInPage(client, `Boolean(document.querySelector("kin-control-settings .control-confirm input"))`, "the confirmation form");
    const code = instance.printed.findLast((event) => event.purpose === "confirm");
    assert.ok(code, "a confirmation code was printed");
    await client.evaluate(`(() => { const input = document.querySelector("kin-control-settings .control-confirm input"); input.value = ${JSON.stringify(code.code)}; input.form.requestSubmit(); })()`);
  };
  await client.evaluate(`document.querySelector('[data-setting="backup-now"] form').requestSubmit()`);
  await confirmWith(second);
  await waitInPage(client, `document.querySelector("kin-control-settings .control-message")?.textContent.startsWith("Backup made")`, "the backup");
  await waitInPage(client, `document.querySelectorAll("#control-setting-restore option").length === 1`, "the backup offered for restore");
  await check("the backups");
  checks += 2;
  await client.evaluate(`document.querySelector('[data-setting="restore"] form').requestSubmit()`);
  await confirmWith(second);
  assert.equal(await second.restarted, "restore");
  await second.stop();
  const third = await harness.boot(port);
  await waitInPage(client, `document.querySelector('[data-section="backups"] [data-restore="restored"]')?.textContent.includes("was restored")`, "the restored backup", 60_000);
  await check("after the restore");
  checks += 2;
  return { checks, second: third };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = process.argv[2];
  assert.ok(executable, "Usage: node scripts/control-panel-regression.mjs <browser executable>");
  const profile = await mkdtemp(join(tmpdir(), "kin-control-"));
  const harness = await startHomeHarness();
  const first = await harness.boot();
  const browser = spawn(executable, [
    "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run", "--no-default-browser-check",
    "--edge-skip-compat-layer-relaunch", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], BROWSER_STDIO);
  let socket;
  try {
    const devtools = await waitForDevTools(browser, profile);
    const target = await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolveOpen, reject) => { socket.onopen = resolveOpen; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) return;
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(JSON.stringify(message.error)));
      else task.resolve(message.result);
    };
    const send = (method, params) => new Promise((resolveSend, reject) => {
      const next = ++id;
      pending.set(next, { resolve: resolveSend, reject });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
    const client = {
      send,
      evaluate: async (expression) => {
        const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      },
    };
    await applyRegressionDefaults(send);
    const { checks } = await controlPanelRegressions(client, harness, first);
    console.log(`PASS ${checks} control panel checks: code, live name check, terms, connect, restart, certificate, status, move code, backup, restore`);
  } catch (error) {
    await captureFailure("control panel regression");
    throw error;
  } finally {
    if (socket) {
      const closed = new Promise((resolveClose) => socket.addEventListener("close", resolveClose, { once: true }));
      socket.close();
      await Promise.race([closed, delay(1_000)]);
    }
    if (process.platform === "win32" && browser.pid) {
      const killer = spawn("powershell.exe", ["-NoProfile", "-Command",
        "for ($attempt = 0; $attempt -lt 10; $attempt++) { $targets = Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" | Where-Object { $_.CommandLine -like \"*$env:KIN_TEST_PROFILE*\" }; if (-not $targets) { break }; foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 100 }"],
      { windowsHide: true, stdio: "ignore", env: { ...process.env, KIN_TEST_PROFILE: profile } });
      await once(killer, "exit");
    } else browser.kill();
    if (browser.exitCode === null) await Promise.race([once(browser, "exit"), delay(2_000)]);
    browser.unref();
    await harness.close();
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), "Refuse cleanup outside the test-profile directory");
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((error) => {
      if (error.code !== "EBUSY") throw error;
      console.warn("Temporary browser profile remained busy; the OS may remove it later.");
    });
  }
  process.exit(0);
}
