import { createReadStream, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { parseAssetLinks, serveAssetLinks } from "./asset-links.mjs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { PairingError, PairingService, CHAT_ACCESS, parseHouseholdPolicy, requireTrustAuthority } from "./pairing-service.mjs";
import { isHouseholdAdmin } from "./pairing-service/shared.mjs";
import { deviceLabel } from "./pairing-service/device-label.mjs";
import { configuredDatabasePath, permissionProblem } from "./permissions.mjs";
import { applyServerMode, RESTART_EXIT_CODE, serverMode } from "./mode.mjs";
import { HouseholdMoves } from "./household-move.mjs";
import { builtInManifest, etagMatches, INSTALL_ICONS, publishedManifest } from "./install-identity.mjs";
import { PushService } from "./push-service.mjs";
import { ChatBlobService } from "./chat-blob-service.mjs";
import { ChatRelayService } from "./chat-relay-service.mjs";
import { BoardRelayService } from "./board-relay-service.mjs";
import { PrivateRelayService } from "./private-relay-service.mjs";
import { PrivateBlobService } from "./private-blob-service.mjs";
import { AccountVaultService } from "./account-vault-service.mjs";
import { NEW_DEVICE_TTL_MS } from "./pairing-service/new-device.mjs";
import { EncryptedSyncService, MAX_EVENTS_PER_BATCH } from "./sync-service.mjs";
import { isEventEnvelopeValid, isSyncId } from "./sync-contract.mjs";
import {
  DurableConflictError,
  DurableStore,
  DurableStoreError,
  MAX_ACCOUNT_VAULT_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_CHAT_HIDDEN_RECORD_BYTES,
  MAX_CHAT_RECEIPT_BYTES,
} from "./durable-store.mjs";
import { WebAuthn } from "./webauthn.mjs";
import { readBody, readJsonBody } from "./http-body.mjs";
import {
  decodeEnvelopeBatch,
  encodeEventPage,
  ENVELOPE_CONTENT_TYPE,
  EnvelopeWireError,
  MAX_CIPHERTEXT_BYTES,
  RECORD_FIXED,
} from "../web/sync/envelope-wire.js";
import { isInsideRoot, webRoot } from "./path-safety.mjs";
import { clientKey, parseTrustedProxies, tunnelPeer } from "./client-key.mjs";
import { LiveService } from "./live/live-service.mjs";
import { FeedbackService, MAX_FEEDBACK_REQUEST_BYTES } from "./feedback-service.mjs";
import { GitHubIssues, parseGitHubConfig } from "./feedback-github.mjs";
import { CalendarSyncService } from "./calendar-sync-service.mjs";

const FLOW_TTL_MS = 2 * 60_000;
const MAX_ACTIVE_FLOWS = 512;

export function createKinServer(options = {}) {
  const port = options.port ?? Number(process.env.KIN_PORT ?? 8000);
  const host = options.host ?? process.env.KIN_HOST ?? "127.0.0.1";
  const origin =
    options.origin ?? process.env.KIN_ORIGIN ?? `http://localhost:${port}`;
  assertSecureOrigin(host, origin);
  // KIN_MODE (ADR 0025 §9): home mode refuses the Google Play settings and
  // limits new households to the owner's unless a limit is configured.
  const mode = serverMode(options.mode ?? process.env.KIN_MODE);
  const androidPackage = options.androidPackage ?? process.env.KIN_ANDROID_PACKAGE;
  const androidCertSha256 = options.androidCertSha256 ?? process.env.KIN_ANDROID_CERT_SHA256;
  const modeSettings = applyServerMode(mode, {
    KIN_ANDROID_PACKAGE: androidPackage,
    KIN_ANDROID_CERT_SHA256: androidCertSha256,
    KIN_MAX_HOUSEHOLDS: options.maxHouseholds ?? process.env.KIN_MAX_HOUSEHOLDS,
  });
  const trustedProxies =
    options.trustedProxies instanceof Set
      ? options.trustedProxies
      : parseTrustedProxies(options.trustedProxies ?? process.env.KIN_TRUSTED_PROXIES);
  const householdSettings = {
    allowNewHouseholds: options.allowNewHouseholds ?? process.env.KIN_ALLOW_NEW_HOUSEHOLDS,
    maxHouseholds: modeSettings.maxHouseholds,
  };
  const householdPolicy = parseHouseholdPolicy(householdSettings);
  // Google Play app link (#532): null unless both settings are given.
  const assetLinks = parseAssetLinks({
    packageName: androidPackage,
    fingerprints: androidCertSha256,
  });
  // A passed-in service keeps its own policy unless a setting is given here.
  const householdPolicyConfigured = [householdSettings.allowNewHouseholds, householdSettings.maxHouseholds]
    .some((value) => value !== undefined && value !== null && value !== "");
  const databasePath = configuredDatabasePath({ databasePath: options.databasePath, dataDirectory: options.dataDirectory, mode });
  const store =
    options.store === false
      ? null
      : (options.store ??
        new DurableStore(databasePath, {
          acquireProcessLock: options.acquireProcessLock,
        }));
  if (options.store) store.validate();
  const service =
    options.service ?? new PairingService({ now: options.now, store, householdPolicy });
  if (householdPolicyConfigured) service.householdPolicy = householdPolicy;
  if (options.service && store && !service.store) {
    service.store = store;
    for (const householdId of service.households.keys())
      store.saveIdentityHousehold(householdId, service);
  }
  const syncService =
    options.syncService ??
    new EncryptedSyncService(service, { now: options.now, store });
  if (options.syncService && store && !syncService.store) {
    syncService.store = store;
    for (const [householdId, state] of syncService.households)
      store.saveSyncState(householdId, state, service);
  }
  // Push notifications (#85). Subscriptions belong to this service's store.
  // VAPID's subject must be a mailto: or https: URL the push services accept;
  // the deployment's own origin is one unless KIN_PUSH_SUBJECT says otherwise.
  const pushService = options.pushService ?? new PushService({ pairingService: service, store, now: options.now ?? (() => Date.now()),
    subject: process.env.KIN_PUSH_SUBJECT || origin });
  syncService.pushService = pushService;
  // Chat content blobs (#110).
  const chatBlobService = new ChatBlobService({ pairingService: service, store, now: options.now ?? (() => Date.now()) });
  syncService.chatBlobService = chatBlobService;
  // The chat relay (#111): chat events in their own encrypted stream.
  const chatRelayService = new ChatRelayService({ syncService, store });
  syncService.chatRelayService = chatRelayService;
  // The fridge's relay (#317): board events in a third encrypted stream.
  const boardRelayService = new BoardRelayService({ syncService, store });
  syncService.boardRelayService = boardRelayService;
  // Each member's private relay (#491, ADR 0019): a stream keyed by member.
  const privateRelayService = new PrivateRelayService({ syncService, store });
  syncService.privateRelayService = privateRelayService;
  // A member's private blobs (#502): journal photos, keyed by member too.
  const privateBlobService = new PrivateBlobService({ relay: privateRelayService, store, now: options.now ?? (() => Date.now()) });
  syncService.privateBlobService = privateBlobService;
  // Removing a member purges their private stream and blobs, in the
  // removal's own transaction (removeMembership runs inside withTransaction).
  service.onMemberRemoved = (_householdId, memberId) => {
    privateRelayService.forgetMember(memberId);
    privateBlobService.forgetMember(memberId);
    // Their problem reports and suggestions too (ADR 0021 §3).
    syncService.feedbackService?.forgetMember(memberId);
    // And the outside calendars they synced, for everyone (ADR 0022 §3).
    syncService.calendarSyncService?.forgetMember(memberId);
  };
  // Members' encrypted key vaults (ADR 0018, #564).
  const accountVaultService = options.accountVaultService ?? new AccountVaultService({ store, now: options.now ?? (() => Date.now()) });
  // A key rotation stores the committer's re-sealed vault with it (#791).
  syncService.accountVaultService = accountVaultService;
  // A removed member's account vault and password verifier go with them.
  service.onAccountRemoved = (householdId, memberId) => accountVaultService.removeMember(householdId, memberId);
  const webauthn =
    options.webauthn ??
    new WebAuthn({
      rpId: new URL(origin).hostname,
      origin,
      now: options.now,
      maxChallenges: options.maxChallenges,
      maxAnonymousChallenges: options.maxAnonymousChallenges,
    });
  // Problem reports and suggestions (ADR 0021 §3, #636), forwarded to
  // GitHub issues when the operator configures a repository and token (#637).
  const githubConfig = options.feedbackGithub === false ? null : parseGitHubConfig({
    repo: options.feedbackGithub?.repo ?? process.env.KIN_FEEDBACK_GITHUB_REPO,
    token: options.feedbackGithub?.token ?? process.env.KIN_FEEDBACK_GITHUB_TOKEN,
    api: options.feedbackGithub?.api ?? process.env.KIN_FEEDBACK_GITHUB_API,
  });
  const feedbackService = options.feedbackService ?? new FeedbackService({
    store,
    github: githubConfig ? new GitHubIssues(githubConfig, { fetch: options.feedbackGithub?.fetch }) : null,
    now: options.now ?? (() => Date.now()),
  });
  syncService.feedbackService = feedbackService;
  // Outside calendars members sync (ADR 0022 §3, #667). The fetcher is built
  // here without test hooks; only a test passes its own (calendarFetcher).
  const calendarSyncService = options.calendarSyncService ?? new CalendarSyncService({
    store,
    fetcher: options.calendarFetcher ?? null,
    now: options.now ?? (() => Date.now()),
  });
  syncService.calendarSyncService = calendarSyncService;
  const maxFlows = options.maxFlows ?? MAX_ACTIVE_FLOWS;
  const context = {
    service,
    syncService,
    pushService,
    chatBlobService,
    chatRelayService,
    boardRelayService,
    privateRelayService,
    privateBlobService,
    accountVaultService,
    feedbackService,
    calendarSyncService,
    store,
    webauthn,
    flows: new Map(),
    now: options.now ?? (() => Date.now()),
    maxFlows,
    maxAnonymousFlows: Math.max(
      0,
      Math.min(
        maxFlows,
        options.maxAnonymousFlows ?? defaultAnonymousCapacity(maxFlows),
      ),
    ),
    secureCookies: new URL(origin).protocol === "https:",
    origin,
    clientKey: (request) => clientKey(request, trustedProxies),
    // The home server's control panel (ADR 0025 §11, #718), attached by
    // home mode after the server exists; null for hosted Kin.
    controlPanel: options.controlPanel ?? null,
  };
  // The live channel (#107): one WebSocket per trusted device at /api/live.
  const liveService = options.liveService ?? new LiveService({
    service, origin, store, readSession: (request) => cookies(request).kin_session, ...(options.live ?? {}),
  });
  syncService.liveService = liveService;
  context.liveService = liveService;
  // Moving a household to a home server (ADR 0026, #738). Packages are
  // built in the data directory, the one place the sandboxed service writes.
  context.householdMoves = store ? new HouseholdMoves({
    service, store, origin,
    workDirectory: options.moveWorkDirectory ?? (store.databasePath === ":memory:" ? join(tmpdir(), `kin-moves-${process.pid}`) : join(dirname(store.databasePath), "moves")),
    ...(options.moveSender ? { sender: options.moveSender } : {}),
    revalidate: (householdId) => liveService.revalidate(householdId),
    now: options.now ?? (() => Date.now()),
    log: options.moveLog ?? ((event) => console.log(JSON.stringify(event))),
  }) : null;
  const server = createServer(async (request, response) => {
    const requestId = randomBytes(12).toString("hex");
    response.setHeader("X-Request-ID", requestId);
    try {
      setHeaders(response);
      const url = new URL(request.url, origin);
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readiness") {
        try {
          store?.health();
          json(response, 200, { ready: true });
        } catch {
          json(response, 503, { ready: false });
        }
        return;
      }
      // The control panel's own loopback API (server/home/control-panel.mjs).
      // It has its own origin and session rules and never reaches api().
      if (context.controlPanel && url.pathname.startsWith("/control/api/")) {
        await context.controlPanel.handle(request, response, url);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (request.headers.origin && request.headers.origin !== origin)
          throw new PairingError(
            "origin_rejected",
            "The request origin was rejected.",
            403,
          );
        // A home server with no name yet serves only its setup page: a
        // household made on localhost would have passkeys for the wrong name.
        if (context.controlPanel?.appBlocked())
          throw new PairingError(
            "home_setup_required",
            "Finish setting up this home server first, on its own computer.",
            503,
          );
        store?.assertAvailable();
        // A household moved here from another Kin server (ADR 0026, #739):
        // its own authentication, a one-time move code and a bearer token.
        if (await context.controlPanel?.moveReceiver?.handle(request, response, url)) return;
        await api(request, response, url, context);
        return;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        if (url.pathname === "/control" || url.pathname.startsWith("/control/")) {
          // The control panel's page exists only on a home server.
          if (!context.controlPanel) { response.writeHead(404); response.end("Not found"); return; }
          serve(response, url.pathname === "/control" || url.pathname === "/control/" ? "/control/index.html" : url.pathname);
          return;
        }
        // On the home server's own computer the app can't work at
        // http://localhost (its origin is https://<name>, or not set yet),
        // so the address the launcher prints leads to the control panel.
        if (context.controlPanel && url.pathname === "/" && !tunnelPeer(request.socket) && /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]):\d+$/i.test(String(request.headers.host ?? ""))) {
          response.writeHead(303, { Location: "/control/", "Cache-Control": "no-store" });
          response.end();
          return;
        }
        if (url.pathname === "/.well-known/assetlinks.json") {
          serveAssetLinks(request, response, assetLinks);
          return;
        }
        if (url.pathname === "/manifest.webmanifest") {
          serveManifest(request, response, context);
          return;
        }
        const icon = INSTALL_ICON_ROUTE.exec({ pathname: url.pathname });
        if (icon) {
          serveInstallIcon(request, response, url, icon.pathname.groups.file, context);
          return;
        }
      }
      // Sharing into Kin (#389): the service worker answers /share itself.
      // Without one (first visit, or a browser that skipped it), the shared
      // content is not read, kept or logged: the app just opens.
      if (request.method === "POST" && url.pathname === "/share") {
        request.resume();
        response.writeHead(303, { Location: "/", "Cache-Control": "no-store" });
        response.end();
        return;
      }
      serve(response, url.pathname);
    } catch (error) {
      if (request.kinPasskeyFlow)
        context.webauthn.discardFlow?.(request.kinPasskeyFlow);
      if (
        error instanceof PairingError &&
        [
          "authentication_required",
          "device_not_trusted",
          "membership_removed",
          "household_deletion_pending",
          "household_deleted",
          "household_moved",
        ].includes(error.code)
      ) {
        clearCookie(response, "kin_session", context.secureCookies);
        if (
          ![
            "authentication_required",
            "household_deletion_pending",
            "household_moved",
          ].includes(error.code)
        )
          clearCookie(response, "kin_device", context.secureCookies);
      }
      const safe =
        error instanceof PairingError
          ? error
          : error instanceof DurableConflictError && !store?.failed
            ? new PairingError(error.code, error.message, 409)
            : error instanceof DurableStoreError || store?.failed
              ? new PairingError(
                  "durable_store_unavailable",
                  "Kin's durable service is unavailable. Restart the service before retrying.",
                  503,
                )
              : new PairingError(
                  "server_error",
                  "Kin could not complete that request.",
                  500,
                );
      console.error(
        JSON.stringify({
          event: "request_failed",
          requestId,
          outcome: safe.code,
        }),
      );
      json(response, safe.status, { error: safe.code, message: safe.message });
    }
  });
  const pruneExpiredDeletions = () => {
    try {
      for (const householdId of service.finalizeExpiredDeletions(context.now()))
        syncService.forgetHousehold(householdId);
    } catch {
      console.error(
        JSON.stringify({
          event: "household_deletion_finalize_failed",
          outcome: "durable_store_unavailable",
        }),
      );
    }
  };
  const lifecycleTimer = setInterval(pruneExpiredDeletions, 60_000);
  lifecycleTimer.unref?.();
  feedbackService.start();
  calendarSyncService.start();
  server.on("close", () => { clearInterval(lifecycleTimer); feedbackService.stop(); calendarSyncService.stop(); });
  server.on("upgrade", (request, socket, head) => {
    try {
      liveService.handleUpgrade(request, socket, head);
    } catch {
      socket.destroy();
    }
  });
  // close() waits for open sockets, so end live connections first.
  const close = server.close.bind(server);
  server.close = (callback) => {
    liveService.closeAll();
    return close(callback);
  };
  return {
    mode,
    server,
    /** Attaches home mode's control panel (server/home/control-panel.mjs). */
    attachControlPanel(panel) { context.controlPanel = panel; },
    service,
    syncService,
    pushService,
    chatBlobService,
    chatRelayService,
    boardRelayService,
    privateRelayService,
    privateBlobService,
    accountVaultService,
    feedbackService,
    calendarSyncService,
    liveService,
    householdMoves: context.householdMoves,
    webauthn,
    store,
    flows: context.flows,
    origin,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  let application;
  try {
    // The sandbox (#106): refuse to serve without it, except for explicit
    // local development (`npm run dev`), which Node's --watch needs.
    const unrestricted = process.argv.includes("--unrestricted");
    const problem = permissionProblem(configuredDatabasePath());
    if (problem && !unrestricted) {
      const error = new Error(problem);
      error.code = "permission_model_required";
      throw error;
    }
    if (unrestricted && process.permission)
      throw Object.assign(new Error("--unrestricted cannot be combined with Node's permission model."), { code: "permission_model_required" });
    if (unrestricted)
      console.warn(JSON.stringify({ event: "permission_model_disabled", message: "Running without Node's permission model. Use this only for local development." }));
    const port = Number(process.env.KIN_PORT ?? 8000);
    const host = process.env.KIN_HOST ?? "127.0.0.1";
    let origin = process.env.KIN_ORIGIN ?? `http://localhost:${port}`;
    // Home mode (ADR 0025 §9, #733): with a name in the home settings, the
    // origin is https://<name> and the tunnel and certificate manager start
    // once the loopback listener is up. Without one it runs as before on
    // loopback, for the setup page (#718). Hosted Kin never loads server/home.
    const dataDirectory = dirname(configuredDatabasePath());
    let homeSettings = null;
    if (serverMode(process.env.KIN_MODE) === "home") {
      // A restore the control panel asked for (#721) runs before the
      // database is opened, and before the settings are read: a backup put
      // back on a new computer brings its home settings with it.
      const { runPendingRestore } = await import("./home/backups.mjs");
      await runPendingRestore({ dataDirectory, databasePath: configuredDatabasePath(), log: (event) => console.log(JSON.stringify(event)) });
      const { homeOrigin, loadHomeSettings } = await import("./home/settings.mjs");
      homeSettings = await loadHomeSettings(dataDirectory);
      if (homeSettings.configured) origin = homeOrigin(homeSettings, process.env.KIN_ORIGIN);
    }
    // The new-household limit the control panel set (ADR 0025 §9), unless
    // KIN_MAX_HOUSEHOLDS says otherwise.
    const panelLimit = homeSettings?.maxHouseholds && !process.env.KIN_MAX_HOUSEHOLDS?.trim() ? { maxHouseholds: homeSettings.maxHouseholds } : {};
    application = createKinServer({
      port,
      host,
      origin,
      acquireProcessLock: true,
      ...panelLimit,
    });
    let shutdown = () => {};
    // The control panel (ADR 0025 §11, #718): setup on first run, then the
    // status page, on loopback and for household admins at https://<name>.
    if (homeSettings) {
      const { createControlPanel } = await import("./home/control-panel.mjs");
      await createControlPanel({
        application, dataDirectory, databasePath: configuredDatabasePath(), settings: homeSettings,
        trustedProxies: parseTrustedProxies(process.env.KIN_TRUSTED_PROXIES),
        log: (event) => console.log(JSON.stringify(event)),
        // Setup's last step: start again under the new name. The launcher
        // (server/launcher.mjs) starts the service again on this exit code.
        restart: (reason) => {
          console.log(JSON.stringify({ event: "service_restart_requested", reason }));
          process.exitCode = RESTART_EXIT_CODE;
          setTimeout(() => shutdown("restart"), 250).unref();
        },
      });
    }
    application.server.on("error", (error) => {
      const code =
        typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
          ? error.code
          : "UNKNOWN";
      const guidance = {
        EADDRINUSE:
          "Another process is already listening on this address. Stop that process or choose a different KIN_PORT, then retry.",
        EACCES:
          "The operating system denied access to this address or port. Check port reservations and permissions, or choose a different KIN_PORT, then retry.",
        EADDRNOTAVAIL:
          "The configured KIN_HOST is unavailable on this computer. Choose an available loopback address and retry.",
      };
      console.error(
        JSON.stringify({
          event: "startup_failed",
          outcome: "listen_failed",
          code,
          host,
          port,
          message:
            guidance[code] ??
            "Kin could not listen on the configured address. Check KIN_HOST and KIN_PORT, then retry.",
        }),
      );
      application.store?.close();
      process.exitCode = 1;
    });
    application.server.listen(port, host, () => {
      console.log(JSON.stringify({ event: "service_ready", origin, mode: application.mode }));
      application.controlPanel?.started();
      if (homeSettings && !homeSettings.configured)
        console.log(JSON.stringify({ event: "home_not_configured", message: "No home server name is set, so the tunnel to the connection relay is off. Set it up on this computer (docs/HOME-SERVER.md)." }));
      if (!homeSettings?.configured) return;
      Promise.all([import("./home/home-server.mjs"), import("./home/control-panel.mjs")])
        .then(([{ startHomeServer }, { certificateAlerts }]) => startHomeServer({
          application, dataDirectory, settings: homeSettings, log: (event) => console.log(JSON.stringify(event)),
          // Fewer than 14 days left, or a certificate this server didn't
          // make: the household admins get a content-free push (§5).
          onCertificateEvent: certificateAlerts(application.pushService, { log: (event) => console.log(JSON.stringify(event)) }),
        }))
        .then((home) => { application.home = home; })
        .catch((error) => {
          // The home key or a home file couldn't be read or made: serving
          // without the tunnel would look healthy and reach no one.
          console.error(JSON.stringify({ event: "startup_failed", outcome: "home_start_failed", ...(typeof error?.code === "string" ? { code: error.code } : {}), message: error?.message ?? "Kin's home server could not start its tunnel." }));
          process.exitCode = 1;
          application.server.close(() => application.store?.close());
        });
    });
    shutdown = installShutdown(application);
  } catch (error) {
    application?.store?.close();
    console.error(
      JSON.stringify({
        event: "startup_failed",
        outcome:
          ["durable_lock_exists", "permission_model_required", "feedback_github_invalid", "server_mode_invalid", "home_mode_setting_refused", "home_settings_invalid"].includes(error.code)
            ? error.code
            : "configuration_or_storage",
        ...(["durable_lock_exists", "trusted_proxies_invalid", "household_policy_invalid", "permission_model_required", "feedback_github_invalid", "server_mode_invalid", "home_mode_setting_refused", "home_settings_invalid"].includes(error.code) ? { message: error.message } : {}),
        ...(error.code === "ERR_ACCESS_DENIED" || error.cause?.code === "ERR_ACCESS_DENIED" ? { message: "Node's permission model denied access to a path the service needs. Start Kin with server/start.mjs, which allows the app and data directories." } : {}),
      }),
    );
    process.exitCode = 1;
  }
}

