import test from "node:test";
import assert from "node:assert/strict";

class Element {
  constructor(tag = "") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.elements = {};
    this.hidden = false;
    this.disabled = false;
    this.history = [];
    this._text = "";
  }
  get textContent() { return this._text; }
  set textContent(value) { this._text = value; this.history.push(value); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === "class") this.className = String(value); if (name === "type") this.type = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...children) {
    for (const child of children) {
      this.children.push(child);
      if (child?.name) this.elements[child.name] = child;
      if (child?.elements) Object.assign(this.elements, child.elements);
    }
  }
  replaceChildren(...children) { this.children = []; this.elements = {}; this.append(...children); }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  async fire(name, event = {}) { for (const listener of this.listeners[name] || []) await listener({ preventDefault() {}, ...event }); }
  focus() { document.activeElement = this; }
  remove() {}
  reset() { for (const control of Object.values(this.elements)) control.value = ""; }
  querySelectorAll(selector) {
    const tags = selector.split(",").map((tag) => tag.toUpperCase());
    return this.children.flatMap((child) => [child, ...(child.querySelectorAll?.(selector) || [])]).filter((child) => tags.includes(child.tagName));
  }
}

const memoryStorage = (fail = false) => {
  const data = new Map();
  return {
    data,
    getItem(key) { if (fail) throw new Error("blocked"); return data.get(key) ?? null; },
    setItem(key, value) { if (fail) throw new Error("blocked"); data.set(key, value); },
    removeItem(key) { if (fail) throw new Error("blocked"); data.delete(key); },
  };
};

class Provider {
  constructor() { this.widgets = []; this.removed = []; this.resets = 0; }
  render(container, options) { this.widgets.push({ container, options }); return `widget-${this.widgets.length}`; }
  reset() { this.resets += 1; }
  remove(id) { this.removed.push(id); }
  get current() { return this.widgets.at(-1).options; }
}

async function setup({ attributes = {}, storage = memoryStorage(), replies = [], clock = { seconds: 1000 }, provider = new Provider(), load } = {}) {
  const previous = { HTMLElement: globalThis.HTMLElement, customElements: globalThis.customElements, document: globalThis.document, fetch: globalThis.fetch, turnstile: globalThis.turnstile };
  const registry = new Map();
  globalThis.HTMLElement = Element;
  globalThis.customElements = { get: (name) => registry.get(name), define: (name, value) => registry.set(name, value) };
  globalThis.document = { createElement: (tag) => new Element(tag), head: new Element("head"), activeElement: null };
  const calls = [];
  const queue = [...replies];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method !== "POST") return { ok: true, json: async () => ({ comments: [] }) };
    const reply = queue.shift() || { status: 202, body: { status: "pending" } };
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  };
  const loads = { count: 0 };
  const { ObComments } = await import(`../../web/components/ob-comments.js?test=${Math.random()}`);
  const mount = async (extra = {}) => {
    const comments = new ObComments("ob-comments");
    for (const [name, value] of Object.entries({ path: "/story/", endpoint: "https://blog.example/api/", ...attributes, ...extra })) comments.setAttribute(name, value);
    comments.captchaOptions = { now: () => clock.seconds * 1000, storage: () => storage, ...(load === "default" ? {} : { load: async () => { loads.count += 1; return provider; } }) };
    await comments.connectedCallback();
    const form = comments.querySelectorAll("form")[0];
    const status = comments.querySelectorAll("p").find((node) => node.className === "ob-comments-status");
    const type = (name = "Mira", body = "A thoughtful draft") => { form.elements.authorName.value = name; form.elements.body.value = body; };
    const buttons = comments.querySelectorAll("button");
    const submit = buttons.find((node) => node.type === "submit");
    const retry = buttons.find((node) => node.className === "ob-comments-captcha-retry");
    const send = () => form.fire("submit");
    return { comments, form, status, type, send, submit, retry, form_: form };
  };
  const posts = () => calls.filter(({ options }) => options.method === "POST").map(({ options }) => JSON.parse(options.body));
  const restore = () => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[name]; else globalThis[name] = value; } };
  return { mount, calls, posts, loads, provider, storage, clock, restore };
}

