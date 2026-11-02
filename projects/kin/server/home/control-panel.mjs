// The control panel (ADR 0025 §11, story #718: setup #719, status #720).
// The server's own pages, at /control/ (web/control/), reached two ways:
//
// 1. On loopback, from the home server's own computer:
//    http://localhost:<port>/control/. Its API is /control/api/* here. A
//    program on the same computer can reach loopback too, so the panel
//    first asks for a one-time code that Kin prints to its window and log
//    (access-codes.mjs), then keeps a control session in a cookie
//    (control-sessions.mjs). Every change after setup needs a fresh
//    confirmation code, printed the same way.
// 2. Through the household's address, https://<name>/control/, for a
//    signed-in household admin. Its API is /api/control/* in server.mjs,
//    behind the app's own origin check and session, and every change needs
//    the admin's fresh passkey (or password), as Kin's other admin changes.
//
// The origin problem. A configured home server's app origin is
// https://<name>, and the app API refuses any other Origin; the browser on
// the computer itself is at http://localhost:<port>. Rather than add a
// second app origin (which would weaken assertSecureOrigin, WebAuthn's
// relying party and the API's CSRF check), the loopback panel has its own
// small API under /control/api/, which the app API never serves, with its
// own rules (loopbackProblem, writeProblem):
//
// - only sockets from the loopback listener, never tunnel streams;
// - only a loopback peer address, and only a Host header that is a loopback
//   name with the listener's own port (a DNS-rebinding page has its own
//   host name in Host);
// - no X-Forwarded-For, Forwarded or X-Real-IP, and none at all when
//   KIN_TRUSTED_PROXIES is set: a proxy in front makes loopback mean
//   "anyone", so the loopback panel turns off;
// - writes need Origin to be exactly http://<that Host>, a JSON body, and
//   Sec-Fetch-Site same-origin when the browser sends it;
// - the session cookie is HttpOnly, SameSite=Strict and Path=/control.
//
// Seams: `provide(section, fn)` fills a status section, and
// `registerChange(kind, handler)` adds a change, which both ways of
// reaching the panel then confirm and apply the same way; a change marked
// `loopbackOnly` is refused unless it came through the loopback panel.
// Backups (#721, backups.mjs) add the "backups" section and the changes
// "backup-now", "backup-hour" and "restore", and the copy to a second
// folder (#763) the loopback-only "backup-copy-folder": the copy holds
// every household's data and the home key, so only someone at the home
// server's own computer chooses where it goes. Updates (#722, updater.mjs)
// add the "updates" section, read from the file the launcher writes, and
// the changes "update-install" and "auto-update".
//
// Moving a household here (ADR 0026, #739): on loopback, after setup, the
// panel prints a one-time move code ("move-code"); the old server sends the
// household to /api/move/* on this server's address with it
// (move-receive.mjs), and the status shows the last move received.
import { readFileSync, statSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isIP } from "node:net";
import { parseHouseholdPolicy } from "../pairing-service/bootstrap-limits.mjs";
import { tunnelPeer } from "../client-key.mjs";
import { readJsonBody } from "../http-body.mjs";
import { CONFIRM_CODE_TTL_MS, MOVE_CODE_TTL_MS, OneTimeCode, SETUP_CODE_TTL_MS, displayCode } from "./access-codes.mjs";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./control-sessions.mjs";
import { BackupError, isBackupHour } from "./backups.mjs";
import { releasePublicKey } from "./release.mjs";
import { readUpdateStatus, writeUpdateRequest } from "./updater.mjs";
import { MoveReceiver, RECEIPT_FILE, moveDirectory } from "./move-receive.mjs";
import { MAX_HOUSEHOLDS_LIMIT, normalizeBackupCopyFolder, writeHomeSettings } from "./settings.mjs";
import { SetupError } from "./setup.mjs";

export const PANEL_API_PREFIX = "/control/api/";
const MAX_BODY_BYTES = 16_384;
const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"];

export class ControlError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = "ControlError";
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const isSet = (value) => value !== undefined && value !== null && String(value).trim() !== "";