function assertSecureOrigin(host, origin) {
  let external;
  try {
    external = new URL(origin);
  } catch {
    throw new Error("Kin requires a valid configured origin.");
  }
  const loopback = (value) =>
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "::1" ||
    value === "[::1]" ||
    (isIP(value) === 4 && value.split(".")[0] === "127");
  if (!loopback(host))
    throw new Error(
      "Kin's built-in server must bind to loopback; use a trusted TLS proxy for external access.",
    );
  if (
    !["http:", "https:"].includes(external.protocol) ||
    external.username ||
    external.password ||
    external.search ||
    external.hash ||
    (external.pathname !== "/" && external.pathname !== "")
  )
    throw new Error("Kin requires a valid origin without credentials or a path.");
  if (external.protocol !== "https:" && !loopback(external.hostname)) {
    throw new Error(
      "Kin requires an HTTPS origin outside loopback development.",
    );
  }
}

async function api(request, response, url, context) {
  const { service, syncService, webauthn, secureCookies } = context;
  withTransaction(context, () => {
    for (const expired of service.expireTemporaryMemberships(context.now()))
      syncService.onAccessChange(expired.householdId, expired.deviceIds);
  });
  for (const householdId of service.finalizeExpiredDeletions(context.now()))
    syncService.forgetHousehold(householdId);
  // A chat blob upload is authorized before its body is read, so nobody
  // without a session can make the service buffer 4 MiB.
  const chatBlobRoute = CHAT_BLOB_ROUTE.exec({ pathname: url.pathname })?.pathname.groups.ref ?? null;
  let chatUploadAuth = null;
  if (request.method === "PUT" && chatBlobRoute) {
    chatUploadAuth = syncService.authorize(cookies(request).kin_session);
    // A member who can't post is refused before the body is read.
    context.chatBlobService.assertCanChat(chatUploadAuth, "write");
  }
  // A private blob upload (#502) likewise: only the member's own trusted
  // devices, while private storage is theirs to use.
  const privateBlobRoute = PRIVATE_BLOB_ROUTE.exec({ pathname: url.pathname })?.pathname.groups.ref ?? null;
  let privateUploadAuth = null;
  if (request.method === "PUT" && privateBlobRoute) {
    privateUploadAuth = syncService.authorize(cookies(request).kin_session);
    context.privateBlobService.assertCanUse(privateUploadAuth);
  }
  // A report (ADR 0021 §3) is checked against its sender's limits before
  // its body (up to a 1 MiB screenshot) is read.
  const feedbackPost = request.method === "POST" && (url.pathname === "/api/feedback" || url.pathname === "/api/feedback/anonymous");
  let feedbackAuth = null;
  if (feedbackPost) {
    if (url.pathname === "/api/feedback") {
      feedbackAuth = service.authorize(cookies(request).kin_session);
      context.feedbackService.assertSignedAllowed(context.clientKey(request));
    } else context.feedbackService.assertAnonymousAllowed(context.clientKey(request));
  }
  const binaryUpload = (request.method === "POST" && /^\/api\/sync\/attachments\/[a-f0-9]{32}$/.test(url.pathname)) ||
    chatUploadAuth !== null || privateUploadAuth !== null ||
    (request.method === "PUT" && url.pathname === "/api/household/settings");
  // Event envelopes travel as binary batches (web/sync/envelope-wire.js).
  const envelopePush = request.method === "POST" &&
    (url.pathname === "/api/sync/events" || url.pathname === "/api/chat/events" || url.pathname === "/api/board/events" ||
      url.pathname === "/api/private/events");
  const body = envelopePush
    ? await readEnvelopeBatch(request, response)
    : binaryUpload
    ? await readBinary(request, response)
    : request.method === "PUT" && url.pathname === "/api/household/install-identity"
    ? await readJsonBody(request, response, MAX_INSTALL_IDENTITY_BODY_BYTES)
    : request.method === "PUT" && url.pathname === "/api/chat/hidden"
    ? await readJsonBody(request, response, MAX_CHAT_HIDDEN_RECORD_BYTES + 1024)
    : request.method === "PUT" && url.pathname === "/api/chat/receipts"
    ? await readJsonBody(request, response, MAX_CHAT_RECEIPT_BYTES + 1024)
    : request.method === "PUT" && url.pathname.startsWith("/api/account/vault")
    ? await readJsonBody(request, response, MAX_ACCOUNT_VAULT_BODY_BYTES)
    : request.method === "POST" && url.pathname === "/api/sync/epochs"
    ? await readJsonBody(request, response, MAX_EPOCH_COMMIT_BODY_BYTES)
    : feedbackPost
    ? await readJsonBody(request, response, MAX_FEEDBACK_REQUEST_BYTES)
    : ["POST", "PUT", "DELETE"].includes(request.method)
    ? await readJsonBody(request, response, MAX_JSON_BODY_BYTES)
    : {};
  if (
    request.method === "POST" &&
    url.pathname.endsWith("/finish") &&
    typeof body.flow === "string"
  )
    request.kinPasskeyFlow = body.flow;
  const session = cookies(request).kin_session;
  const claimToken = cookies(request).kin_claim;
  const deviceToken = cookies(request).kin_device;

  if (request.method === "GET" && url.pathname === "/api/household/lifecycle") {
    const householdId = url.searchParams.get("householdId") ?? "";
    if (!/^[a-f0-9]{32}$/.test(householdId)) throw badRequest();
    const knownHousehold = service.households.get(householdId);
    const lifecycle =
      context.store?.lifecycleInfo(householdId) ??
      (knownHousehold
        ? {
            state: knownHousehold.lifecycleState ?? "active",
            finalizeAt: knownHousehold.deletionFinalizeAt ?? null,
          }
        : null);
    if (!lifecycle)
      throw new PairingError(
        "household_not_found",
        "That household is unavailable.",
        404,
      );
    json(response, 200, {
      state: lifecycle.state,
      finalizeAt: lifecycle.finalizeAt,
      message:
        lifecycle.state === "deleted"
          ? "This household was deleted and can no longer sync."
          : lifecycle.state === "deletion_pending"
            ? "This household is pending deletion and can no longer sync."
            : "This household is active.",
    });
    return;
  }

  // Problem reports and suggestions (ADR 0021 §3, #636).
  if (feedbackPost) {
    const result = context.feedbackService.submit({ auth: feedbackAuth, body, clientKey: context.clientKey(request) });
    json(response, result.duplicate ? 200 : 201, { reference: result.reference, status: result.status });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/feedback/channel") {
    json(response, 200, await context.feedbackService.channel());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/feedback/mine") {
    json(response, 200, context.feedbackService.mine(service.authorize(session)));
    return;
  }
  // Outside calendars (ADR 0022 §3, #667): list, add, turn off, and the feed
  // for a device in the calendar's audience.
  if (url.pathname === "/api/calendar/subscriptions") {
    if (request.method === "GET") {
      json(response, 200, context.calendarSyncService.list(syncService.authorize(session)));
      return;
    }
    if (request.method === "POST") {
      const subscription = await context.calendarSyncService.add(syncService.authorize(session), body);
      json(response, 201, { subscription });
      return;
    }
  }
  const calendarFeed = CALENDAR_FEED_ROUTE.exec({ pathname: url.pathname })?.pathname.groups.id ?? null;
  if (calendarFeed && request.method === "GET") {
    const ifNoneMatch = typeof request.headers["if-none-match"] === "string" ? request.headers["if-none-match"] : null;
    const feed = await context.calendarSyncService.feed(syncService.authorize(session), calendarFeed, { ifNoneMatch });
    const headers = { "Cache-Control": "no-store", "X-Kin-Calendar-Fetched-At": String(feed.fetchedAt) };
    if (feed.etag) headers.ETag = feed.etag;
    if (feed.notModified) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, { ...headers, "Content-Type": "text/calendar; charset=utf-8", "Content-Length": feed.body.length });
    response.end(feed.body);
    return;
  }
  const calendarSubscription = CALENDAR_SUBSCRIPTION_ROUTE.exec({ pathname: url.pathname })?.pathname.groups.id ?? null;
  if (calendarSubscription && request.method === "DELETE") {
    json(response, 200, context.calendarSyncService.remove(syncService.authorize(session), calendarSubscription));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    let identity = null;
    let claim = null;
    let householdLifecycle = null;
    try {
      const auth = service.authorize(session);
      identity = {
        householdId: auth.household.id,
        memberId: auth.member.id,
        deviceId: auth.device.id,
      };
    } catch (error) {
      // A household that is moving keeps its session: the move may fail.
      if (session && error?.code !== "household_moving") clearCookie(response, "kin_session", secureCookies);
      if (deviceToken) {
        try {
          const { member, device } = service.trustedDevice(deviceToken, {
            allowDeletionPending: true,
            allowMoved: true,
          });
          const household = service.households.get(member.householdId);
          const move = household && service.householdMoves.get(household.id);
          if (move && household.lifecycleState === "active") {
            // ADR 0026 §5 (#738): where the household is now.
            const moveStatus = context.householdMoves.status(household.id);
            householdLifecycle = {
              householdId: household.id,
              state: move.state === "moved" ? "moved" : "moving",
              movedTo: move.targetOrigin,
              movedAt: moveStatus.movedAt,
              undoUntil: moveStatus.undoUntil,
              remindAt: moveStatus.remindAt,
              admin: Boolean(member.householdAdmin),
              message: move.state === "moved" ? `This household moved to ${move.targetOrigin}.` : "This household is moving to its home server.",
            };
          } else if (household?.lifecycleState === "deletion_pending")
            householdLifecycle = {
              householdId: household.id,
              state: "deletion_pending",
              finalizeAt: household.deletionFinalizeAt,
              message:
                "This household is pending deletion and can no longer sync.",
            };
          else if (!device.revokedAt && !member.active)
            clearCookie(response, "kin_device", secureCookies);
        } catch (error) {
          if (!["household_deletion_pending", "household_deleted", "household_moved", "household_moving"].includes(error.code))
            clearCookie(response, "kin_device", secureCookies);
        }
      }
    }

    try {
      claim = claimToken ? service.pairingForClaim(claimToken) : null;
      if (["Expired", "Revoked"].includes(claim?.state))
        clearCookie(response, "kin_claim", secureCookies);
    } catch {
      clearCookie(response, "kin_claim", secureCookies);
    }
    json(response, 200, { identity, claim, householdLifecycle });
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/passkeys/register/options"
  ) {
    if (!["bootstrap", "claim"].includes(body.purpose)) throw badRequest();
    // Refuse before the passkey prompt, not after it (#157).
    if (body.purpose === "bootstrap")
      service.assertBootstrapAllowed(context.clientKey(request));
    let flowPurpose = body.purpose;
    if (body.purpose === "claim") {
      const pairing = service.validatePairingCode(body.code, {
        rateKey: context.clientKey(request),
      });
      if (pairing.purpose !== "adult")
        flowPurpose = `${pairing.purpose}-claim`;
      if (claimToken) {
        service.clearClaim(claimToken);
        clearCookie(response, "kin_claim", secureCookies);
      }
    }
    const issued = issueRegistrationFlow(
      {
        purpose: flowPurpose,
        code: body.code,
        // Only an automatic name is kept, even in memory (#71).
        deviceLabel: deviceLabel(body.deviceLabel),
      },
      context,
      { anonymous: body.purpose === "bootstrap" },
    );
    json(response, 200, issued);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/passkeys/register/finish"
  ) {
    const flow = consumeFlow(body.flow, context);
    const credential = webauthn.verifyRegistration(body.credential, body.flow);
    if (flow.purpose === "bootstrap") {
      const result = service.bootstrap({
        credential,
        deviceLabel: flow.deviceLabel,
        syncPublicKeys: body.syncPublicKeys,
        rateKey: context.clientKey(request),
      });
      cookie(response, "kin_session", result.sessionToken, secureCookies);
      cookie(
        response,
        "kin_device",
        result.deviceToken,
        secureCookies,
        31_536_000,
      );
      json(response, 201, omitToken(result));
      return;
    }
    const result = service.claimPairing({
      code: flow.code,
      credential,
      deviceLabel: flow.deviceLabel,
      syncPublicKeys: body.syncPublicKeys,
      rateKey: context.clientKey(request),
    });
    cookie(response, "kin_claim", result.claimToken, secureCookies);
    cookie(
      response,
      "kin_device",
      result.deviceToken,
      secureCookies,
      31_536_000,
    );
    json(response, 200, omitToken(result));
    return;
  }
  // Username and password accounts (ADR 0018, #558). The browser sends
  // authKey, derived from the password; the password itself never arrives.
  if (request.method === "POST" && url.pathname === "/api/account/username") {
    json(response, 200, service.usernameAvailable(body.username, context.clientKey(request)));
    return;
  }
  // The first run checks an invitation code before a password is chosen,
  // with the same per-client limit as every code attempt.
  if (request.method === "POST" && url.pathname === "/api/account/invitation") {
    json(response, 200, service.validatePairingCode(body.code, { rateKey: context.clientKey(request) }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/account/bootstrap") {
    const rateKey = context.clientKey(request);
    // Refused before any Argon2id work, like the passkey prompt (#157).
    service.assertBootstrapAllowed(rateKey);
    const password = await service.preparePassword(body);
    const result = withTransaction(context, () => service.bootstrap({
      password,
      deviceLabel: deviceLabel(body.deviceLabel),
      syncPublicKeys: body.syncPublicKeys,
      rateKey,
    }));
    cookie(response, "kin_session", result.sessionToken, secureCookies);
    cookie(response, "kin_device", result.deviceToken, secureCookies, 31_536_000);
    json(response, 201, omitToken(result));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/account/claim") {
    const rateKey = context.clientKey(request);
    // The code is checked (and a wrong one charged) before any Argon2id work.
    const pairing = service.validatePairingCode(body.code, { rateKey });
    if (pairing.purpose !== "adult")
      throw new PairingError("passkey_required", "Adding a device to an existing member still uses a passkey.", 409);
    const password = await service.preparePassword(body);
    if (claimToken) {
      service.clearClaim(claimToken);
      clearCookie(response, "kin_claim", secureCookies);
    }
    const result = service.claimPairing({
      code: body.code,
      password,
      deviceLabel: deviceLabel(body.deviceLabel),
      syncPublicKeys: body.syncPublicKeys,
      rateKey,
    });
    cookie(response, "kin_claim", result.claimToken, secureCookies);
    cookie(response, "kin_device", result.deviceToken, secureCookies, 31_536_000);
    json(response, 200, omitToken(result));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/login/password") {
    const result = await service.signInWithPassword({
      deviceToken,
      username: body.username,
      authKey: body.authKey,
      rateKey: context.clientKey(request),
    });
    cookie(response, "kin_session", result.sessionToken, secureCookies);
    cookie(response, "kin_device", result.deviceToken, secureCookies, 31_536_000);
    json(response, 200, omitToken(result));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/claim/activate/password") {
    const result = await service.activateClaimWithPassword(claimToken, body.authKey, context.clientKey(request));
    cookie(response, "kin_session", result.sessionToken, secureCookies);
    cookie(response, "kin_device", result.deviceToken, secureCookies, 31_536_000);
    clearCookie(response, "kin_claim", secureCookies);
    json(response, 200, omitToken(result));
    return;
  }
  // Signing in on a device with no cookie (ADR 0018 section 4, #568). A
  // sign-in earns a short-lived new-device capability (HttpOnly cookie
  // kin_new_device), never a session; the capability downloads the vault and
  // registers this browser as one of the member's devices, once.
  const newDeviceToken = cookies(request).kin_new_device;
  const vaultWrappers = (member) => context.accountVaultService.wrapperSummary(member.householdId, member.id);
  const issueNewDevice = (issued) => {
    if (issued.token) cookie(response, "kin_new_device", issued.token, secureCookies, Math.ceil(NEW_DEVICE_TTL_MS / 1000));
    json(response, 200, issued.view);
  };
  if (request.method === "POST" && url.pathname === "/api/account/sign-in/parameters") {
    json(response, 200, service.signInParameters(body.username, context.clientKey(request)));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/account/sign-in/password") {
    issueNewDevice(await service.signInNewDeviceWithPassword({
      username: body.username, authKey: body.authKey, rateKey: context.clientKey(request),
      vaultWrapperTypes: (member) => vaultWrappers(member)?.map((wrapper) => wrapper.type) ?? null,
    }));
    return;
  }
  // The third way in (#572): username and backup code.
  if (request.method === "POST" && url.pathname === "/api/account/sign-in/backup-code") {
    issueNewDevice(service.signInNewDeviceWithBackupCode({
      username: body.username, codeAuth: body.codeAuth, rateKey: context.clientKey(request),
      backupCodeVerifier: (member) => context.accountVaultService.backupCodeVerifier(member.householdId, member.id),
    }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/account/sign-in/passkey/options") {
    const rateKey = context.clientKey(request);
    let pending = null;
    if (newDeviceToken) {
      try { pending = service.newDeviceCapability(newDeviceToken, { allowPending: true }).record; } catch { pending = null; }
      if (!pending?.needsPasskey) pending = null;
    }
    const { memberId, credentials } = service.newDevicePasskeyCredentials({ username: body.username, pending, rateKey, vaultWrappers });
    service.assertNewDevicePasskeyAllowed(memberId, rateKey);
    const flow = createFlow({ purpose: "new-device", memberId, credentialIds: credentials.map((entry) => entry.id), pending: Boolean(pending) },
      context, { anonymous: true });
    try {
      json(response, 200, {
        flow,
        publicKey: context.webauthn.authenticationOptions(flow, credentials.map((entry) => entry.id)),
        // Each passkey's PRF input for its vault wrapper (public parameters).
        prfSalts: Object.fromEntries(credentials.map((entry) => [entry.id, entry.prfSalt])),
      });
    } catch (error) {
      context.flows.delete(flow);
      context.webauthn.discardFlow?.(flow);
      throw error;
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/account/sign-in/passkey/finish") {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "new-device") throw badRequest();
    const rateKey = context.clientKey(request);
    service.assertNewDevicePasskeyAllowed(flow.memberId, rateKey);
    const credentialId = body.credential?.id;
    const credential = flow.memberId && flow.credentialIds.includes(credentialId) ? service.credentials.get(credentialId) : null;
    try {
      if (!credential || credential.memberId !== flow.memberId)
        throw new PairingError("sign_in_failed", "That passkey didn't match. Try again or use your password.", 401);
      context.webauthn.verifyAuthentication(body.credential, body.flow, credential);
    } catch {
      context.webauthn.discardFlow?.(body.flow);
      service.newDevicePasskeyFailed(flow.memberId, rateKey);
      throw new PairingError("sign_in_failed", "That passkey didn't match. Try again or use your password.", 401);
    }
    const issued = service.completeNewDevicePasskey({
      memberId: flow.memberId, credentialId, pendingToken: flow.pending ? newDeviceToken : null, vaultWrappers,
    });
    // The verified signature counter is kept, as for any passkey sign-in.
    withTransaction(context, () => service.persistHousehold(service.members.get(flow.memberId).householdId));
    issueNewDevice(issued);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/account/sign-in") {
    json(response, 200, service.newDeviceView(service.newDeviceCapability(newDeviceToken, { allowPending: true }).record));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/account/sign-in/cancel") {
    if (newDeviceToken) service.cancelNewDeviceCapability(newDeviceToken);
    clearCookie(response, "kin_new_device", secureCookies);
    json(response, 200, { cancelled: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/account/sign-in/vault") {
    const capability = service.spendNewDeviceDownload(newDeviceToken);
    json(response, 200, {
      ...context.accountVaultService.downloadWithCapability(capability, context.clientKey(request)),
      // Whether the account has a backup code (#572): then a passkey-only
      // sign-in asks for no per-device backup key.
      backupCode: context.accountVaultService.backupCodeVerifier(capability.householdId, capability.memberId) !== null,
      certificationEndorsement: service.certificationEndorsement(capability.memberId),
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/account/sign-in/device") {
    // A backup-code sign-in (#572) sets a new password with the device, and
    // re-wraps (or removes) the vault wrappers that depended on the old one
    // in the same transaction. The password is hashed first (Argon2id is
    // asynchronous); everything else happens inside the transaction.
    const pendingMethod = service.newDeviceCapability(newDeviceToken).record.method;
    const newPassword = pendingMethod === "backup-code" && body.newPassword ? await service.preparePasswordChange(body.newPassword) : null;
    const vaultChange = pendingMethod === "backup-code" && body.vaultChange ? context.accountVaultService.parseChange(body.vaultChange) : null;
    const result = withTransaction(context, () => {
      const { record } = service.newDeviceCapability(newDeviceToken);
      // The vault change goes first: it only touches the database, so a
      // refusal rolls back cleanly before the device is registered.
      if (vaultChange && record.method === "backup-code")
        context.accountVaultService.applyChange({ household: { id: record.householdId }, member: { id: record.memberId } }, vaultChange);
      const registered = service.registerNewDevice({
        newPassword: record.method === "backup-code" ? newPassword : null,
        capability: newDeviceToken,
        syncPublicKeys: body.syncPublicKeys,
        certificate: body.certificate,
        replaceDeviceId: body.replaceDeviceId ?? null,
        deviceLabel: deviceLabel(body.deviceLabel),
        vaultEpochs: body.vaultEpochs ?? [],
        currentEpoch: syncService.state(record.householdId).currentEpoch,
      });
      // A replaced device is left out of the next epoch; the new device gets
      // every epoch it doesn't have, like any same-member device.
      if (registered.replacedDeviceId) syncService.onAccessChange(registered.householdId, [registered.replacedDeviceId]);
      syncService.onDeviceAdded(registered.householdId, registered.deviceId, { historyFromEpoch: 1 });
      return registered;
    });
    cookie(response, "kin_session", result.sessionToken, secureCookies);
    cookie(response, "kin_device", result.deviceToken, secureCookies, 31_536_000);
    clearCookie(response, "kin_new_device", secureCookies);
    json(response, 201, omitToken(result));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/login/options") {
    const { member, device } = service.trustedDevice(deviceToken);
    const issued = issueAuthenticationFlow(
      { purpose: "login", memberId: member.id, deviceId: device.id },
      [...member.credentials],
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/login/finish") {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "login") throw badRequest();
    const { member, device } = service.trustedDevice(deviceToken);
    if (flow.memberId !== member.id || flow.deviceId !== device.id)
      throw badRequest();
    const credential = service.credentials.get(body.credential?.id);
    webauthn.verifyAuthentication(body.credential, body.flow, credential);
    const result = service.reauthenticate(deviceToken, body.credential.id);
    cookie(response, "kin_session", result.sessionToken, secureCookies);
    cookie(
      response,
      "kin_device",
      result.deviceToken,
      secureCookies,
      31_536_000,
    );
    json(response, 200, omitToken(result));
    return;
  }
  // Phone-approved sign-in (#99). The request secret travels only in request
  // bodies, never in a URL; every route takes it as `secret`.
  // Each link call saves the households whose requests it ended once its own
  // transaction is over, so a rolled-back failure keeps its audit (#99).
  const linked = (operation) => {
    try {
      return operation();
    } finally {
      service.flushLinkAudits();
    }
  };
  if (request.method === "POST" && url.pathname === "/api/link/requests") {
    const created = linked(() => service.createLinkRequest({
      syncPublicKeys: body.syncPublicKeys,
      deviceLabel: body.deviceLabel,
      deviceToken,
      rateKey: context.clientKey(request),
    }));
    json(response, 201, created);
    return;
  }
  const linkMatch = url.pathname.match(
    /^\/api\/link\/requests\/([a-f0-9]{32})(?:\/(status|approve\/options|approve\/finish|complete))?$/,
  );
  if (linkMatch) {
    const [, requestId, action] = linkMatch;
    if (request.method === "DELETE" && !action) {
      json(response, 200, linked(() => service.cancelLinkRequest(requestId, body.secret)));
      return;
    }
    if (request.method === "POST" && action === "status") {
      json(response, 200, linked(() => service.linkStatus(requestId, body.secret)));
      return;
    }
    if (request.method === "POST" && action === "approve/options") {
      const auth = service.authorize(session);
      const view = linked(() => service.linkRequestForApprover(session, requestId, {
        secret: body.secret,
        fingerprint: body.fingerprint,
      }));
      const issued = issueAuthenticationFlow(
        { purpose: "link-approve", requestId, memberId: auth.member.id },
        [...auth.member.credentials],
        context,
      );
      json(response, 200, { ...issued, request: view });
      return;
    }
    if (request.method === "POST" && action === "approve/finish") {
      const auth = service.authorize(session);
      const flow = consumeFlow(body.flow, context);
      if (flow.purpose !== "link-approve" || flow.requestId !== requestId || flow.memberId !== auth.member.id)
        throw badRequest();
      await confirmFresh(context, request, auth.member, body, () => {
        const credential = service.credentialForAuthenticatedMember(session, body.credential?.id);
        webauthn.verifyAuthentication(body.credential, body.flow, credential);
      });
      const approved = linked(() => withTransaction(context, () =>
        service.approveLinkRequest(session, requestId, {
          secret: body.secret,
          fingerprint: body.fingerprint,
          deviceCertificate: body.deviceCertificate,
          code: body.code,
          tag: body.tag,
        }),
      ));
      json(response, 200, approved);
      return;
    }
    if (request.method === "POST" && action === "complete") {
      const completed = linked(() => withTransaction(context, () => {
        const result = service.completeLinkRequest({
          requestId,
          secret: body.secret,
          code: body.code,
          rateKey: context.clientKey(request),
        });
        // A new computer receives the household's retained history, as a
        // device added with a pairing code does.
        if (result.newDevice) syncService.onDeviceAdded(result.householdId, result.deviceId, { historyFromEpoch: 1 });
        return result;
      }));
      cookie(response, "kin_session", completed.sessionToken, secureCookies);
      cookie(response, "kin_device", completed.deviceToken, secureCookies, 31_536_000);
      json(response, 200, omitToken(completed));
      return;
    }
  }
  if (request.method === "POST" && url.pathname === "/api/pairings") {
    json(response, 201, service.createPairing(session, {
      kind: body?.kind ?? "adult",
      ...(body && typeof body === "object" && Object.hasOwn(body, "expiresAt") ? { expiresAt: body.expiresAt } : {}),
    }));
    return;
  }
  // "Set up Kin for someone" (#613): a prepared invitation, and the ones
  // this member made that still wait.
  if (request.method === "POST" && url.pathname === "/api/pairings/prepared") {
    if (!body || typeof body !== "object") throw badRequest();
    json(response, 201, service.createPreparedPairing(session, {
      kind: body.kind ?? "adult",
      ...(Object.hasOwn(body, "expiresAt") ? { expiresAt: body.expiresAt } : {}),
      easyMode: body.easyMode ?? true,
      card: body.card ?? null,
      days: body.days ?? undefined,
    }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/pairings/prepared") {
    json(response, 200, { invitations: service.preparedPairings(session) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/devices/pairings") {
    json(response, 201, service.createDevicePairing(session));
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/devices/replacements"
  ) {
    json(
      response,
      201,
      service.createReplacementPairing(session, body.deviceId),
    );
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/recovery"
  ) {
    json(
      response,
      201,
      service.createMemberRecoveryPairing(session, body.memberId),
    );
    return;
  }
  const pairingMatch = url.pathname.match(/^\/api\/pairings\/([a-f0-9]{32})$/);
  if (request.method === "GET" && pairingMatch) {
    json(response, 200, service.pairingForAdult(session, pairingMatch[1]));
    return;
  }
  if (request.method === "DELETE" && pairingMatch) {
    json(response, 200, service.revokePairing(session, pairingMatch[1]));
    return;
  }
  const approveOptions = url.pathname.match(
    /^\/api\/pairings\/([a-f0-9]{32})\/approve\/options$/,
  );
  if (request.method === "POST" && approveOptions) {
    const auth = service.authorize(session);
    requireTrustAuthority(auth.member, "approve a pairing");
    const ids = [...auth.member.credentials];
    const issued = issueAuthenticationFlow(
      {
        purpose: "approve",
        pairingId: approveOptions[1],
        expectedVersion: body.expectedVersion,
        memberId: auth.member.id,
      },
      ids,
      context,
    );
    json(response, 200, issued);
    return;
  }
  const approveFinish = url.pathname.match(
    /^\/api\/pairings\/([a-f0-9]{32})\/approve\/finish$/,
  );
  if (request.method === "POST" && approveFinish) {
    const auth = service.authorize(session);
    const flow = consumeFlow(body.flow, context);
    if (
      flow.purpose !== "approve" ||
      flow.pairingId !== approveFinish[1] ||
      flow.memberId !== auth.member.id
    )
      throw badRequest();
    await confirmFresh(context, request, auth.member, body, () => {
      const credential = service.credentialForAuthenticatedMember(
        session,
        body.credential?.id,
      );
      webauthn.verifyAuthentication(body.credential, body.flow, credential);
    });
    const approved = withTransaction(context, () => {
      const result = service.approvePairing(
        session,
        flow.pairingId,
        flow.expectedVersion,
        body.deviceCertificate,
      );
      const pairing = service.pairings.get(flow.pairingId);
      const device = service.devices.get(pairing?.confirmedDeviceId);
      if (device?.syncPublicKeys && device.syncHistoryFromEpoch == null)
        syncService.onDeviceAdded(auth.household.id, device.id, {
          historyFromEpoch:
            ["device", "replacement", "member-recovery"].includes(
              pairing.purpose,
            )
              ? 1
              : undefined,
        });
      return result;
    });
    // A replacement or recovery revokes old devices: their sockets close now.
    context.liveService.revalidate(auth.household.id);
    json(response, 200, approved);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/claim") {
    const result = service.pairingForClaim(claimToken);
    if (["Expired", "Revoked"].includes(result.state))
      clearCookie(response, "kin_claim", secureCookies);
    json(response, 200, result);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/claim/activate/options"
  ) {
    const credential = service.claimCredential(claimToken);
    const issued = issueAuthenticationFlow(
      {
        purpose: "activate",
        claimToken,
      },
      [credential.id],
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/claim/activate/finish"
  ) {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "activate" || flow.claimToken !== claimToken)
      throw badRequest();
    webauthn.verifyAuthentication(
      body.credential,
      body.flow,
      service.claimCredential(claimToken),
    );
    const result = service.activateClaim(claimToken);
    cookie(response, "kin_session", result.sessionToken, secureCookies);
    cookie(
      response,
      "kin_device",
      result.deviceToken,
      secureCookies,
      31_536_000,
    );
    clearCookie(response, "kin_claim", secureCookies);
    json(response, 200, omitToken(result));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/logout") {
    // Signing out stops this browser's notifications (#85).
    // An expired session still names the browser through its device cookie.
    let signedOutDevice = null;
    try { signedOutDevice = service.authorize(session).device.id; } catch {
      try { signedOutDevice = service.trustedDevice(deviceToken, { allowDeletionPending: true }).device.id; } catch { /* no device */ }
    }
    if (signedOutDevice) context.pushService.signedOut(signedOutDevice);
    service.logout(session);
    if (signedOutDevice) context.liveService.revalidate(service.devices.get(signedOutDevice)?.householdId);
    clearCookie(response, "kin_session", secureCookies);
    json(response, 200, { loggedOut: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/devices") {
    const auth = service.authorize(session);
    json(response, 200, {
      devices: service.listDevices(session),
      canManageMembers: service.canManageMembers(auth.member, auth.household),
    });
    return;
  }
  const revokeOptionsMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9]{32})\/revocation\/options$/);
  if (request.method === "POST" && revokeOptionsMatch) {
    const revocation = service.deviceRevocationContext(session, revokeOptionsMatch[1]);
    const issued = issueAuthenticationFlow(
      {
        purpose: "revoke-device",
        targetDeviceId: revokeOptionsMatch[1],
        memberId: revocation.memberId,
        deviceId: revocation.deviceId,
      },
      revocation.credentialIds,
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/devices/revocation/finish") {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "revoke-device") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id)
      throw badRequest();
    await confirmFresh(context, request, auth.member, body, () => {
      const credential = service.credentials.get(body.credential?.id);
      if (!credential || credential.memberId !== auth.member.id)
        throw new PairingError("passkey_member_mismatch", "Use this Adult's passkey to continue.", 401);
      webauthn.verifyAuthentication(body.credential, body.flow, credential);
    });
    const target = service.devices.get(flow.targetDeviceId);
    const alreadyRevoked = Boolean(target?.revokedAt);
    const result = withTransaction(context, () => {
      const revoked = service.revokeDevice(session, flow.targetDeviceId, auth.member.id);
      if (target && !alreadyRevoked) syncService.onAccessChange(target.householdId, [target.id]);
      return revoked;
    });
    json(response, 200, result);
    return;
  }
  // The devices carried over from the old address (ADR 0026 §6), removed
  // together after one fresh confirmation: one revocation, one new epoch.
  if (request.method === "POST" && url.pathname === "/api/devices/carried-over/revocation/options") {
    const revocation = service.carriedOverRevocationContext(session);
    const issued = issueAuthenticationFlow(
      {
        purpose: "revoke-carried-over",
        deviceIds: revocation.deviceIds,
        memberId: revocation.memberId,
        deviceId: revocation.deviceId,
      },
      revocation.credentialIds,
      context,
    );
    json(response, 200, { ...issued, devices: revocation.deviceIds.length });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/devices/carried-over/revocation/finish") {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "revoke-carried-over") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id)
      throw badRequest();
    await confirmFresh(context, request, auth.member, body, () => {
      const credential = service.credentials.get(body.credential?.id);
      if (!credential || credential.memberId !== auth.member.id)
        throw new PairingError("passkey_member_mismatch", "Use this Adult's passkey to continue.", 401);
      webauthn.verifyAuthentication(body.credential, body.flow, credential);
    });
    const result = withTransaction(context, () => {
      const revoked = service.revokeCarriedOverDevices(session, flow.deviceIds, auth.member.id);
      if (revoked.length) syncService.onAccessChange(auth.household.id, revoked);
      return { revoked, revokedAt: revoked.length ? service.devices.get(revoked[0]).revokedAt : null };
    });
    json(response, 200, result);
    return;
  }
  const deviceMatch = url.pathname.match(/^\/api\/devices\/([a-f0-9]{32})$/);
  if (request.method === "DELETE" && deviceMatch) {
    throw new PairingError("fresh_auth_required", "Authenticate with your passkey before revoking a device.", 401);
  }
  if (request.method === "POST" && url.pathname === "/api/sync/device-keys/successor") {
    const auth = service.authorize(session);
    const result = withTransaction(context, () => {
      const transition = service.transitionSyncPublicKeys(session, body.transition);
      if (!transition.retried)
        syncService.onDeviceKeyTransition(auth.household.id, auth.device.id);
      return transition;
    });
    json(response, 200, result);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/sync/device-keys") {
    const auth = service.authorize(session);
    const keyedDevices = [...service.devices.values()].filter(
      (device) =>
        device.householdId === auth.household.id &&
        !device.revokedAt &&
        device.syncPublicKeys,
    ).length;
    const result = withTransaction(context, () => {
      const registered = service.registerSyncPublicKeys(session, body.publicKeys);
      if (registered.registered && keyedDevices > 0)
        syncService.onDeviceAdded(auth.household.id, auth.device.id, {
          historyFromEpoch: 1,
        });
      return registered;
    });
    json(response, 200, result);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/status") {
    json(response, 200, syncService.status(session));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/household/settings") {
    json(response, 200, syncService.householdSettings(session));
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/household/settings") {
    const expectedRevision = request.headers["x-household-settings-revision"];
    const keyEpoch = request.headers["x-household-settings-key-epoch"];
    const digest = request.headers["x-household-settings-sha256"];
    if (!/^\d+$/.test(expectedRevision ?? "") || !/^[1-9]\d{0,2}$/.test(keyEpoch ?? "") || typeof digest !== "string") throw badRequest();
    json(response, 200, syncService.updateHouseholdSettings(session, { expectedRevision: Number(expectedRevision), keyEpoch: Number(keyEpoch), digest, ciphertext: body }));
    return;
  }
  if (url.pathname === "/api/household/install-identity") {
    if (request.method === "GET") {
      json(response, 200, syncService.installIdentity(session));
      return;
    }
    if (request.method === "PUT") {
      json(response, 200, withTransaction(context, () => syncService.publishInstallIdentity(session, body)));
      return;
    }
    if (request.method === "DELETE") {
      json(response, 200, withTransaction(context, () => syncService.withdrawInstallIdentity(session, body.expectedRev)));
      return;
    }
  }
  if (chatUploadAuth) {
    // Authorized (and rate-limited) once, before the body was read.
    json(response, 200, withTransaction(context, () => context.chatBlobService.put(chatUploadAuth, chatBlobRoute, body)));
    return;
  }
  if (chatBlobRoute && request.method === "GET") {
    const bytes = context.chatBlobService.get(syncService.authorize(session), chatBlobRoute);
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "Cache-Control": "no-store" });
    response.end(bytes);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/chat/blobs/retire") {
    const auth = syncService.authorize(session);
    // Not in an outer transaction: the store zeroes freed pages and then
    // checkpoints the WAL, which needs no transaction open.
    json(response, 200, context.chatBlobService.retire(auth, body?.refs));
    return;
  }
  if (url.pathname.startsWith("/api/push/")) {
    const auth = syncService.authorize(session);
    const { pushService } = context;
    if (request.method === "GET" && url.pathname === "/api/push/vapid-public-key") {
      json(response, 200, { publicKey: pushService.publicKey() });
      return;
    }
    if (url.pathname === "/api/push/subscription") {
      if (request.method === "GET") { json(response, 200, pushService.status(auth)); return; }
      if (request.method === "PUT") { json(response, 200, withTransaction(context, () => pushService.subscribe(auth, body))); return; }
      if (request.method === "DELETE") { json(response, 200, withTransaction(context, () => pushService.unsubscribe(auth))); return; }
    }
    if (request.method === "PUT" && url.pathname === "/api/push/mute") {
      json(response, 200, withTransaction(context, () => pushService.mute(auth, body.choice ?? null)));
      return;
    }
  }
  if (request.method === "POST" && url.pathname === "/api/sync/enable") {
    json(response, 200, syncService.enable(session));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/devices") {
    json(response, 200, {
      devices: syncService.deviceDirectory(session),
      members: syncService.membershipDirectory(session),
    });
    return;
  }
  if (envelopePush && url.pathname === "/api/sync/events") {
    json(response, 200, syncService.push(session, body));
    return;
  }
  if (url.pathname === "/api/chat/events" && request.method === "POST") {
    const auth = syncService.authorize(session);
    json(response, 200, withTransaction(context, () => context.chatRelayService.push(auth, body, { chatEpoch: Number(request.headers["x-kin-chat-epoch"] ?? 0) })));
    return;
  }
  // The member's encrypted key vault (ADR 0018, #564). Only the session's
  // own member, from one of their trusted devices; no route names a member.
  if (url.pathname === "/api/account/vault" && request.method === "GET") {
    const auth = service.authorize(session);
    json(response, 200, {
      ...context.accountVaultService.download(auth, context.clientKey(request)),
      // Whether the member's certification key is endorsed yet (#568).
      certificationEndorsement: service.certificationEndorsement(auth.member.id),
    });
    return;
  }
  // A trusted device endorses its member's certification key (#570).
  if (url.pathname === "/api/account/certification" && request.method === "PUT") {
    syncService.authorize(session);
    json(response, 200, withTransaction(context, () => service.putCertificationEndorsement(session, body.endorsement)));
    return;
  }
  if (url.pathname === "/api/account/vault" && request.method === "PUT") {
    json(response, 200, context.accountVaultService.upload(syncService.authorize(session), body));
    return;
  }
  // One wrapper at a time (hardening after #561/#572): like every other
  // change to how the vault opens, these need the current password, fresh
  // (`currentAuthKey`), or a fresh passkey (`flow` and `credential` from
  // /api/account/confirm/options). A session alone, say a browser left
  // signed in, can't add a way into the vault or take one away.
  const vaultWrapper = ACCOUNT_VAULT_WRAPPER_ROUTE.exec({ pathname: url.pathname })?.pathname.groups.id ?? null;
  if (vaultWrapper && (request.method === "PUT" || request.method === "DELETE")) {
    syncService.authorize(session);
    const auth = await confirmAccountChange(context, request, session, body);
    const { currentAuthKey: _current, flow: _flow, credential: _credential, ...wrapper } = body;
    json(response, 200, request.method === "PUT"
      ? context.accountVaultService.putWrapper(auth, vaultWrapper, wrapper)
      : context.accountVaultService.removeWrapper(auth, vaultWrapper));
    return;
  }
  // A fresh passkey confirmation for an account change (the per-wrapper
  // routes above). A member without a passkey gets the password parameters
  // instead, as every fresh confirmation does.
  if (url.pathname === "/api/account/confirm/options" && request.method === "POST") {
    const auth = service.authorize(session);
    json(response, 200, issueAuthenticationFlow({ purpose: "account-confirm", memberId: auth.member.id, deviceId: auth.device.id },
      [...auth.member.credentials], context));
    return;
  }
  // Moving a member set up the old way (passkey and per-device backup key)
  // to an account (#575): a fresh assertion of their passkey, then a
  // username and password. The same touch gives the device the passkey's
  // PRF output for the vault wrapper; the service never sees it.
  if (url.pathname === "/api/account/migrate/options" && request.method === "POST") {
    const auth = service.authorize(session);
    service.assertAccountMigratable(auth.member);
    json(response, 200, issueAuthenticationFlow({ purpose: "account-migrate", memberId: auth.member.id, deviceId: auth.device.id },
      [...auth.member.credentials], context));
    return;
  }
  if (url.pathname === "/api/account/migrate/finish" && request.method === "POST") {
    const flow = consumeFlow(body.flow, context);
    const auth = service.authorize(session);
    if (flow.purpose !== "account-migrate" || flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id) throw badRequest();
    const credential = service.credentials.get(body.credential?.id);
    if (!credential || credential.memberId !== auth.member.id)
      throw new PairingError("passkey_member_mismatch", "Use your own passkey to continue.", 401);
    webauthn.verifyAuthentication(body.credential, body.flow, credential);
    service.assertAccountMigratable(auth.member);
    const prepared = await service.preparePassword(body);
    json(response, 200, withTransaction(context, () => service.migrateAccount(service.authorize(session), prepared)));
    return;
  }
  // Removing one of the member's passkeys (#592 follow-up): the vault
  // wrappers that named it go (and, for the last passkey, a password
  // wrapper comes back) in the same transaction, after the password.
  if (url.pathname === "/api/account/passkeys/remove" && request.method === "POST") {
    syncService.authorize(session);
    const vaultChange = body.vaultChange ? context.accountVaultService.parseChange(body.vaultChange) : null;
    const auth = await service.confirmAccountPassword(session, body.currentAuthKey, context.clientKey(request));
    json(response, 200, withTransaction(context, () => {
      if (vaultChange) context.accountVaultService.applyChange(auth, vaultChange);
      return service.removeAccountPasskey(auth, body.credentialId,
        context.accountVaultService.wrapperSummary(auth.household.id, auth.member.id));
    }));
    return;
  }
  // A member's own account security (ADR 0018, #560/#571). Every change
  // needs the current password, fresh (`currentAuthKey`).
  if (url.pathname === "/api/account/security" && request.method === "GET") {
    const auth = service.authorize(session);
    json(response, 200, service.accountSecurityView(auth, context.accountVaultService.summary(auth)));
    return;
  }
  // Swapping how the vault opens in one step: adding a passkey, require
  // password and passkey on or off, a new backup code (#561/#572).
  if (url.pathname === "/api/account/vault/wrappers" && request.method === "POST") {
    syncService.authorize(session);
    const auth = await service.confirmAccountPassword(session, body.currentAuthKey, context.clientKey(request));
    const { currentAuthKey: _current, ...change } = body;
    json(response, 200, context.accountVaultService.changeWrappers(auth, change));
    return;
  }
  // Adding a passkey to a password account (#561): a registration ceremony
  // for the signed-in member, after their password.
  if (url.pathname === "/api/account/passkeys/options" && request.method === "POST") {
    syncService.authorize(session);
    const auth = await service.confirmAccountPassword(session, body.currentAuthKey, context.clientKey(request));
    const flow = createFlow({ purpose: "account-passkey", memberId: auth.member.id, deviceId: auth.device.id }, context);
    try {
      json(response, 200, { flow, publicKey: context.webauthn.registrationOptions(flow, { userName: auth.member.username, displayName: auth.member.username }) });
    } catch (error) {
      context.flows.delete(flow);
      context.webauthn.discardFlow?.(flow);
      throw error;
    }
    return;
  }
  if (url.pathname === "/api/account/passkeys/finish" && request.method === "POST") {
    const flow = consumeFlow(body.flow, context);
    const auth = service.authorize(session);
    if (flow.purpose !== "account-passkey" || flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id) throw badRequest();
    const credential = webauthn.verifyRegistration(body.credential, body.flow);
    json(response, 200, withTransaction(context, () => service.addAccountPasskey(auth, credential)));
    return;
  }
  // Changing the password (#560): the new verifier and the vault wrappers
  // that depend on the password (re-wrapped by the device, `vaultChange`)
  // in one transaction, after the current password.
  if (url.pathname === "/api/account/password" && request.method === "POST") {
    syncService.authorize(session);
    const vaultChange = body.vaultChange ? context.accountVaultService.parseChange(body.vaultChange) : null;
    const prepared = await service.preparePasswordChange(body);
    const auth = await service.confirmAccountPassword(session, body.currentAuthKey, context.clientKey(request));
    json(response, 200, withTransaction(context, () => {
      if (vaultChange) context.accountVaultService.applyChange(auth, vaultChange);
      return service.setAccountPassword(auth, prepared);
    }));
    return;
  }
  if (url.pathname === "/api/chat/hidden" && request.method === "GET") {
    json(response, 200, context.chatRelayService.hidden(syncService.authorize(session), url.searchParams.get("since")));
    return;
  }
  if (url.pathname === "/api/chat/hidden" && request.method === "PUT") {
    const auth = syncService.authorize(session);
    json(response, 200, context.chatRelayService.putHidden(auth, body));
    return;
  }
  if (url.pathname === "/api/chat/receipts" && request.method === "GET") {
    json(response, 200, context.chatRelayService.receipts(syncService.authorize(session)));
    return;
  }
  if (url.pathname === "/api/chat/receipts" && request.method === "PUT") {
    const auth = syncService.authorize(session);
    json(response, 200, context.chatRelayService.putReceipt(auth, body));
    return;
  }
  if (url.pathname === "/api/chat/keys" && request.method === "GET") {
    json(response, 200, context.chatRelayService.keys(syncService.authorize(session)));
    return;
  }
  if (url.pathname === "/api/chat/keys" && request.method === "POST") {
    const auth = syncService.authorize(session);
    json(response, 200, withTransaction(context, () => context.chatRelayService.putKeys(auth, body)));
    return;
  }
  if (url.pathname === "/api/chat/keys/reject" && request.method === "POST") {
    json(response, 200, context.chatRelayService.rejectKey(syncService.authorize(session), body));
    return;
  }
  if (url.pathname === "/api/chat/storage" && request.method === "GET") {
    const auth = syncService.authorize(session);
    // usage() first: it refuses anyone who is not an admin.
    const blobs = context.chatBlobService.usage(auth);
    json(response, 200, { ...blobs, ...context.chatRelayService.eventUsage(auth) });
    return;
  }
  // The fridge (#317): the board relay stream.
  if (url.pathname === "/api/board/events" && request.method === "POST") {
    const auth = syncService.authorize(session);
    json(response, 200, withTransaction(context, () => context.boardRelayService.push(auth, body)));
    return;
  }
  if (url.pathname === "/api/board/status" && request.method === "GET") {
    const auth = syncService.authorize(session);
    json(response, 200, { ...context.boardRelayService.status(auth), ...context.boardRelayService.eventUsage(auth) });
    return;
  }
  if (url.pathname === "/api/board/events" && request.method === "GET") {
    const auth = syncService.authorize(session);
    try {
      binary(response, encodeEventPage(context.boardRelayService.pull(auth, url.searchParams.get("cursor") ?? "", url.searchParams.get("limit") ?? undefined)));
    } catch (error) {
      if (!(error instanceof EnvelopeWireError) &&
          !(error instanceof DurableStoreError && error.code === "sync_store_invalid")) throw error;
      console.error(JSON.stringify({ event: "board_store_invalid", householdId: auth.household.id }));
      throw new PairingError("sync_store_invalid", "Kin's stored fridge history is invalid.", 500);
    }
    return;
  }
  // A member's private stream (#491, ADR 0019): always the session's own
  // member's; no route names a member.
  if (url.pathname === "/api/private/events" && request.method === "POST") {
    const auth = syncService.authorize(session);
    json(response, 200, withTransaction(context, () => context.privateRelayService.push(auth, body)));
    return;
  }
  if (url.pathname === "/api/private/status" && request.method === "GET") {
    const auth = syncService.authorize(session);
    json(response, 200, { ...context.privateRelayService.status(auth), ...context.privateBlobService.usage(auth) });
    return;
  }
  // A member's private blobs (#502): always the session's own member's.
  if (privateUploadAuth) {
    json(response, 200, withTransaction(context, () => context.privateBlobService.put(privateUploadAuth, privateBlobRoute, body)));
    return;
  }
  if (privateBlobRoute && request.method === "GET") {
    const bytes = context.privateBlobService.get(syncService.authorize(session), privateBlobRoute);
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "Cache-Control": "no-store" });
    response.end(bytes);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/private/blobs/retire") {
    const auth = syncService.authorize(session);
    // Not in an outer transaction: the store zeroes freed pages and then
    // checkpoints the WAL, which needs no transaction open.
    json(response, 200, context.privateBlobService.retire(auth, body?.refs));
    return;
  }
  if (url.pathname === "/api/private/events" && request.method === "GET") {
    const auth = syncService.authorize(session);
    try {
      binary(response, encodeEventPage(context.privateRelayService.pull(auth, url.searchParams.get("cursor") ?? "", url.searchParams.get("limit") ?? undefined)));
    } catch (error) {
      if (!(error instanceof EnvelopeWireError) &&
          !(error instanceof DurableStoreError && error.code === "sync_store_invalid")) throw error;
      console.error(JSON.stringify({ event: "private_store_invalid" }));
      throw new PairingError("sync_store_invalid", "Kin's stored private history is invalid.", 500);
    }
    return;
  }
  if (url.pathname === "/api/chat/status" && request.method === "GET") {
    json(response, 200, context.chatRelayService.status(syncService.authorize(session)));
    return;
  }
  if (url.pathname === "/api/chat/events" && request.method === "GET") {
    const auth = syncService.authorize(session);
    let page;
    try {
      page = context.chatRelayService.pull(auth, url.searchParams.get("cursor") ?? "", url.searchParams.get("limit") ?? undefined);
      binary(response, encodeEventPage(page));
    } catch (error) {
      if (!(error instanceof EnvelopeWireError) &&
          !(error instanceof DurableStoreError && error.code === "sync_store_invalid")) throw error;
      console.error(JSON.stringify({ event: "chat_store_invalid", householdId: auth.household.id }));
      throw new PairingError("sync_store_invalid", "Kin's stored chat history is invalid.", 500);
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/events") {
    const { household } = service.authorize(session);
    let page;
    try {
      page = syncService.pull(
        session,
        url.searchParams.get("cursor") ?? "",
        url.searchParams.get("limit") ?? "20",
      );
      binary(response, encodeEventPage(page));
    } catch (error) {
      if (!(error instanceof EnvelopeWireError) &&
          !(error instanceof DurableStoreError && error.code === "sync_store_invalid")) throw error;
      const eventId = error.eventId ?? page?.events.find((row) => !isEventEnvelopeValid(row.envelope))?.envelope.eventId;
      console.error(JSON.stringify({
        event: "sync_store_invalid",
        householdId: household.id,
        eventId: isSyncId(eventId) ? eventId : null,
      }));
      throw new PairingError("sync_store_invalid", "Kin's stored sync history is invalid. Repair the development store before retrying.", 500);
    }
    return;
  }
  const attachmentRoute = url.pathname.match(/^\/api\/sync\/attachments(?:\/([a-f0-9]{32}))?$/);
  if (attachmentRoute && request.method === "GET" && !attachmentRoute[1]) {
    // ?album=1: a device that knows the family album (#673) asks for its
    // photos too.
    json(response, 200, { attachments: syncService.listAttachments(session, { album: url.searchParams.get("album") === "1" }) });
    return;
  }
  if (attachmentRoute && request.method === "POST" && attachmentRoute[1]) {
    const keyEpoch = request.headers["x-attachment-key-epoch"];
    const digest = request.headers["x-attachment-sha256"];
    if (typeof keyEpoch !== "string" || !/^[1-9][0-9]{0,2}$/.test(keyEpoch) || typeof digest !== "string") throw badRequest();
    json(response, 200, syncService.pushAttachment(session, { attachmentId: attachmentRoute[1], keyEpoch: Number(keyEpoch), ciphertext: body, digest }));
    return;
  }
  if (attachmentRoute && request.method === "GET" && attachmentRoute[1]) {
    const attachment = syncService.getAttachment(session, attachmentRoute[1]);
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": attachment.ciphertext.length, "Cache-Control": "no-store", "X-Attachment-Key-Epoch": String(attachment.keyEpoch), "X-Attachment-SHA256": attachment.digest });
    response.end(attachment.ciphertext);
    return;
  }
  if (attachmentRoute && request.method === "DELETE" && attachmentRoute[1]) {
    json(response, 200, syncService.removeAttachment(session, attachmentRoute[1]));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/sync/bindings") {
    json(response, 200, syncService.pushBindings(session, body.bindings));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/bindings") {
    json(
      response,
      200,
      syncService.pullBindings(session, url.searchParams.get("cursor") ?? ""),
    );
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/sync/provisioning/grants"
  ) {
    json(response, 201, syncService.createProvisioningGrant(session, body));
    return;
  }
  const provisioningUpload = url.pathname.match(
    /^\/api\/sync\/provisioning\/grants\/([a-f0-9]{32})$/,
  );
  if (request.method === "POST" && provisioningUpload) {
    json(
      response,
      200,
      syncService.submitProvisioning(
        session,
        provisioningUpload[1],
        body.package,
      ),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sync/provisioning") {
    json(response, 200, { grants: syncService.pendingProvisioning(session) });
    return;
  }
  const provisioningAck = url.pathname.match(
    /^\/api\/sync\/provisioning\/([a-f0-9]{32})\/ack$/,
  );
  if (request.method === "POST" && provisioningAck) {
    json(
      response,
      200,
      syncService.acknowledgeProvisioning(session, provisioningAck[1]),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/sync/epochs") {
    // One transaction: the epoch, its grants and the committer's vault
    // change (#791) are stored together or not at all.
    json(response, 200, withTransaction(context, () => syncService.rotateEpoch(session, body)));
    return;
  }
  // Moving a household to a home server (ADR 0026, #738). Starting it:
  // a household admin, a fresh passkey or password. After it moved, every
  // session is refused, so undoing it (within a day) or closing the
  // household goes through the trusted device, like cancelling a deletion.
  if (url.pathname === "/api/household/move" || url.pathname.startsWith("/api/household/move/")) {
    const moves = context.householdMoves;
    if (!moves) throw new PairingError("not_found", "That endpoint is unavailable.", 404);
    if (request.method === "GET" && url.pathname === "/api/household/move") {
      const auth = service.authorize(session, { allowMoving: true });
      service.requireManagementAuthority(auth.member, auth.household, "move the household");
      json(response, 200, { readiness: moves.readiness(auth.household.id), move: moves.status(auth.household.id) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/household/move/options") {
      const auth = service.authorize(session);
      service.requireManagementAuthority(auth.member, auth.household, "move the household");
      const targetOrigin = moves.check(auth.household.id, body?.address);
      json(response, 200, {
        targetOrigin,
        ...issueAuthenticationFlow(
          { purpose: "move-household", householdId: auth.household.id, memberId: auth.member.id, deviceId: auth.device.id, targetOrigin },
          [...auth.member.credentials],
          context,
        ),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/household/move/finish") {
      const flow = consumeFlow(body.flow, context);
      const auth = service.authorize(session);
      if (flow.purpose !== "move-household" || flow.householdId !== auth.household.id || flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id)
        throw badRequest();
      await confirmFresh(context, request, auth.member, body, () => {
        const credential = service.credentialForAuthenticatedMember(session, body.credential?.id);
        webauthn.verifyAuthentication(body.credential, body.flow, credential);
      });
      withTransaction(context, () => service.persistHousehold(auth.household.id));
      json(response, 200, moves.start({ householdId: auth.household.id, memberId: auth.member.id, address: flow.targetOrigin, code: body?.code }));
      return;
    }
    const after = /^\/api\/household\/move\/(undo|close)\/(options|finish)$/.exec(url.pathname);
    if (request.method === "POST" && after) {
      const [, action, step] = after;
      const purpose = `${action}-household-move`;
      if (step === "options") {
        const { device, member } = service.trustedDevice(deviceToken, { allowMoved: true });
        const household = service.households.get(member.householdId);
        service.requireManagementAuthority(member, household, action === "undo" ? "undo the move" : "close the household");
        if (service.householdMoves.get(household.id)?.state !== "moved")
          throw new PairingError("move_unavailable", "This household hasn't moved.", 409);
        json(response, 200, issueAuthenticationFlow({ purpose, householdId: household.id, memberId: member.id, deviceId: device.id }, [...member.credentials], context));
        return;
      }
      const flow = consumeFlow(body.flow, context);
      const { device, member } = service.trustedDevice(deviceToken, { allowMoved: true });
      if (flow.purpose !== purpose || flow.householdId !== member.householdId || flow.memberId !== member.id || flow.deviceId !== device.id)
        throw badRequest();
      const credential = await confirmFresh(context, request, member, body, () => {
        const passkey = service.credentials.get(body.credential?.id);
        if (!passkey || passkey.memberId !== member.id)
          throw new PairingError("passkey_member_mismatch", "Use this member's passkey to continue.", 401);
        webauthn.verifyAuthentication(body.credential, body.flow, passkey);
        return passkey;
      });
      const confirmed = { passwordConfirmed: !credential };
      if (action === "undo") {
        const { household } = service.movedHouseholdAdmin(deviceToken, credential?.id, confirmed, "undo the move");
        json(response, 200, moves.undo(household.id));
      } else {
        const result = withTransaction(context, () => service.closeMovedHousehold(deviceToken, credential?.id, confirmed));
        json(response, 200, { ...result, message: "The old household is closed. Its data here is deleted after 30 days." });
      }
      return;
    }
    throw new PairingError("not_found", "That endpoint is unavailable.", 404);
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/deletion/options"
  ) {
    const auth = service.authorize(session);
    service.requireManagementAuthority(auth.member, auth.household, "delete the household");
    const issued = issueAuthenticationFlow(
      {
        purpose: "delete-household",
        householdId: auth.household.id,
        memberId: auth.member.id,
        deviceId: auth.device.id,
      },
      [...auth.member.credentials],
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/deletion/finish"
  ) {
    const flow = consumeFlow(body.flow, context);
    const auth = service.authorize(session);
    if (
      flow.purpose !== "delete-household" ||
      flow.householdId !== auth.household.id ||
      flow.memberId !== auth.member.id ||
      flow.deviceId !== auth.device.id
    )
      throw badRequest();
    await confirmFresh(context, request, auth.member, body, () => {
      const credential = service.credentialForAuthenticatedMember(
        session,
        body.credential?.id,
      );
      webauthn.verifyAuthentication(body.credential, body.flow, credential);
    });
    const result = withTransaction(context, () =>
      service.requestHouseholdDeletion(session, auth.member.id),
    );
    for (const [flowId, activeFlow] of context.flows)
      if (
        activeFlow.householdId === auth.household.id ||
        auth.household.members.has(activeFlow.memberId)
      )
        context.flows.delete(flowId);
    context.liveService.revalidate(auth.household.id);
    clearCookie(response, "kin_session", secureCookies);
    json(response, 200, {
      ...result,
      cancelable: true,
      message:
        "Household sync is stopped. Deletion becomes final after 30 days unless an adult cancels it with a passkey.",
    });
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/deletion/cancel/options"
  ) {
    const { device, member } = service.trustedDevice(deviceToken, {
      allowDeletionPending: true,
    });
    const household = service.households.get(member.householdId);
    if (household) service.requireManagementAuthority(member, household, "cancel household deletion");
    else requireTrustAuthority(member, "cancel household deletion");
    if (household?.lifecycleState !== "deletion_pending")
      throw new PairingError(
        "household_deletion_unavailable",
        "There is no pending household deletion to cancel.",
        409,
      );
    const issued = issueAuthenticationFlow(
      {
        purpose: "cancel-household-deletion",
        householdId: household.id,
        memberId: member.id,
        deviceId: device.id,
      },
      [...member.credentials],
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/deletion/cancel/finish"
  ) {
    const flow = consumeFlow(body.flow, context);
    const { device, member } = service.trustedDevice(deviceToken, {
      allowDeletionPending: true,
    });
    if (
      flow.purpose !== "cancel-household-deletion" ||
      flow.householdId !== member.householdId ||
      flow.memberId !== member.id ||
      flow.deviceId !== device.id
    )
      throw badRequest();
    const credential = await confirmFresh(context, request, member, body, () => {
      const passkey = service.credentials.get(body.credential?.id);
      if (!passkey || passkey.memberId !== member.id)
        throw new PairingError(
          "passkey_member_mismatch",
          "Use this member's passkey to continue.",
          401,
        );
      webauthn.verifyAuthentication(body.credential, body.flow, passkey);
      return passkey;
    });
    const result = withTransaction(context, () =>
      service.cancelHouseholdDeletion(deviceToken, credential?.id, { passwordConfirmed: !credential }),
    );
    cookie(response, "kin_session", result.sessionToken, secureCookies);
    cookie(
      response,
      "kin_device",
      result.deviceToken,
      secureCookies,
      31_536_000,
    );
    json(response, 200, {
      householdId: result.householdId,
      memberId: result.memberId,
      deviceId: result.deviceId,
      state: "active",
      message: "Household deletion was cancelled. Sync can be started again.",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/household") {
    json(response, 200, service.householdView(session));
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/membership/remove/options"
  ) {
    const removal = service.removalContext(session, body.memberId, { allowSelf: true });
    const issued = issueAuthenticationFlow(
      {
        purpose: "remove-adult",
        targetMemberId: body.memberId,
        memberId: removal.memberId,
        deviceId: removal.deviceId,
      },
      removal.credentialIds,
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/membership/remove/finish"
  ) {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "remove-adult") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id)
      throw badRequest();
    await confirmFresh(context, request, auth.member, body, () => {
      const credential = service.credentials.get(body.credential?.id);
      if (!credential || credential.memberId !== auth.member.id)
        throw new PairingError(
          "passkey_member_mismatch",
          "Use this member's passkey to continue.",
          401,
        );
      webauthn.verifyAuthentication(body.credential, body.flow, credential);
    });
    const leaving = flow.targetMemberId === auth.member.id;
    const excludedDevices = [...service.devices.values()]
      .filter((device) => device.memberId === flow.targetMemberId)
      .map((device) => device.id);
    const result = withTransaction(context, () => {
      const removed = leaving
        ? service.leaveHousehold(session, auth.member.id)
        : service.removeOtherAdult(session, flow.targetMemberId, auth.member.id);
      syncService.onAccessChange(auth.household.id, excludedDevices);
      return removed;
    });
    if (leaving) {
      clearCookie(response, "kin_session", secureCookies);
      clearCookie(response, "kin_device", secureCookies);
    }
    json(response, 200, result);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/admins/options"
  ) {
    if (typeof body?.admin !== "boolean") throw badRequest();
    const change = service.householdAdminContext(session, body.memberId);
    const issued = issueAuthenticationFlow(
      {
        purpose: "set-household-admin",
        targetMemberId: body.memberId,
        admin: body.admin,
        memberId: change.memberId,
        deviceId: change.deviceId,
      },
      change.credentialIds,
      context,
    );
    json(response, 200, issued);
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/household/admins/finish"
  ) {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "set-household-admin") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id)
      throw badRequest();
    await confirmFresh(context, request, auth.member, body, () => {
      const credential = service.credentials.get(body.credential?.id);
      if (!credential || credential.memberId !== auth.member.id)
        throw new PairingError(
          "passkey_member_mismatch",
          "Use this member's passkey to continue.",
          401,
        );
      webauthn.verifyAuthentication(body.credential, body.flow, credential);
    });
    json(
      response,
      200,
      withTransaction(context, () =>
        service.setHouseholdAdmin(session, flow.targetMemberId, flow.admin, auth.member.id),
      ),
    );
    return;
  }
  // Simple view (#343, ADR 0013): the household-admin flow for one Limited member.
  if (request.method === "POST" && url.pathname === "/api/household/simple-view/options") {
    if (typeof body?.simpleView !== "boolean" || typeof body?.memberId !== "string") throw badRequest();
    const change = service.simpleViewContext(session, body.memberId);
    json(response, 200, issueAuthenticationFlow(
      { purpose: "set-simple-view", targetMemberId: body.memberId, simpleView: body.simpleView, memberId: change.memberId, deviceId: change.deviceId },
      change.credentialIds,
      context,
    ));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/household/simple-view/finish") {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "set-simple-view") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id) throw badRequest();
    await confirmFresh(context, request, auth.member, body, () => {
      const credential = service.credentials.get(body.credential?.id);
      if (!credential || credential.memberId !== auth.member.id)
        throw new PairingError("passkey_member_mismatch", "Use this member's passkey to continue.", 401);
      webauthn.verifyAuthentication(body.credential, body.flow, credential);
    });
    const result = withTransaction(context, () =>
      service.setSimpleView(session, flow.targetMemberId, flow.simpleView, auth.member.id),
    );
    // The member's devices learn it on their next status poll; a hint makes that now.
    if (result.changed) syncService.hintHousehold(auth.household.id);
    json(response, 200, result);
    return;
  }
  // Who can use the fridge (#323): the chat policy's flow, its own purpose.
  if (request.method === "POST" && url.pathname === "/api/household/board-policy/options") {
    const change = service.boardPolicyContext(session);
    if (!CHAT_ACCESS.includes(body?.limited) || !CHAT_ACCESS.includes(body?.temporary)) throw badRequest();
    json(response, 200, issueAuthenticationFlow(
      { purpose: "set-board-policy", limited: body?.limited, temporary: body?.temporary, memberId: change.memberId, deviceId: change.deviceId },
      change.credentialIds,
      context,
    ));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/household/board-policy/finish") {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "set-board-policy") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id) throw badRequest();
    await confirmFresh(context, request, auth.member, body, () => {
      const credential = service.credentials.get(body.credential?.id);
      if (!credential || credential.memberId !== auth.member.id)
        throw new PairingError("passkey_member_mismatch", "Use this member's passkey to continue.", 401);
      webauthn.verifyAuthentication(body.credential, body.flow, credential);
    });
    const result = withTransaction(context, () =>
      service.setBoardPolicy(session, { limited: flow.limited, temporary: flow.temporary }, auth.member.id),
    );
    if (result.changed) syncService.hintHousehold(auth.household.id);
    json(response, 200, result);
    return;
  }
  // Private storage for Limited members (ADR 0019): the chat policy's flow,
  // its own purpose.
  if (request.method === "POST" && url.pathname === "/api/household/private-policy/options") {
    const change = service.privatePolicyContext(session);
    if (typeof body?.limited !== "boolean") throw badRequest();
    json(response, 200, issueAuthenticationFlow(
      { purpose: "set-private-policy", limited: body.limited, memberId: change.memberId, deviceId: change.deviceId },
      change.credentialIds,
      context,
    ));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/household/private-policy/finish") {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "set-private-policy") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id) throw badRequest();
    const credential = service.credentials.get(body.credential?.id);
    if (!credential || credential.memberId !== auth.member.id)
      throw new PairingError("passkey_member_mismatch", "Use this member's passkey to continue.", 401);
    webauthn.verifyAuthentication(body.credential, body.flow, credential);
    const result = withTransaction(context, () =>
      service.setPrivatePolicy(session, { limited: flow.limited }, auth.member.id),
    );
    if (result.changed) syncService.hintHousehold(auth.household.id);
    json(response, 200, result);
    return;
  }
  // Household features (ADR 0021 §2, #624): the policies' flow, its own
  // purpose. The change carries the revision it was made from; both steps
  // check it, so a stale screen fails before the passkey prompt.
  if (request.method === "POST" && url.pathname === "/api/household/features/options") {
    const change = service.featuresContext(session);
    const requested = { off: body?.off, expectedRevision: body?.expectedRevision };
    service.checkFeatureChange(service.households.get(change.householdId), requested);
    json(response, 200, issueAuthenticationFlow(
      { purpose: "set-household-features", off: requested.off, expectedRevision: requested.expectedRevision, memberId: change.memberId, deviceId: change.deviceId },
      change.credentialIds,
      context,
    ));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/household/features/finish") {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "set-household-features") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id) throw badRequest();
    await confirmFresh(context, request, auth.member, body, () => {
      const credential = service.credentials.get(body.credential?.id);
      if (!credential || credential.memberId !== auth.member.id)
        throw new PairingError("passkey_member_mismatch", "Use this member's passkey to continue.", 401);
      webauthn.verifyAuthentication(body.credential, body.flow, credential);
    });
    const result = withTransaction(context, () =>
      service.setFeatures(session, { off: flow.off, expectedRevision: flow.expectedRevision }, auth.member.id),
    );
    // Chat and Fridge access may have changed: online members learn it now.
    if (result.changed) syncService.chatPolicyChanged(auth.household.id);
    json(response, 200, result);
    return;
  }
  // The control panel through the household's address (ADR 0025 §11,
  // #718): household admins only, and every change with a fresh passkey
  // (or password), as other admin changes. The loopback panel has its own
  // API (server/home/control-panel.mjs).
  if (url.pathname.startsWith("/api/control/")) {
    const panel = context.controlPanel;
    if (!panel) throw new PairingError("not_found", "That endpoint is unavailable.", 404);
    const auth = service.authorize(session);
    if (!isHouseholdAdmin(auth.member, context.now()))
      throw new PairingError("household_admin_required", "Only a household admin can use the control panel.", 403);
    if (request.method === "GET" && url.pathname === "/api/control/status") {
      json(response, 200, panel.status());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/control/change/options") {
      const change = controlChange(panel, body?.change);
      json(response, 200, issueAuthenticationFlow(
        { purpose: "control-change", change, memberId: auth.member.id, deviceId: auth.device.id },
        [...auth.member.credentials],
        context,
      ));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/control/change/finish") {
      const flow = consumeFlow(body.flow, context);
      if (flow.purpose !== "control-change" || flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id) throw badRequest();
      await confirmFresh(context, request, auth.member, body, () => {
        const credential = service.credentials.get(body.credential?.id);
        if (!credential || credential.memberId !== auth.member.id)
          throw new PairingError("passkey_member_mismatch", "Use this member's passkey to continue.", 401);
        webauthn.verifyAuthentication(body.credential, body.flow, credential);
      });
      // The verified signature counter is kept, as for any passkey use.
      withTransaction(context, () => service.persistHousehold(auth.household.id));
      let result;
      // No `loopback` here, so loopback-only changes (#763) are refused.
      try { result = await panel.applyChange(flow.change); } catch (error) { throw controlPairingError(error); }
      json(response, 200, result);
      return;
    }
    throw new PairingError("not_found", "That endpoint is unavailable.", 404);
  }
  // Adults on the chore chart (ADR 0022 §6, #676): household features' flow,
  // its own purpose, with the revision checked at both steps.
  if (request.method === "POST" && url.pathname === "/api/household/chore-chart/options") {
    const change = service.choreChartContext(session);
    const requested = { adults: body?.adults, expectedRevision: body?.expectedRevision };
    service.checkChoreChartChange(service.households.get(change.householdId), requested);
    json(response, 200, issueAuthenticationFlow(
      { purpose: "set-chore-chart-adults", adults: requested.adults, expectedRevision: requested.expectedRevision, memberId: change.memberId, deviceId: change.deviceId },
      change.credentialIds,
      context,
    ));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/household/chore-chart/finish") {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "set-chore-chart-adults") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id) throw badRequest();
    await confirmFresh(context, request, auth.member, body, () => {
      const credential = service.credentials.get(body.credential?.id);
      if (!credential || credential.memberId !== auth.member.id)
        throw new PairingError("passkey_member_mismatch", "Use this member's passkey to continue.", 401);
      webauthn.verifyAuthentication(body.credential, body.flow, credential);
    });
    const result = withTransaction(context, () =>
      service.setChoreChart(session, { adults: flow.adults, expectedRevision: flow.expectedRevision }, auth.member.id),
    );
    // Online members learn it on their next status read; hint one now.
    if (result.changed) syncService.chatPolicyChanged(auth.household.id);
    json(response, 200, result);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/household/chat-policy/options") {
    const change = service.chatPolicyContext(session);
    if (!CHAT_ACCESS.includes(body?.limited) || !CHAT_ACCESS.includes(body?.temporary)) throw badRequest();
    json(response, 200, issueAuthenticationFlow(
      { purpose: "set-chat-policy", limited: body?.limited, temporary: body?.temporary, memberId: change.memberId, deviceId: change.deviceId },
      change.credentialIds,
      context,
    ));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/household/chat-policy/finish") {
    const flow = consumeFlow(body.flow, context);
    if (flow.purpose !== "set-chat-policy") throw badRequest();
    const auth = service.authorize(session);
    if (flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id) throw badRequest();
    await confirmFresh(context, request, auth.member, body, () => {
      const credential = service.credentials.get(body.credential?.id);
      if (!credential || credential.memberId !== auth.member.id)
        throw new PairingError("passkey_member_mismatch", "Use this member's passkey to continue.", 401);
      webauthn.verifyAuthentication(body.credential, body.flow, credential);
    });
    const result = withTransaction(context, () =>
      service.setChatPolicy(session, { limited: flow.limited, temporary: flow.temporary }, auth.member.id),
    );
    if (result.changed) syncService.chatPolicyChanged(auth.household.id);
    json(response, 200, result);
    return;
  }
  if (
    request.method === "DELETE" &&
    url.pathname === "/api/household/membership"
  ) {
    throw new PairingError(
      "fresh_auth_required",
      "Authenticate with your passkey again before removing a household adult or leaving.",
      401,
    );
  }
  throw new PairingError("not_found", "That endpoint is unavailable.", 404);
}

/** A control-panel change, checked by the panel; its refusal as a
 * PairingError. No `loopback`, so loopback-only changes (#763) are refused. */
function controlChange(panel, change) {
  try { return panel.checkChange(change); } catch (error) { throw controlPairingError(error); }
}

function controlPairingError(error) {
  if (typeof error?.code === "string" && Number.isInteger(error.status) && error.name === "ControlError")
    return new PairingError(error.code, error.message, error.status);
  return error;
}

function withTransaction(context, operation) {
  return context.store ? context.store.transaction(operation) : operation();
}

function installShutdown(application) {
  const { server, store } = application;
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "shutdown_started", signal }));
    const timeout = setTimeout(() => {
      console.error(JSON.stringify({ event: "shutdown_timeout" }));
      store?.close();
      process.exitCode = 1;
    }, 30_000);
    timeout.unref();
    // The tunnel goes first (GOAWAY 8 to the relay), so no new phone
    // connection arrives while the server closes.
    Promise.all([application.home?.stop(), application.controlPanel?.close()]).catch(() => {}).then(() => server.close((error) => {
      clearTimeout(timeout);
      if (error) {
        console.error(JSON.stringify({ event: "shutdown_failed" }));
        process.exitCode = 1;
      }
      store?.close();
    }));
  };
  // `on`, not `once`: a terminal's Ctrl+C reaches the service and its
  // launcher together, and the launcher forwards a stop too. A repeated
  // signal must not kill the service before it closes the store and its lock.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // A supervising launcher (server/launcher.mjs --supervise, used by the
  // Windows scheduled task) holds this process's stdin open. Windows ends a
  // task by terminating the launcher without a signal, so the closed pipe is
  // how the service learns to close its store and lock.
  if (process.env.KIN_STOP_WITH_LAUNCHER === "1") {
    process.stdin.on("end", () => shutdown("launcher_exit"));
    process.stdin.on("error", () => shutdown("launcher_exit"));
    process.stdin.resume();
  }
  return shutdown;
}

function defaultAnonymousCapacity(maximum) {
  return maximum > 1 ? Math.max(1, Math.floor(maximum / 4)) : 0;
}

function createFlow(value, context, { anonymous = false } = {}) {
  pruneFlows(context);
  if (
    anonymous &&
    [...context.flows.values()].filter((flow) => flow.anonymous).length >=
      context.maxAnonymousFlows
  )
    throw new PairingError(
      "flow_capacity",
      "Too many active passkey requests. Wait and try again.",
      503,
    );
  if (context.flows.size >= context.maxFlows)
    throw new PairingError(
      "flow_capacity",
      "Too many active passkey requests. Wait and try again.",
      503,
    );
  const flow = randomBytes(18).toString("base64url");
  context.flows.set(flow, {
    ...value,
    anonymous,
    expiresAt: context.now() + FLOW_TTL_MS,
  });
  return flow;
}

function issueRegistrationFlow(value, context, { anonymous = false } = {}) {
  const flow = createFlow(value, context, { anonymous });
  try {
    return {
      flow,
      publicKey: context.webauthn.registrationOptions(flow, { anonymous }),
    };
  } catch (error) {
    context.flows.delete(flow);
    context.webauthn.discardFlow?.(flow);
    throw error;
  }
}

function issueAuthenticationFlow(value, credentialIds, context) {
  const flow = createFlow(value, context);
  try {
    // A member who has no passkey yet confirms with their password (#558):
    // the options then also carry the parameters their device needs to
    // derive authKey. Members with a passkey get exactly what they did.
    const member = value.memberId ? context.service.members.get(value.memberId) : null;
    const password = context.service.confirmsWithPassword?.(member) ? context.service.passwordParameters(member) : null;
    return {
      flow,
      publicKey: context.webauthn.authenticationOptions(flow, credentialIds),
      ...(password ? { password } : {}),
    };
  } catch (error) {
    context.flows.delete(flow);
    context.webauthn.discardFlow?.(flow);
    throw error;
  }
}

/**
 * A fresh confirmation for a sensitive action. A member with a passkey uses
 * it: `passkey()` runs the route's own WebAuthn check, unchanged. A member
 * who has no passkey yet (#558) re-enters their password instead: the body
 * carries `authKey`, checked against their Argon2id verifier with the
 * password limits. THREAT-MODEL records this as weaker than a passkey until
 * one is added. Resolves to what `passkey()` returned, or null.
 */
async function confirmFresh(context, request, member, body, passkey) {
  if (!context.service.confirmsWithPassword(member)) return passkey();
  if (body.credential !== undefined || typeof body.authKey !== "string") throw badRequest();
  context.webauthn.discardFlow?.(body.flow);
  await context.service.verifyFreshPassword(member, body.authKey, context.clientKey(request));
  return null;
}

/**
 * A fresh confirmation for a change to how the member's vault opens: the
 * current password (`currentAuthKey`, checked with the password limits), or
 * a fresh passkey assertion (`flow` from /api/account/confirm/options and
 * `credential`). Resolves to the session's authorization afterwards; a body
 * with neither is refused (`fresh_auth_required`, 401).
 */
async function confirmAccountChange(context, request, session, body) {
  const { service } = context;
  if (typeof body.currentAuthKey === "string")
    return service.confirmAccountPassword(session, body.currentAuthKey, context.clientKey(request));
  if (typeof body.flow === "string" && body.credential && typeof body.credential === "object") {
    const flow = consumeFlow(body.flow, context);
    const auth = service.authorize(session);
    if (flow.purpose !== "account-confirm" || flow.memberId !== auth.member.id || flow.deviceId !== auth.device.id) throw badRequest();
    const credential = service.credentials.get(body.credential.id);
    if (!credential || credential.memberId !== auth.member.id)
      throw new PairingError("passkey_member_mismatch", "Use your own passkey to continue.", 401);
    context.webauthn.verifyAuthentication(body.credential, body.flow, credential);
    // The verified signature counter is kept, as for any passkey sign-in.
    withTransaction(context, () => service.persistHousehold(auth.household.id));
    return service.authorize(session);
  }
  throw new PairingError("fresh_auth_required", "Confirm with your password or your passkey to change how your account opens.", 401);
}

function pruneFlows({ flows, now }) {
  const timestamp = now();
  for (const [key, flow] of flows)
    if (flow.expiresAt <= timestamp) flows.delete(key);
}

function consumeFlow(value, context) {
  pruneFlows(context);
  const flowKey = String(value ?? "");
  const flow = context.flows.get(flowKey);
  context.flows.delete(flowKey);
  if (!flow || flow.expiresAt <= context.now())
    throw new PairingError(
      "challenge_expired",
      "That passkey request expired. Try again.",
      410,
    );
  return flow;
}

function omitToken(value) {
  const { sessionToken, claimToken, deviceToken, ...safe } = value;
  return safe;
}
function badRequest() {
  return new PairingError(
    "invalid_request",
    "Kin could not understand that request.",
  );
}
function cookie(response, name, value, secure, maxAge = 43_200) {
  response.appendHeader(
    "Set-Cookie",
    `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
  );
}
function clearCookie(response, name, secure) {
  response.appendHeader(
    "Set-Cookie",
    `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`,
  );
}
function cookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length === 2),
  );
}

// JSON request bodies are small control messages; attachments and settings
// are binary and bounded by the attachment limit (http-body.mjs).
const MAX_JSON_BODY_BYTES = 256_000;
// A sealed vault in base64url plus its first wrappers and JSON framing.
const MAX_ACCOUNT_VAULT_BODY_BYTES = Math.ceil(MAX_ACCOUNT_VAULT_BYTES * 4 / 3) + 16_384;
/** A rotation's packages plus the committer's sealed vault (#791). */
const MAX_EPOCH_COMMIT_BODY_BYTES = MAX_JSON_BODY_BYTES + Math.ceil(MAX_ACCOUNT_VAULT_BYTES * 4 / 3) + 1_024;
// Four base64url PNGs of at most 512 KB each, plus the names.
const MAX_INSTALL_IDENTITY_BODY_BYTES = 2_850_000;

// Header 8 + 20 * (fixed record 148 + max ciphertext 6,144) = 125,848 bytes.
const MAX_ENVELOPE_PUSH_BYTES = 8 + MAX_EVENTS_PER_BATCH * (RECORD_FIXED + MAX_CIPHERTEXT_BYTES);

async function readEnvelopeBatch(request, response) {
  const mediaType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== ENVELOPE_CONTENT_TYPE)
    throw new PairingError("unsupported_media_type", "Send sync events as a binary batch.", 415);
  const bytes = await readBody(request, response, MAX_ENVELOPE_PUSH_BYTES, "That sync batch is too large.");
  try {
    return decodeEnvelopeBatch(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), { maxCount: MAX_EVENTS_PER_BATCH });
  } catch (error) {
    if (error instanceof EnvelopeWireError) throw new PairingError("sync_batch_invalid", "That sync batch is invalid.", 400);
    throw error;
  }
}

async function readBinary(request, response) {
  const body = await readBody(request, response, MAX_ATTACHMENT_BYTES, "That attachment is larger than Kin supports.");
  if (!body.length) throw badRequest();
  return body;
}

function binary(response, bytes) {
  if (response.headersSent) return;
  response.writeHead(200, {
    "Content-Type": ENVELOPE_CONTENT_TYPE,
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
  });
  response.end(bytes);
}

function json(response, status, value) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}
function setHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "camera=(self), microphone=(self), geolocation=()",
  );
}
// The service worker keys its shell cache by the release in the registration
// URL and refuses to re-stage an existing cache name. Appending a fingerprint
// of the served files as semver build metadata means any changed shell gets a
// new cache instead of leaving browsers on a frozen snapshot. Static test
// servers serve the raw file, so the plain release still works.
//
// A file or folder can disappear between listing and reading it (an editor's
// temporary file, a test's scratch folder). That entry is skipped rather than
// failing the page with a 500: it isn't part of the shell either way. Windows
// reports an entry that is being deleted as EPERM rather than ENOENT.
const vanished = (error) =>
  error?.code === "ENOENT" || error?.code === "ENOTDIR" ||
  (process.platform === "win32" && error?.code === "EPERM");
export function shellFingerprint(root = webRoot) {
  const hash = createHash("sha256");
  const visit = (directory) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) {
      if (directory !== root && vanished(error)) return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !entry.name.endsWith(".test.mjs")) {
        const name = relative(root, path).replaceAll("\\", "/");
        let content;
        try { content = readFileSync(path); } catch (error) {
          if (vanished(error)) continue;
          throw error;
        }
        hash.update(`${name.length}:${name}:${content.length}:`);
        hash.update(content);
        hash.update("\n");
      }
    }
  };
  visit(root);
  return hash.digest("hex").slice(0, 12);
}

export function fingerprintedShell(html, fingerprint) {
  return html.replace(
    /(<meta name="kin-version" content="\d+\.\d+\.\d+)(")/,
    (_, prefix, quote) => `${prefix}+${fingerprint}${quote}`,
  );
}

// New routes match with URLPattern (#106) rather than hand-written parsing.
const INSTALL_ICON_ROUTE = new URLPattern({ pathname: "/install-icon/:file([a-z0-9\\-]+[.]png)" });
const CHAT_BLOB_ROUTE = new URLPattern({ pathname: "/api/chat/blobs/:ref([a-f0-9]{64})" });
const PRIVATE_BLOB_ROUTE = new URLPattern({ pathname: "/api/private/blobs/:ref([a-f0-9]{64})" });
const CALENDAR_SUBSCRIPTION_ROUTE = new URLPattern({ pathname: "/api/calendar/subscriptions/:id([a-f0-9]{32})" });
const CALENDAR_FEED_ROUTE = new URLPattern({ pathname: "/api/calendar/subscriptions/:id([a-f0-9]{32})/feed" });
const ACCOUNT_VAULT_WRAPPER_ROUTE = new URLPattern({ pathname: "/api/account/vault/wrappers/:id([a-f0-9]{32})" });

// The install identity (#78) a trusted device's kin_device cookie resolves
// to, or the built-in Kin manifest and icon. Always private to the browser
// and never cached by the service worker (web/service-worker.js).
function serveManifest(request, response, context) {
  const resolved = context.syncService.installIdentityForDevice(cookies(request).kin_device);
  const { body, etag } = resolved ? publishedManifest(resolved.householdId, resolved.identity) : builtInManifest();
  const headers = {
    "Content-Type": "application/manifest+json",
    "Cache-Control": "private, no-cache",
    Vary: "Cookie",
    ETag: etag,
  };
  if (etagMatches(request.headers["if-none-match"], etag)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, { ...headers, "Content-Length": body.length });
  response.end(request.method === "HEAD" ? undefined : body);
}

function serveInstallIcon(request, response, url, file, context) {
  const icon = INSTALL_ICONS.find((entry) => entry.file === file);
  const resolved = icon && context.syncService.installIdentityForDevice(cookies(request).kin_device);
  const published = resolved && context.syncService.publishedInstallIcon(resolved.householdId, icon.key);
  if (!published) {
    // Kin has no PNG icon, and iOS ignores an SVG touch icon. A 404 keeps
    // iOS's own behaviour from before (a screenshot), as it was until #78.
    if (file === "apple-180.png") {
      response.writeHead(404, { "Cache-Control": "private, no-cache", Vary: "Cookie" });
      response.end();
      return;
    }
    // The built-in Kin icon stands in for the other sizes.
    const body = readFileSync(join(webRoot, "icon.svg"));
    response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "private, no-cache", Vary: "Cookie", "Content-Length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  const body = published;
  // A URL naming the current content never changes; any other (the
  // unversioned apple-touch-icon link, earlier content) is revalidated.
  const current = url.searchParams.get("v") === resolved.identity.contentTag;
  response.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": current ? "private, max-age=31536000, immutable" : "private, no-cache",
    Vary: "Cookie",
    "Content-Length": body.length,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function serve(response, pathname) {
  let requested;
  try {
    requested =
      pathname === "/" || pathname === "/pair" || pathname === "/link"
        ? "index.html"
        : decodeURIComponent(pathname.slice(1));
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    // A malformed percent-escape names no file: a client error, not a
    // server failure, so it is not logged as one.
    requested = null;
  }
  let path;
  try {
    if (requested === null) throw new URIError("malformed path");
    const candidate = resolve(webRoot, requested);
    if (isInsideRoot(candidate, webRoot)) {
      const canonical = realpathSync(candidate);
      if (
        isInsideRoot(canonical, realpathSync(webRoot)) &&
        statSync(canonical).isFile()
      )
        path = canonical;
    }
  } catch {
    // Missing files and inaccessible paths are not static assets.
  }
  if (!path) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    // Kin's app and shortcut icons (web/icons, #473).
    ".png": "image/png",
    // The chat emoji table (#113).
    ".json": "application/json; charset=utf-8",
  };
  if (requested === "index.html") {
    let body;
    try {
      body = Buffer.from(fingerprintedShell(readFileSync(path, "utf8"), shellFingerprint()), "utf8");
    } catch {
      response.writeHead(500);
      response.end("Kin could not prepare its application shell.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": types[".html"],
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    });
    response.end(body);
    return;
  }
  response.writeHead(200, {
    "Content-Type": types[extname(path)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  createReadStream(path).pipe(response);
}