const on = { "captcha-provider": "turnstile", "captcha-site-key": "public-key", "captcha-scope": "session" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const required = { status: 403, body: { code: "captcha_required", error: "server words" } };
const stored = (storage) => [...storage.data.values()].map((value) => JSON.parse(value));

test("nothing third-party is requested until the reader interacts, and then only once", async () => {
  const t = await setup({ attributes: on });
  try {
    const view = await t.mount();
    await settle();
    assert.equal(t.loads.count, 0);
    assert.equal(t.provider.widgets.length, 0);
    await view.form.fire("focusin");
    await view.form.fire("input");
    await view.form.fire("focusin");
    await settle();
    assert.equal(t.loads.count, 1);
    assert.equal(t.provider.widgets.length, 1);
    assert.equal(t.provider.current.sitekey, "public-key");
    assert.equal(t.provider.current.action, "comment");
    assert.equal(view.status.history.filter((text) => text === "Checking that you are human…").length, 1, "announced once");
  } finally { t.restore(); }
});

test("the real loader injects one allowlisted async script and reports a blocked script", async () => {
  const t = await setup({ attributes: on, load: "default" });
  try {
    delete globalThis.turnstile;
    const view = await t.mount();
    await view.form.fire("focusin");
    const scripts = globalThis.document.head.children;
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].src, "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    assert.equal(scripts[0].async, true);
    await view.form.fire("input");
    assert.equal(globalThis.document.head.children.length, 1);
    scripts[0].onerror();
    await settle();
    assert.equal(view.retry.hidden, false);
    assert.match(view.status.textContent, /could not load.*Your comment is kept.*Retry verification/);
  } finally { t.restore(); }
});

test("the first submit sends the token, the pass is remembered for the tab, later comments need no challenge", async () => {
  const pass = { status: 202, body: { status: "pending", captchaPass: "signed.pass", captchaPassExpiresAt: 2800 } };
  const t = await setup({ attributes: on, replies: [pass] });
  try {
    const view = await t.mount();
    await view.form.fire("focusin");
    await settle();
    view.type();
    t.provider.current.callback("turnstile-token");
    assert.equal(view.status.textContent, "Verified. You can submit your comment.");
    await view.send();
    assert.deepEqual(t.posts()[0], { path: "/story/", authorName: "Mira", body: "A thoughtful draft", captchaToken: "turnstile-token" });
    assert.equal(view.status.textContent, "Comment submitted for moderation.");
    assert.deepEqual(stored(t.storage), [{ pass: "signed.pass", expiresAt: 2800 }]);
    assert.deepEqual(t.provider.removed, ["widget-1"]);
    const second = await t.mount();
    second.type("Mira", "Second");
    await second.form.fire("focusin");
    await settle();
    await second.send();
    assert.equal(t.loads.count, 1, "no second provider load");
    assert.deepEqual(t.posts()[1], { path: "/story/", authorName: "Mira", body: "Second", captchaPass: "signed.pass" });
    for (const { url } of t.calls) assert.ok(url.startsWith("https://blog.example/api/comments"), url);
  } finally { t.restore(); }
});

test("submitting before verification is blocked with a clear message and keeps the text", async () => {
  const t = await setup({ attributes: on });
  try {
    const view = await t.mount();
    view.type("Mira", "Do not lose this");
    await view.form.fire("focusin");
    await settle();
    await view.send();
    assert.equal(t.posts().length, 0);
    assert.equal(view.status.textContent, "Still checking that you are human. Your comment is kept; submit again in a moment.");
    assert.equal(view.form.elements.body.value, "Do not lose this");
    assert.equal(view.submit.disabled, false);
    await view.send();
    assert.equal(view.status.history.filter((text) => text.startsWith("Still checking")).length, 2, "each blocked attempt is its own announcement");
    t.provider.current.callback("late");
    await view.send();
    assert.equal(t.posts()[0].captchaToken, "late");
  } finally { t.restore(); }
});

test("an expired pass is not sent and triggers a fresh challenge", async () => {
  const t = await setup({ attributes: on });
  try {
    t.storage.setItem("openblog.commentPass.v1:https://blog.example/api:public-key", JSON.stringify({ pass: "old.pass", expiresAt: 1003 }));
    const view = await t.mount();
    view.type();
    await view.send();
    assert.equal(t.posts().length, 0, "within the clock-skew margin the pass counts as expired");
    assert.equal(t.storage.data.size, 0, "the expired pass is dropped");
    await settle();
    assert.equal(t.provider.widgets.length, 1);
    t.provider.current.callback("fresh");
    await view.send();
    assert.equal(t.posts()[0].captchaToken, "fresh");
    assert.equal("captchaPass" in t.posts()[0], false);
  } finally { t.restore(); }
});