/** True when `folder` is `directory` or inside it, by their text alone
 * (the service may not look outside its data directory). */
function isWithin(folder, directory, platform = process.platform) {
  const fold = platform === "win32" || platform === "darwin" ? (value) => value.toLowerCase() : (value) => value;
  const inside = relative(fold(directory), fold(folder));
  return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

export function isLoopbackAddress(address) {
  const value = String(address ?? "").toLowerCase().replace(/^::ffff:/, "");
  if (value === "::1") return true;
  return isIP(value) === 4 && value.split(".")[0] === "127";
}

/** Host header names that mean "this computer". */
function loopbackHost(host, port) {
  const match = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]):(\d{1,5})$/i.exec(String(host ?? ""));
  return Boolean(match) && Number(match[2]) === port;
}

/**
 * Why `request` may not use the loopback panel, or null when it may. Codes:
 * "not-loopback" (a tunnel stream or another address), "proxied" (a proxy
 * may stand in front), "host" (not a loopback Host for this listener).
 */
export function loopbackProblem(request, { trustedProxies = new Set() } = {}) {
  if (tunnelPeer(request.socket) !== null) return "not-loopback";
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return "not-loopback";
  if (trustedProxies.size > 0) return "proxied";
  if (FORWARDING_HEADERS.some((name) => request.headers[name] !== undefined)) return "proxied";
  if (!loopbackHost(request.headers.host, request.socket?.localPort)) return "host";
  return null;
}

/** Why a loopback write is refused (cross-site or not JSON), or null. */
export function writeProblem(request) {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin !== `http://${String(request.headers.host).toLowerCase()}`) return "origin";
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return "origin";
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] ?? ""))) return "content-type";
  return null;
}

