import { publicLimitMessage } from "./github-access.mjs";
const VERSION = 1;
const API_ORIGIN = "https://api.github.com";
const DEFAULT_TTL = 15 * 60 * 1000;

function hash(value) {
  let first = 0x811c9dc5,
    second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}

function authKey(context, scopes) {
  if (!context) return Promise.resolve("public");
  const value = String(context);
  if (!scopes.has(value)) {
    const scope = (async () => {
      try {
        const bytes = new TextEncoder().encode(value);
        const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      } catch {
        return hash(value);
      }
    })();
    scopes.set(value, scope);
    if (scopes.size > 16) scopes.delete(scopes.keys().next().value);
  }
  return scopes.get(value);
}

function cloneResponse(entry, extraHeaders = {}) {
  const headers = new Headers(entry.headers || {});
  for (const [name, value] of Object.entries(extraHeaders))
    headers.set(name, value);
  return new Response(entry.body || null, {
    status: entry.status,
    statusText: entry.statusText,
    headers,
  });
}

function cloneNetworkResponse(response) {
  return typeof response?.clone === "function" ? response.clone() : response;
}

function waitForConsumer(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(
      signal.reason ||
        new DOMException("The operation was aborted.", "AbortError"),
    );
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason ||
          new DOMException("The operation was aborted.", "AbortError"),
      );
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createGitHubRequestCache({
  fetchImpl = fetch,
  storage,
  storageKey = "constellation-github-requests-v1",
  ttlMs = DEFAULT_TTL,
  maxEntries = 500,
  maxBytes = 5 * 1024 * 1024,
  now = Date.now,
} = {}) {
  const entries = new Map();
  const pending = new Map();
  const cooldowns = new Map();
  const epochs = new Map();
  const authScopes = new Map();
  const rates = new Map();
  const stats = { hit: 0, miss: 0, sharedRequest: 0, revalidation: 0 };
  let retainedBytes = 0;
  let revision = 0;
  let publicInFlight = 0;

  function load() {
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) || "null");
      if (saved?.version !== VERSION || !Array.isArray(saved.entries)) return;
      if (
        saved.publicRate &&
        Number.isFinite(saved.publicRate.remaining) &&
        Number.isFinite(saved.publicRate.observedAt)
      )
        rates.set("public", saved.publicRate);
      for (const item of saved.cooldowns || []) {
        if (
          Array.isArray(item) &&
          typeof item[0] === "string" &&
          Number.isFinite(item[1]) &&
          item[1] > now()
        )
          cooldowns.set(item[0], item[1]);
      }
      for (const raw of saved.entries) {
        if (
          !raw ||
          typeof raw.key !== "string" ||
          typeof raw.body !== "string" ||
          !Number.isFinite(raw.expiresAt) ||
          !Number.isFinite(raw.storedAt)
        )
          continue;
        insert(raw.key, raw, false);
      }
    } catch {
      /* Cache persistence is best-effort. */
    }
  }

  function persist() {
    try {
      const publicEntries = [...entries.values()].filter(
        (entry) => entry.persistable,
      );
      const savedCooldowns = [...cooldowns]
        .filter(([, until]) => until > now())
        .slice(-64);
      storage?.setItem(
        storageKey,
        JSON.stringify({
          version: VERSION,
          entries: publicEntries,
          cooldowns: savedCooldowns,
          publicRate: rates.get("public"),
        }),
      );
    } catch {
      /* Quota and unavailable-storage errors do not affect requests. */
    }
  }

  function insert(key, entry, save = true) {
    const replaced = entries.has(key);
    if (replaced) {
      retainedBytes -= entries.get(key).size;
      entries.delete(key);
    }
    entry.key = key;
    entry.size =
      entry.body.length * 2 + JSON.stringify(entry.headers).length * 2;
    if (entry.size > maxBytes) {
      if (save && replaced) persist();
      return;
    }
    entries.set(key, entry);
    retainedBytes += entry.size;
    while (entries.size > maxEntries || retainedBytes > maxBytes) {
      const oldestKey = entries.keys().next().value;
      retainedBytes -= entries.get(oldestKey).size;
      entries.delete(oldestKey);
    }
    if (save) persist();
  }

  load();

  async function request(
    input,
    init = {},
    { authContext, publicBudget = false } = {},
  ) {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (
      init.method || (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init.headers || {}).forEach((value, name) =>
      headers.set(name, value),
    );
    const authorization = headers.get("authorization");
    const context = authContext ?? authorization ?? null;
    const bypass = init.refresh === true || init.cache === "no-store";
    const signal =
      init.signal || (input instanceof Request ? input.signal : undefined);
    const nativeInit = { ...init, method, headers };
    delete nativeInit.refresh;
    if (
      url.origin !== API_ORIGIN ||
      method !== "GET" ||
      url.pathname === "/graphql"
    )
      return waitForConsumer(fetchImpl(input, nativeInit), signal);

    const representation = headers.get("accept") || "";
    const scope = await authKey(context, authScopes);
    const key = `${method}\n${url.href}\n${representation}\n${scope}`;
    if (pending.has(key) && (!bypass || pending.get(key).refresh)) {
      stats.sharedRequest++;
      return waitForConsumer(
        pending.get(key).promise.then(cloneNetworkResponse),
        signal,
      );
    }
    let cached = entries.get(key);
    const time = now();
    const cooldownUntil = cooldowns.get(scope) || 0;
    const rate = rates.get(scope);
    const stopped =
      cooldownUntil > time ||
      (publicBudget &&
        !context &&
        rate?.remaining - publicInFlight <= 5 &&
        (rate.reset || rate.observedAt + 60000) > time);
    // Cached data stays useful even while GitHub refuses new requests.
    if (stopped && cached && publicBudget && !context) {
      stats.hit++;
      return cloneResponse(cached, { "X-Constellation-Cache": "hit" });
    }
    if (stopped)
      throw new Error(
        publicBudget && !context
          ? publicLimitMessage(rate?.reset)
          : `GitHub rate limit is active; retry after ${new Date(cooldownUntil).toISOString()}.`,
      );
    if (bypass) {
      epochs.set(key, (epochs.get(key) || 0) + 1);
      if (cached && !(publicBudget && !context)) {
        retainedBytes -= cached.size;
        entries.delete(key);
        persist();
      }
      cached = undefined;
    }
    if (!bypass && cached && cached.expiresAt > time) {
      stats.hit++;
      entries.delete(key);
      entries.set(key, cached);
      return waitForConsumer(
        Promise.resolve(
          cloneResponse(cached, { "X-Constellation-Cache": "hit" }),
        ),
        signal,
      );
    }
    const cooldownKey = scope;

    stats.miss++;
    const requestRevision = revision,
      requestEpoch = epochs.get(key) || 0;
    const operation = (async () => {
      const requestHeaders = new Headers(headers);
      if (!bypass && cached?.etag)
        requestHeaders.set("If-None-Match", cached.etag);
      let response;
      if (publicBudget && !context) publicInFlight++;
      try {
        response = await fetchImpl(input, {
          ...nativeInit,
          headers: requestHeaders,
          signal: AbortSignal.timeout(20000),
        });
      } finally {
        if (publicBudget && !context) publicInFlight--;
      }
      if (!response || typeof response.status !== "number") return response;
      const getHeader = (name) => response.headers?.get?.(name) || null;
      const retryAfter = getHeader("retry-after");
      const remaining = getHeader("x-ratelimit-remaining");
      if (remaining !== null)
        rates.set(scope, {
          limit:
            getHeader("x-ratelimit-limit") === null
              ? null
              : Number(getHeader("x-ratelimit-limit")),
          remaining: Number(remaining),
          reset: Number(getHeader("x-ratelimit-reset")) * 1000 || null,
          resource: getHeader("x-ratelimit-resource") || "core",
          observedAt: now(),
        });
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (publicBudget || retryAfter || remaining === "0"))
      ) {
        const resetValue = Number(getHeader("x-ratelimit-reset"));
        const resetMs =
          Number.isFinite(resetValue) && resetValue > 0
            ? Math.max(0, resetValue * 1000 - time)
            : 0;
        const retryNumber = Number(retryAfter);
        const retryMs =
          retryAfter && Number.isFinite(retryNumber)
            ? retryNumber * 1000
            : retryAfter
              ? Math.max(0, Date.parse(retryAfter) - time)
              : 0;
        cooldowns.set(
          cooldownKey,
          Math.max(
            cooldowns.get(cooldownKey) || 0,
            time +
              Math.max(
                Number.isFinite(retryMs) ? retryMs : 0,
                resetMs,
                publicBudget && !retryMs && !resetMs ? 60000 : 1000,
              ),
          ),
        );
        if (cooldowns.size > 64)
          cooldowns.delete(
            [...cooldowns].sort((left, right) => left[1] - right[1])[0][0],
          );
        persist();
        if (publicBudget && !context)
          throw new Error(publicLimitMessage(rates.get(scope)?.reset));
      }
      if (response.status === 304 && cached) {
        stats.revalidation++;
        const updated = {
          ...cached,
          expiresAt: now() + ttlMs,
          storedAt: now(),
          persistable: cached.persistable,
        };
        const merged = new Headers(cached.headers);
        response.headers?.forEach?.((value, name) => merged.set(name, value));
        updated.headers = [...merged.entries()];
        updated.etag = merged.get("etag") || cached.etag;
        if (
          requestRevision === revision &&
          requestEpoch === (epochs.get(key) || 0)
        )
          insert(key, updated);
        return cloneResponse(updated, {
          "X-Constellation-Cache": "revalidated",
        });
      }
      if (!response.ok) return response;
      const body = await response.clone().text();
      const responseHeaders = [
        ...(response.headers || new Headers()).entries(),
      ];
      const cacheable =
        !getHeader("cache-control")?.includes("no-store") &&
        body.length * 2 <= maxBytes;
      if (
        cacheable &&
        requestRevision === revision &&
        requestEpoch === (epochs.get(key) || 0)
      ) {
        const entry = {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body,
          etag: getHeader("etag") || "",
          storedAt: now(),
          expiresAt: now() + ttlMs,
          persistable: !context,
        };
        insert(key, entry);
      }
      return cloneResponse(
        {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body,
        },
        { "X-Constellation-Cache": "miss" },
      );
    })();
    const pendingEntry = { promise: operation, refresh: bypass };
    pending.set(key, pendingEntry);
    try {
      return await waitForConsumer(
        operation.then(cloneNetworkResponse),
        signal,
      );
    } finally {
      if (pending.get(key) === pendingEntry) pending.delete(key);
    }
  }

  return {
    fetch: request,
    publicRateLimit() {
      const rate = rates.get("public");
      return {
        ...rate,
        stopped:
          (cooldowns.get("public") || 0) > now() ||
          Boolean(
            rate?.remaining <= 5 &&
            (rate.reset || rate.observedAt + 60000) > now(),
          ),
      };
    },
    clear() {
      revision++;
      entries.clear();
      retainedBytes = 0;
      pending.clear();
      authScopes.clear();
      persist();
    },
    statistics() {
      return { ...stats, entries: entries.size, retainedBytes };
    },
  };
}

export const GITHUB_REQUEST_CACHE_TTL = DEFAULT_TTL;
