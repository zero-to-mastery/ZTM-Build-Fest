import test, { before, after } from "node:test";
import assert from "node:assert/strict";

// A just-enough DOM for <ob-search>: it only needs the four children it queries and a few
// attribute helpers. The WebAssembly module is pointed at a data: URL that throws, so the
// element takes its JavaScript fallback and the test needs no build output.
const BROKEN_WASM = 'data:text/javascript,throw new Error("no wasm in tests")';

class FakeElement {
  constructor(attributes = {}) {
    this.attributes = { index: "/search.json", wasm: BROKEN_WASM, ...attributes };
    this.input = { value: "", listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; } };
    this.status = { textContent: "" };
    this.results = { innerHTML: "", replaceChildren() { this.innerHTML = ""; } };
    this.form = { addEventListener() {} };
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  querySelector(selector) {
    if (selector === "input[type=search]") return this.input;
    if (selector === ".ob-search-status") return this.status;
    if (selector === ".ob-search-results") return this.results;
    if (selector === "form") return this.form;
    return null;
  }
}

// The component is imported exactly once. Re-importing the same file under a different `?query`
// is not a reliable way to get a fresh copy on every Node version, so each test builds a new
// element and swaps the page address instead. The runner gives this file its own process; the
// hooks put the globals back anyway.
const KEYS = ["HTMLElement", "customElements", "location", "history", "fetch", "console"];
const saved = new Map();
const page = { location: { href: "", search: "" }, replaced: [] };
let ObSearch;

before(async () => {
  for (const key of KEYS) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const registry = new Map();
  globalThis.HTMLElement = FakeElement;
  globalThis.customElements = { get: (name) => registry.get(name), define: (name, value) => registry.set(name, value) };
  Object.defineProperty(globalThis, "location", { get: () => page.location, configurable: true });
  Object.defineProperty(globalThis, "history", {
    value: { replaceState: (_state, _title, next) => page.replaced.push(String(next)) },
    configurable: true,
    writable: true,
  });
  globalThis.fetch = async () => ({ ok: true, text: async () => '{"entries":[]}' });
  globalThis.console = { ...console, info() {}, warn() {} };
  await import("../../web/components/ob-search.js");
  ObSearch = registry.get("ob-search");
  assert.equal(typeof ObSearch, "function", "ob-search.js defines the element");
});

after(() => {
  for (const key of KEYS) {
    const descriptor = saved.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

async function mount(attributes, address) {
  const url = new URL(address);
  page.location = { href: url.href, search: url.search };
  page.replaced = [];
  const element = new ObSearch();
  Object.assign(element.attributes, attributes);
  await element.connectedCallback();
  return { element, replaced: page.replaced, type: (text) => { element.input.value = text; element.input.listeners.input(); } };
}

test("by default the search box reads ?q= and keeps the address in step with what is typed", async () => {
  const { element, replaced, type } = await mount({}, "https://site.test/search/?q=hello");
  assert.equal(element.input.value, "hello");
  assert.ok(replaced.at(-1).includes("q=hello"), replaced.join(" | "));
  type("git rebase");
  assert.ok(replaced.at(-1).includes("q=git+rebase") || replaced.at(-1).includes("q=git%20rebase"), replaced.join(" | "));
  type("");
  assert.equal(new URL(replaced.at(-1)).searchParams.has("q"), false);
});

test("no-history ignores ?q= and never rewrites the address, so a search inside a dialog leaves the page alone", async () => {
  const { element, replaced, type } = await mount({ "no-history": "" }, "https://site.test/some-post/?q=hello");
  assert.equal(element.input.value, "", "the host page's own ?q= must not leak into the dialog");
  type("git rebase");
  assert.equal(element.status.textContent.length > 0, true, "it still searches");
  assert.deepEqual(replaced, [], "history.replaceState is never called");
});