function cookieValue(request, name) {
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function send(response, status, value, headers = {}) {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

const CODE_ANSWERS = {
  wrong: ["control-code-wrong", 401],
  expired: ["control-code-expired", 410],
  locked: ["control-code-locked", 429],
  none: ["control-code-none", 410],
  malformed: ["control-code-malformed", 400],
};

export class ControlPanel {
  /**
   * @param {object} options
   * @param {object} options.application  createKinServer's result
   * @param {string} options.dataDirectory
   * @param {string|null} options.databasePath  for "storage used" (null: in memory)
   * @param {() => object} options.getSettings
   * @param {(settings: object) => void} options.setSettings
   * @param {import("./setup.mjs").HomeSetup} options.setup
   * @param {import("./control-sessions.mjs").ControlSessions} options.sessions
   * @param {import("./backups.mjs").HomeBackups|null} [options.backups]
   * @param {Set<string>} [options.trustedProxies]
   * @param {object} [options.env]
   * @param {(event: object) => void} [options.log]  where codes are printed
   * @param {() => number} [options.now]
   */
  constructor({ application, dataDirectory, databasePath = null, getSettings, setSettings, setup, sessions, backups = null, trustedProxies = new Set(), env = process.env, log = () => {}, now = Date.now, version }) {
    Object.assign(this, { application, dataDirectory, databasePath, getSettings, setSettings, setup, sessions, backups, trustedProxies, env, log, now });
    this.version = version ?? JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    this.codes = {
      access: new OneTimeCode({ purpose: "access", ttlMs: SETUP_CODE_TTL_MS, now }),
      confirm: new OneTimeCode({ purpose: "confirm", ttlMs: CONFIRM_CODE_TTL_MS, reissueAfterUse: true, now }),
      move: new OneTimeCode({ purpose: "move", ttlMs: MOVE_CODE_TTL_MS, now }),
    };
    this.moveReceiver = null;
    this.sections = new Map([
      ["backups", () => (this.backups ? this.backups.status() : { state: "not-built" })],
      // #722 provides these: the update policy and what is available.
      ["updates", () => this.#updates()],
    ]);
    this.changes = new Map();
    this.registerChange("households-limit", {
      check: (change) => {
        const value = change?.maxHouseholds;
        if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HOUSEHOLDS_LIMIT)
          throw new ControlError("control-limit-invalid", `Choose a number from 1 to ${MAX_HOUSEHOLDS_LIMIT}.`);
        if (isSet(this.env.KIN_MAX_HOUSEHOLDS) || isSet(this.env.KIN_ALLOW_NEW_HOUSEHOLDS))
          throw new ControlError("control-limit-from-environment", "This limit is set on this computer (KIN_MAX_HOUSEHOLDS or KIN_ALLOW_NEW_HOUSEHOLDS).", 409);
        return { kind: "households-limit", maxHouseholds: value };
      },
      apply: async ({ maxHouseholds }) => {
        this.setSettings(await writeHomeSettings(this.dataDirectory, { maxHouseholds }, this.env));
        this.application.service.householdPolicy = parseHouseholdPolicy({ maxHouseholds });
        return { maxHouseholds };
      },
    });
    if (this.backups) this.#registerBackupChanges();
    this.#registerUpdateChanges();
  }

  /** What the launcher last wrote about updates (#722), with this
   * version. Before the launcher's first look (or without its updater, as
   * when Kin is started by hand without the launcher) it is "not-checked",
   * or "off" in a build without a release key. */
  #updates() {
    const status = readUpdateStatus(this.dataDirectory);
    if (!status) return { state: releasePublicKey() === null ? "off" : "not-checked", current: this.version, autoUpdate: this.settings.autoUpdate !== false };
    const { format, failedVersion, ...shown } = status;
    return { ...shown, current: this.version, autoUpdate: this.settings.autoUpdate !== false };
  }

  /** Install an offered release now, and automatic updates on or off. */
  #registerUpdateChanges() {
    this.registerChange("update-install", {
      check: (change) => {
        const status = this.#updates();
        const available = status.available;
        if (!available || available.version !== change?.version) throw new ControlError("control-update-unknown", "That update isn't available any more.", 409);
        if (available.install === "manual") throw new ControlError("control-update-manual", "This copy of Kin can't update itself.", 409);
        if (status.state === "installing") throw new ControlError("control-update-busy", "Kin is installing an update now.", 409);
        return { kind: "update-install", version: available.version };
      },
      apply: async ({ version }) => {
        await writeUpdateRequest(this.dataDirectory, { version, now: this.now });
        this.log({ event: "home_update_requested" });
        return { requested: version };
      },
    });
    this.registerChange("auto-update", {
      check: (change) => {
        if (typeof change?.enabled !== "boolean") throw new ControlError("control-bad-request", "Kin couldn't read that request.");
        return { kind: "auto-update", enabled: change.enabled };
      },
      apply: async ({ enabled }) => {
        this.setSettings(await writeHomeSettings(this.dataDirectory, { autoUpdate: enabled }, this.env));
        return { enabled };
      },
    });
  }

  /** Back up now, the hour of the daily backup, and restore (#721). A
   * restore is checked (the set exists and opens) before the confirmation
   * is spent, then asks the launcher to start Kin again to put it back. */
  #registerBackupChanges() {
    const backups = this.backups;
    const asControlError = (error) => (error instanceof BackupError ? new ControlError(error.code, error.message, 409) : error);
    this.registerChange("backup-now", {
      check: () => ({ kind: "backup-now" }),
      apply: async () => {
        try { return { backup: await backups.create("manual") }; } catch (error) { throw asControlError(error); }
      },
    });
    this.registerChange("backup-hour", {
      check: (change) => {
        if (!isBackupHour(change?.hour)) throw new ControlError("control-backup-hour-invalid", "Choose an hour from 0 to 23.");
        return { kind: "backup-hour", hour: change.hour };
      },
      apply: async ({ hour }) => {
        this.setSettings(await writeHomeSettings(this.dataDirectory, { backupHour: hour }, this.env));
        return { hour };
      },
    });
    // The second folder (#763): only its form is checked here. Whether it
    // exists, can be written and is on another disk is the launcher's to
    // find out, since the service may not look outside its data directory.
    this.registerChange("backup-copy-folder", {
      loopbackOnly: true,
      check: (change) => {
        const value = change?.folder;
        if (value === null) return { kind: "backup-copy-folder", folder: null };
        const folder = normalizeBackupCopyFolder(value);
        if (!folder || isWithin(folder, this.dataDirectory))
          throw new ControlError("control-backup-copy-invalid", "Choose a folder by its full path, outside Kin's own data folder.");
        return { kind: "backup-copy-folder", folder };
      },
      apply: async ({ folder }) => {
        this.setSettings(await writeHomeSettings(this.dataDirectory, { backupCopyFolder: folder }, this.env));
        return { folder, checking: folder !== null };
      },
    });
    this.registerChange("restore", {
      check: (change) => {
        try { backups.checkRestore(change?.id); } catch (error) { throw asControlError(error); }
        return { kind: "restore", id: change.id };
      },
      apply: async ({ id }) => {
        try { return { restoring: await backups.requestRestore(id) }; } catch (error) { throw asControlError(error); }
      },
    });
  }

  get settings() { return this.getSettings(); }

  /** The panel's address on this computer. */
  url() {
    const port = this.application.server.address()?.port ?? Number(this.env.KIN_PORT ?? 8000);
    return `http://localhost:${port}/control/`;
  }

  /** Called once the loopback listener is up. On first run (no name yet)
   * this prints the setup code. */
  started() {
    if (!this.settings.configured) this.issueCode("access", { force: true });
    this.backups?.start();
  }

  /** Issues and prints a code. Resolves with { expiresAt } or throws when
   * asked again too soon. The code itself goes only to the log. */
  issueCode(purpose, { force = false } = {}) {
    const code = this.codes[purpose];
    const issued = code.issue({ force });
    if (!issued) throw new ControlError("control-code-too-soon", "Kin printed a code a moment ago. Look for it in Kin's window or log.", 429, { retryAt: new Date(code.nextIssueAt()).toISOString() });
    this.log({
      event: "home_control_code",
      purpose: purpose === "access" && !this.settings.configured ? "setup" : purpose,
      code: displayCode(issued.code),
      expiresAt: new Date(issued.expiresAt).toISOString(),
      url: this.url(),
    });
    return { expiresAt: new Date(issued.expiresAt).toISOString() };
  }

  // ------------------------------------------------------------- the seams

  /** Fills a status section (#721 "backups", #722 "updates"). */
  provide(section, provider) {
    if (typeof provider !== "function") throw new TypeError("a status provider is a function");
    this.sections.set(section, provider);
  }

  /** Adds a change: `check(change)` returns the normalized change or throws
   * ControlError; `apply(normalized)` makes it. Both ways of reaching the
   * panel confirm it freshly before `apply`. A `loopbackOnly` change is
   * refused unless the caller says it came through the loopback panel. */
  registerChange(kind, { check, apply, loopbackOnly = false }) {
    this.changes.set(kind, { check, apply, loopbackOnly });
  }

  /** Checks `change`. Only the loopback panel's route passes `loopback`, so
   * a caller that leaves it out can't make a loopback-only change. */
  checkChange(change, { loopback = false } = {}) {
    const handler = this.changes.get(change?.kind);
    if (!handler) throw new ControlError("control-change-unknown", "Kin doesn't know that change.");
    if (handler.loopbackOnly && loopback !== true)
      throw new ControlError("control-loopback-only", "This works only on the home server's own computer.", 403);
    return handler.check(change);
  }

  /** Applies a change that has been checked and freshly confirmed. */
  async applyChange(change, options = {}) {
    const normalized = this.checkChange(change, options);
    const result = await this.changes.get(normalized.kind).apply(normalized);
    this.log({ event: "home_control_change", kind: normalized.kind });
    return { kind: normalized.kind, ...result };
  }

  // ----------------------------------------------------------- the status

  #storage() {
    if (!this.databasePath || this.databasePath === ":memory:") return { databaseBytes: null, freeBytes: null };
    let databaseBytes = 0;
    for (const suffix of ["", "-wal"]) databaseBytes += statSync(`${this.databasePath}${suffix}`, { throwIfNoEntry: false })?.size ?? 0;
    let freeBytes = null;
    try {
      const disk = statfsSync(dirname(this.databasePath));
      freeBytes = Number(disk.bavail) * Number(disk.bsize);
    } catch { freeBytes = null; }
    return { databaseBytes, freeBytes };
  }

  /** Households and trusted devices on this server: counts only. */
  #counts() {
    const { service } = this.application;
    let devices = 0;
    for (const device of service.devices.values()) {
      if (device.revokedAt) continue;
      const household = service.households.get(device.householdId);
      if (household && household.lifecycleState !== "deleted") devices += 1;
    }
    return { households: service.countLiveHouseholds(), devices };
  }

  /**
   * What the status page shows (#720). Counts, dates, states and error
   * codes: never household content, a household's or member's identifier,
   * a device label, a key or anyone's address.
   */
  status() {
    const settings = this.settings;
    const home = this.application.home ?? null;
    const now = this.now();
    const tunnel = home?.tunnel.status() ?? null;
    const certificate = home?.certificates.status() ?? null;
    const policy = this.application.service.householdPolicy;
    const sections = {};
    for (const [name, provider] of this.sections) {
      try { sections[name] = provider(); } catch { sections[name] = { state: "error" }; }
    }
    return {
      version: this.version,
      checkedAt: new Date(now).toISOString(),
      name: settings.name,
      freeName: settings.freeName,
      origin: settings.configured ? `https://${settings.name}` : null,
      setupComplete: Boolean(certificate?.certificate),
      relay: tunnel ? {
        state: tunnel.state, connected: tunnel.connected, since: tunnel.since, relay: tunnel.relay,
        names: tunnel.names, routed: tunnel.routed, nameError: tunnel.nameError, lastError: tunnel.lastError, nextAttemptAt: tunnel.nextAttemptAt,
      } : null,
      certificate: certificate ? {
        state: certificate.state,
        notAfter: certificate.certificate?.notAfter ?? null,
        daysLeft: certificate.certificate?.daysLeft ?? null,
        issuer: certificate.certificate?.issuer ?? null,
        renewAt: certificate.renewAt,
        expiringSoon: certificate.expiringSoon,
        nextAttemptAt: certificate.nextAttemptAt,
        lastError: certificate.lastError ? { code: certificate.lastError.code, at: certificate.lastError.at } : null,
        lastRenewedAt: certificate.lastRenewedAt,
        transparency: { state: certificate.transparency.state, checkedAt: certificate.transparency.checkedAt, unexpected: certificate.transparency.unexpected.length, error: certificate.transparency.error?.code ?? null },
      } : null,
      storage: this.#storage(),
      counts: this.#counts(),
      lastMove: this.#lastMove(),
      limits: {
        maxHouseholds: policy.maxHouseholds,
        allowNew: policy.allowNew,
        fromEnvironment: isSet(this.env.KIN_MAX_HOUSEHOLDS) || isSet(this.env.KIN_ALLOW_NEW_HOUSEHOLDS),
        highest: MAX_HOUSEHOLDS_LIMIT,
      },
      ...sections,
    };
  }

  /** The last household moved here (#739): when, and how many members. */
  #lastMove() {
    try {
      const receipt = JSON.parse(readFileSync(join(moveDirectory(this.dataDirectory), RECEIPT_FILE), "utf8"));
      return receipt?.format === 1 ? { at: receipt.at, members: receipt.members } : null;
    } catch { return null; }
  }

  /** Whether the household limit has room for one more (a move here). */
  canAddHousehold() {
    const { allowNew, maxHouseholds } = this.application.service.householdPolicy;
    return allowNew !== false && (maxHouseholds === null || maxHouseholds === undefined || this.application.service.countLiveHouseholds() < maxHouseholds);
  }

  /** True while a home server has no name: the app's own API is off, so no
   * household is made on localhost, where its passkeys would be bound to
   * the wrong name (ADR 0025 §10). */
  appBlocked() { return !this.settings.configured; }

  // ------------------------------------------------- the loopback panel API

  #signedIn(request) {
    return this.sessions.verify(cookieValue(request, SESSION_COOKIE));
  }

  #requireSession(request) {
    if (!this.#signedIn(request)) throw new ControlError("control-sign-in-required", "Enter the code Kin printed to open the control panel.", 401);
  }

  #state(request) {
    const signedIn = this.#signedIn(request);
    const access = this.codes.access;
    return {
      signedIn,
      version: this.version,
      configured: this.settings.configured,
      codeExpiresAt: access.active ? new Date(access.expiresAt).toISOString() : null,
      ...(signedIn ? { moveCodeExpiresAt: this.codes.move.active ? new Date(this.codes.move.expiresAt).toISOString() : null } : {}),
      ...(signedIn ? { setup: this.setup.view(), status: this.#localStatus() } : {}),
    };
  }

  /** The status, with what only this computer's own panel shows: the
   * second backup folder's path (#763), which can hold an account name. */
  #localStatus() {
    const status = this.status();
    if (status.backups?.copy) status.backups = { ...status.backups, copy: { ...status.backups.copy, folder: this.settings.backupCopyFolder ?? null } };
    return status;
  }

  /**
   * Handles /control/api/* on loopback. Resolves true when it answered.
   * Everything else under /control/ is the static page (server.mjs).
   */
  async handle(request, response, url) {
    if (!url.pathname.startsWith(PANEL_API_PREFIX)) return false;
    try {
      const problem = loopbackProblem(request, { trustedProxies: this.trustedProxies });
      if (problem) throw new ControlError("control-loopback-only", "This part of the control panel works only on the home server's own computer. Through the household's address, sign in to Kin as a household admin.", 403, { reason: problem });
      const route = url.pathname.slice(PANEL_API_PREFIX.length);
      if (request.method === "GET" && route === "state") { send(response, 200, this.#state(request)); return true; }
      if (request.method !== "POST") throw new ControlError("control-not-found", "That isn't part of the control panel.", 404);
      const refused = writeProblem(request);
      if (refused) throw new ControlError("control-origin-rejected", "The control panel only accepts changes from its own page.", 403);
      let body;
      try { body = await readJsonBody(request, response, MAX_BODY_BYTES); } catch { throw new ControlError("control-bad-request", "Kin couldn't read that request."); }
      if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ControlError("control-bad-request", "Kin couldn't read that request.");
      send(response, 200, await this.#route(request, response, route, body));
    } catch (error) {
      this.#fail(response, error);
    }
    return true;
  }

  async #route(request, response, route, body) {
    switch (route) {
      case "sign-in": {
        const answer = this.codes.access.verify(body.code);
        if (answer !== "ok") {
          const [code, status] = CODE_ANSWERS[answer];
          throw new ControlError(code, "That code didn't work.", status, answer === "wrong" ? { attemptsLeft: this.codes.access.attemptsLeft } : {});
        }
        const token = await this.sessions.create();
        response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/control; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
        this.log({ event: "home_control_signed_in" });
        return { signedIn: true };
      }
      case "code":
        return this.issueCode("access");
      case "sign-out": {
        await this.sessions.revoke(cookieValue(request, SESSION_COOKIE));
        response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/control; Max-Age=0`);
        return { signedIn: false };
      }
      default:
        break;
    }
    this.#requireSession(request);
    switch (route) {
      case "setup/check-name": return this.setup.checkName(body.name);
      case "setup/name": return this.setup.chooseName(body.name);
      case "setup/terms": return { ...(await this.setup.agreeTerms(body.agreed)) };
      case "setup/terms-url": return { url: await this.setup.termsUrl() };
      case "setup/records": return this.setup.checkRecords();
      case "setup/connect": return this.setup.connect();
      case "setup/retry": return this.setup.retryCertificate();
      case "confirm-code": return this.issueCode("confirm");
      case "move-code": {
        // Only a server people can reach, with its certificate, takes a move.
        if (!this.application.home?.certificates.status()?.certificate)
          throw new ControlError("control-move-not-ready", "Finish setting up this home server first.", 409);
        if (!this.canAddHousehold())
          throw new ControlError("control-move-limit", "This home server's household limit is reached. Raise it first.", 409);
        return { ...this.issueCode("move"), address: `https://${this.settings.name}` };
      }
      case "change": {
        // Checked before the code is spent, so a wrong value doesn't cost one.
        this.checkChange(body.change, { loopback: true });
        const answer = this.codes.confirm.verify(body.code);
        if (answer !== "ok") {
          const [code, status] = CODE_ANSWERS[answer];
          throw new ControlError(code.replace("control-code", "control-confirm"), "That confirmation code didn't work.", status, answer === "wrong" ? { attemptsLeft: this.codes.confirm.attemptsLeft } : {});
        }
        return this.applyChange(body.change, { loopback: true });
      }
      default:
        throw new ControlError("control-not-found", "That isn't part of the control panel.", 404);
    }
  }

  #fail(response, error) {
    if (error instanceof ControlError || error instanceof SetupError) {
      send(response, error.status, { error: error.code, message: error.message, ...(error.extra ?? {}) });
      return;
    }
    // A HomeSettingsError (a bad value that got past the checks) or an
    // unexpected failure: logged by code, answered without detail.
    this.log({ event: "home_control_failed", code: typeof error?.code === "string" ? error.code : "error" });
    send(response, 500, { error: "control-failed", message: "Kin couldn't do that. Look at Kin's log on this computer." });
  }

  async close() {
    this.backups?.stop();
    await this.backups?.running?.catch(() => {});
    await this.setup.close();
  }
}