test("a rejected pass runs exactly one fresh challenge and one automatic retry with the same text", async () => {
  const t = await setup({ attributes: on, replies: [required] });
  try {
    t.storage.setItem("openblog.commentPass.v1:https://blog.example/api:public-key", JSON.stringify({ pass: "revoked.pass", expiresAt: 5000 }));
    const view = await t.mount();
    view.type("Mira", "Keep me");
    await view.send();
    assert.equal(t.posts()[0].captchaPass, "revoked.pass");
    assert.equal(t.storage.data.size, 0, "the rejected pass is dropped");
    assert.match(view.status.textContent, /Checking again; your comment is kept/);
    assert.equal(view.form.elements.body.value, "Keep me");
    await settle();
    assert.equal(t.provider.widgets.length, 1, "one fresh challenge");
    t.provider.current.callback("fresh-token");
    await settle();
    assert.equal(t.posts().length, 2, "one retry");
    assert.deepEqual(t.posts()[1], { path: "/story/", authorName: "Mira", body: "Keep me", captchaToken: "fresh-token" });
    assert.equal(view.status.textContent, "Comment submitted for moderation.");
  } finally { t.restore(); }
});

test("a second rejection does not loop: the reader is told and the text is kept", async () => {
  const t = await setup({ attributes: on, replies: [required, required] });
  try {
    const view = await t.mount();
    view.type("Mira", "Keep me");
    await view.form.fire("focusin");
    await settle();
    t.provider.current.callback("first");
    await view.send();
    t.provider.current.callback("second");
    await settle();
    assert.equal(t.posts().length, 2);
    assert.equal(view.status.textContent, "server words");
    assert.equal(view.form.elements.body.value, "Keep me");
    t.provider.current.callback("third");
    await settle();
    assert.equal(t.posts().length, 2, "no automatic third attempt");
  } finally { t.restore(); }
});

test("blocked storage keeps the pass in memory for the page and persists nothing", async () => {
  const pass = { status: 202, body: { status: "pending", captchaPass: "memory.pass", captchaPassExpiresAt: 2800 } };
  const t = await setup({ attributes: on, storage: memoryStorage(true), replies: [pass] });
  try {
    const view = await t.mount();
    await view.form.fire("focusin");
    await settle();
    t.provider.current.callback("tok");
    view.type();
    await view.send();
    view.type("Mira", "Again");
    await view.send();
    assert.equal(t.posts()[1].captchaPass, "memory.pass");
    assert.equal(t.provider.widgets.length, 1);
  } finally { t.restore(); }
});

test("every-comment scope never stores or sends a pass and asks again each time", async () => {
  const issued = { status: 202, body: { status: "pending", captchaPass: "ignored.pass", captchaPassExpiresAt: 2800 } };
  const t = await setup({ attributes: { ...on, "captcha-scope": "every-comment" }, replies: [issued] });
  try {
    t.storage.setItem("openblog.commentPass.v1:https://blog.example/api:public-key", JSON.stringify({ pass: "leftover.pass", expiresAt: 5000 }));
    const view = await t.mount();
    await view.form.fire("focusin");
    await settle();
    t.provider.current.callback("one");
    view.type();
    await view.send();
    assert.equal("captchaPass" in t.posts()[0], false);
    assert.equal(t.posts()[0].captchaToken, "one");
    assert.equal(t.provider.resets, 1, "the widget is reset after use");
    view.type("Mira", "Next");
    await view.send();
    assert.equal(t.posts().length, 1, "a second comment waits for a new token");
    t.provider.current.callback("two");
    await view.send();
    assert.equal(t.posts()[1].captchaToken, "two");
    assert.equal(stored(t.storage).every((value) => value.pass === "leftover.pass"), true);
  } finally { t.restore(); }
});

