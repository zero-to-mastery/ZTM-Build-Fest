// Only source-controlled static shell assets are eligible for this cache.
// API, archives, projections, drafts and keys never pass through Cache.put.
// index.html supplies the current release in the registration URL. The old
// active worker keeps its own version while the new worker stages separately.
// The release may carry semver build metadata (a fingerprint of the served
// shell files added by the Kin server) so a changed shell gets a new cache.
const RELEASE = new URL(self.location.href).searchParams.get("v");
if (!/^\d+\.\d+\.\d+(\+[a-z0-9]{1,32})?$/.test(RELEASE ?? "")) throw new Error("Kin service worker release is missing.");
const CACHE = `kin-static-v${RELEASE}`;
const SHELL = [
  // Not the manifest or /install-icon/*: they depend on the household that
  // published an install identity (#78), so they always come from the network.
  "/", "/index.html", "/styles/app.css", "/icon.svg",
  // The public privacy policy (#541), readable offline from the app.
  "/privacy.html",
  // Kin's own PNG app and shortcut icons (#473); scripts/render-icons.mjs.
  ...["icon-192", "icon-512", "icon-maskable-512"].map((name) => `/icons/${name}.png`),
  ...["add-shopping", "add-task", "new-journal-entry", "week", "shopping", "chat", "today"].flatMap((name) => [96, 192].map((size) => `/icons/shortcut-${name}-${size}.png`)),
  // The start-up guard index.html runs before the app's modules (#594).
  "/boot-guard.js",
  "/browser-time.js", "/sitter-view.js", "/platform.js", "/pairing-link.js", "/share-target.js", "/app-badge.js", "/device-link.js", "/calendar-export.js", "/household-validation.js", "/search.js", "/reminders.js", "/wasm/kin-engine.js", "/wasm/kin-board.js", "/wasm/kin-meals.js", "/wasm/kin-simple.js", "/wasm/kin-sections.js", "/wasm/kin-rotations.js", "/wasm/kin-sitter.js", "/wasm/kin-calendar.js", "/wasm/kin-week.js", "/wasm/kin_engine.wasm", "/wasm/kin-qr.js", "/wasm/kin-private.js", "/wasm/kin-prefs.js",
  "/wasm/wire.js", "/wasm/history-mirror.js", "/wasm/projection-decode.js", "/wasm/projection/reader.js", "/wasm/projection/items.js",
  "/wasm/projection/conversations.js", "/wasm/projection/routines.js", "/wasm/projection/records.js",
  "/routes.js", "/today-view.js", "/reminder-time.js", "/capture-plan.js", "/keyboard-commands.js", "/bulk-actions.js", "/undo.js", "/import/list-import.js", "/wake-lock.js", "/recurrence.js",
  "/attachments/attachment-crypto.js", "/attachments/attachment-lifecycle.js", "/attachments/attachment-permissions.js", "/attachments/attachment-preview.js", "/attachments/attachment-progress.js", "/attachments/object-urls.js",
  "/storage/event-store.js", "/storage/event-arena.js", "/storage/encrypted-idb.js", "/storage/root-rotation.js", "/storage/quarantine.js",
  "/security/local-vault.js", "/security/passkey-unlock.js", "/security/archive.js", "/security/archive-stream.js", "/security/key-label.js", "/security/backup-key-entry.js", "/security/reload-resume.js", "/security/account-vault.js", "/security/account-vault-sync.js", "/security/account-credentials.js", "/security/account-setup.js", "/security/device-certification.js", "/security/new-device.js",
  "/security/backup-code.js", "/security/account-wrappers.js", "/security/account-passkey.js", "/security/account-security.js",
  "/security/account-migration.js", "/security/start-over.js", "/private/private-export.js",
  // Set up Kin for someone (#613, #615).
  "/security/prepared-card.js", "/components/household/prepared.js",
  "/private/member-key.js", "/private/private-envelope.js", "/private/private-log-store.js", "/private/private-log.js", "/private/synced-prefs.js", "/private/private-blobs.js", "/private/journal.js", "/private/journal-view.js",
  // Outside calendars (#668, ADR 0022 §3).
  "/calendar/external.js", "/calendar/feed-cache.js", "/calendar/feed-expand.js", "/calendar/feed-link.js", "/calendar/feed-refresh.js", "/components/app/calendar-sync.js", "/components/kin-calendar-subscriptions.js",
  // Household features (#625, ADR 0021).
  "/features.js", "/features-cache.js", "/components/app/features.js", "/components/kin-household-features.js",
  // Family photos (#673).
  "/wasm/kin-album.js", "/album/album-blobs.js", "/album/album-image.js", "/album/album-session.js", "/album/album-store.js",
  "/components/kin-album.js", "/components/kin-photo-frame.js", "/components/app/album.js",
  // The chore chart (#676, ADR 0022 §6).
  "/wasm/kin-chores.js", "/chores/chore-chart-view.js", "/components/app/chores.js", "/components/kin-chore-chart.js", "/components/kin-chore-adults.js",
  // Just for me (#510).
  "/private-items.js", "/components/kin-just-for-me.js", "/components/app/private-items.js", "/components/shared/private-marker.js",
  "/appearance/palette.js", "/appearance/display-prefs.js", "/appearance/image.js", "/appearance/store.js", "/appearance/household.js", "/appearance/install-icons.js",
  "/sync/crypto.js", "/sync/key-store.js", "/sync/sync-coordinator.js", "/sync/rotation-vault.js", "/sync/envelope-wire.js", "/sync/live-channel.js", "/sync/ephemeral-envelope.js",
  "/components/kin-fridge.js", "/components/kin-meals.js", "/components/kin-tonight.js", "/components/kin-simple.js", "/simple/simple-view.js", "/meals/meals-view.js", "/board/board-room.js", "/board/fridge-view.js", "/board/fridge-magnets.js", "/board/board-archive.js", "/board/board-log-store.js", "/chat/chat-room.js", "/chat/chat-log-store.js", "/chat/chat-records.js", "/chat/chat-attachments.js", "/chat/chat-blobs.js", "/chat/chat-blob-store.js", "/chat/chat-blob-client.js", "/chat/chat-blob-crypto.js", "/chat/emoji.js", "/chat/emoji.json", "/chat/chat-hidden.js", "/chat/chat-presence.js", "/chat/chat-layout.js", "/chat/chat-keys.js", "/chat/chat-reactions.js",
  "/chat/chat-badge.js", "/chat/chat-archive.js", "/chat/chat-voice.js",
  "/chat/chat-mentions.js",
  "/chat/chat-polls.js",
  "/chat/chat-search-ranges.js",
  // Easy mode and Help on every screen (#616, #620).
  "/easy/easy-mode.js", "/help/glossary.js", "/help/help-content.js", "/help/tips.js",
  "/components/kin-help.js", "/components/app/easy.js", "/components/app/help.js", "/components/shared/help-button.js",
  ...["app", "appearance", "household-defaults", "install-identity", "notifications", "app-badge", "personal-settings", "security", "household", "quick-add", "command-palette", "compose", "item", "item-detail", "today", "handoff-list", "talk-list", "qr", "qr-scanner", "chat", "chat-search", "chat-settings", "chat-policy", "chat-share", "share-sheet", "shopping-mode", "sitter-editor", "sitter-page", "rotation", "import", "week", "chat-poll", "chat-voice", "emoji-picker", "search", "segment-nav", "sync-status", "reminder", "pulse", "catch-up", "routines", "areas", "notes", "attachments", "responsibility", "bulk-bar", "playbook-editor", "routine-schedule"].map((name) => `/components/kin-${name}.js`),
  "/components/app/appearance.js", "/components/app/attachments.js", "/components/app/journal.js", "/components/kin-journal.js", "/components/app/chat-share.js", "/components/app/commands/append.js", "/components/app/commands/bulk.js", "/components/app/commands/conversations.js", "/components/app/commands/items.js", "/components/app/commands/records.js", "/components/app/commands/routines.js", "/components/app/constants.js", "/components/app/context.js", "/components/app/detail.js", "/components/app/feedback.js", "/components/app/first-run.js", "/components/app/meals.js", "/components/app/simple.js", "/components/app/share.js", "/components/app/badge.js", "/components/app/private-prefs.js", "/components/app/sections.js", "/components/app/import.js", "/components/app/week.js", "/components/app/sitter.js", "/components/app/rotations.js", "/components/app/navigation.js", "/components/app/peer-channel.js", "/components/app/refresh.js", "/components/app/wake.js", "/components/app/render.js", "/components/app/session.js", "/components/app/shell.js", "/components/app/status.js", "/components/app/sync.js", "/components/app/undo.js", "/components/app/views.js",
  ...["assignee-label", "dom", "focus", "icons", "operation", "props", "session-guard"].map((name) => `/components/shared/${name}.js`),
  ...["account", "api", "auth", "carried-over", "fresh-confirmation", "lifecycle", "link", "link-approval", "member-labels", "membership", "move", "pairing", "pairing-path", "views"].map((name) => `/components/household/${name}.js`),
  ...["account", "archive", "first-run", "private-export", "protection", "sign-in", "unlock", "views"].map((name) => `/components/security/${name}.js`),
  ...["focus", "sections", "selection"].map((name) => `/components/today/${name}.js`),
  "/components/item-detail/sections.js", "/components/notes/notes.js", "/components/notes/references.js",
  // Reports and suggestions to the Kin team (ADR 0021 §3).
  "/components/kin-report.js", "/components/app/report.js", "/diagnostics/registry.js", "/diagnostics/ring-buffer.js", "/diagnostics/global.js",
  "/feedback/format.js", "/feedback/collect.js", "/feedback/channel.js", "/feedback/outbox.js", "/feedback/screenshot.js",
  // The family calendar (#660, ADR 0022 §2).
  "/styles/calendar.css", "/components/app/calendar.js",
  // Kitchen display mode (#669, ADR 0022 §4).
  "/styles/display.css", "/components/app/display.js", "/components/kin-kitchen-display.js",
  ...["panels", "schedule", "idle", "leave"].map((name) => `/display/${name}.js`),
  ...["kin-display-setup", "kin-display-shopping", "kin-display-chat", "leave-dialog"].map((name) => `/components/display/${name}.js`),
  ...["calendar-time", "calendar-layout", "member-colours", "repeat", "ics-import"].map((name) => `/calendar/${name}.js`),
  ...["event-chip", "kin-calendar", "kin-calendar-today", "kin-event-editor", "kin-member-colour", "kin-calendar-import"].map((name) => `/components/calendar/${name}.js`),
];
const ALLOWED = new Set(SHELL);

