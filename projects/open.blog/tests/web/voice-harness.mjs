// Shared pieces for the Voice view's harness tests: a clock the test moves by hand and a small in-memory
// stand-in for the server's voice routes that follows the same rules (the deadline is the server's, a late
// draft is refused, a lock takes the final text only within ten seconds of the deadline, a rough draft is
// created once, a polished save names its revision).

import { ApiError, DomNode } from "./dom-shim.mjs";

// The shared shim is forgiving: it skips null and flattens arrays. A real browser does neither (`append(null)` adds
// the text "null" and an array becomes "[object HTMLElement],..."), and a library page once shipped with exactly
// that. Every Voice test therefore runs on a DOM that refuses what a browser would stringify.
for (const method of ["append", "replaceChildren"]) {
  const original = DomNode.prototype[method];
  DomNode.prototype[method] = function strict(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined || node === false || Array.isArray(node)) {
        throw new TypeError(`${method}() was given ${Array.isArray(node) ? "an array" : String(node)}, which a real DOM would turn into text`);
      }
    }
    return original.apply(this, nodes);
  };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export const flush = async () => {
  for (let i = 0; i < 6; i += 1) await tick();
};
// The fake server only awaits promises, so a few microtask turns settle a call without a real timer.
const settle = async () => {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
};

export function fakeClock() {
  let t = 0;
  let id = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    setInterval(run, ms) {
      const key = ++id;
      timers.set(key, { run, ms, next: t + ms, every: true });
      return key;
    },
    clearInterval: (key) => timers.delete(key),
    setTimeout(run, ms) {
      const key = ++id;
      timers.set(key, { run, ms, next: t + ms });
      return key;
    },
    clearTimeout: (key) => timers.delete(key),
    pending: () => timers.size,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.next <= end).sort((a, b) => a[1].next - b[1].next)[0];
        if (!due) break;
        const [key, timer] = due;
        t = Math.max(t, timer.next);
        if (timer.every) timer.next += timer.ms;
        else timers.delete(key);
        await timer.run();
        await settle();
      }
      t = end;
      await flush();
    },
  };
  return clock;
}

const PROMPTS = [
  { id: "a-mistake-i-made", pack: "stories", packTitle: "Stories", title: "A mistake I made", invitation: "Tell about a mistake and what it taught you.", wordsMin: 80, wordsMax: 150, site: false },
  { id: "my-hot-take", pack: "opinions", packTitle: "Opinions", title: "My hot take", invitation: "Say what you really think.", wordsMin: 80, wordsMax: 150, site: false },
  { id: "a-small-joy", pack: "everyday-life", packTitle: "Everyday life", title: "A small joy", invitation: "Describe a small joy.", wordsMin: 60, wordsMax: 120, site: false },
];
const MORE = [
  { id: "teach-it", pack: "teaching", packTitle: "Teaching", title: "Teach it", invitation: "Explain something you know.", wordsMin: 80, wordsMax: 150, site: false },
  { id: "my-people", pack: "people", packTitle: "People", title: "My people", invitation: "Tell about someone.", wordsMin: 80, wordsMax: 150, site: false },
  { id: "a-craft-tip", pack: "craft", packTitle: "Craft", title: "A craft tip", invitation: "Share a tip.", wordsMin: 80, wordsMax: 150, site: false },
];
export const RULE = "Write it the way you would say it.";
export const PROMPT_LIST = [...PROMPTS, ...MORE];

const sha = (text) => `rev-${[...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`;

/**
 * A server. `clock` is the shared fake clock (its `now` is the server's time too). Everything the page
 * sends is recorded in `calls`; `fail` can make a route throw once.
 */