/** Certificate events that need an admin (ADR 0025 §5): fewer than 14
 * days left, or a certificate this server didn't make in the CT logs. */
export const ALERT_EVENTS = Object.freeze(["expiring", "transparency-alert"]);
export const ALERT_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Turns the certificate manager's events into the admins' content-free
 * push, at most once a day per kind (the manager reports "expiring" each
 * time it plans, which can be hourly while renewal retries).
 */
export function certificateAlerts(pushService, { now = Date.now, log = () => {} } = {}) {
  const lastSent = new Map();
  return (event) => {
    if (!ALERT_EVENTS.includes(event?.type)) return;
    const last = lastSent.get(event.type);
    if (last !== undefined && now() - last < ALERT_INTERVAL_MS) return;
    lastSent.set(event.type, now());
    pushService?.adminsAlerted?.();
    log({ event: "home_admins_alerted", reason: event.type });
  };
}

/**
 * Builds home mode's control panel for a running Kin server: the settings
 * it reads and writes, its stored sessions, the setup flow and the
 * backups, and attaches it. `restart(reason)` asks the launcher to start
 * the service again (setup's last step, and a restore). Test seams: `setup`
 * (HomeSetup options such as `tunnel`, `acmeTransport`, `checkDomain`,
 * `resolver`), `backups` (HomeBackups options such as `checkMs`) and `now`.
 */
