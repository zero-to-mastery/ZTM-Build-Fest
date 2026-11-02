// The control panel's page (web/control/, #718–#722) without a browser:
// plain words for every code the home server can send, the API client's
// two ways in, and each component's rendering and actions on a small DOM
// stand-in (test-dom.mjs). scripts/control-panel-regression.mjs drives
// the real page in a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { ACME_ERROR_CODES } from "../../server/acme/client.mjs";
import { BACKUP_COPY_ERROR_CODES, BACKUP_COPY_STATES, BACKUP_ERROR_CODES, BACKUP_STATES } from "../../server/home/backups.mjs";
import { DOMAIN_PROBLEMS } from "../../server/home/domain-records.mjs";
import { TUNNEL_ERRORS } from "../../server/home/tunnel-client.mjs";
import { UPDATE_ERROR_CODES } from "../../server/home/updater.mjs";
import { installDom, settle } from "./test-dom.mjs";

const document = installDom();
const { explain, explainCertificateState, explainTunnelState, isExplained, KNOWN } = await import("./explain.js");
const { countOf, displayCode, formatBytes } = await import("./format.js");
const { ControlApi, ControlApiError } = await import("./control-api.js");
const { KinControlPanel } = await import("./kin-control-panel.js");

const TIMEOUT = { timeout: 30_000 };