test("provider failures are recoverable: plain copy, a Retry button, focus and text kept", async () => {
  const t = await setup({ attributes: on });
  try {
    const view = await t.mount();
    view.type("Mira", "Words to keep");
    await view.form.fire("focusin");
    await settle();
    t.provider.current["error-callback"]();
    assert.equal(view.retry.hidden, false);
    assert.match(view.status.textContent, /did not work.*Your comment is kept.*Retry verification/);
    assert.equal(view.form.elements.body.value, "Words to keep");
    await view.send();
    assert.equal(t.posts().length, 0);
    assert.match(view.status.textContent, /did not work/);
    await view.retry.fire("click");
    await settle();
    assert.equal(globalThis.document.activeElement, view.submit);
    assert.equal(view.retry.hidden, true);
    assert.equal(t.provider.widgets.length, 2);
    assert.deepEqual(t.provider.removed, ["widget-1"]);
    t.provider.current["expired-callback"]();
    assert.match(view.status.textContent, /expired/);
    assert.equal(view.retry.hidden, false);
  } finally { t.restore(); }
});

test("an interactive challenge takes focus and hands it back to Submit", async () => {
  const t = await setup({ attributes: on });
  try {
    const view = await t.mount();
    await view.form.fire("focusin");
    await settle();
    const widget = t.provider.widgets[0];
    assert.equal(widget.container.hidden, true);
    t.provider.current["before-interactive-callback"]();
    assert.equal(widget.container.hidden, false);
    assert.equal(globalThis.document.activeElement, widget.container);
    assert.equal(widget.container.getAttribute("tabindex"), "-1");
    assert.equal(widget.container.getAttribute("role"), "group");
    assert.equal(widget.container.getAttribute("aria-label"), "Human check");
    assert.match(view.status.textContent, /complete the human check below/);
    t.provider.current.callback("done");
    assert.equal(globalThis.document.activeElement, view.submit);
    assert.equal(widget.container.hidden, true);
  } finally { t.restore(); }
});

test("the third-party disclosure appears only when captcha is on and the form is writable", async () => {
  const t = await setup({ attributes: on });
  try {
    const view = await t.mount();
    const note = view.comments.querySelectorAll("p").find((node) => node.className === "ob-comments-captcha-note");
    assert.match(note.textContent, /Cloudflare Turnstile.*IP address.*nothing loads until you click into this form/s);
    const container = view.comments.querySelectorAll("div").find((node) => node.className === "ob-comments-captcha");
    assert.equal(container.getAttribute("aria-describedby"), note.getAttribute("id"));
    const order = view.form.children.map((child) => child.className || child.tagName);
    assert.ok(order.indexOf("ob-comments-captcha") < order.indexOf("BUTTON"), "the challenge sits above Submit");
    const locked = await t.mount({ mode: "locked" });
    assert.equal(locked.comments.querySelectorAll("p").some((node) => node.className === "ob-comments-captcha-note"), false);
    assert.equal(t.loads.count, 0);
  } finally { t.restore(); }
});

test("without captcha attributes the component builds the same form and never touches a provider", async () => {
  const t = await setup({ attributes: {} });
  try {
    const view = await t.mount();
    assert.deepEqual(view.form.children.map((child) => child.tagName), ["LABEL", "LABEL", "BUTTON"]);
    assert.equal(view.comments.captcha, null);
    view.type();
    await view.form.fire("focusin");
    await view.send();
    assert.deepEqual(t.posts(), [{ path: "/story/", authorName: "Mira", body: "A thoughtful draft" }]);
    assert.equal(t.loads.count, 0);
    const other = await t.mount({ "captcha-provider": "unknown" });
    assert.equal(other.comments.captcha, null);
  } finally { t.restore(); }
});

test("a token spent on a refused comment is reset so the reader can try again", async () => {
  const limited = { status: 429, body: { error: "Too many comments. Please try again later." } };
  const t = await setup({ attributes: on, replies: [limited] });
  try {
    const view = await t.mount();
    await view.form.fire("focusin");
    await settle();
    t.provider.current.callback("spent");
    view.type();
    await view.send();
    assert.equal(view.status.textContent, "Too many comments. Please try again later.");
    assert.equal(t.provider.resets, 1);
    assert.equal(t.posts().length, 1);
    await view.send();
    assert.equal(t.posts().length, 1, "needs a new token");
  } finally { t.restore(); }
});