self.addEventListener("install", (event) => {
  // Cache each public shell asset independently. A missing build artifact must
  // not leave the previous worker unusable or make online launch fail.
  const replacingWorker = Boolean(self.registration.active);
  event.waitUntil((async () => {
    if ((await caches.keys()).includes(CACHE))
      throw new Error("Kin release cache already exists; a changed shell needs a new release version.");
    const cache = await caches.open(CACHE);
    try {
    const results = await Promise.allSettled(SHELL.map(async (path) => {
      const response = await fetch(path, { cache: "reload" });
      if (!response.ok || response.type === "opaque") throw new Error("Shell asset unavailable");
      await cache.put(path, response);
    }));
    // Keep the previous worker and its cache if this version cannot stage a
    // complete shell. A partial new cache must never replace a working offline shell.
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Kin could not stage the complete offline shell.");
    if (replacingWorker) {
      for (const client of await self.clients.matchAll({ type: "window" }))
        client.postMessage({ type: "KIN_UPDATE_READY" });
    }
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});
// ---- Sharing into Kin (#389) -------------------------------------------------
// Another app's share sheet POSTs to /share (manifest `share_target`). The
// worker answers it here, so the shared text and files never reach the
// server: they wait in this worker's memory under a random id (never in the
// Cache API or any storage) until the page takes them, once, or a few
// minutes pass.
const SHARE_TTL_MS = 5 * 60_000;
const shares = new Map();
function forgetOldShares() {
  const now = Date.now();
  for (const [id, share] of shares) if (now - share.at > SHARE_TTL_MS) shares.delete(id);
}
async function receiveShare(request) {
  forgetOldShares();
  let form;
  try { form = await request.formData(); } catch { form = null; }
  const field = (name) => (typeof form?.get(name) === "string" ? form.get(name).slice(0, 4_000) : "");
  const files = form ? form.getAll("files").filter((file) => file instanceof File && file.size > 0).slice(0, 10) : [];
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  shares.set(id, { at: Date.now(), title: field("title"), text: field("text"), url: field("url"), files });
  return Response.redirect(new URL(`/#kin-share=${id}`, self.location.origin).href, 303);
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "KIN_SKIP_WAITING") void self.skipWaiting();
  // A page whose load began before this worker activated missed the claim
  // below and asks for one (#770); otherwise it starts offline without it.
  // Only a page of this worker's own release: a newer page (after a hard
  // reload while an older tab keeps this worker) would get this release's
  // cached files, such as an older engine for its newer kin-engine.js.
  if (event.data?.type === "KIN_CLAIM" && event.data.release === RELEASE) event.waitUntil(self.clients.claim());
  if (event.data?.type === "kin-share-take" && event.ports?.[0]) {
    forgetOldShares();
    const share = shares.get(event.data.id) ?? null;
    shares.delete(event.data.id);
    event.ports[0].postMessage(share ? { title: share.title, text: share.text, url: share.url, files: share.files } : null);
  }
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("kin-static-") && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.origin === self.location.origin && url.pathname === "/share") {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate" && ["/", "/pair", "/link"].includes(url.pathname)) {
    // Never cache the requested URL (which could contain a pairing code).
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then((cache) => cache.match("/index.html"))));
  } else if (!url.search && ALLOWED.has(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(url.pathname);
      if (cached && cached.ok) return cached;
      if (cached) await cache.delete(url.pathname);
      return fetch(event.request);
    }));
  }
});