test("every code the home server sends has plain words of its own", TIMEOUT, () => {
  const codes = [
    ...TUNNEL_ERRORS, ...ACME_ERROR_CODES, ...DOMAIN_PROBLEMS, ...BACKUP_ERROR_CODES, "control-backup-hour-invalid", ...BACKUP_COPY_ERROR_CODES, "control-backup-copy-invalid", "backup-copy-not-private", ...UPDATE_ERROR_CODES, "control-update-unknown", "control-update-manual", "control-update-busy", "control-move-not-ready", "control-move-limit",
    "tunnel-caa-name-taken", "tunnel-caa-name-not-allowed", "tunnel-caa-name-limit", "tunnel-caa-name-unknown", "tunnel-caa-suspended", "tunnel-caa-refused",
    "tunnel-not-ready", "tunnel-timeout", "tunnel-lost", "tunnel-stopped",
    "setup-name-empty", "setup-name-invalid", "setup-name-length", "setup-name-taken", "setup-name-not-allowed",
    "setup-name-limit", "setup-name-first", "setup-name-from-environment", "setup-finished", "setup-restarting", "setup-terms-required",
    "setup-records-not-needed", "setup-records-not-ready", "setup-not-connected",
    "control-code-wrong", "control-code-expired", "control-code-locked", "control-code-none", "control-code-malformed", "control-code-too-soon",
    "control-confirm-wrong", "control-confirm-expired", "control-confirm-locked", "control-confirm-none", "control-sign-in-required",
    "control-loopback-only", "control-origin-rejected", "control-limit-invalid", "control-limit-from-environment", "control-change-unknown",
    "control-bad-request", "control-failed", "control-not-found", "household_admin_required", "home_setup_required", "network",
  ];
  const missing = codes.filter((code) => !isExplained(code));
  assert.deepEqual(missing, [], "codes without their own sentence");
  for (const code of codes) assert.doesNotMatch(explain(code), /^[a-z-]+$/, `${code} reads as words`);
  for (const state of ["connected", "connecting", "waiting", "stopped"]) assert.ok(KNOWN.tunnelStates.includes(state), state);
  for (const state of ["none", "valid", "renewing", "valid-retrying", "failed", "expired"]) assert.ok(KNOWN.certificateStates.includes(state), state);
  assert.deepEqual([...KNOWN.backupStates].sort(), [...BACKUP_STATES].sort(), "every backups state has words");
  assert.deepEqual([...KNOWN.backupCopyStates].sort(), [...BACKUP_COPY_STATES].sort(), "every state of the second copy has words");
  assert.match(explain("acme-something-new"), /Let's Encrypt/, "an unknown code still gets its family's sentence");
  assert.match(explain("replaced"), /Only one copy of a home server can run at a time/);
  assert.match(explainTunnelState("connected"), /Phones can reach/);
  assert.match(explainCertificateState("valid-retrying"), /tries again/);
});

test("formatting: sizes, counts and codes", TIMEOUT, () => {
  assert.equal(formatBytes(512, "en"), "512 bytes");
  assert.equal(formatBytes(1_536_000, "en"), "1.5 MB");
  assert.equal(formatBytes(null, "en"), "Not known");
  assert.equal(countOf(1, "household", "households"), "1 household");
  assert.equal(countOf(3, "device", "devices"), "3 devices");
  assert.equal(displayCode("abcde23456"), "ABCDE-23456");
});

/** A fetch stand-in answering from `routes` ("METHOD path" → [status, body]). */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (path, init) => {
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const answer = routes[`${init.method} ${path}`];
    if (!answer) return { ok: false, status: 404, json: async () => ({ error: "control-not-found" }) };
    const [status, body] = typeof answer === "function" ? answer(init) : answer;
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

test("the API client: the loopback panel's API here, the app's API with a fresh confirmation through the household's address", TIMEOUT, async () => {
  const local = fakeFetch({
    "GET /control/api/state": [200, { signedIn: false }],
    "POST /control/api/sign-in": [401, { error: "control-code-wrong", message: "no", attemptsLeft: 3 }],
    "POST /control/api/change": [200, { kind: "households-limit", maxHouseholds: 2 }],
  });
  const loopback = new ControlApi({ loopback: true, fetchImpl: local.fetchImpl });
  assert.deepEqual(await loopback.state(), { remote: false, signedIn: false });
  await assert.rejects(loopback.post("sign-in", { code: "x" }), (error) => error instanceof ControlApiError && error.code === "control-code-wrong" && error.attemptsLeft === 3);
  assert.equal(local.calls[1].headers["Content-Type"], "application/json");
  await loopback.change({ kind: "households-limit", maxHouseholds: 2 }, { code: "ABCDE-23456" });
  assert.deepEqual(local.calls.at(-1).body, { change: { kind: "households-limit", maxHouseholds: 2 }, code: "ABCDE-23456" });

  const confirmations = [];
  const remoteFetch = fakeFetch({
    "GET /api/control/status": [200, { version: "1.6.0" }],
    "POST /api/control/change/options": [200, { flow: "flow-1", publicKey: { challenge: "c" } }],
    "POST /api/control/change/finish": [200, { kind: "households-limit", maxHouseholds: 2 }],
  });
  const remote = new ControlApi({ loopback: false, fetchImpl: remoteFetch.fetchImpl, confirm: async (started) => { confirmations.push(started.flow); return { credential: { id: "passkey" } }; } });
  assert.deepEqual(await remote.state(), { remote: true, signedIn: true, admin: true, status: { version: "1.6.0" } });
  await assert.rejects(remote.post("sign-in", {}), (error) => error.code === "control-loopback-only");
  await remote.change({ kind: "households-limit", maxHouseholds: 2 });
  assert.deepEqual(confirmations, ["flow-1"]);
  assert.deepEqual(remoteFetch.calls.at(-1).body, { flow: "flow-1", credential: { id: "passkey" } });
  const signedOut = new ControlApi({ loopback: false, fetchImpl: fakeFetch({ "GET /api/control/status": [401, { error: "authentication_required" }] }).fetchImpl });
  assert.deepEqual(await signedOut.state(), { remote: true, signedIn: false, admin: false });
  const notAdmin = new ControlApi({ loopback: false, fetchImpl: fakeFetch({ "GET /api/control/status": [403, { error: "household_admin_required" }] }).fetchImpl });
  assert.deepEqual(await notAdmin.state(), { remote: true, signedIn: true, admin: false });
  const down = new ControlApi({ loopback: true, fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(down.state(), (error) => error.code === "network");
});

const STATUS = Object.freeze({
  version: "1.6.0", checkedAt: "2026-10-22T12:00:00.000Z", name: "fern.home.kin.journeytocode.io", freeName: true,
  origin: "https://fern.home.kin.journeytocode.io", setupComplete: true,
  relay: { state: "connected", connected: true, since: "2026-10-22T11:00:00.000Z", relay: "relay.kin.journeytocode.io", names: ["fern.home.kin.journeytocode.io"], routed: true, nameError: null, lastError: null, nextAttemptAt: null },
  certificate: { state: "valid", notAfter: "2027-01-20T00:00:00.000Z", daysLeft: 89, issuer: "CN=Test CA", renewAt: "2026-12-21T00:00:00.000Z", expiringSoon: false, nextAttemptAt: null, lastError: null, lastRenewedAt: null, transparency: { state: "ok", checkedAt: null, unexpected: 0, error: null } },
  storage: { databaseBytes: 2_400_000, freeBytes: 52_000_000_000 },
  counts: { households: 1, devices: 3 },
  limits: { maxHouseholds: 1, allowNew: true, fromEnvironment: false, highest: 10 },
  backups: {
    state: "ok", hour: 3, kept: 14, lastBackupAt: "2026-10-22T03:00:00.000Z", due: false, nextBackupAt: "2026-10-23T03:00:00.000Z",
    lastError: null, totalBytes: 4_800_000, lastRestore: null,
    backups: [
      { id: "kin-20261022T030000Z", createdAt: "2026-10-22T03:00:00.000Z", reason: "scheduled", databaseBytes: 2_400_000, home: true },
      { id: "kin-20261021T090000Z", createdAt: "2026-10-21T09:00:00.000Z", reason: "manual", databaseBytes: 2_400_000, home: true },
    ],
  },
  updates: { state: "up-to-date", stage: null, current: "1.6.0", checkedAt: "2026-10-22T11:00:00.000Z", available: null, autoUpdate: true, cannotInstall: null, lastError: null, lastUpdate: null },
});
const AVAILABLE = Object.freeze({ version: "1.6.1", kind: "patch", releasedAt: "2026-11-02T10:00:00.000Z", page: "https://github.com/mnichols08/ZTM-Build-Fest/releases/tag/kin-v1.6.1", blocked: null, install: "automatic" });

test("the status page: every section, plain-words states, backups, and the seam for updates", TIMEOUT, () => {
  const element = document.createElement("kin-control-status");
  element.status = STATUS;
  const sections = element.querySelectorAll("section").map((section) => section.dataset.section);
  assert.deepEqual(sections, ["relay", "name", "certificate", "backups", "storage", "counts", "updates"]);
  assert.equal(element.querySelector(".control-headline").textContent, "Everything is working.");
  const text = element.textContent;
  for (const expected of ["Connected to the relay", "relay.kin.journeytocode.io", "89 days left", "2.4 MB", "52 GB", "1 household", "3 devices", "1.6.0", "Counts only"])
    assert.ok(text.includes(expected), expected);
  const backups = element.querySelector('[data-section="backups"]');
  assert.equal(backups.dataset.tone, "good");
  for (const expected of ["every day by itself", "Last backup", "Next backup", "2 backups of the newest 14, 4.8 MB in all", "as private as this computer"])
    assert.ok(backups.textContent.includes(expected), expected);
  assert.match(element.querySelector('[data-section="updates"]').textContent, /This is the newest version/);
  for (const section of element.querySelectorAll("section")) assert.ok(section.getAttribute("aria-labelledby"), "each section is named by its heading");

  element.status = {
    ...STATUS,
    relay: { ...STATUS.relay, state: "waiting", connected: false, routed: false, lastError: { code: "replaced", at: "2026-10-22T11:30:00.000Z" }, nextAttemptAt: "2026-10-22T11:35:00.000Z" },
    certificate: { ...STATUS.certificate, state: "valid-retrying", lastError: { code: "acme-rate-limited", at: "2026-10-22T11:00:00.000Z" } },
    backups: { state: "ok", lastBackupAt: "2026-10-22T03:00:00.000Z" },
  };
  assert.equal(element.querySelector(".control-headline").dataset.tone, "attention");
  assert.match(element.querySelector('[data-code="replaced"]').textContent, /Only one copy/);
  assert.match(element.querySelector('[data-code="acme-rate-limited"]').textContent, /limit/);
  assert.match(element.querySelector('[data-section="backups"]').textContent, /Last backup/, "a section with fewer fields still renders");
  element.status = {
    ...STATUS,
    backups: { ...STATUS.backups, state: "failed", lastError: { code: "backup-disk-full", at: "2026-10-23T03:00:00.000Z" }, nextBackupAt: "2026-10-23T04:00:00.000Z",
      lastRestore: { outcome: "failed", at: "2026-10-22T12:00:00.000Z", backupCreatedAt: "2026-10-21T09:00:00.000Z", code: "restore-newer-household", homeRestored: false } },
  };
  const failed = element.querySelector('[data-section="backups"]');
  assert.equal(failed.dataset.tone, "attention");
  assert.match(failed.querySelector('[data-code="backup-disk-full"]').textContent, /disk is full/);
  assert.match(failed.querySelector('[data-restore="failed"]').textContent, /didn't happen, and Kin kept the data it had\. The backup is older than a household/);
  element.status = { ...STATUS, backups: { ...STATUS.backups, lastRestore: { outcome: "restored", at: "2026-10-22T12:00:00.000Z", backupCreatedAt: "2026-10-21T09:00:00.000Z", code: null, homeRestored: true } } };
  assert.match(element.querySelector('[data-restore="restored"]').textContent, /was restored.*same home server/);
  element.status = { ...STATUS, certificate: { ...STATUS.certificate, transparency: { state: "alert", unexpected: 1 } } };
  assert.equal(element.querySelector(".control-headline").dataset.tone, "alert");
  assert.equal(element.querySelector('[data-section="certificate"]').dataset.tone, "alert");
});

function fakeApi(answers = {}) {
  const calls = [];
  return {
    calls,
    loopback: true,
    async post(route, body) {
      calls.push([route, body]);
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(body) : answer ?? {};
    },
    async change(change, options) { calls.push(["change", change, options]); return answers.change ?? {}; },
  };
}

const VIEW = { step: "name", zone: "home.kin.journeytocode.io", relay: "relay.kin.journeytocode.io", name: null, freeName: null, configuredName: null, termsAgreed: false, nameFromEnvironment: false, expectedRecords: null, records: null, origin: null, progress: null };

test("setup: the name step checks as you type and chooses; errors are spoken in plain words", TIMEOUT, async () => {
  const api = fakeApi({
    "setup/check-name": (body) => ({ name: body.name, freeName: true, answer: body.name.startsWith("taken") ? "taken" : "available" }),
    "setup/name": new ControlApiError("setup-name-taken", "taken", 409),
  });
  const setup = document.createElement("kin-control-setup");
  setup.api = api;
  document.body.append(setup);
  setup.view = VIEW;
  assert.equal(setup.querySelector("h2").textContent, "Choose this home server's name");
  assert.equal(setup.querySelector('[aria-current="step"]').textContent, "Name");
  assert.equal(setup.querySelectorAll(".control-steps li").length, 5, "no DNS step for a free name");
  const input = setup.querySelector("#control-name");
  assert.ok(setup.querySelector('label[for="control-name"]'), "the field has a label");
  assert.equal(setup.querySelector("#control-name-suffix").textContent, ".home.kin.journeytocode.io");
  assert.match(input.getAttribute("aria-describedby"), /control-name-suffix/);
  input.value = "Taken";
  input.dispatchEvent({ type: "input" });
  await settle(700);
  assert.deepEqual(api.calls[0], ["setup/check-name", { name: "taken.home.kin.journeytocode.io" }]);
  assert.match(setup.querySelector(".control-availability").textContent, /Taken/);
  assert.equal(setup.querySelector(".control-availability").getAttribute("role"), "status");
  setup.querySelector("form").submit();
  await settle();
  assert.equal(setup.querySelector(".control-message").getAttribute("role"), "alert");
  assert.match(setup.querySelector(".control-message").textContent, /belongs to another home server/);
  // Choosing "our own domain" adds the DNS step and asks for the full name.
  const own = setup.querySelectorAll("input").find((input) => input.type === "radio" && input.value === "own");
  own.checked = true;
  own.dispatchEvent({ type: "change" });
  assert.equal(setup.querySelector('label[for="control-name"]').textContent, "Your domain");
  setup.remove();
});

test("setup: a chosen name moves on; the view the server answers is passed up", TIMEOUT, async () => {
  const next = { ...VIEW, step: "terms", name: "fern.home.kin.journeytocode.io", freeName: true };
  const api = fakeApi({ "setup/name": next, "setup/terms-url": { url: "https://ca.test/terms.pdf" } });
  const setup = document.createElement("kin-control-setup");
  setup.api = api;
  const host = document.createElement("div");
  document.body.append(host);
  host.append(setup);
  const views = [];
  host.addEventListener("view", (event) => { views.push(event.detail); setup.view = event.detail; });
  setup.view = VIEW;
  setup.querySelector("#control-name").value = "fern";
  setup.querySelector("form").submit();
  await settle();
  assert.deepEqual(views, [next]);
  assert.equal(setup.querySelector("h2").textContent, "Agree to Let's Encrypt's terms");
  assert.equal(document.activeElement, setup.querySelector("#control-step-title"), "focus moves to the new step");
  await settle();
  const link = setup.querySelector("a");
  assert.equal(link.href, "https://ca.test/terms.pdf", "the CA's own terms");
  assert.equal(link.rel, "noopener noreferrer");
  // Not ticked: refused here, nothing sent.
  setup.querySelector("form").submit();
  assert.match(setup.querySelector(".control-message").textContent, /agreement/);
  assert.ok(!api.calls.some(([route]) => route === "setup/terms"));
  setup.querySelector("#control-terms").checked = true;
  setup.querySelector("form").submit();
  await settle();
  assert.deepEqual(api.calls.at(-1), ["setup/terms", { agreed: true }]);
  host.remove();
});

test("setup: own-domain records, progress with a retry, and done", TIMEOUT, async () => {
  const api = fakeApi({ "setup/records": { ...VIEW, step: "records" } });
  const setup = document.createElement("kin-control-setup");
  setup.api = api;
  document.body.append(setup);
  const records = [
    { type: "A", name: "kin.smith.family", value: "192.0.2.10" },
    { type: "TXT", name: "_kin-relay.kin.smith.family", value: "abc" },
    { type: "CAA", name: "kin.smith.family", value: '0 issue "letsencrypt.org; accounturi=https://acme.test/a/1; validationmethods=tls-alpn-01"' },
  ];
  setup.view = { ...VIEW, step: "records", name: "kin.smith.family", freeName: false, termsAgreed: true, expectedRecords: records,
    records: { ok: false, records, checks: [{ id: "address", ok: true, problem: null }, { id: "caa", ok: false, problem: "dns-caa-missing" }], checkedAt: "2026-10-22T12:00:00.000Z" } };
  assert.equal(setup.querySelectorAll(".control-steps li").length, 6, "the DNS step is shown for an own domain");
  assert.equal(setup.querySelectorAll("tbody tr").length, 3);
  assert.equal(setup.querySelectorAll('th[scope="col"]').length, 3);
  assert.match(setup.querySelector('[data-ok="false"]').textContent, /CAA record that names this server's Let's Encrypt account/);
  setup.querySelectorAll("button").find((button) => button.textContent === "Check the records").click();
  await settle();
  assert.deepEqual(api.calls.at(-1), ["setup/records", undefined]);

  setup.view = { ...VIEW, step: "certificate", name: "fern.home.kin.journeytocode.io", freeName: true,
    progress: { tunnel: { state: "connected", routed: true, error: null, nameError: null }, certificate: { state: "failed", error: "acme-connection", nextAttemptAt: "2026-10-22T13:00:00.000Z", notAfter: null } } };
  assert.equal(setup.querySelector("h2").textContent, "Getting the certificate");
  assert.equal(setup.querySelector('[data-state="problem"]').textContent.startsWith("Certificate"), true);
  assert.match(setup.querySelector('[data-code="acme-connection"]').textContent, /couldn't connect/);
  setup.querySelectorAll("button").find((button) => button.textContent === "Try again now").click();
  await settle();
  assert.equal(api.calls.at(-1)[0], "setup/retry");

  setup.view = { ...VIEW, step: "done", name: "fern.home.kin.journeytocode.io", freeName: true, origin: "https://fern.home.kin.journeytocode.io",
    progress: { tunnel: { state: "connected", routed: true }, certificate: { state: "valid", notAfter: "2027-01-20T00:00:00.000Z" } } };
  assert.equal(setup.querySelector("h2").textContent, "Kin is ready");
  const open = setup.querySelector("a.control-button");
  assert.equal(open.href, "https://fern.home.kin.journeytocode.io");
  assert.match(setup.textContent, /Create the household there, not here/);
  setup.remove();
});

test("sign-in: a wrong code is announced with the tries left; a new code can be printed", TIMEOUT, async () => {
  const api = fakeApi({
    "sign-in": new ControlApiError("control-code-wrong", "no", 401, { attemptsLeft: 2 }),
    code: { expiresAt: "2026-10-22T13:00:00.000Z" },
  });
  const signIn = document.createElement("kin-control-sign-in");
  signIn.api = api;
  document.body.append(signIn);
  signIn.render();
  assert.equal(signIn.querySelector("h2").textContent, "Enter the setup code");
  const input = signIn.querySelector("#control-code");
  assert.equal(input.autocomplete, "one-time-code");
  assert.ok(signIn.querySelector('label[for="control-code"]'));
  signIn.querySelector("form").submit();
  assert.match(signIn.querySelector(".control-message").textContent, /Type the code first/);
  input.value = "ABCDE-23456";
  signIn.querySelector("form").submit();
  await settle();
  assert.equal(signIn.querySelector(".control-message").getAttribute("role"), "alert");
  assert.match(signIn.querySelector(".control-message").textContent, /isn't right.*2 more tries/);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  signIn.querySelectorAll("button").find((button) => button.textContent === "Print a new code").click();
  await settle();
  assert.match(signIn.querySelector(".control-message").textContent, /printed a new code/);
  signIn.remove();
});

test("settings: on this computer a change asks for a printed confirmation code", TIMEOUT, async () => {
  const api = fakeApi({ "confirm-code": { expiresAt: "2026-10-22T13:00:00.000Z" }, change: { kind: "households-limit", maxHouseholds: 3 } });
  const settings = document.createElement("kin-control-settings");
  settings.api = api;
  document.body.append(settings);
  let changed = 0;
  settings.addEventListener("changed", () => { changed += 1; });
  settings.status = STATUS;
  const select = settings.querySelector("#control-setting-households-limit");
  assert.equal(select.children.length, 10);
  assert.ok(settings.querySelector('label[for="control-setting-households-limit"]'));
  select.value = "3";
  settings.querySelector('[data-setting="households-limit"] form').submit();
  await settle();
  assert.deepEqual(api.calls[0], ["confirm-code", undefined]);
  const confirm = settings.querySelector(".control-confirm");
  assert.ok(confirm, "a confirmation form appears");
  assert.equal(document.activeElement, confirm.querySelector("input"));
  confirm.querySelector("input").value = "ABCDE-23456";
  confirm.submit();
  await settle();
  assert.deepEqual(api.calls.at(-1), ["change", { kind: "households-limit", maxHouseholds: 3 }, { code: "ABCDE-23456" }]);
  assert.equal(changed, 1);
  assert.equal(settings.querySelector(".control-confirm"), null);
  // A limit set in the environment is shown, not offered.
  settings.status = { ...STATUS, limits: { ...STATUS.limits, fromEnvironment: true } };
  assert.equal(settings.querySelector("#control-setting-households-limit"), null);
  assert.match(settings.textContent, /KIN_MAX_HOUSEHOLDS/);
  settings.remove();
});

test("settings, backups: back up now is a button, the time a choice, restore names each backup; each is confirmed", TIMEOUT, async () => {
  const answers = { "confirm-code": { expiresAt: "2026-10-22T13:00:00.000Z" }, change: { kind: "backup-now", backup: { id: "kin-20261022T120000Z", createdAt: "2026-10-22T12:00:00.000Z" } } };
  const api = fakeApi(answers);
  const settings = document.createElement("kin-control-settings");
  settings.api = api;
  document.body.append(settings);
  try {
    settings.status = STATUS;
    const now = settings.querySelector('[data-setting="backup-now"] form');
    assert.equal(now.querySelector("select"), null, "a button alone");
    assert.equal(now.querySelector("button").textContent, "Back up now");
    now.submit();
    await settle();
    const confirm = settings.querySelector(".control-confirm");
    confirm.querySelector("input").value = "ABCDE-23456";
    confirm.submit();
    await settle();
    assert.deepEqual(api.calls.at(-1), ["change", { kind: "backup-now" }, { code: "ABCDE-23456" }]);
    assert.match(settings.querySelector(".control-message").textContent, /^Backup made: /);
    const hour = settings.querySelector("#control-setting-backup-hour");
    assert.equal(hour.children.length, 24);
    assert.equal(hour.children.find((option) => option.selected).value, "3");
    assert.ok(settings.querySelector('label[for="control-setting-backup-hour"]'));
    const restore = settings.querySelector("#control-setting-restore");
    assert.deepEqual(restore.children.map((option) => option.value), ["kin-20261022T030000Z", "kin-20261021T090000Z"]);
    assert.match(restore.children[1].textContent, /made by hand/);
    assert.match(settings.querySelector('[data-setting="restore"]').textContent, /households deleted since then stay deleted/);
    answers.change = { kind: "restore", restoring: { id: "kin-20261021T090000Z" } };
    restore.value = "kin-20261021T090000Z";
    settings.querySelector('[data-setting="restore"] form').submit();
    await settle();
    const again = settings.querySelector(".control-confirm");
    again.querySelector("input").value = "ABCDE-23456";
    again.submit();
    await settle();
    assert.deepEqual(api.calls.at(-1), ["change", { kind: "restore", id: "kin-20261021T090000Z" }, { code: "ABCDE-23456" }]);
    assert.match(settings.querySelector(".control-message").textContent, /starting again to restore/);
    // While Kin restores, nothing is offered.
    settings.status = { ...STATUS, backups: { ...STATUS.backups, state: "restoring" } };
    assert.equal(settings.querySelector("#control-setting-restore"), null);
    assert.match(settings.querySelector('[data-setting="restore"]').textContent, /restoring a backup now/);
  } finally {
    settings.remove();
  }
});

const COPY = Object.freeze({ state: "ok", kept: 14, lastCopyAt: "2026-10-22T03:01:00.000Z", lastCopiedCreatedAt: "2026-10-22T03:00:00.000Z", copies: 2, lastError: null });

test("the status page: the second copy of the backups in a row of its own, and its problem in plain words", TIMEOUT, () => {
  const element = document.createElement("kin-control-status");
  const backups = (copy) => { element.status = { ...STATUS, backups: { ...STATUS.backups, copy } }; return element.querySelector('[data-section="backups"]'); };
  const row = (section) => section.querySelectorAll("dt").find((term) => term.textContent === "Second copy")?.parentNode.querySelector("dd").textContent;
  const off = backups({ ...COPY, state: "off", copies: 0 });
  assert.equal(row(off), "Not set up");
  assert.match(off.querySelector('[data-copy="off"]').textContent, /Choose a second folder/);
  const waiting = backups({ ...COPY, state: "waiting" });
  assert.equal(row(waiting), "Kin is checking the folder");
  assert.match(waiting.querySelector('[data-copy="waiting"]').textContent, /started in a way that doesn't copy backups/, "why it may never change");
  const ok = backups(COPY);
  assert.equal(ok.querySelector("[data-copy]"), null);
  assert.match(row(ok), /^2 copies, the newest from /);
  assert.equal(ok.dataset.tone, "good");
  assert.match(ok.textContent, /any drive they're copied to, as private as this computer/);
  const failed = backups({ ...COPY, state: "failed", lastError: { code: "backup-copy-missing", at: "2026-10-22T12:00:00.000Z" } });
  assert.equal(failed.dataset.tone, "attention");
  assert.match(row(failed), /didn't work/);
  assert.match(failed.querySelector('[data-code="backup-copy-missing"]').textContent, /plug the drive in/);
  assert.equal(ok.querySelector('[data-code="backup-copy-not-private"]'), null);
  const open = backups({ ...COPY, notPrivate: true });
  assert.equal(open.dataset.tone, "attention");
  assert.match(open.querySelector('[data-code="backup-copy-not-private"]').textContent, /couldn't make the copies in the second folder private/);
  assert.equal(backups({ ...COPY, state: "off", notPrivate: true }).querySelector('[data-code="backup-copy-not-private"]'), null, "nothing said once the copy is off");
  assert.equal(row(backups(undefined)), undefined, "an older server without the copy shows no row");
});

test("settings, the second backup folder: typed on this computer, emptied to stop; through the household's address it says where to choose it", TIMEOUT, async () => {
  const answers = { "confirm-code": { expiresAt: "2026-10-22T13:00:00.000Z" }, change: { kind: "backup-copy-folder", folder: "E:\\", checking: true } };
  const api = fakeApi(answers);
  const settings = document.createElement("kin-control-settings");
  settings.api = api;
  document.body.append(settings);
  try {
    settings.status = { ...STATUS, backups: { ...STATUS.backups, copy: { ...COPY, folder: "E:\\Kin" } } };
    const input = settings.querySelector("#control-setting-backup-copy-folder");
    assert.equal(input.value, "E:\\Kin", "the folder chosen, on this computer");
    assert.ok(settings.querySelector('label[for="control-setting-backup-copy-folder"]'));
    const confirmWith = async () => {
      settings.querySelector('[data-setting="backup-copy-folder"] form').submit();
      await settle();
      const confirm = settings.querySelector(".control-confirm");
      confirm.querySelector("input").value = "ABCDE-23456";
      confirm.submit();
      await settle();
    };
    input.value = "  E:\\  ";
    await confirmWith();
    assert.deepEqual(api.calls.at(-1), ["change", { kind: "backup-copy-folder", folder: "E:\\" }, { code: "ABCDE-23456" }]);
    assert.match(settings.querySelector(".control-message").textContent, /copies your backups there within a minute/);
    answers.change = { kind: "backup-copy-folder", folder: null, checking: false };
    settings.querySelector("#control-setting-backup-copy-folder").value = "";
    await confirmWith();
    assert.deepEqual(api.calls.at(-1)[1], { kind: "backup-copy-folder", folder: null }, "empty stops the copies");
    assert.match(settings.querySelector(".control-message").textContent, /Copies already there stay/);
  } finally {
    settings.remove();
  }
  const remote = document.createElement("kin-control-settings");
  remote.api = { ...fakeApi(), loopback: false };
  document.body.append(remote);
  try {
    remote.status = { ...STATUS, backups: { ...STATUS.backups, copy: COPY } };
    assert.equal(remote.querySelector("#control-setting-backup-copy-folder"), null);
    assert.match(remote.querySelector('[data-setting="backup-copy-folder"]').textContent, /Choose this folder on the home server's own computer/);
  } finally {
    remote.remove();
  }
});

test("setting up a new computer: a backup in Kin's folder can be restored before choosing a name", TIMEOUT, async () => {
  const panel = document.createElement("kin-control-panel");
  let state = { remote: false, signedIn: true, configured: false, setup: VIEW, status: { ...STATUS, setupComplete: false, name: null, origin: null, relay: null, certificate: null, backups: { ...STATUS.backups, state: "off" } } };
  panel.api = { loopback: true, state: async () => state, post: async () => ({}) };
  try {
    document.body.append(panel);
    await settle();
    assert.equal(panel.screen(), "setup");
    const moving = panel.querySelector("kin-control-settings");
    assert.ok(moving, "offered on the name step");
    assert.equal(moving.querySelector("h2").textContent, "Moving from another computer?");
    assert.deepEqual(moving.querySelectorAll("[data-setting]").map((section) => section.dataset.setting), ["restore"]);
    // Without a backup, setup alone.
    state = { ...state, status: { ...state.status, backups: { ...state.status.backups, backups: [] } } };
    await panel.refresh();
    assert.equal(panel.querySelector("kin-control-settings"), null);
  } finally {
    panel.disconnectedCallback();
    panel.remove();
  }
});

test("the status page: updates in plain words, from off to a release that was undone", TIMEOUT, () => {
  const element = document.createElement("kin-control-status");
  const updates = (value) => { element.status = { ...STATUS, updates: { ...STATUS.updates, ...value } }; return element.querySelector('[data-section="updates"]'); };
  assert.match(updates({ state: "off" }).textContent, /doesn't check for updates/);
  assert.match(updates({ state: "available", available: AVAILABLE }).textContent, /Kin 1\.6\.1 is available\. Kin installs it by itself tonight, between 02:00 and 05:00/);
  assert.equal(element.querySelector('[data-section="updates"] a').href, AVAILABLE.page);
  assert.match(updates({ state: "available", available: { ...AVAILABLE, version: "2.0.0", kind: "major", install: "admin" } }).textContent, /bigger update, so it waits for you/);
  assert.match(updates({ state: "available", available: { ...AVAILABLE, install: "manual" }, cannotInstall: "not-installed" }).textContent, /can't update itself.*releases page/);
  assert.match(updates({ state: "installing", stage: "trying", available: AVAILABLE }).textContent, /Installing Kin 1\.6\.1: trying it for five minutes/);
  const undone = updates({ lastUpdate: { from: "1.6.0", to: "1.6.1", outcome: "rolled-back", at: "2026-11-03T02:40:00.000Z", code: "update-unhealthy" } });
  assert.equal(undone.dataset.tone, "attention");
  assert.match(undone.querySelector('[data-update="rolled-back"]').textContent, /Kin 1\.6\.1 didn't work here, so Kin went back to 1\.6\.0 .*didn't answer/);
  assert.match(updates({ lastUpdate: { from: "1.6.0", to: "1.6.1", outcome: "updated", at: "2026-11-03T02:40:00.000Z", code: null } }).querySelector('[data-update="updated"]').textContent, /Updated from Kin 1\.6\.0 to 1\.6\.1/);
});

test("settings, updates: install now names the release; automatic updates on or off; neither when updates are off", TIMEOUT, async () => {
  const api = fakeApi({ "confirm-code": { expiresAt: "2026-10-22T13:00:00.000Z" }, change: { kind: "update-install", requested: "2.0.0" } });
  const settings = document.createElement("kin-control-settings");
  settings.api = api;
  document.body.append(settings);
  try {
    settings.status = STATUS;
    assert.equal(settings.querySelector('[data-setting="update-install"]'), null, "nothing to install");
    assert.ok(settings.querySelector("#control-setting-auto-update"));
    settings.status = { ...STATUS, updates: { ...STATUS.updates, state: "available", available: { ...AVAILABLE, version: "2.0.0", kind: "major", install: "admin" } } };
    const install = settings.querySelector('[data-setting="update-install"]');
    assert.match(install.textContent, /Installs Kin 2\.0\.0 now/);
    assert.equal(install.querySelector("button").textContent, "Install now");
    install.querySelector("form").submit();
    await settle();
    const confirm = settings.querySelector(".control-confirm");
    confirm.querySelector("input").value = "ABCDE-23456";
    confirm.submit();
    await settle();
    assert.deepEqual(api.calls.at(-1), ["change", { kind: "update-install", version: "2.0.0" }, { code: "ABCDE-23456" }]);
    assert.match(settings.querySelector(".control-message").textContent, /within a minute/);
    settings.status = { ...STATUS, updates: { ...STATUS.updates, state: "available", available: { ...AVAILABLE, install: "manual" } } };
    assert.equal(settings.querySelector('[data-setting="update-install"] form'), null, "a copy that can't update itself isn't offered the button");
    settings.status = { ...STATUS, updates: { state: "off", current: "1.6.0", autoUpdate: true } };
    assert.equal(settings.querySelector("#control-setting-auto-update"), null);
    assert.equal(settings.querySelector('[data-setting="update-install"]'), null);
  } finally {
    settings.remove();
  }
});

test("moving a household here: a move code printed on this computer, and the last move", TIMEOUT, async () => {
  await import("./kin-control-move.js");
  const api = fakeApi({ "move-code": { expiresAt: "2026-10-25T13:00:00.000Z", address: "https://fern.home.kin.journeytocode.io" } });
  const move = document.createElement("kin-control-move");
  move.api = api;
  document.body.append(move);
  try {
    move.status = { ...STATUS, lastMove: null };
    assert.equal(move.querySelector("h2").textContent, "Moving a household here");
    assert.match(move.textContent, /signs in here again with their password or backup code/);
    move.querySelector("button").click();
    await settle();
    assert.deepEqual(api.calls.at(-1), ["move-code", undefined]);
    assert.match(move.querySelector(".control-message").textContent, /printed a move code .* with https:\/\/fern\.home\.kin\.journeytocode\.io, on the old address/);
    move.status = { ...STATUS, lastMove: { at: "2026-10-25T12:30:00.000Z", members: 3 } };
    assert.match(move.textContent, /A household moved here on .*, with 3 members/);
    const refused = fakeApi({ "move-code": new ControlApiError("control-move-limit", "full", 409) });
    move.api = refused;
    move.querySelector("button").click();
    await settle();
    assert.equal(move.querySelector(".control-message").getAttribute("role"), "alert");
    assert.match(move.querySelector(".control-message").textContent, /household limit is reached/);
  } finally {
    move.remove();
  }
});

test("the panel picks the screen from the state", TIMEOUT, () => {
  const panel = new KinControlPanel();
  assert.equal(panel.screen(null), "loading");
  assert.equal(panel.screen({ remote: false, signedIn: false }), "sign-in");
  assert.equal(panel.screen({ remote: false, signedIn: true, setup: { step: "terms" }, status: { setupComplete: false } }), "setup");
  assert.equal(panel.screen({ remote: false, signedIn: true, setup: { step: "done" }, status: { setupComplete: true } }), "status");
  assert.equal(panel.screen({ remote: true, signedIn: false }), "remote-sign-in");
  assert.equal(panel.screen({ remote: true, signedIn: true, admin: false }), "remote-not-admin");
  assert.equal(panel.screen({ remote: true, signedIn: true, admin: true, status: STATUS }), "status");
});

test("the panel shows a notice while Kin restarts and asks again", TIMEOUT, async () => {
  let fail = true;
  const panel = document.createElement("kin-control-panel");
  panel.api = {
    loopback: true,
    state: async () => { if (fail) throw new ControlApiError("network", "down", 0); return { remote: false, signedIn: false, configured: true }; },
    post: async () => ({}),
  };
  try {
    document.body.append(panel);
    await settle();
    assert.match(panel.querySelector(".control-notice").textContent, /Kin didn't answer/, "even the first request may fail");
    await panel.refresh();
    assert.match(panel.querySelector(".control-notice").textContent, /restarting/);
    fail = false;
    await panel.refresh();
    assert.equal(panel.querySelector(".control-notice").hidden, true);
    assert.equal(panel.querySelector("h2").textContent, "Open the control panel");
  } finally {
    panel.disconnectedCallback();
    panel.remove();
  }
});
