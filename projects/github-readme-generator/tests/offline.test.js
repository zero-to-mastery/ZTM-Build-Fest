// @vitest-environment node
import { it, expect } from "vitest";
import { runInNewContext } from "node:vm";
import { offlinePlugin } from "../scripts/offline-plugin.mjs";
function worker() {
  let output;
  offlinePlugin("0.9.2").generateBundle.call(
    { emitFile: (v) => (output = v) },
    null,
    { "assets/main-test.js": {} },
  );
  const events = {},
    requests = [],
    removed = [];
  const scope = "https://studio.example/readme-studio/";
  const cache = {
    addAll: async (values) => requests.push(...values),
    match: async () => new Response("cached"),
    put: async () => {},
  };
  runInNewContext(output.source, {
    URL,
    Request,
    Error,
    Set,
    Promise,
    self: {
      registration: { scope },
      location: { origin: "https://studio.example" },
      addEventListener: (name, handler) => (events[name] = handler),
      skipWaiting: () => {},
    },
    caches: {
      open: async () => cache,
      keys: async () => [
        "unrelated",
        "readme-studio:" + scope + ":oldest",
        "readme-studio:" + scope + ":previous",
      ],
      delete: async (name) => removed.push(name),
    },
    fetch: async () => {
      throw Error("offline");
    },
  });
  return { events, requests, removed, scope };
}
it("pre-caches only named same-origin static resources with omitted credentials", async () => {
  const w = worker();
  let done;
  w.events.install({ waitUntil: (p) => (done = p) });
  await done;
  expect(w.requests.length).toBeGreaterThan(3);
  expect(
    w.requests.every(
      (r) => r.credentials === "omit" && r.url.startsWith(w.scope),
    ),
  ).toBe(true);
  expect(w.requests.some((r) => r.url.includes("/api/"))).toBe(false);
});
it("never intercepts writes, APIs, remote images, query strings or authorization", () => {
  const w = worker();
  for (const request of [
    new Request(w.scope + "api/publishing/session"),
    new Request(w.scope, { method: "POST" }),
    new Request("https://images.example/a.svg"),
    new Request(w.scope + "?code=secret"),
    new Request(w.scope, { headers: { Authorization: "secret" } }),
  ]) {
    let intercepted = false;
    w.events.fetch({ request, respondWith: () => (intercepted = true) });
    expect(intercepted).toBe(false);
  }
});
it("retains the previous scoped cache and leaves other apps alone", async () => {
  const w = worker();
  let done;
  w.events.activate({ waitUntil: (p) => (done = p) });
  await done;
  expect(w.removed).toEqual(["readme-studio:" + w.scope + ":oldest"]);
});