export function fakeServer(clock, { seconds = 180 } = {}) {
  const calls = [];
  const epoch = Date.now();
  const iso = (ms) => new Date(epoch + ms).toISOString();
  const state = { session: null, samples: [], failures: [], drawn: 0, status: null, holds: [] };
  const api = {
    calls,
    state,
    async call(method, path, options = {}) {
      const body = options.json === undefined ? undefined : structuredClone(options.json);
      calls.push({ method, path, body });
      const failure = state.failures.findIndex((f) => f.method === method && path.startsWith(f.path));
      if (failure >= 0) {
        const [{ error }] = state.failures.splice(failure, 1);
        throw error;
      }
      const held = state.holds?.find((h) => h.method === method && path.startsWith(h.path));
      if (held) await held.promise;
      return structuredClone(await route(method, path, body));
    },
  };
  const refuse = (status, data) => new ApiError(data.error || "refused", status, data);
  const sessionView = () => ({
    state: "active",
    sessionId: `${state.session.promptId}@${state.session.startedAt}`,
    promptId: state.session.promptId,
    pack: state.session.pack,
    title: state.session.title,
    invitation: state.session.invitation,
    wordsMin: 80,
    wordsMax: 150,
    rule: RULE,
    deadline: state.session.deadline,
    timeLimitSeconds: seconds,
    remainingSeconds: Math.max(0, Math.ceil((state.session.deadlineMs - clock.now()) / 1000)),
    draft: state.session.draft,
    visibility: state.session.visibility,
  });
  const sampleView = (sample) => ({ ...sample, readOnly: sample.stage === "rough" });
  function lockNow(text) {
    const session = state.session;
    const rough = {
      id: `2026-10-28-${session.promptId}-rough`,
      file: `2026-10-28-${session.promptId}-rough.md`,
      visibility: session.visibility,
      stage: "rough",
      pack: session.pack,
      prompt: session.promptId,
      promptTitle: session.title,
      title: session.title,
      words: text.trim() ? text.trim().split(/\s+/).length : 0,
      date: `2026-10-28T09:00:00Z`,
      body: text,
      valid: true,
      revision: sha(text),
      roughOf: null,
    };
    state.samples.push(rough);
    state.session = null;
    return rough;
  }
  async function route(method, path, body) {
    const url = new URL(path, "http://x");
    const route = url.pathname.replace(/^\//, "");
    if (method === "GET" && route === "voice/status") {
      const s = state.session;
      return state.status || { session: s ? { open: true, expired: clock.now() >= s.deadlineMs, sessionId: sessionView().sessionId, deadline: s.deadline, draftChars: [...s.draft].length } : { open: false }, samples: state.samples.length };
    }
    if (method === "POST" && route === "voice/draw") {
      state.drawn += 1;
      const exclude = body.exclude || [];
      const pool = PROMPT_LIST.filter((p) => !exclude.includes(p.id) && (!body.pack || p.pack === body.pack));
      return { prompts: pool.slice(0, 3), rule: RULE, pack: body.pack || null };
    }
    if (method === "GET" && route === "voice/session") {
      const s = state.session;
      if (!s) return { state: "none" };
      if (clock.now() >= s.deadlineMs) {
        if (!s.draft.trim()) {
          state.session = null;
          return { state: "discarded", promptId: s.promptId };
        }
        return { state: "locked", expired: true, words: 0, sample: sampleView(lockNow(s.draft)) };
      }
      return sessionView();
    }
    if (method === "POST" && route === "voice/session/start") {
      if (state.session) throw refuse(409, { error: `A writing session for "${state.session.promptId}" is already open.`, alreadyOpen: true, expired: clock.now() >= state.session.deadlineMs, sessionId: sessionView().sessionId });
      const prompt = PROMPT_LIST.find((p) => p.id === body.promptId);
      const now = clock.now();
      state.session = { promptId: prompt.id, pack: prompt.pack, title: prompt.title, invitation: prompt.invitation, startedAt: `T${now}`, deadlineMs: now + seconds * 1000, deadline: iso(now + seconds * 1000), draft: "", visibility: body.visibility || "private" };
      return sessionView();
    }
    if (method === "PUT" && route === "voice/session/draft") {
      const s = state.session;
      if (!s) throw refuse(409, { error: "There is no open writing session.", noSession: true });
      if (body.sessionId !== sessionView().sessionId) throw refuse(409, { error: "Another session.", otherSession: true });
      if (clock.now() >= s.deadlineMs) throw refuse(409, { error: "Time is up.", timeUp: true });
      s.draft = body.text;
      return { saved: true, remainingSeconds: sessionView().remainingSeconds };
    }
    if (method === "POST" && route === "voice/session/lock") {
      const s = state.session;
      if (!s) throw refuse(409, { error: "There is no open writing session.", noSession: true });
      if (body.sessionId !== sessionView().sessionId) throw refuse(409, { error: "Another session.", otherSession: true });
      const late = clock.now() > s.deadlineMs + 10000;
      const text = typeof body.text === "string" && !late ? body.text : s.draft;
      if (!text.trim()) throw refuse(409, { error: "Nothing was written.", empty: true });
      const expired = clock.now() >= s.deadlineMs;
      return { state: "locked", expired, words: 0, sample: sampleView(lockNow(text)) };
    }
    if (method === "DELETE" && route === "voice/session") {
      // Like the server: only the session the page names is thrown away.
      if (state.session && body?.sessionId !== sessionView().sessionId) throw refuse(409, { error: "A newer writing session is open now, so nothing was thrown away.", otherSession: true });
      state.session = null;
      return { state: "none" };
    }
    if (method === "POST" && route === "voice/samples") {
      const rough = state.samples.find((s) => s.file === body.roughOf);
      if (!rough) throw refuse(404, { error: "There is no such voice sample." });
      if (state.samples.some((s) => s.roughOf === rough.file)) throw refuse(409, { error: "A polished draft already exists.", conflict: true, current: state.samples.find((s) => s.roughOf === rough.file) });
      const polished = { ...rough, id: rough.id.replace(/-rough$/, "-polished"), file: rough.file.replace("-rough.md", "-polished.md"), stage: "polished", roughOf: rough.file, title: body.title, body: body.body, words: body.body.trim().split(/\s+/).length, revision: sha(body.title + body.body) };
      state.samples.push(polished);
      return sampleView(polished);
    }
    const one = /^voice\/samples\/([a-z0-9-]+)$/.exec(route);
    if (method === "PUT" && one) {
      const sample = state.samples.find((s) => s.id === one[1]);
      if (!sample) throw refuse(404, { error: "There is no such voice sample." });
      if (sample.stage === "rough") throw refuse(409, { error: "A rough draft is never changed.", readOnly: true });
      if (body.revision !== sample.revision) throw refuse(409, { error: "This polished draft changed since you opened it.", conflict: true, revision: sample.revision, current: sampleView(sample) });
      Object.assign(sample, { title: body.title, body: body.body, words: body.body.trim().split(/\s+/).length });
      sample.revision = sha(sample.title + sample.body + clock.now());
      return sampleView(sample);
    }
    if (method === "GET" && one) {
      const sample = state.samples.find((s) => s.id === one[1]);
      if (!sample) throw refuse(404, { error: "There is no such voice sample." });
      const partner = state.samples.find((s) => (sample.stage === "rough" ? s.roughOf === sample.file : s.file === sample.roughOf));
      return { ...sampleView(sample), partner: partner ? { id: partner.id, file: partner.file, stage: partner.stage } : null };
    }
    const promote = /^voice\/samples\/([a-z0-9-]+)\/promote$/.exec(route);
    if (method === "POST" && promote) {
      const sample = state.samples.find((s) => s.id === promote[1]);
      if (sample.stage !== "polished") throw refuse(409, { error: "Only a polished draft can become a post." });
      if (state.promoteTaken) throw refuse(409, { error: "A post already uses the slug my-polished-title. Nothing was written." });
      return { created: true, path: "content/posts/my-polished-title.md", editPath: "posts/my-polished-title.md", draft: true };
    }
    const move = /^voice\/samples\/([a-z0-9-]+)\/visibility$/.exec(route);
    if (method === "POST" && move) {
      const sample = state.samples.find((s) => s.id === move[1]);
      for (const s of state.samples.filter((x) => x.prompt === sample.prompt)) s.visibility = body.visibility;
      return { moved: [], visibility: body.visibility };
    }
    if (method === "GET" && route === "voice/samples") {
      return state.listing ? state.listing() : { samples: state.samples.map(({ body: _b, ...rest }) => rest), coverage: [], warnings: [] };
    }
    throw new ApiError(`unexpected ${method} ${path}`, 500, null);
  }
  return api;
}

/** A stand-in for `localStorage`; `blocked` makes every access throw, as a private window can. */
export function fakeStorage({ blocked = false } = {}) {
  const values = new Map();
  const guard = () => {
    if (blocked) throw new Error("blocked");
  };
  return {
    values,
    getItem: (key) => (guard(), values.get(key) ?? null),
    setItem: (key, value) => (guard(), values.set(key, String(value))),
    removeItem: (key) => (guard(), values.delete(key)),
    get length() {
      return guard() ?? values.size;
    },
    key: (index) => (guard(), [...values.keys()][index] ?? null),
  };
}

export const all = (root, selector) => root.querySelectorAll(selector);
export const one = (root, selector) => root.querySelector(selector);
export const text = (node) => node.textContent.replace(/\s+/g, " ").trim();
export const button = (root, action) => root.querySelector(`button[data-action]`) && all(root, "button").find((b) => b.dataset.action === action) || null;
export const link = (root, action) => all(root, "a").find((a) => a.dataset.action === action) || null;

// ---------------------------------------------------------------- an axe-style check for the view

const walk = (node, visit) => {
  for (const child of node.children || []) {
    if (child.hidden) continue;
    visit(child);
    walk(child, visit);
  }
};

/**
 * The problems a quick accessibility scan would report in `root`: names, labels, references, duplicate ids,
 * positive tabindex, headings that skip a level, groups without names. Hidden subtrees are skipped.
 */
export function accessibilityProblems(root) {
  const problems = [];
  const everything = [];
  walk(root, (node) => everything.push(node));
  const byId = new Map();
  for (const node of everything) {
    const id = node.attributes?.id || node.id;
    if (!id) continue;
    if (byId.has(id)) problems.push(`duplicate id ${id}`);
    byId.set(id, node);
  }
  const textOf = (node) => (node ? node.textContent.replace(/\s+/g, " ").trim() : "");
  const nameOf = (node) => {
    if (node.attributes["aria-label"]) return node.attributes["aria-label"];
    if (node.attributes["aria-labelledby"]) return node.attributes["aria-labelledby"].split(/\s+/).map((id) => textOf(byId.get(id))).join(" ").trim();
    return "";
  };
  let lastHeading = 0;
  for (const node of everything) {
    const tag = node.tagName.toLowerCase();
    const where = `${tag}${node.attributes.id ? `#${node.attributes.id}` : ""}${node.dataset?.action ? `[${node.dataset.action}]` : ""}`;
    for (const attribute of ["aria-labelledby", "aria-describedby", "aria-controls"]) {
      for (const id of (node.attributes[attribute] || "").split(/\s+/).filter(Boolean)) if (!byId.has(id)) problems.push(`${where} ${attribute} names a missing id ${id}`);
    }
    if (Number(node.attributes.tabindex) > 0) problems.push(`${where} has a positive tabindex`);
    const control = tag === "textarea" || tag === "select" || (tag === "input" && node.attributes.type !== "hidden");
    if (control) {
      const labelled = nameOf(node) || everything.some((l) => l.tagName === "LABEL" && (l.attributes.for === node.attributes.id || l.contains(node)) && textOf(l));
      if (!labelled) problems.push(`${where} has no accessible name`);
    }
    if (tag === "button" && !textOf(node) && !nameOf(node)) problems.push(`${where} has no accessible name`);
    if (tag === "a" && !(textOf(node) || nameOf(node))) problems.push(`${where} is a link with no name`);
    if (tag === "a" && !node.attributes.href) problems.push(`${where} is a link with no href`);
    if (["timer", "region", "group", "radiogroup"].includes(node.attributes.role) && !nameOf(node)) problems.push(`${where} role ${node.attributes.role} has no name`);
    if (tag === "fieldset" && !node.children.some((c) => c.tagName === "LEGEND")) problems.push(`${where} has no legend`);
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      if (lastHeading && level > lastHeading + 1) problems.push(`${where} skips from h${lastHeading} to h${level}`);
      lastHeading = level;
      if (!textOf(node)) problems.push(`${where} is an empty heading`);
    }
    if (node.attributes["aria-hidden"] === "true" && (control || tag === "button" || tag === "a")) problems.push(`${where} is focusable but aria-hidden`);
  }
  return problems;
}

/** The elements a Tab key reaches, in document order. */
export function tabStops(root) {
  const stops = [];
  walk(root, (node) => {
    const tag = node.tagName.toLowerCase();
    const focusable = (tag === "button" || tag === "textarea" || tag === "select" || (tag === "input" && node.attributes.type !== "hidden") || (tag === "a" && node.attributes.href)) && !node.disabled;
    const tabbable = focusable ? node.attributes.tabindex !== "-1" : node.attributes.tabindex === "0";
    if (tabbable) stops.push(node);
  });
  return stops;
}