export async function createControlPanel({ application, dataDirectory, databasePath = null, settings, env = process.env, restart, log = () => {}, trustedProxies = new Set(), setup: setupOptions = {}, backups: backupOptions = {}, now = Date.now, version }) {
  const { ControlSessions } = await import("./control-sessions.mjs");
  const { HomeSetup } = await import("./setup.mjs");
  const { HomeBackups } = await import("./backups.mjs");
  let current = settings;
  const getSettings = () => current;
  const setSettings = (next) => { current = next; };
  const sessions = await new ControlSessions({ dataDirectory, now }).load();
  const setup = new HomeSetup({ dataDirectory, getSettings, setSettings, getHome: () => application.home ?? null, restart, env, log, ...setupOptions });
  const resolvedVersion = version ?? JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  const backups = application.store
    ? new HomeBackups({ store: application.store, dataDirectory, getSettings, version: resolvedVersion, restart, log, now, ...backupOptions })
    : null;
  const panel = new ControlPanel({ application, dataDirectory, databasePath, getSettings, setSettings, setup, sessions, backups, trustedProxies, env, log, now, version: resolvedVersion });
  if (application.store)
    panel.moveReceiver = new MoveReceiver({ dataDirectory, store: application.store, codes: panel.codes.move, canAddHousehold: () => panel.canAddHousehold(), restart, log, now });
  application.attachControlPanel(panel);
  application.controlPanel = panel;
  return panel;
}
