import test from "node:test";
import assert from "node:assert/strict";

class Element {
  constructor(tag = "") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.elements = {};
    this.textContent = "";
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...children) {
    for (const child of children) {
      this.children.push(child);
      if (child?.name) this.elements[child.name] = child;
      if (child?.elements) Object.assign(this.elements, child.elements);
    }
  }
  replaceChildren(...children) { this.children = []; this.elements = {}; this.append(...children); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelectorAll(selector) {
    const tags = selector.split(",").map((tag) => tag.toUpperCase());
    return this.children.flatMap((child) => [child, ...(child.querySelectorAll?.(selector) || [])]).filter((child) => tags.includes(child.tagName));
  }
  reset() { for (const control of Object.values(this.elements)) control.value = ""; }
}

test("comments render untrusted values as text and submit for moderation", async () => {
  const previous = { HTMLElement: globalThis.HTMLElement, customElements: globalThis.customElements, document: globalThis.document, fetch: globalThis.fetch };
  const registry = new Map();
  globalThis.HTMLElement = Element;
  globalThis.customElements = { get: (name) => registry.get(name), define: (name, value) => registry.set(name, value) };
  globalThis.document = { createElement: (tag) => new Element(tag) };
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return options.method === "POST"
      ? { ok: true, json: async () => ({ status: "pending" }) }
      : { ok: true, json: async () => ({ comments: [{ authorName: "<img onerror=bad>", body: "<script>bad()</script>", createdAt: "2026-10-24T12:00:00Z" }] }) };
  };
  try {
    const { ObComments } = await import(`../../web/components/ob-comments.js?test=${Date.now()}`);
    const comments = new ObComments("ob-comments");
    comments.setAttribute("path", "/story/");
    comments.setAttribute("endpoint", "https://blog.example/api/");
    await comments.connectedCallback();
    assert.equal(calls[0].url, "https://blog.example/api/comments?path=%2Fstory%2F");
    const all = comments.querySelectorAll("strong,p");
    assert.ok(all.some((node) => node.textContent === "<img onerror=bad>"));
    assert.ok(all.some((node) => node.textContent === "<script>bad()</script>"));

    const form = comments.querySelectorAll("form")[0];
    form.elements.authorName.value = "Mira";
    form.elements.body.value = "Useful post.";
    await form.listeners.submit({ preventDefault() {} });
    assert.deepEqual(JSON.parse(calls[1].options.body), { path: "/story/", authorName: "Mira", body: "Useful post." });
    assert.ok(comments.querySelectorAll("p").some((node) => node.textContent === "Comment submitted for moderation."));

    const locked = new ObComments("ob-comments");
    locked.setAttribute("path", "/story/");
    locked.setAttribute("endpoint", "https://blog.example/api");
    locked.setAttribute("mode", "locked");
    await locked.connectedCallback();
    assert.equal(locked.querySelectorAll("form").length, 0);
    assert.ok(locked.querySelectorAll("p").some((node) => node.textContent === "This discussion is read-only."));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