// ---- Push notifications (#85) ----------------------------------------------
// A push says only that something is new: the payload is fixed and carries no
// household content, and this worker never opens the key stores or decrypts
// anything. It always shows a notification (browsers require one for every
// push). Nothing here is cached.

// The installed app's own name (#78), if the household published one, so the
// notification matches the home-screen icon. Kin otherwise.
async function notificationIdentity() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const response = await fetch("/manifest.webmanifest", { credentials: "include", cache: "no-store", signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error("no manifest");
    const manifest = await response.json();
    const name = typeof manifest.short_name === "string" && manifest.short_name.trim() ? manifest.short_name.trim().slice(0, 48) : "Kin";
    const icon = manifest.icons?.find((entry) => entry.type === "image/png" && entry.purpose !== "maskable")?.src;
    return { name, icon: typeof icon === "string" && icon.startsWith("/") ? icon : "/icon.svg" };
  } catch {
    return { name: "Kin", icon: "/icon.svg" };
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const { name, icon } = await notificationIdentity();
    await self.registration.showNotification(name === "Kin" ? "Kin" : name, {
      body: name === "Kin" ? "Something new in Kin" : `Something new in ${name}`,
      tag: "kin-new",
      renotify: false,
      icon,
      badge: icon,
      data: { url: "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    // Focus an open Kin window, else open one. Kin's own lock applies.
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.focus();
    return self.clients.openWindow("/");
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
    if (!applicationServerKey) return;
    const subscription = event.newSubscription ??
      await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    const json = subscription.toJSON();
    await fetch("/api/push/subscription", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    }).catch(() => {});
  })());
});
