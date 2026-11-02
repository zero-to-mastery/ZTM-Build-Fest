import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MOMENT_LOCATOR_KINDS, QUOTATION_PROVENANCE, QUOTATION_RIGHTS, momentLinkText, momentLocationError, momentPayload, momentText, momentsFailure, parseMomentTimestamp, quotationNotices, rightsGuidanceText, sortMoments } from "../../web/admin/admin.js";
import { APPROVAL_REQUIREMENTS, APPROVAL_ROLE_CHOICES, ARRANGEMENT_LAYOUTS, ObAdmin, approvalPeopleRows, approvalPolicyChoice, approvalPolicyPayload, approvalRuleFailure, approvalRuleText, REFLECTION_PROMPTS, SYNTHESIS_KINDS, TURN_LABEL_MAX_BYTES, arrangementDraft, arrangementFailure, arrangementPayload, draftFailure, draftStateText, insertAtSelection, moveItem, moveSynthesisItem, nextRoundId, partBreakInsertion, previewItemText, previewSectionText, previewStateText, promptInsertion, revealSlotText, synthesisFailure, synthesisItemText, validateArrangement } from "../../web/admin/admin.js";

const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../web/admin/admin.css", import.meta.url), "utf8");

// ---------------------------------------------------------------- DOM shim


class DomNode {
  constructor(tag = "", owner = null) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.owner = owner;
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.selected = false;
    this.open = false;
    this._text = "";
    this._value = undefined;
    this.classList = { contains: (name) => (this.className || "").split(/\s+/).includes(name) };
  }
  get value() {
    if (this.tagName === "SELECT" && this._value === undefined) return this.children.find((child) => child.selected)?.value ?? this.children[0]?.value ?? "";
    return this._value ?? "";
  }
  set value(value) {
    this._value = String(value);
  }
  // Like a browser: anything that is not a node becomes a text node of String(value), so an
  // array shows as "[object HTMLLabelElement]" and null as "null" instead of being skipped.
  append(...children) {
    for (const child of children) {
      const node = child instanceof DomNode ? child : Object.assign(new DomNode("#text"), { textContent: String(child) });
      node.parent?.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "id") this.id = String(value);
    if (name === "hidden") this.hidden = true;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  contains(node) {
    for (let current = node; current; current = current.parent) if (current === this) return true;
    return false;
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  addEventListener(name, listener, options = {}) {
    (this.listeners[name] ||= []).push({ listener, once: Boolean(options.once) });
  }
  dispatch(name, event = {}) {
    const listeners = this.listeners[name] || [];
    this.listeners[name] = listeners.filter((entry) => !entry.once);
    const payload = { type: name, target: this, currentTarget: this, preventDefault() {}, ...event };
    return Promise.all(listeners.map((entry) => entry.listener(payload)));
  }
  click() {
    if (this.disabled) return Promise.resolve();
    return this.dispatch("click");
  }
  focus() {
    this.owner.activeElement = this;
  }
  showModal() {
    this.open = true;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    // Browsers queue the close event as a task, after the code that closed the dialog.
    setTimeout(() => this.dispatch("close"), 0);
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }
  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const valued = selector.match(/^([a-z]*)\[([a-z-]+)="([^"]*)"\]$/);
    if (valued) return (!valued[1] || this.tagName === valued[1].toUpperCase()) && this.attributes[valued[2]] === valued[3];
    const attribute = selector.match(/^([a-z]*)\[([a-z-]+)\]$/);
    if (attribute) {
      const [, tag, name] = attribute;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if (name === "open") return this.open;
      if (name.startsWith("data-")) return name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in this.dataset;
      return name in this.attributes;
    }
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function installDom() {
  const previous = { Node: globalThis.Node, document: globalThis.document, location: globalThis.location, open: globalThis.open, localStorage: globalThis.localStorage };
  const documentShim = {
    activeElement: null,
    documentElement: { dataset: {} },
    title: "",
    createElement: (tag) => new DomNode(tag, documentShim),
    createTextNode: (text) => Object.assign(new DomNode("#text", documentShim), { textContent: String(text) }),
    querySelector: (selector) => documentShim.body.querySelector(selector),
  };
  documentShim.body = new DomNode("body", documentShim);
  globalThis.Node = DomNode;
  globalThis.document = documentShim;
  globalThis.location = { hash: "#/shared", origin: "https://blog.example" };
  return {
    document: documentShim,
    restore() {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
    },
  };
}

const withDom = (run) => async () => {
  const dom = installDom();
  try {
    await run(dom);
  } finally {
    dom.restore();
  }
};


const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await tick();
};

class FakeApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const PUBLICATION = "shared-0a1b2c3d4e5f";
const stampOf = (number) => ({ number, contributionId: "participant-1", digest: "d" });

const ME = { id: "p-me", displayName: "Mikey" };
const OTHER = { id: "p-grace", displayName: "Grace" };

/** Applies one synthesis change the way the server does: a revision check, then the change. */
function applySynthesis(state, body) {
  const current = state.synthesis;
  if (body.expectedRevision !== current.revision) throw new FakeApiError("The continuing conversation changed since you read it.", 409, { error: "The continuing conversation changed since you read it." });
  const change = body.change;
  const items = current.items.map((item) => ({ ...item }));
  const find = () => items.find((item) => item.id === change.id);
  const who = (id) => [ME, OTHER].find((person) => person.id === id);
  if (change.action === "add") {
    if (!change.markdown.trim()) throw new FakeApiError("empty", 422, { error: "That item is empty." });
    const contributors = [ME, ...change.others.map(who)];
    items.push({ id: `syn-${items.length + 1}`, kind: change.kind, markdown: change.markdown, revision: 1, contributors, approved: [], awaiting: contributors, mine: true, approvedByYou: false });
  } else if (change.action === "approve") {
    const item = find();
    item.approved = [...item.approved, ME];
    item.awaiting = item.awaiting.filter((person) => person.id !== ME.id);
    item.approvedByYou = true;
  } else if (change.action === "edit") {
    const item = find();
    Object.assign(item, { kind: change.kind, markdown: change.markdown, approved: [], approvedByYou: false });
    for (const id of change.addContributors) item.contributors = [...item.contributors, who(id)];
    item.awaiting = item.contributors;
  } else if (change.action === "withdraw") {
    items.splice(items.indexOf(find()), 1);
  } else if (change.action === "reorder") {
    items.sort((a, b) => change.order.indexOf(a.id) - change.order.indexOf(b.id));
  }
  state.synthesis = { ...current, revision: current.revision + 1, items };
  return state.synthesis;
}

const SOURCES = [
  { id: "source-1", kind: "video", kindLabel: "Video", title: "A talk on video", url: "https://www.youtube.com/watch?v=abcdefghijk" },
  { id: "source-2", kind: "book", kindLabel: "Book", title: "A book", url: null },
  { id: "source-3", kind: "podcast", kindLabel: "Podcast", title: "A podcast", url: "https://podcasts.example/12" },
];

/** The server's quotation guide (ADR 0065), shaped as `quotation_guide` sends it. */
const GUIDE = {
  briefQuotationChars: 300,
  maxQuotationChars: 1000,
  maxRightsNoteBytes: 500,
  statement: "The rights status is the participant's own statement about these words. open.blog records it and shows it to co-authors; it does not check rights or decide how the words may be used.",
  rights: [
    { value: "unknown", label: "Not checked yet", guidance: "Nobody has considered yet how these words may be reused." },
    { value: "briefQuotation", label: "A brief quotation for commentary or review", guidance: "This states that the words are quoted briefly to comment on, criticise or review the source." },
    { value: "permission", label: "The rights holder gave permission", guidance: "This states that the rights holder agreed to this use. Say in the rights note who agreed and when." },
    { value: "openLicense", label: "The source is under an open licence", guidance: "This states that the source carries an open licence covering this use." },
    { value: "publicDomain", label: "The source is in the public domain", guidance: "This states that the source is in the public domain." },
    { value: "ownWords", label: "The participant's own words", guidance: "This states that the words are the participant's own." },
  ],
  notices: {
    noSpeaker: "No speaker is named, so the words are credited to the source alone. Name who said or wrote them if you know.",
    long: "This quotation is longer than 300 characters. Consider quoting only the words the point needs.",
    longForBriefQuotation: "This quotation is longer than 300 characters, which is long for a brief quotation. Consider quoting fewer words. This is a guide, not a legal limit.",
  },
};

/** The attribution line and warnings the server derives for a stored moment. */
function serverAttribution(moment, location) {
  const source = SOURCES.find((entry) => entry.id === moment.source);
  const where = source ? `${source.title} (${source.kindLabel})` : null;
  const speaker = moment.quotation?.speaker;
  if (speaker) return where ? `${speaker}, in ${where}, ${location}` : `${speaker}, in a source that is no longer listed, ${location}`;
  return where ? `${where}, ${location}` : `A source that is no longer listed, ${location}`;
}

/** The link the server derives from the source's own address: a start time only for YouTube. */
function serverLink(moment) {
  const source = SOURCES.find((entry) => entry.id === moment.source);
  if (!source?.url) return null;
  const time = moment.locators.find((locator) => locator.kind === "timestamp");
  return source.id === "source-1" && time ? { href: `https://www.youtube.com/watch?v=abcdefghijk&t=${parseMomentTimestamp(time.value).seconds}s`, atTime: true } : { href: source.url, atTime: false };
}

/** Applies one moments change the way the server does: a revision check, then the change. */
function applyMoments(state, body) {
  const current = state.moments;
  if (body.expectedRevision !== current.revision) throw new FakeApiError("The moments changed since you read them.", 409, { error: "The moments changed since you read them. Reload to see the current moments; what you typed is still here and nothing was changed." });
  const change = body.change;
  let moments = current.moments.map((moment) => ({ ...moment }));
  const shaped = (id, moment) => {
    if (moment.locators.some((locator) => locator.kind === "timestamp" && !parseMomentTimestamp(locator.value))) throw new FakeApiError("bad", 422, { error: "Give a location: a timestamp as seconds or h:mm:ss.", field: "locators" });
    if (/<|javascript:/.test(moment.observation || "")) throw new FakeApiError("bad", 422, { error: "That moment has raw HTML, an image, a heading, a footnote, a paragraph that is only a link to embeddable media, or a link that is not an absolute http(s) address. Nothing was changed.", field: "observation" });
    const time = moment.locators[0];
    const location = time.kind === "timestamp" ? (time.to ? `from ${time.value} to ${time.to}` : `at ${time.value}`) : time.to ? `${time.kind}s ${time.value} to ${time.to}` : `${time.kind} ${time.value}`;
    const notices = moment.quotation ? quotationNotices({ quote: moment.quotation.text, speaker: moment.quotation.speaker, rights: moment.quotation.rights }, GUIDE) : [];
    return { id, ...moment, quotation: moment.quotation || null, observation: moment.observation || null, location, attribution: serverAttribution(moment, location), notices, link: serverLink(moment) };
  };
  if (change.action === "add") moments.push(shaped(`moment-${current.next + 1}`, change.moment));
  else if (change.action === "edit") moments = moments.map((moment) => (moment.id === change.id ? shaped(change.id, change.moment) : moment));
  else if (change.action === "remove") moments = moments.filter((moment) => moment.id !== change.id);
  state.moments = { ...current, revision: current.revision + 1, next: current.next + (change.action === "add" ? 1 : 0), moments };
  return state.moments;
}

/** A stand-in for the Admin API: it checks the expected revision like the server does. */
function fakeApi({ number = 0, markdown = "", reveal = {}, failures = {} } = {}) {
  const state = { number, markdown, calls: [], moments: { revision: 0, next: 0, moments: [], shared: [], sources: SOURCES, you: "p-me", quotationGuide: GUIDE }, synthesis: { revision: 0, items: [], authors: [ME, OTHER], you: "p-me" }, reveal: { policy: "voluntary", ready: false, canSetPolicy: false, slots: [], ...reveal } };
  return {
    state,
    async call(method, path, options = {}) {
      const key = `${method} ${path.split("?")[0]}`;
      state.calls.push({ key, body: options.json });
      if (failures[key]) {
        const failure = failures[key];
        delete failures[key];
        throw failure;
      }
      switch (key) {
        case "GET collaboration/draft":
          return { draft: state.number ? { stamp: stampOf(state.number), markdown: state.markdown } : null };
        case "PUT collaboration/draft":
          if (options.json.expectedRevision !== state.number) {
            throw new FakeApiError("Your draft changed since you last read it.", 409, { error: "Your draft changed since you last read it.", current: { stamp: stampOf(state.number), markdown: state.markdown } });
          }
          state.number += 1;
          state.markdown = options.json.markdown;
          return { stamp: stampOf(state.number) };
        case "GET collaboration/reveal":
          return state.reveal;
        case "GET collaboration/reflection":
          return { structure: state.structure ?? null, participants: [{ id: "p1", displayName: "Ann" }, { id: "p2", displayName: "Bo" }], layouts: [], canArrange: state.canArrange === true };
        case "PUT collaboration/reflection":
          if (options.json.expectedRevision !== (state.structure?.revision ?? 0)) throw new FakeApiError("changed", 409, { error: "The arrangement changed." });
          state.structure = options.json.structure;
          return { structure: state.structure };
        case "GET collaboration/synthesis":
          return state.synthesis;
        case "POST collaboration/synthesis":
          return applySynthesis(state, options.json);
        case "GET collaboration/moments":
          return state.moments;
        case "POST collaboration/moments":
          return applyMoments(state, options.json);
        case "GET collaboration/preview":
          if (state.previewFails) throw new FakeApiError("not found", 404, null);
          return { preview: state.preview };
        case "PUT collaboration/reveal/ready":
          state.reveal = { ...state.reveal, ready: options.json.revision !== null };
          return { ready: state.reveal.ready, revealed: false, ...(state.momentsShared === undefined ? {} : { momentsShared: state.momentsShared }), ...(state.momentsNote === undefined ? {} : { momentsNote: state.momentsNote }) };
        case "PUT collaboration/reveal/policy":
          if (options.json.expectedPolicy !== state.reveal.policy) throw new FakeApiError("changed", 409, { error: "The sharing rule changed since you loaded it. Reload to see the current rule; nothing was changed." });
          if (options.json.policy === state.reveal.policy) return { policy: options.json.policy, changed: false };
          if (options.json.confirmed !== true) throw new FakeApiError("confirm", 422, { error: "Confirm that changing the sharing rule clears every standing offer, so everyone offers again. Nothing was changed.", field: "confirmed" });
          state.reveal = { ...state.reveal, policy: options.json.policy, ready: false };
          return { policy: options.json.policy, changed: true };
        case "GET collaboration/approval-policy":
          if (!state.rule) throw new FakeApiError("not found", 404, null);
          return state.rule;
        case "PUT collaboration/approval-policy": {
          if (options.json.expectedRevision !== state.rule.revision) throw new FakeApiError("changed", 409, { error: "The approval rule changed since you loaded it. Reload to see the current rule; nothing was changed." });
          const named = options.json.policy?.requirement?.namedAuthors || [];
          if (named.some((who) => !(state.rule.approvers || []).some((person) => person.participantId === who))) throw new FakeApiError("unmeetable", 422, { error: "This rule could never be met: Grace cannot approve this piece. Nothing was changed.", field: "policy" });
          if (!options.json.confirmed) throw new FakeApiError("confirm", 422, { error: "Confirm that changing the rule clears every approval, so every required author approves again. Nothing was changed.", field: "confirmed" });
          state.rule = { ...state.rule, policy: options.json.policy, revision: state.rule.revision + 1, summary: "Changed rule." };
          return { ...state.rule, changed: true, cleared: 2 };
        }
        default:
          throw new FakeApiError(`unexpected ${key}`, 500, null);
      }
    },
  };
}

async function openDraft(api, roles = ["contributor"]) {
  const app = new ObAdmin();
  app.api = api;
  const panel = app.draftPanel({ publicationId: PUBLICATION, roles }, 0);
  if (!panel) return { panel };
  document.body.append(panel);
  panel.open = true;
  await panel.dispatch("toggle");
  await settle();
  return { panel };
}

const button = (root, label) => root.querySelectorAll("button").find((node) => node.attributes["aria-label"] === label || node.textContent === label);
const textarea = (root) => root.querySelector("textarea");
const textOf = (root) => root.textContent.replace(/\s+/g, " ");
const save = (panel) => panel.querySelector("form").dispatch("submit");
const typeInto = async (panel, value) => {
  textarea(panel).value = value;
  await textarea(panel).dispatch("input");
};
const alertOf = (root) => root.querySelectorAll("p").find((node) => node.attributes.role === "alert");

// ---------------------------------------------------------------- pure helpers

test("prompts are plain optional quotes, inserted where the caret is and owned by the writer", () => {
  assert.ok(REFLECTION_PROMPTS.length >= 3);
  assert.equal(promptInsertion("  What   stood\nout? "), "> What stood out?\n\n");
  assert.deepEqual(insertAtSelection("ab", 1, 1, "X"), { text: "aXb", caret: 2 });
  assert.deepEqual(insertAtSelection("ab", 0, 2, "X"), { text: "X", caret: 1 });
  assert.deepEqual(insertAtSelection("ab", undefined, undefined, "X"), { text: "abX", caret: 3 });
  assert.deepEqual(insertAtSelection("ab", 9, 9, "X"), { text: "abX", caret: 3 });
});

test("the save state is always words", () => {
  assert.match(draftStateText({}), /Nothing saved yet/);
  assert.match(draftStateText({ number: 3 }), /Saved as revision 3/);
  assert.match(draftStateText({ number: 3, dirty: true }), /Unsaved changes.*revision 3/);
  assert.match(draftStateText({ dirty: true }), /Unsaved changes. Nothing saved/);
  assert.equal(draftStateText({ saving: true }), "Saving...");
});

test("failures tell the writer their text is safe and what kind of problem it was", () => {
  assert.equal(draftFailure(new TypeError("Failed to fetch")).kind, "offline");
  assert.match(draftFailure(new TypeError("x")).message, /offline.*still here/);
  const current = { stamp: stampOf(2), markdown: "theirs" };
  assert.deepEqual(draftFailure(new FakeApiError("m", 409, { error: "newer", current })), { kind: "conflict", message: "newer", current });
  assert.equal(draftFailure(new FakeApiError("m", 404, null)).kind, "denied");
  assert.equal(draftFailure(new FakeApiError("m", 422, { error: "too big" })).message, "too big");
  assert.match(draftFailure(new FakeApiError("", 500, null)).message, /still here/);
});

test("comparison slots say only what the reader may know", () => {
  assert.match(revealSlotText({ kind: "own", displayName: "Ada" }), /Ada \(you\)/);
  assert.match(revealSlotText({ kind: "revealed", displayName: "Grace", stamp: { number: 2 } }), /Grace: revealed to you, revision 2/);
  const offered = revealSlotText({ kind: "private", displayName: "Linus", ready: true });
  const quiet = revealSlotText({ kind: "private", displayName: "Linus", ready: false });
  assert.match(offered, /offered a revision/);
  assert.match(quiet, /not offered/);
  assert.doesNotMatch(offered + quiet, /revision \d/);
});

// ---------------------------------------------------------------- the panel

test("the draft panel is for writers and coordinators and loads only when opened", withDom(async () => {
  const app = new ObAdmin();
  assert.equal(app.draftPanel({ publicationId: PUBLICATION, roles: ["reader"] }, 0), null);
  const api = fakeApi({ number: 2, markdown: "mine" });
  app.api = api;
  const panel = app.draftPanel({ publicationId: PUBLICATION, roles: ["contributor"] }, 0);
  assert.equal(api.state.calls.length, 0, "nothing is requested until the panel opens");
  panel.open = true;
  await panel.dispatch("toggle");
  await settle();
  assert.equal(textarea(panel).value, "mine");
  assert.deepEqual(api.state.calls.map((call) => call.key), ["GET collaboration/draft", "GET collaboration/reveal", "GET collaboration/reflection", "GET collaboration/synthesis", "GET collaboration/moments"]);
}));

test("prompts can be added, edited, deleted, hidden, and are never required to save", withDom(async () => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  assert.match(textOf(panel), /Prompts are optional/);
  const prompt = REFLECTION_PROMPTS[0];
  await button(panel, `Add prompt to draft: ${prompt}`).click();
  assert.equal(textarea(panel).value, `> ${prompt}\n\n`);
  assert.match(textOf(panel), /Unsaved changes/);
  await typeInto(panel, "");
  await button(panel, "Hide prompts").click();
  assert.equal(panel.querySelector(".oba-draft-prompts").hidden, true);
  assert.equal(button(panel, "Show prompts").attributes["aria-pressed"], "true");
  await save(panel);
  await settle();
  assert.equal(api.state.number, 1, "an empty draft saves: no length or structure is enforced");
  assert.equal(api.state.markdown, "");
}));

test("saving shows an unsaved indicator, then the saved revision, and announces it politely", withDom(async () => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  assert.match(textOf(panel), /Nothing saved yet/);
  await typeInto(panel, "my words");
  assert.match(textOf(panel), /Unsaved changes. Nothing saved yet. 8 characters/);
  await save(panel);
  await settle();
  assert.match(textOf(panel), /Saved as revision 1/);
  const live = panel.querySelectorAll("p").find((node) => node.attributes.role === "status");
  assert.equal(live.attributes["aria-live"], "polite");
  assert.match(live.textContent, /Saved as revision 1/);
  assert.deepEqual(api.state.calls.find((call) => call.key === "PUT collaboration/draft").body, { publicationId: PUBLICATION, expectedRevision: 0, markdown: "my words" });
}));

test("a conflict keeps the original text, moves focus to the recovery heading, and offers every way out", withDom(async (dom) => {
  const api = fakeApi({ number: 1, markdown: "first" });
  const { panel } = await openDraft(api);
  api.state.number = 2;
  api.state.markdown = "from another tab";
  await typeInto(panel, "my unsaved text");
  await save(panel);
  await settle();
  const conflict = panel.querySelector(".oba-draft-conflict");
  assert.equal(conflict.hidden, false);
  assert.equal(textarea(panel).value, "my unsaved text", "the editor is untouched");
  assert.equal(api.state.markdown, "from another tab", "nothing was overwritten");
  assert.equal(dom.document.activeElement.id, "oba-draft-0-conflict-heading");
  assert.equal(conflict.attributes["aria-labelledby"], "oba-draft-0-conflict-heading");
  assert.equal(conflict.querySelector("#oba-draft-0-conflict-mine").value, "my unsaved text");
  assert.equal(conflict.querySelector("#oba-draft-0-conflict-newer").value, "from another tab");
  assert.match(textOf(conflict), /Newer saved copy \(revision 2\)/);
  for (const label of ["Save my text as a new revision", "Use the newer copy instead", "Decide later"]) assert.ok(button(conflict, label), label);
}));

test("keeping my text saves it on top of the newer revision, and focus returns to the editor", withDom(async (dom) => {
  const api = fakeApi({ number: 1, markdown: "first" });
  const { panel } = await openDraft(api);
  api.state.number = 2;
  await typeInto(panel, "mine");
  await save(panel);
  await settle();
  await button(panel, "Save my text as a new revision").click();
  await settle();
  assert.equal(api.state.number, 3);
  assert.equal(api.state.markdown, "mine");
  assert.equal(panel.querySelector(".oba-draft-conflict").hidden, true);
  assert.equal(dom.document.activeElement, textarea(panel));
  assert.match(textOf(panel), /Saved as revision 3/);
}));

test("using the newer copy can be undone: the earlier text comes back unsaved", withDom(async (dom) => {
  const api = fakeApi({ number: 1, markdown: "first" });
  const { panel } = await openDraft(api);
  api.state.number = 2;
  api.state.markdown = "theirs";
  await typeInto(panel, "mine");
  await save(panel);
  await settle();
  await button(panel, "Use the newer copy instead").click();
  assert.equal(textarea(panel).value, "theirs");
  assert.equal(dom.document.activeElement, textarea(panel));
  const restore = button(panel, "Restore my earlier text");
  assert.equal(restore.hidden, false);
  await restore.click();
  assert.equal(textarea(panel).value, "mine");
  assert.equal(restore.hidden, true);
  assert.match(textOf(panel), /Unsaved changes/);
  assert.equal(api.state.markdown, "theirs", "restoring never saves");
}));

test("deciding later leaves the text alone and returns focus to the editor", withDom(async (dom) => {
  const api = fakeApi({ number: 1, markdown: "first" });
  const { panel } = await openDraft(api);
  api.state.number = 2;
  await typeInto(panel, "mine");
  await save(panel);
  await settle();
  await button(panel, "Decide later").click();
  assert.equal(textarea(panel).value, "mine");
  assert.equal(dom.document.activeElement, textarea(panel));
  assert.equal(panel.querySelector(".oba-draft-conflict").hidden, true);
}));

test("a race without the newer copy fetches it instead of losing the text", withDom(async () => {
  const failures = { "PUT collaboration/draft": new FakeApiError("Your draft changed while you were saving.", 409, null) };
  const api = fakeApi({ number: 1, markdown: "first", failures });
  const { panel } = await openDraft(api);
  await typeInto(panel, "mine");
  await save(panel);
  await settle();
  assert.equal(panel.querySelector(".oba-draft-conflict").hidden, false);
  assert.equal(textarea(panel).value, "mine");
  assert.equal(panel.querySelector("#oba-draft-0-conflict-newer").value, "first");
}));

test("offline and oversized failures keep the text, say so, and put focus on the alert", withDom(async (dom) => {
  const failures = { "PUT collaboration/draft": new TypeError("Failed to fetch") };
  const api = fakeApi({ failures });
  const { panel } = await openDraft(api);
  await typeInto(panel, "keep me");
  await save(panel);
  await settle();
  const alert = alertOf(panel);
  assert.equal(alert.hidden, false);
  assert.match(alert.textContent, /offline.*still here/);
  assert.equal(dom.document.activeElement, alert);
  assert.equal(textarea(panel).value, "keep me");
  assert.match(textOf(panel), /Unsaved changes/);
  failures["PUT collaboration/draft"] = new FakeApiError("big", 422, { error: "This draft has reached its limit.", field: "markdown" });
  await save(panel);
  await settle();
  assert.match(alert.textContent, /reached its limit/);
  await save(panel);
  await settle();
  assert.equal(alert.hidden, true, "a later success clears the problem");
  assert.equal(api.state.markdown, "keep me");
}));

test("losing access shows a plain notice and no editor", withDom(async () => {
  const failures = { "GET collaboration/draft": new FakeApiError("nf", 404, null), "GET collaboration/reveal": new FakeApiError("nf", 404, null) };
  const { panel } = await openDraft(fakeApi({ failures }), ["coordinator"]);
  assert.equal(panel.querySelector(".oba-draft-editor").hidden, true);
  assert.match(textOf(panel), /You cannot write a draft/);
  assert.equal(panel.querySelector(".oba-draft-sharing").hidden, true);
}));

// ---------------------------------------------------------------- sharing

const SLOTS = [
  { participantId: "participant-1", displayName: "Ada", kind: "own", ready: false, stamp: stampOf(1), markdown: "my text" },
  { participantId: "participant-2", displayName: "Grace", kind: "private", ready: true, stamp: null, markdown: null },
  { participantId: "participant-3", displayName: "Linus", kind: "revealed", ready: false, stamp: { number: 4 }, markdown: "<img src=x onerror=alert(1)>" },
];

test("other writers appear only as the server revealed them, and revealed prose is text, never markup", withDom(async () => {
  const { panel } = await openDraft(fakeApi({ number: 1, markdown: "my text", reveal: { slots: SLOTS } }));
  const text = textOf(panel);
  assert.match(text, /Grace: private. They have offered a revision/);
  assert.match(text, /Linus: revealed to you, revision 4/);
  const revealed = panel.querySelectorAll("pre").find((node) => node.attributes["aria-label"] === "Text from Linus");
  assert.equal(revealed.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(panel.querySelectorAll("img").length, 0);
  assert.equal(panel.querySelectorAll("pre").some((node) => node.attributes["aria-label"] === "Text from Grace"), false);
  assert.doesNotMatch(admin.slice(admin.indexOf("draftPanel(publication, index) {"), admin.indexOf("The page an invitation link opens")), /innerHTML/);
}));

test("offering a revision asks first, names the revision, and Escape or Cancel changes nothing", withDom(async (dom) => {
  const api = fakeApi({ number: 2, markdown: "mine", reveal: { slots: SLOTS.slice(0, 2).map((slot) => ({ ...slot, ready: false })) } });
  const { panel } = await openDraft(api);
  const offer = button(panel, "Offer revision 2 to the group");
  await offer.click();
  const box = panel.querySelector(".oba-confirm");
  assert.equal(dom.document.activeElement, box);
  assert.match(textOf(box), /cannot be taken back/);
  await box.dispatch("keydown", { key: "Escape" });
  assert.equal(panel.querySelector(".oba-confirm"), null);
  assert.equal(dom.document.activeElement, offer);
  assert.equal(api.state.calls.some((call) => call.key === "PUT collaboration/reveal/ready"), false);
  await offer.click();
  await button(panel.querySelector(".oba-confirm"), "Share revision 2").click();
  await settle();
  assert.deepEqual(api.state.calls.find((call) => call.key === "PUT collaboration/reveal/ready").body, { publicationId: PUBLICATION, revision: 2 });
  await button(panel, "Take back my offer").click();
  await settle();
  assert.equal(api.state.reveal.ready, false);
}));

test("the offer box can never send a revision the writer did not confirm", withDom(async () => {
  const api = fakeApi({ number: 3, markdown: "mine", reveal: { slots: SLOTS.slice(0, 2).map((slot) => ({ ...slot, ready: false })) } });
  const { panel } = await openDraft(api);
  await button(panel, "Offer revision 3 to the group").click();
  const stale = button(panel.querySelector(".oba-confirm"), "Share revision 3");
  assert.ok(stale);
  api.state.number = 4;
  api.state.markdown = "from another tab";
  await typeInto(panel, "my unsaved text");
  await save(panel);
  await settle();
  await button(panel.querySelector(".oba-draft-conflict"), "Use the newer copy instead").click();
  await settle();
  // A detached button cannot be clicked in a browser; if it were, it still carries revision 3.
  await stale.click();
  await settle();
  const sent = api.state.calls.filter((call) => call.key === "PUT collaboration/reveal/ready");
  assert.ok(sent.every((call) => call.body.revision === 3), "only the confirmed revision may be sent");
  api.state.reveal = { ...api.state.reveal, ready: false };
  await button(panel, "Take back my offer")?.click();
  await settle();
  assert.equal(panel.querySelector(".oba-confirm"), null, "the stale box is gone once the draft changes");
  assert.ok(button(panel, "Offer revision 4 to the group"));
}));

test("after offering, taking back or changing the rule, focus stays inside the sharing section", withDom(async (dom) => {
  const api = fakeApi({ number: 2, markdown: "mine", reveal: { canSetPolicy: true, slots: SLOTS.slice(0, 2).map((slot) => ({ ...slot, ready: false })) } });
  const { panel } = await openDraft(api, ["coordinator"]);
  const sharing = panel.querySelector(".oba-draft-sharing");
  const inSharing = () => sharing.contains(dom.document.activeElement) && dom.document.activeElement.attributes.tabindex === "-1";
  await button(panel, "Offer revision 2 to the group").click();
  await button(panel.querySelector(".oba-confirm"), "Share revision 2").click();
  await settle();
  assert.ok(inSharing(), "after offering");
  await button(panel, "Take back my offer").click();
  await settle();
  assert.ok(inSharing(), "after taking back");
  dom.document.activeElement = null;
  await button(panel, "Change sharing rule").click();
  await settle();
  assert.ok(inSharing(), "after changing the rule");
}));

test("with sharing off or nothing saved there is nothing to offer, and coordinators can change the rule", withDom(async () => {
  const off = await openDraft(fakeApi({ number: 1, markdown: "x", reveal: { policy: "independent", slots: SLOTS.slice(0, 1) } }));
  assert.equal(button(off.panel, "Offer revision 1 to the group"), undefined);
  assert.match(textOf(off.panel), /Independent. Nobody sees/);
  const unsaved = await openDraft(fakeApi({ reveal: { slots: SLOTS.slice(0, 1) } }));
  assert.match(textOf(unsaved.panel), /Save a draft before you can offer it/);
  const api = fakeApi({ number: 1, markdown: "x", reveal: { policy: "independent", canSetPolicy: true, slots: SLOTS.slice(0, 1) } });
  const { panel } = await openDraft(api, ["coordinator"]);
  // Resubmitting the current rule needs no confirmation and changes nothing.
  await button(panel, "Change sharing rule").click();
  await settle();
  assert.match(textOf(panel), /already the sharing rule\. Nothing changed\./);
  panel.querySelector("#oba-draft-0-policy").value = "allReady";
  // A real change clears every offer, so without the labelled confirmation it is refused.
  const confirm = panel.querySelector("#oba-draft-0-policy-confirm");
  assert.ok(panel.querySelectorAll("label").some((label) => label.attributes.for === "oba-draft-0-policy-confirm" && /clears every standing offer/.test(label.textContent)));
  await button(panel, "Change sharing rule").click();
  await settle();
  assert.match(alertOf(panel).textContent, /Confirm that changing the sharing rule clears every standing offer/);
  assert.equal(api.state.reveal.policy, "independent");
  confirm.checked = true;
  await button(panel, "Change sharing rule").click();
  await settle();
  const puts = api.state.calls.filter((call) => call.key === "PUT collaboration/reveal/policy");
  assert.deepEqual(puts.at(-1).body, { publicationId: PUBLICATION, policy: "allReady", expectedPolicy: "independent", confirmed: true });
  assert.match(textOf(panel), /sharing rule changed.*nothing was shared/);
}));

// ---------------------------------------------------------------- combined preview

const PREVIEW = {
  complete: false,
  ready: false,
  previewUrl: "/admin/api/preview/" + "a".repeat(64),
  sections: [
    { participantId: "a", displayName: "Ada", shown: true, revision: 2, approval: "approved", required: true },
    { participantId: "b", displayName: "Grace", shown: false, revision: null, approval: "stale", required: true },
  ],
};

test("preview lines say what is shown and where each approval stands, without leaking hidden revisions", () => {
  assert.equal(previewSectionText(PREVIEW.sections[0]), "Ada: revision 2; approved.");
  const hidden = previewSectionText(PREVIEW.sections[1]);
  assert.match(hidden, /Grace: not shared with you at its current revision; approval out of date/);
  assert.doesNotMatch(hidden, /revision \d/);
  assert.match(previewSectionText({ displayName: "Linus", shown: true, revision: 1, approval: "awaiting", required: false }), /awaiting approval \(approval not required\)/);
  assert.match(previewStateText({ ready: true }), /Every required author has approved/);
  assert.match(previewStateText({ complete: true }), /Not ready to publish/);
  assert.match(previewStateText({}), /Incomplete/);
});

test("the combined preview opens on request in a frame with no sandbox allowances, labelled as unpublished", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { slots: SLOTS.slice(0, 1) } });
  api.state.preview = PREVIEW;
  const { panel } = await openDraft(api);
  assert.equal(api.state.calls.some((call) => call.key === "GET collaboration/preview"), false, "nothing is built until asked");
  assert.equal(panel.querySelector("iframe"), null);
  await button(panel, "Review the combined piece").click();
  await settle();
  const frame = panel.querySelector("iframe");
  assert.equal(frame.attributes.sandbox, "", "an empty sandbox allows no scripts, forms, popups or same-origin access");
  assert.equal(frame.attributes.src, PREVIEW.previewUrl);
  assert.match(frame.attributes.title, /not published/);
  assert.equal(frame.attributes.srcdoc, undefined, "prose never travels through the Admin page");
  assert.match(textOf(panel), /Preview, not published. Incomplete/);
  assert.match(textOf(panel), /Ada: revision 2; approved\./);
  assert.match(textOf(panel), /Grace: not shared with you.*approval out of date/);
}));

test("a failed preview shows a calm message, keeps nothing stale, and changes nothing", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { slots: SLOTS.slice(0, 1) } });
  api.state.preview = PREVIEW;
  const { panel } = await openDraft(api);
  await button(panel, "Review the combined piece").click();
  await settle();
  assert.ok(panel.querySelector("iframe"));
  api.state.previewFails = true;
  await button(panel, "Review the combined piece").click();
  await settle();
  assert.equal(panel.querySelector("iframe"), null);
  assert.match(textOf(panel), /could not be loaded.*Nothing was changed/);
  assert.equal(api.state.calls.filter((call) => call.key.startsWith("PUT")).length, 0);
}));

// ---------------------------------------------------------------- layout and arrangement (ADR 0031)

test("the part break is the marker alone on its own line, and the starting arrangement reads no draft", () => {
  assert.equal(partBreakInsertion(), "\n<!-- openblog:part -->\n");
  assert.deepEqual(insertAtSelection("ab", 1, 1, partBreakInsertion()).text, "a\n<!-- openblog:part -->\nb");
  const people = [{ id: "p1", displayName: "Ann" }, { id: "p2", displayName: "Bo" }];
  const start = arrangementDraft(null, people);
  assert.equal(start.revision, 0);
  assert.equal(start.layout, "sequential");
  assert.deepEqual(start.rounds[0].turns, [{ draft: "p1", part: 0, label: "" }, { draft: "p2", part: 0, label: "" }]);
  const payload = arrangementPayload(start);
  assert.equal(payload.revision, 1);
  assert.equal(payload.rounds[0].roundPrompt, undefined, "an empty prompt is omitted");
  assert.deepEqual(Object.keys(payload).sort(), ["layout", "revision", "rounds", "version"]);
  assert.deepEqual(Object.keys(payload.rounds[0].turns[0]).sort(), ["draft", "part"], "a turn names a draft and a part, never a side or a person");
  assert.deepEqual(ARRANGEMENT_LAYOUTS.map((item) => item.value), ["sequential", "sideBySide", "pointCounterpoint", "alternatingDialogue", "roundtable"]);
});

test("moving and validating an arrangement never loses or repeats a turn", () => {
  assert.deepEqual(moveItem([1, 2, 3], 0, 1), [2, 1, 3]);
  assert.deepEqual(moveItem([1, 2, 3], 0, -1), [1, 2, 3]);
  assert.deepEqual(moveItem([1, 2, 3], 2, 1), [1, 2, 3]);
  assert.equal(nextRoundId([{ id: "round-1" }, { id: "round-3" }]), "round-4");
  const draft = arrangementDraft({ revision: 2, layout: "sideBySide", rounds: [{ id: "round-1", roundPrompt: "Why?", turns: [{ draft: "p1", part: 0 }, { draft: "p2", part: 0 }] }] }, []);
  assert.equal(validateArrangement(draft), "");
  assert.equal(arrangementPayload(draft).revision, 3);
  draft.rounds[0].turns.push({ draft: "p1", part: 0 });
  assert.match(validateArrangement(draft), /only once/);
  assert.match(validateArrangement({ rounds: [] }), /at least one round/);
  assert.match(validateArrangement({ rounds: [{ prompt: "", turns: [] }] }), /no turns/);
  assert.match(validateArrangement({ rounds: [{ prompt: "a\nb", turns: [{ draft: "p1", part: 0 }] }] }), /one line/);
  assert.equal(arrangementFailure({ status: 409 }).kind, "conflict");
  assert.equal(arrangementFailure({ status: 404 }).kind, "denied");
  assert.equal(arrangementFailure({}).kind, "offline");
});

test("a coordinator sets the layout and order with labelled, keyboard operable controls", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { canSetPolicy: true, slots: SLOTS.slice(0, 1) } });
  api.state.canArrange = true;
  const { panel } = await openDraft(api, ["coordinator"]);
  assert.match(textOf(panel), /Layout and arrangement/);
  const radios = panel.querySelectorAll("input").filter((node) => node.attributes.type === "radio");
  assert.equal(radios.length, 5);
  for (const radio of radios) assert.ok(panel.querySelectorAll("label").some((label) => label.attributes.for === radio.attributes.id), "every layout has a label");
  await radios.find((radio) => radio.value === "sideBySide").dispatch("change");
  await button(panel, "Move round 1, turn 1 down").click();
  await button(panel, "Save layout and arrangement").click();
  await settle();
  const put = api.state.calls.find((call) => call.key === "PUT collaboration/reflection");
  assert.equal(put.body.expectedRevision, 0);
  assert.equal(put.body.structure.revision, 1);
  assert.equal(put.body.structure.layout, "sideBySide");
  assert.deepEqual(put.body.structure.rounds[0].turns.map((turn) => turn.draft), ["p2", "p1"]);
  assert.match(textOf(panel), /Approvals that no longer matched were cleared/);
}));

test("someone without the grant reads the arrangement and has no way to change it", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { slots: SLOTS.slice(0, 1) } });
  api.state.canArrange = false;
  api.state.structure = { version: 1, revision: 1, layout: "sideBySide", rounds: [{ id: "round-1", roundPrompt: "Why?", turns: [{ draft: "p2", part: 0 }, { draft: "p1", part: 1 }] }] };
  const { panel } = await openDraft(api);
  assert.match(textOf(panel), /Layout: Side by side. Only a coordinator can change it./);
  assert.match(textOf(panel), /Round 1: Why\?. Bo, part 1; Ann, part 2\./);
  assert.equal(button(panel, "Save layout and arrangement"), undefined);
}));

test("a conflicting save shows the server words and reloads the current arrangement", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { canSetPolicy: true, slots: SLOTS.slice(0, 1) } });
  api.state.canArrange = true;
  const { panel } = await openDraft(api, ["coordinator"]);
  api.state.structure = { version: 1, revision: 4, layout: "sequential", rounds: [{ id: "round-1", turns: [{ draft: "p1", part: 0 }] }] };
  await button(panel, "Save layout and arrangement").click();
  await settle();
  assert.match(panel.querySelectorAll("p").filter((node) => node.attributes.role === "alert").map((node) => node.textContent).join(" "), /arrangement changed/);
  assert.equal(api.state.structure.revision, 4, "nothing was overwritten");
}));

test("a writer can start a new part from the editor and the page documents the layout styles", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "first" });
  const { panel } = await openDraft(api);
  await button(panel, "Start a new part").click();
  assert.match(textarea(panel).value, /<!-- openblog:part -->/);
  assert.match(textOf(panel), /marker line is never published/);
  assert.match(styles, /\.oba-arrangement-turn/);
}));

test("a sharing refresh keeps unsaved arrangement edits, and each part input names its round and turn", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { canSetPolicy: true, slots: SLOTS.slice(0, 1) } });
  api.state.canArrange = true;
  const { panel } = await openDraft(api, ["coordinator"]);
  const labels = panel.querySelectorAll("label").map((node) => node.textContent);
  assert.ok(labels.includes("Round 1, turn 1: part"));
  assert.ok(labels.includes("Round 1, turn 2: part"));
  await panel.querySelectorAll("input").find((node) => node.attributes.type === "radio" && node.value === "sideBySide").dispatch("change");
  await button(panel, "Move round 1, turn 1 down").click();
  // A readiness action refreshes the sharing panel; the local edits must survive it.
  await button(panel, "Change sharing rule").click();
  await settle();
  assert.equal(api.state.calls.filter((call) => call.key === "GET collaboration/reflection").length, 1);
  await button(panel, "Save layout and arrangement").click();
  await settle();
  const put = api.state.calls.find((call) => call.key === "PUT collaboration/reflection");
  assert.equal(put.body.structure.layout, "sideBySide");
  assert.deepEqual(put.body.structure.rounds[0].turns.map((turn) => turn.draft), ["p2", "p1"]);
  // Its own save reloads once more.
  assert.equal(api.state.calls.filter((call) => call.key === "GET collaboration/reflection").length, 2);
}));

test("turn labels are optional, short, one line, and sent only when written", withDom(async () => {
  const people = [{ id: "p1", displayName: "Ann" }, { id: "p2", displayName: "Bo" }];
  const draft = arrangementDraft(null, people);
  assert.equal(draft.rounds[0].turns[0].label, "");
  assert.equal(arrangementPayload(draft).rounds[0].turns[0].label, undefined, "no label is invented");
  draft.rounds[0].turns[0].label = "  Point <b>one</b>  ";
  assert.equal(arrangementPayload(draft).rounds[0].turns[0].label, "Point <b>one</b>");
  assert.equal(validateArrangement(draft), "");
  draft.rounds[0].turns[1].label = "two\nlines";
  assert.match(validateArrangement(draft), /one line/);
  draft.rounds[0].turns[1].label = "x".repeat(TURN_LABEL_MAX_BYTES + 1);
  assert.match(validateArrangement(draft), /at most 80 bytes/);
  const stored = arrangementDraft({ revision: 1, layout: "pointCounterpoint", rounds: [{ id: "round-1", turns: [{ draft: "p1", part: 0, label: "Point" }, { draft: "p2", part: 0 }] }] }, people);
  assert.deepEqual(stored.rounds[0].turns.map((turn) => turn.label), ["Point", ""]);

  const api = fakeApi({ number: 1, markdown: "x", reveal: { canSetPolicy: true, slots: SLOTS.slice(0, 1) } });
  api.state.canArrange = true;
  const { panel } = await openDraft(api, ["coordinator"]);
  const labelInputs = panel.querySelectorAll("input").filter((node) => /-label$/.test(node.attributes.id || ""));
  assert.equal(labelInputs.length, 2);
  for (const input of labelInputs) {
    assert.ok(panel.querySelectorAll("label").some((node) => node.attributes.for === input.attributes.id), "every label field is labelled");
  }
  assert.ok(panel.querySelectorAll("label").some((node) => node.textContent === "Round 1, turn 2: label (optional)"));
  labelInputs[0].value = "Counterpoint";
  await labelInputs[0].dispatch("input");
  await panel.querySelectorAll("input").find((node) => node.attributes.type === "radio" && node.value === "pointCounterpoint").dispatch("change");
  await button(panel, "Save layout and arrangement").click();
  await settle();
  const put = api.state.calls.find((call) => call.key === "PUT collaboration/reflection");
  assert.equal(put.body.structure.layout, "pointCounterpoint");
  assert.equal(put.body.structure.rounds[0].turns[0].label, "Counterpoint");
  assert.equal(put.body.structure.rounds[0].turns[1].label, undefined);
}));

// ---------------------------------------------------------------- source checks

test("the draft panel is wired into the shared reflections view, with labels and small-screen styles", () => {
  assert.match(admin, /this\.draftPanel\(publication, index\)/);
  assert.match(admin, /for: `\$\{prefix\}-text`/);
  assert.match(styles, /\.oba-draft-conflict/);
  assert.match(styles, /@media \(max-width: 44rem\)\s*\{\s*\.oba-draft/);
});

// ---------------------------------------------------------------- continuing conversation

const synthesisRoot = (panel) => panel.querySelector(".oba-synthesis");
const synthesisSubmit = (panel) => panel.querySelector(".oba-synthesis-form").dispatch("submit");
const synthesisText = (panel) => panel.querySelector(".oba-synthesis-form").querySelector("textarea");
const lastCall = (api) => api.state.calls.at(-1);

test("synthesis words say who an item speaks for and who has approved it", () => {
  const item = { kind: "difference", contributors: [ME, OTHER], approved: [ME], awaiting: [OTHER] };
  assert.equal(synthesisItemText(item), "Difference, speaking for Mikey, Grace. Approved by: Mikey. Awaiting: Grace.");
  assert.match(synthesisItemText({ kind: "question", contributors: [ME], approved: [], awaiting: [ME] }), /Approved by: no one yet\. Awaiting: Mikey\./);
  assert.equal(previewItemText({ kind: "agreement", mine: true, authors: ["Ann", "Bo"], approved: ["Ann"], awaiting: ["Bo"] }), "Agreement (yours): speaks for Ann, Bo. Approved by: Ann. Awaiting: Bo.");
  assert.equal(SYNTHESIS_KINDS.length, 5);
  assert.ok(SYNTHESIS_KINDS.every((kind) => kind.prompt.length > 0));
  assert.deepEqual(moveSynthesisItem(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.equal(moveSynthesisItem(["a", "b"], "a", -1), null);
  assert.equal(moveSynthesisItem(["a", "b"], "b", 1), null);
  assert.equal(synthesisFailure({ status: 409 }).kind, "conflict");
  assert.equal(synthesisFailure({ status: 404 }).kind, "denied");
  assert.equal(synthesisFailure({}).kind, "offline");
});

test("the continuing conversation is only for contributors and is optional, any length", withDom(async () => {
  const coordinatorApi = fakeApi();
  await openDraft(coordinatorApi, ["coordinator"]);
  assert.equal(coordinatorApi.state.calls.some((call) => call.key.includes("synthesis")), false);
  const api = fakeApi();
  const { panel } = await openDraft(api);
  assert.equal(synthesisRoot(panel).hidden, false);
  assert.match(textOf(panel), /None are required/);
  synthesisText(panel).value = "x";
  await synthesisSubmit(panel);
  await settle();
  assert.equal(lastCall(api).body.change.markdown, "x", "no minimum length");
  assert.match(textOf(panel), /Item 1 of 1\. Agreement, speaking for Mikey\. Approved by: no one yet\. Awaiting: Mikey\./);
  assert.equal(synthesisText(panel).value, "", "the form is cleared once the item is stored");
}));

test("prompts are dismissible, restorable and editable, and never required", withDom(async () => {
  const { panel } = await openDraft(fakeApi());
  assert.match(textOf(panel), /Optional prompt: Where did we land/);
  await button(panel, "Use this prompt").click();
  assert.equal(synthesisText(panel).value, SYNTHESIS_KINDS[0].prompt);
  synthesisText(panel).value = "My own words instead.";
  await button(panel, "Dismiss prompts").click();
  assert.equal(panel.querySelector(".oba-synthesis-prompt").hidden, true);
  assert.equal(synthesisText(panel).value, "My own words instead.", "dismissing keeps what was typed");
  await button(panel, "Show prompts").click();
  assert.equal(panel.querySelector(".oba-synthesis-prompt").hidden, false);
}));

test("attribution, partial approval and edits show who approved each item", withDom(async () => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  synthesisText(panel).value = "We both saw it.";
  panel.querySelector(".oba-synthesis-form").querySelectorAll("input").find((box) => box.value === OTHER.id).checked = true;
  await synthesisSubmit(panel);
  await settle();
  assert.deepEqual(lastCall(api).body.change.others, [OTHER.id]);
  assert.match(textOf(panel), /speaking for Mikey, Grace\. Approved by: no one yet\. Awaiting: Mikey, Grace/);
  await button(panel, "Approve this item").click();
  await settle();
  assert.match(textOf(panel), /Approved by: Mikey\. Awaiting: Grace/);
  assert.equal(button(panel, "You approved this").disabled, true);
  // Editing asks everyone to approve again.
  await button(panel, "Edit").click();
  assert.match(textOf(panel), /clears every approval/);
  const area = panel.querySelectorAll("textarea").find((node) => node.attributes["aria-label"] === "Edit item text");
  area.value = "We both saw it, differently.";
  await button(panel, "Save changes").click();
  await settle();
  assert.match(textOf(panel), /Approved by: no one yet\. Awaiting: Mikey, Grace/);
  assert.match(textOf(panel), /Everyone named must approve it again/);
}));

test("items can be reordered and withdrawn from with plain buttons", withDom(async () => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  for (const text of ["First", "Second"]) {
    synthesisText(panel).value = text;
    await synthesisSubmit(panel);
    await settle();
  }
  assert.equal(button(panel, "Move up: Agreement item 1 of 2").disabled, true);
  await button(panel, "Move up: Agreement item 2 of 2").click();
  await settle();
  assert.deepEqual(api.state.synthesis.items.map((item) => item.markdown), ["Second", "First"]);
  await button(panel, "Take my name off").click();
  await settle();
  assert.equal(api.state.synthesis.items.length, 1);
  assert.match(textOf(panel), /Your name was taken off this item\./);
}));

test("a conflict keeps the typed text, says so, and reloads the current items", withDom(async () => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  api.state.synthesis = { ...api.state.synthesis, revision: 5 };
  synthesisText(panel).value = "Typed before the conflict";
  await synthesisSubmit(panel);
  await settle();
  const problem = panel.querySelectorAll("p").find((node) => node.attributes.role === "alert" && !node.hidden);
  assert.match(problem.textContent, /changed since you read it/);
  assert.equal(synthesisText(panel).value, "Typed before the conflict");
  // The reload adopted the new revision, so the next try succeeds.
  await synthesisSubmit(panel);
  await settle();
  assert.equal(api.state.synthesis.items.length, 1);
}));

test("losing access hides the conversation and untrusted prose is only ever text", withDom(async () => {
  const api = fakeApi({ failures: { "GET collaboration/synthesis": new FakeApiError("not found", 404, null) } });
  const { panel } = await openDraft(api);
  assert.equal(synthesisRoot(panel).hidden, true);
  const start = admin.indexOf("synthesisPanel(publication, index) {");
  const end = admin.indexOf("The page an invitation link opens");
  assert.doesNotMatch(admin.slice(start, end), /innerHTML|insertAdjacentHTML/);
  assert.match(styles, /\.oba-synthesis-item/);
}));

test("the combined preview lists who approved each item", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { slots: SLOTS.slice(0, 1) } });
  api.state.preview = { sections: [], items: [{ id: "syn-1", kind: "question", mine: false, authors: ["Ann"], approved: [], awaiting: ["Ann"] }], previewUrl: "/admin/api/preview/t", ready: false, complete: true };
  const { panel } = await openDraft(api);
  await button(panel, "Review the combined piece").click();
  await settle();
  assert.match(textOf(panel), /Question: speaks for Ann\. Approved by: no one\. Awaiting: Ann\./);
}));

// ------------------------------------------------ synthesis: focus, edit survival, denial

const synthesisHeading = "oba-synthesis-0-heading";
const addItem = async (panel, text) => {
  synthesisText(panel).value = text;
  await synthesisSubmit(panel);
  await settle();
};
const activeLabel = (dom) => dom.document.activeElement?.attributes?.["aria-label"] || dom.document.activeElement?.textContent;
const visibleAlert = (panel) => panel.querySelectorAll("p").find((node) => node.attributes.role === "alert" && !node.hidden);

test("the attribution choices render as real checkboxes, in both the add form and edit mode", withDom(async () => {
  const { panel } = await openDraft(fakeApi());
  const form = panel.querySelector(".oba-synthesis-form");
  assert.doesNotMatch(textOf(form), /object HTML/);
  assert.match(textOf(form), /Who else it speaks for.*Also speaks for Grace/);
  assert.equal(form.querySelectorAll("input").length, 1);
  await addItem(panel, "Mine alone");
  await button(panel, "Edit").click();
  const item = panel.querySelector(".oba-synthesis-item");
  assert.doesNotMatch(textOf(item), /object HTML/);
  assert.match(textOf(item), /Also name Grace/);
  assert.equal(item.querySelectorAll("input").length, 1);
}));

test("after adding, approving, saving, cancelling, reordering and withdrawing, focus is never lost to the page", withDom(async (dom) => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  await addItem(panel, "First");
  assert.equal(dom.document.activeElement.id, synthesisHeading, "add returns to the panel heading");
  await addItem(panel, "Second");
  await button(panel, "Move up: Agreement item 2 of 2").click();
  await settle();
  assert.equal(activeLabel(dom), "Move down: Agreement item 1 of 2", "reorder follows the moved item; its own Move up is now disabled, so the other direction");
  await button(panel, "Move down: Agreement item 1 of 2").click();
  await settle();
  assert.equal(activeLabel(dom), "Move up: Agreement item 2 of 2");
  await button(panel, "Move up: Agreement item 2 of 2").click();
  await settle();
  assert.equal(activeLabel(dom), "Move down: Agreement item 1 of 2");
  await button(panel, "Approve this item").click();
  await settle();
  assert.equal(dom.document.activeElement.textContent, "Edit", "approve moves to the item's Edit button");
  assert.match(textOf(panel), /You approved this item\./);
  await button(panel, "Edit").click();
  assert.equal(dom.document.activeElement.attributes["aria-label"], "Edit item text", "opening edit focuses the text");
  await button(panel, "Cancel").click();
  assert.equal(dom.document.activeElement.textContent, "Edit", "cancel returns to the Edit button");
  assert.match(textOf(panel), /Edit cancelled/);
  await button(panel, "Edit").click();
  await button(panel, "Save changes").click();
  await settle();
  assert.equal(dom.document.activeElement.textContent, "Edit", "saving returns to the Edit button");
  await button(panel, "Take my name off").click();
  await settle();
  assert.equal(dom.document.activeElement.id, synthesisHeading, "withdraw returns to the panel heading");
}));

test("dismissing and showing prompts, and using one, keep focus on a control that is still there", withDom(async (dom) => {
  const { panel } = await openDraft(fakeApi());
  await button(panel, "Use this prompt").click();
  assert.equal(dom.document.activeElement, synthesisText(panel));
  await button(panel, "Dismiss prompts").click();
  assert.equal(dom.document.activeElement.textContent, "Show prompts");
  assert.equal(dom.document.activeElement.hidden, false);
  await button(panel, "Show prompts").click();
  assert.equal(dom.document.activeElement.textContent, "Use this prompt");
  assert.equal(dom.document.activeElement.hidden, false);
}));

test("a conflict puts focus on the alert, and the typed text is kept", withDom(async (dom) => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  api.state.synthesis = { ...api.state.synthesis, revision: 5 };
  await addItem(panel, "Typed before the conflict");
  assert.equal(dom.document.activeElement, visibleAlert(panel));
  assert.equal(synthesisText(panel).value, "Typed before the conflict");
}));

test("a conflict while editing keeps the edited text and the item, and the edit stays open", withDom(async (dom) => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  await addItem(panel, "Original");
  await button(panel, "Edit").click();
  const area = () => panel.querySelectorAll("textarea").find((node) => node.attributes["aria-label"] === "Edit item text");
  area().value = "My careful rewrite";
  await area().dispatch("input");
  panel.querySelector(".oba-synthesis-item").querySelectorAll("input")[0].checked = true;
  await panel.querySelector(".oba-synthesis-item").querySelectorAll("input")[0].dispatch("change");
  api.state.synthesis = { ...api.state.synthesis, revision: 9 };
  await button(panel, "Save changes").click();
  await settle();
  assert.match(visibleAlert(panel).textContent, /changed since you read it/);
  assert.equal(dom.document.activeElement, visibleAlert(panel));
  assert.ok(area(), "edit mode is open again");
  assert.equal(area().value, "My careful rewrite");
  assert.equal(panel.querySelector(".oba-synthesis-item").querySelectorAll("input")[0].checked, true);
  await button(panel, "Save changes").click();
  await settle();
  assert.equal(api.state.synthesis.items[0].markdown, "My careful rewrite", "the retry saves the kept text");
  assert.deepEqual(api.state.synthesis.items[0].contributors.map((person) => person.id), [ME.id, OTHER.id]);
  assert.equal(area(), undefined, "a saved edit closes");
}));

test("a denied change keeps the notice and the typed text visible", withDom(async (dom) => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  api.state.failures = null;
  const failing = { call: api.call.bind(api) };
  api.call = async (method, path, options) => {
    if (method === "POST") throw new FakeApiError("not found", 404, null);
    return failing.call(method, path, options);
  };
  await addItem(panel, "Words I do not want to lose");
  assert.equal(synthesisRoot(panel).hidden, false);
  const alert = visibleAlert(panel);
  assert.match(alert.textContent, /Your text is still here/);
  assert.equal(dom.document.activeElement, alert);
  assert.equal(synthesisText(panel).value, "Words I do not want to lose");
}));

test("the dismissed-prompts preference uses the ob-admin key", () => {
  assert.match(admin, /"ob-admin-synthesis-prompts-dismissed"/);
  assert.doesNotMatch(admin, /openblog\.admin\.synthesisPromptsDismissed/);
});

// ---------------------------------------------------------------- approval rule (ADR 0052)

const RULE = {
  policy: { requirement: "allAuthors", scope: "ownSections" },
  revision: 3,
  summary: "Every author must approve. An approval covers the approver's own sections and the frame of the piece.",
  unmetNamed: [],
  unmetRoles: [],
  required: ["Ann", "Bo", "Linus"],
  missing: ["Linus"],
  approvers: [{ participantId: "p1", displayName: "Ann" }, { participantId: "p2", displayName: "Bo" }],
  published: false,
};

test("approval rule choices round-trip and never send an empty list", () => {
  assert.deepEqual(APPROVAL_REQUIREMENTS.map((item) => item.value), ["allAuthors", "contributingAuthors", "namedAuthors", "authorsWithRoles"]);
  assert.deepEqual(APPROVAL_ROLE_CHOICES.map((item) => item.value), ["siteOwner", "coordinator", "contributor"]);
  assert.deepEqual(approvalPolicyChoice({ requirement: { namedAuthors: ["p2"] }, scope: "wholePiece" }), { kind: "namedAuthors", named: ["p2"], roles: [], scope: "wholePiece" });
  assert.deepEqual(approvalPolicyChoice({ requirement: { authorsWithRoles: ["coordinator"] } }).roles, ["coordinator"]);
  assert.equal(approvalPolicyChoice({ requirement: "nonsense" }).kind, "allAuthors");
  assert.deepEqual(approvalPolicyPayload({ kind: "namedAuthors", named: ["p1", "p1"], scope: "ownSections" }), { policy: { requirement: { namedAuthors: ["p1"] }, scope: "ownSections" } });
  assert.match(approvalPolicyPayload({ kind: "namedAuthors", named: [] }).error, /at least one person/);
  assert.match(approvalPolicyPayload({ kind: "authorsWithRoles", roles: [] }).error, /at least one role/);
  assert.deepEqual(approvalPolicyPayload({ kind: "contributingAuthors", scope: "wholePiece" }), { policy: { requirement: "contributingAuthors", scope: "wholePiece" } });
  assert.match(approvalRuleText({ summary: "S.", unmetNamed: ["Grace"], unmetRoles: ["editor"] }), /^S\. It cannot be met as things stand: Grace can no longer approve; no author is an editor\./);
  // Only a site owner can take a named person off the rule; a coordinator can change a role.
  const namedOnly = approvalRuleText({ summary: "S.", unmetNamed: ["Grace"] });
  assert.match(namedOnly, /A site owner can take them off the rule/);
  assert.doesNotMatch(namedOnly, /coordinator/);
  const roleOnly = approvalRuleText({ summary: "S.", unmetRoles: ["editor"] });
  assert.match(roleOnly, /A coordinator can change the rule/);
  assert.doesNotMatch(roleOnly, /site owner/);
  assert.equal(approvalRuleText({ summary: "S." }), "S.");
  assert.equal(approvalRuleFailure({ status: 409 }).kind, "conflict");
  assert.equal(approvalRuleFailure({ status: 404 }).kind, "denied");
  assert.equal(approvalRuleFailure({ status: 422, data: { error: "Confirm it." } }).message, "Confirm it.");
  assert.equal(approvalRuleFailure({}).kind, "offline");
  const owner = approvalRuleFailure({ status: 403, data: { error: "Only a site owner can change the rule so that Grace no longer has to approve.", field: "policy" } });
  assert.equal(owner.kind, "needsOwner");
  assert.match(owner.message, /Only a site owner/);
  assert.equal(approvalRuleFailure({ status: 403, data: { error: "Missing or invalid CSRF token" } }).kind, "denied");
});

test("a named approver who left is listed as chosen and can be cleared", () => {
  const rows = approvalPeopleRows({ approvers: RULE.approvers, formerApprovers: [{ participantId: "p9", displayName: "Grace" }, { participantId: "p2", displayName: "Bo" }] });
  assert.deepEqual(rows, [
    { participantId: "p1", displayName: "Ann", canApprove: true },
    { participantId: "p2", displayName: "Bo", canApprove: true },
    { participantId: "p9", displayName: "Grace", canApprove: false },
  ]);
  assert.deepEqual(approvalPeopleRows({}), []);
});

test("replacing a named approver who left saves without them", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { canSetPolicy: true, slots: SLOTS.slice(0, 1) } });
  api.state.rule = { ...RULE, policy: { requirement: { namedAuthors: ["p2", "p9"] }, scope: "ownSections" }, unmetNamed: ["Grace"], formerApprovers: [{ participantId: "p9", displayName: "Grace" }], mayDropApprovers: true };
  const { panel } = await openDraft(api, ["siteOwner"]);
  const block = panel.querySelector(".oba-approval-rule");
  const inputs = block.querySelectorAll("input");
  const grace = inputs.find((input) => input.attributes.id === "oba-draft-0-rule-person-p9");
  assert.equal(grace.checked, true);
  assert.ok(block.querySelectorAll("label").some((label) => label.attributes.for === "oba-draft-0-rule-person-p9" && /Grace \(can no longer approve\)/.test(label.textContent)));
  assert.match(textOf(block), /Clear this to take them off the rule\./);
  grace.checked = false;
  await grace.dispatch("change");
  const ann = inputs.find((input) => input.attributes.id === "oba-draft-0-rule-person-p1");
  ann.checked = true;
  await ann.dispatch("change");
  inputs.find((input) => input.attributes.id === "oba-draft-0-rule-confirm").checked = true;
  await button(block, "Change approval rule").click();
  await settle();
  const put = api.state.calls.filter((call) => call.key === "PUT collaboration/approval-policy").at(-1);
  assert.deepEqual(put.body.policy, { requirement: { namedAuthors: ["p2", "p1"] }, scope: "ownSections" });
  assert.match(textOf(block), /The approval rule changed/);
  assert.equal(alertOf(block).hidden, true);
}));

test("a coordinator is told that only a site owner can take a departed approver off the rule", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { canSetPolicy: true, slots: SLOTS.slice(0, 1) } });
  api.state.rule = { ...RULE, policy: { requirement: { namedAuthors: ["p9"] }, scope: "ownSections" }, formerApprovers: [{ participantId: "p9", displayName: "Grace" }], mayDropApprovers: false };
  const { panel } = await openDraft(api, ["coordinator"]);
  const block = panel.querySelector(".oba-approval-rule");
  assert.match(textOf(block), /Grace \(can no longer approve\) Only a site owner can take them off the rule\./);
}));

test("only someone who may change the rule loads it, and a writer never asks", withDom(async () => {
  const writer = fakeApi({ number: 1, markdown: "x", reveal: { slots: SLOTS.slice(0, 1) } });
  writer.state.rule = RULE;
  const { panel } = await openDraft(writer);
  assert.equal(writer.state.calls.some((call) => call.key === "GET collaboration/approval-policy"), false);
  assert.doesNotMatch(textOf(panel), /Approval rule/);
  // A coordinator whose request is refused sees nothing either.
  const refused = await openDraft(fakeApi({ number: 1, markdown: "x", reveal: { canSetPolicy: true, slots: SLOTS.slice(0, 1) } }), ["coordinator"]);
  assert.equal(refused.panel.querySelector(".oba-approval-rule").hidden, true);
}));

test("a coordinator changes the rule with labelled controls, the revision read and an explicit confirmation", withDom(async (dom) => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { canSetPolicy: true, slots: SLOTS.slice(0, 1) } });
  api.state.rule = RULE;
  const { panel } = await openDraft(api, ["coordinator"]);
  const block = panel.querySelector(".oba-approval-rule");
  assert.equal(block.hidden, false);
  assert.match(textOf(block), /Current rule. Every author must approve/);
  assert.match(textOf(block), /Must approve now: Ann, Bo, Linus. Still to approve: Linus./);
  const inputs = block.querySelectorAll("input");
  for (const input of inputs) assert.ok(block.querySelectorAll("label").some((label) => label.attributes.for === input.attributes.id), `input ${input.attributes.id} has a label`);
  await inputs.find((input) => input.attributes.id === "oba-draft-0-rule-namedAuthors").dispatch("change");
  // Nobody chosen: refused before anything is sent.
  await button(block, "Change approval rule").click();
  await settle();
  assert.match(alertOf(block).textContent, /at least one person/);
  assert.equal(api.state.calls.some((call) => call.key === "PUT collaboration/approval-policy"), false);
  const bo = inputs.find((input) => input.attributes.id === "oba-draft-0-rule-person-p2");
  bo.checked = true;
  await bo.dispatch("change");
  // Not confirmed: the server's words are shown and focus moves to them.
  await button(block, "Change approval rule").click();
  await settle();
  assert.match(alertOf(block).textContent, /Confirm that changing the rule clears every approval/);
  assert.equal(dom.document.activeElement, alertOf(block));
  const confirm = block.querySelectorAll("input").find((input) => input.attributes.id === "oba-draft-0-rule-confirm");
  confirm.checked = true;
  await button(block, "Change approval rule").click();
  await settle();
  const puts = api.state.calls.filter((call) => call.key === "PUT collaboration/approval-policy");
  assert.deepEqual(puts.at(-1).body, { publicationId: PUBLICATION, expectedRevision: 3, policy: { requirement: { namedAuthors: ["p2"] }, scope: "ownSections" }, confirmed: true });
  assert.match(textOf(block), /The approval rule changed. 2 approvals were cleared/);
  assert.match(textOf(block), /Current rule. Changed rule./);
  assert.equal(dom.document.activeElement.attributes.id, "oba-draft-0-rule-heading");
}));

test("a rule changed elsewhere is a conflict that reloads the current rule", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { canSetPolicy: true, slots: SLOTS.slice(0, 1) } });
  api.state.rule = RULE;
  const { panel } = await openDraft(api, ["coordinator"]);
  const block = panel.querySelector(".oba-approval-rule");
  api.state.rule = { ...RULE, revision: 4, summary: "Someone else's rule." };
  block.querySelectorAll("input").find((input) => input.attributes.id === "oba-draft-0-rule-confirm").checked = true;
  await button(block, "Change approval rule").click();
  await settle();
  assert.match(alertOf(block).textContent, /approval rule changed since you loaded it/);
  assert.match(textOf(block), /Someone else's rule\./);
}));

test("a published reflection shows its rule without a way to change it, and unmet rules say why", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { canSetPolicy: true, slots: SLOTS.slice(0, 1) } });
  api.state.rule = { ...RULE, published: true, unmetNamed: ["Grace"] };
  const { panel } = await openDraft(api, ["coordinator"]);
  const block = panel.querySelector(".oba-approval-rule");
  assert.equal(button(block, "Change approval rule"), undefined);
  assert.match(textOf(block), /Grace can no longer approve/);
  assert.match(textOf(block), /published, so its rule no longer changes/);
}));

test("the combined preview names the rule it is reviewed under", withDom(async () => {
  const api = fakeApi({ number: 1, markdown: "x", reveal: { slots: SLOTS.slice(0, 1) } });
  api.state.preview = { ...PREVIEW, rule: { summary: "Everyone who wrote a section must approve.", unmetNamed: [], unmetRoles: [] } };
  const { panel } = await openDraft(api);
  await button(panel, "Review the combined piece").click();
  await settle();
  assert.match(textOf(panel), /Approval rule: Everyone who wrote a section must approve\./);
}));

// ---------------------------------------------------------------- a roundtable at the cap (#188)

test("a roundtable of a hundred writers stays a labelled list in sharing, preview and arrangement", withDom(async () => {
  const people = Array.from({ length: 100 }, (_, n) => ({ id: `p${n}`, displayName: n === 7 ? "<b>Bold</b> [x](javascript:alert(1))" : `Writer ${n}` }));
  const slots = people.map((person, n) => (n === 0
    ? { participantId: person.id, displayName: person.displayName, kind: "own", ready: true, stamp: stampOf(1), markdown: "my text" }
    : { participantId: person.id, displayName: person.displayName, kind: n % 2 ? "revealed" : "private", ready: true, stamp: n % 2 ? { number: 1 } : null, markdown: n % 2 ? `TEXT-${n} <img src=x>` : null }));
  const api = fakeApi({ number: 1, markdown: "my text", reveal: { canSetPolicy: true, slots } });
  api.state.canArrange = true;
  api.state.structure = { revision: 1, layout: "roundtable", rounds: [{ id: "round-1", turns: people.map((person) => ({ draft: person.id, part: 0 })) }] };
  api.state.preview = { ...PREVIEW, complete: true, sections: people.map((person) => ({ participantId: person.id, displayName: person.displayName, shown: true, revision: 1, approval: "awaiting", required: true })) };
  const { panel } = await openDraft(api, ["coordinator", "contributor"]);
  const list = panel.querySelectorAll("ul").find((node) => node.attributes["aria-label"] === "Everyone's drafts");
  assert.equal(list.children.length, 100);
  // Private drafts stay private; revealed ones are text in a labelled block, never markup.
  const blocks = panel.querySelectorAll("pre").filter((node) => /^Text from /.test(node.attributes["aria-label"] || ""));
  assert.equal(blocks.length, 51, "the fifty revealed drafts and the writer's own");
  assert.equal(blocks.some((node) => /Writer 2$/.test(node.attributes["aria-label"])), false);
  assert.equal(panel.querySelectorAll("img").length, 0);
  assert.equal(panel.querySelectorAll("b").length, 0);
  assert.match(textOf(panel), /<b>Bold<\/b> \[x\]\(javascript:alert\(1\)\)/);
  // The combined preview lists every author in order.
  await button(panel, "Review the combined piece").click();
  await settle();
  const authors = panel.querySelectorAll("ul").find((node) => node.attributes["aria-label"] === "Authors in the combined piece");
  const lines = authors.children.map((item) => item.textContent).filter((line) => !line.startsWith("Approval rule"));
  assert.equal(lines.length, 100);
  assert.match(lines[0], /^Writer 0: revision 1; awaiting approval/);
  assert.match(lines[99], /^Writer 99:/);
  // Every turn of the arrangement has its own labelled controls.
  const controls = panel.querySelectorAll("select").filter((node) => /-turn-\d+-who$/.test(node.attributes.id || ""));
  assert.equal(controls.length, 100);
  for (const control of controls) assert.ok(panel.querySelectorAll("label").some((label) => label.attributes.for === control.attributes.id), control.attributes.id);
}));

// ---------------------------------------------------------------- media moments

const momentsRoot = (panel) => panel.querySelector(".oba-moments");
const momentField = (panel, name) => panel.querySelector(`#oba-moments-0-${name}`);
const momentSubmit = (panel) => panel.querySelector(".oba-moments-form").dispatch("submit");
const typeMoment = async (panel, values) => {
  for (const [name, value] of Object.entries(values)) {
    const control = momentField(panel, name);
    if (name === "publish") control.checked = value;
    else control.value = value;
    await control.dispatch(control.tagName === "SELECT" || name === "publish" ? "change" : "input");
  }
};
const addMoment = async (panel, values) => {
  await typeMoment(panel, values);
  await momentSubmit(panel);
  await settle();
};
const momentItems = (panel) => momentsRoot(panel).querySelectorAll("li").filter((node) => node.classList.contains("oba-moment"));
const storedMoment = (overrides = {}) => ({ id: "moment-1", source: "source-1", locators: [{ kind: "timestamp", value: "1:02" }], location: "at 1:02", observation: "First", quotation: null, intent: "private", link: null, ...overrides });

test("typed times are read deterministically, exactly as the server reads them", () => {
  assert.deepEqual(parseMomentTimestamp("75"), { seconds: 75, fraction: "" });
  assert.deepEqual(parseMomentTimestamp("1:02"), { seconds: 62, fraction: "" });
  assert.deepEqual(parseMomentTimestamp("1:02:03.50"), { seconds: 3723, fraction: "5" });
  assert.deepEqual(parseMomentTimestamp("100:00"), { seconds: 6000, fraction: "" });
  for (const bad of ["", " 1", "1 ", "1:2", "1:60", "1:02:03:04", "-5", "+5", "1h2m", "1:02.", ".5", "1,5", "١٢", "99999999999999999999"]) {
    assert.equal(parseMomentTimestamp(bad), null, bad);
  }
  assert.deepEqual(parseMomentTimestamp("0:45"), parseMomentTimestamp("0:45"), "the same text always gives the same answer");
  assert.match(momentLocationError("timestamp", "1:60", ""), /seconds or h:mm:ss/);
  assert.match(momentLocationError("timestamp", "1:10", "1:02"), /after the start/);
  assert.match(momentLocationError("timestamp", "1:10", "1:10.0"), /after the start/);
  assert.equal(momentLocationError("timestamp", "1:10", "1:10.5"), "");
  assert.match(momentLocationError("page", "", ""), /Give the page/);
  assert.match(momentLocationError("page", "3]", ""), /brackets/);
  assert.equal(momentLocationError("chapter", "Two", ""), "");
  assert.ok(MOMENT_LOCATOR_KINDS.every((kind) => kind.value !== "folio"), "a shared source is never a manuscript");
});

test("a moment's request has explicit rights and provenance, keeps what the form does not edit, and needs some content", () => {
  const base = { source: "source-1", kind: "timestamp", value: "1:02", to: "", quote: "", speaker: "", rights: "", provenance: "", observation: "", publish: false };
  assert.equal(momentPayload({ ...base, source: "" }).field, "source");
  assert.equal(momentPayload({ ...base, value: "1:2" }).field, "value");
  assert.equal(momentPayload({ ...base, to: "1:00" }).field, "to");
  assert.equal(momentPayload(base).field, "quote", "a moment says something");
  assert.equal(momentPayload({ ...base, quote: "Words" }).field, "rights", "rights have no default");
  assert.equal(momentPayload({ ...base, quote: "Words", rights: "briefQuotation" }).field, "provenance");
  assert.equal(momentPayload({ ...base, quote: "Words", rights: "unknown", provenance: "copied", publish: true }).field, "rights");
  const kept = momentPayload({ ...base, quote: "Words", speaker: "  The host ", rights: "unknown", provenance: "copied", observation: "  " }, { locators: [{ kind: "chapter", value: "2" }], language: "en" });
  assert.deepEqual(kept.moment, {
    source: "source-1",
    locators: [{ kind: "timestamp", value: "1:02" }, { kind: "chapter", value: "2" }],
    intent: "private",
    quotation: { text: "Words", rights: "unknown", provenance: "copied", speaker: "The host", language: "en" },
  });
  assert.deepEqual(momentPayload({ ...base, observation: "Mine", publish: true, to: "1:10" }).moment, {
    source: "source-1",
    locators: [{ kind: "timestamp", value: "1:02", to: "1:10" }],
    intent: "publication",
    observation: "Mine",
  });
  assert.ok(QUOTATION_RIGHTS.some((entry) => entry.value === "unknown") && QUOTATION_PROVENANCE.length === 3);
});

test("moments across several media are listed by source, then by time, then as made", () => {
  const moments = [
    { id: "moment-1", source: "source-3", locators: [{ kind: "timestamp", value: "10" }] },
    { id: "moment-2", source: "source-1", locators: [{ kind: "timestamp", value: "1:00:00" }] },
    { id: "moment-3", source: "source-1", locators: [{ kind: "timestamp", value: "59:59.5" }] },
    { id: "moment-4", source: "source-2", locators: [{ kind: "page", value: "9" }] },
    { id: "moment-5", source: "source-gone", locators: [{ kind: "timestamp", value: "1" }] },
    { id: "moment-6", source: "source-2", locators: [{ kind: "page", value: "2" }] },
  ];
  assert.deepEqual(sortMoments(moments, SOURCES).map((moment) => moment.id), ["moment-3", "moment-2", "moment-4", "moment-6", "moment-1", "moment-5"]);
  assert.match(momentText({ source: "source-gone", location: "at 1", intent: "private" }, SOURCES), /no longer listed.*Private: only you/);
  assert.match(momentText({ source: "source-1", location: "at 1:02", intent: "publication" }, SOURCES), /A talk on video \(Video\), at 1:02\. Proposed for the piece/);
});

test("links are the server's: at the moment where the provider allows it, the original otherwise, words when there is none", () => {
  assert.equal(momentLinkText({ link: { href: "https://www.youtube.com/watch?v=abcdefghijk&t=62s", atTime: true }, locators: [{ kind: "timestamp", value: "1:02" }] }), "Open the source at 1:02");
  assert.equal(momentLinkText({ link: { href: "https://podcasts.example/12", atTime: false }, locators: [{ kind: "timestamp", value: "5" }] }), "Open the source (find the location yourself)");
  assert.equal(momentLinkText({ link: null }), "");
  assert.equal(momentsFailure({ status: 409 }).kind, "conflict");
  assert.equal(momentsFailure({ status: 404 }).kind, "denied");
  assert.equal(momentsFailure({ status: 422, data: { error: "x", field: "locators" } }).field, "locators");
  assert.equal(momentsFailure({}).kind, "offline");
});

test("the moments panel is for contributors, loads with the draft, and adds a labelled, linked moment", withDom(async (dom) => {
  const coordinator = fakeApi();
  await openDraft(coordinator, ["coordinator"]);
  assert.equal(coordinator.state.calls.some((call) => call.key.includes("moments")), false);
  const api = fakeApi();
  const { panel } = await openDraft(api);
  assert.equal(momentsRoot(panel).hidden, false);
  const controls = [...momentsRoot(panel).querySelectorAll("input"), ...momentsRoot(panel).querySelectorAll("select"), ...momentsRoot(panel).querySelectorAll("textarea")];
  assert.ok(controls.length >= 10);
  for (const control of controls) assert.ok(panel.querySelectorAll("label").some((label) => label.attributes.for === control.id), control.id);
  await addMoment(panel, { source: "source-1", value: "1:02", observation: "Noticed the pause." });
  assert.deepEqual(lastCall(api).body, { publicationId: PUBLICATION, expectedRevision: 0, change: { action: "add", moment: { source: "source-1", locators: [{ kind: "timestamp", value: "1:02" }], intent: "private", observation: "Noticed the pause." } } });
  assert.equal(momentItems(panel).length, 1);
  assert.match(textOf(momentItems(panel)[0]), /Moment 1 of 1\. A talk on video \(Video\), at 1:02\. Private: only you can see it\./);
  const link = momentItems(panel)[0].querySelector("a");
  assert.equal(link.attributes.href, "https://www.youtube.com/watch?v=abcdefghijk&t=62s");
  assert.match(link.attributes.rel, /noopener/);
  assert.match(textOf(link), /Open the source at 1:02/);
  assert.match(textOf(panel), /Moment added\. Only you can see it\./);
  assert.equal(activeLabel(dom), "Edit moment 1 of 1", "focus goes to the new moment");
  assert.equal(momentField(panel, "observation").value, "", "the form is cleared once stored");
}));

test("unavailable embeds and sources without a link still leave a working link or the location as text", withDom(async () => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  await addMoment(panel, { source: "source-3", value: "5:00", observation: "On the podcast." });
  await addMoment(panel, { source: "source-2", kind: "page", value: "12", quote: "Listen first.", speaker: "Ada", rights: "publicDomain", provenance: "copied" });
  const [book, podcast] = momentItems(panel);
  assert.match(textOf(book), /A book \(Book\), page 12/, "listed in source order");
  assert.match(textOf(book), /This source has no link\. The location is kept with the moment\./);
  assert.match(textOf(book), /— Ada, in A book \(Book\), page 12/);
  assert.equal(book.querySelector("a"), null);
  assert.equal(podcast.querySelector("a").attributes.href, "https://podcasts.example/12");
  assert.match(textOf(podcast), /find the location yourself/);
}));

test("a malformed time is refused before sending, the field is marked, focus goes to the alert and the text stays", withDom(async (dom) => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  const before = api.state.calls.length;
  await addMoment(panel, { source: "source-1", value: "1:60", observation: "Kept words" });
  assert.equal(api.state.calls.length, before, "nothing was sent");
  assert.match(visibleAlert(panel).textContent, /seconds or h:mm:ss/);
  assert.equal(dom.document.activeElement, visibleAlert(panel));
  assert.equal(momentField(panel, "value").attributes["aria-invalid"], "true");
  assert.equal(momentField(panel, "observation").value, "Kept words");
  // The server's refusal names its field and never repeats the text.
  await addMoment(panel, { value: "1:02", observation: "<img src=x onerror=alert(1)>" });
  assert.match(visibleAlert(panel).textContent, /raw HTML/);
  assert.doesNotMatch(visibleAlert(panel).textContent, /onerror/);
  assert.equal(momentField(panel, "observation").attributes["aria-invalid"], "true");
  assert.equal(momentField(panel, "observation").value, "<img src=x onerror=alert(1)>");
}));

test("a stale save keeps everything typed, reloads the current moments and focuses the alert", withDom(async (dom) => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  api.state.moments = { ...api.state.moments, revision: 4, next: 1, moments: [storedMoment({ source: "source-2", locators: [{ kind: "page", value: "3" }], location: "page 3", observation: "Made elsewhere" })] };
  await addMoment(panel, { source: "source-1", value: "2:00", quote: "Typed words", rights: "briefQuotation", provenance: "transcribed", observation: "Typed note", publish: true });
  assert.match(visibleAlert(panel).textContent, /changed since you read them/);
  assert.equal(dom.document.activeElement, visibleAlert(panel));
  assert.equal(momentItems(panel).length, 1, "the current moments are shown");
  for (const [name, value] of [["source", "source-1"], ["value", "2:00"], ["quote", "Typed words"], ["rights", "briefQuotation"], ["observation", "Typed note"]]) assert.equal(momentField(panel, name).value, value, name);
  assert.equal(momentField(panel, "publish").checked, true);
  await momentSubmit(panel);
  await settle();
  assert.equal(momentItems(panel).length, 2, "the retry stores the kept moment");
  assert.match(textOf(panel), /proposed for the piece/i);
}));

test("editing keeps the source and extra locations, and cancel and remove are keyboard-operable with focus kept", withDom(async (dom) => {
  const api = fakeApi();
  api.state.moments = { ...api.state.moments, revision: 1, next: 1, moments: [storedMoment({ locators: [{ kind: "timestamp", value: "1:02" }, { kind: "chapter", value: "2" }], location: "at 1:02, chapter 2", quotation: { text: "Q", rights: "ownWords", provenance: "supplied", language: "en" } })] };
  const { panel } = await openDraft(api);
  const root = momentsRoot(panel);
  await button(root, "Edit moment 1 of 1").click();
  assert.equal(dom.document.activeElement, momentField(panel, "value"));
  assert.equal(momentField(panel, "source").disabled, true, "a moment keeps its source");
  assert.equal(momentField(panel, "quote").value, "Q");
  await button(root, "Cancel editing").click();
  assert.equal(activeLabel(dom), "Edit moment 1 of 1", "cancel returns to the Edit button");
  assert.equal(momentField(panel, "quote").value, "", "cancel clears the form");
  await button(root, "Edit moment 1 of 1").click();
  await typeMoment(panel, { value: "1:05" });
  await momentSubmit(panel);
  await settle();
  const edit = lastCall(api).body.change;
  assert.equal(edit.action, "edit");
  assert.equal(edit.id, "moment-1");
  assert.deepEqual(edit.moment.locators, [{ kind: "timestamp", value: "1:05" }, { kind: "chapter", value: "2" }]);
  assert.equal(edit.moment.quotation.language, "en");
  assert.equal(activeLabel(dom), "Edit moment 1 of 1", "saving returns to the Edit button");
  // Remove asks first; Escape backs out to the Remove button.
  await button(root, "Remove moment 1 of 1").click();
  const box = root.querySelector(".oba-confirm");
  assert.equal(dom.document.activeElement, box);
  await box.dispatch("keydown", { key: "Escape" });
  assert.equal(activeLabel(dom), "Remove moment 1 of 1");
  await button(root, "Remove moment 1 of 1").click();
  await button(root, "Remove this moment").click();
  await settle();
  assert.equal(lastCall(api).body.change.action, "remove");
  assert.equal(dom.document.activeElement.id, "oba-moments-0-list-heading");
  assert.match(textOf(root), /Moment removed\./);
  assert.equal(momentItems(panel).length, 0);
}));

test("moments others shared are shown as text only, and a denied load hides the panel", withDom(async () => {
  const api = fakeApi();
  api.state.moments = { ...api.state.moments, shared: [{ participant: { id: "p-grace", displayName: "Grace" }, moments: [storedMoment({ id: "moment-7", observation: "<script>alert(1)</script>", intent: "publication" })] }] };
  const { panel } = await openDraft(api);
  assert.match(textOf(momentsRoot(panel)), /Moments others shared with you/);
  assert.match(textOf(momentsRoot(panel)), /Grace/);
  assert.match(textOf(momentsRoot(panel)), /<script>alert\(1\)<\/script>/, "untrusted Markdown stays text");
  assert.equal(momentsRoot(panel).querySelector("script"), null);
  assert.equal(button(momentsRoot(panel), "Edit moment 1 of 1"), undefined, "nobody edits another author's moment");
  const start = admin.indexOf("momentsPanel(publication, index) {");
  const end = admin.indexOf("The page an invitation link opens");
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(admin.slice(start, end), /innerHTML|insertAdjacentHTML/);
  const denied = fakeApi({ failures: { "GET collaboration/moments": new FakeApiError("not found", 404, null) } });
  const { panel: hidden } = await openDraft(denied);
  assert.equal(momentsRoot(hidden).hidden, true);
  assert.match(styles, /\.oba-moment \{/);
  assert.match(styles, /@media \(max-width: 44rem\)\s*\{\s*\.oba-moments/);
}));

test("offering a revision says when later moment edits stay private", withDom(async () => {
  const api = fakeApi({ number: 2, markdown: "mine", reveal: { slots: SLOTS.slice(0, 2).map((slot) => ({ ...slot, ready: false })) } });
  api.state.momentsShared = false;
  const { panel } = await openDraft(api);
  await button(panel, "Offer revision 2 to the group").click();
  await button(panel.querySelector(".oba-confirm"), "Share revision 2").click();
  await settle();
  assert.match(textOf(panel), /Your moments changed after you first offered this revision/);
}));

test("offering a revision whose moments could not be stored says so, apart from the write-once advice", withDom(async () => {
  const api = fakeApi({ number: 2, markdown: "mine", reveal: { slots: SLOTS.slice(0, 2).map((slot) => ({ ...slot, ready: false })) } });
  api.state.momentsShared = null;
  api.state.momentsNote = "Your moments could not be shared with this revision, so they stay private. Take back your offer if it still stands, then offer this revision again to share them.";
  const { panel } = await openDraft(api);
  await button(panel, "Offer revision 2 to the group").click();
  await button(panel.querySelector(".oba-confirm"), "Share revision 2").click();
  await settle();
  assert.match(textOf(panel), /Your moments could not be shared with this revision/);
  assert.doesNotMatch(textOf(panel), /Your moments changed after you first offered/);
}));

test("a successful offer reloads the moments panel, keeping what was typed", withDom(async () => {
  const api = fakeApi({ number: 2, markdown: "mine", reveal: { slots: SLOTS.slice(0, 2).map((slot) => ({ ...slot, ready: false })) } });
  const { panel } = await openDraft(api);
  const before = api.state.calls.filter((call) => call.key === "GET collaboration/moments").length;
  await typeMoment(panel, { observation: "Half-typed note" });
  // Someone else revealed moments meanwhile; the offer brings them in.
  api.state.moments = { ...api.state.moments, shared: [{ participant: { id: "p-grace", displayName: "Grace" }, moments: [storedMoment({ id: "moment-9", observation: "Seen after the offer.", intent: "publication" })] }] };
  await button(panel, "Offer revision 2 to the group").click();
  await button(panel.querySelector(".oba-confirm"), "Share revision 2").click();
  await settle();
  assert.equal(api.state.calls.filter((call) => call.key === "GET collaboration/moments").length, before + 1);
  assert.match(textOf(momentsRoot(panel)), /Seen after the offer\./);
  assert.equal(momentField(panel, "observation").value, "Half-typed note");
}));

// ---------------------------------------------------------------- quotation attribution and rights guidance (ADR 0065)

test("quotation warnings count Unicode characters and say nothing without the server's guide", () => {
  const at = "a".repeat(300);
  assert.deepEqual(quotationNotices({ quote: "Listen first.", speaker: "Ada", rights: "briefQuotation" }, GUIDE), []);
  assert.deepEqual(quotationNotices({ quote: "Listen first.", speaker: "  ", rights: "briefQuotation" }, GUIDE).map((n) => n.code), ["noSpeaker"]);
  assert.deepEqual(quotationNotices({ quote: at, speaker: "Ada", rights: "briefQuotation" }, GUIDE), [], "exactly at the guide is not long");
  assert.deepEqual(quotationNotices({ quote: `${at}x`, speaker: "Ada", rights: "briefQuotation" }, GUIDE).map((n) => n.code), ["longForBriefQuotation"]);
  assert.deepEqual(quotationNotices({ quote: `${at}x`, speaker: "", rights: "permission" }, GUIDE).map((n) => n.code), ["noSpeaker", "long"]);
  // Astral characters count once, as the server counts them; newlines count too.
  const astral = "🎙".repeat(150) + "\n".repeat(150);
  assert.equal(astral.length, 450, "UTF-16 length would wrongly call it long");
  assert.deepEqual(quotationNotices({ quote: astral, speaker: "Ada", rights: "briefQuotation" }, GUIDE), []);
  assert.deepEqual(quotationNotices({ quote: `${astral}x`, speaker: "Ada", rights: "briefQuotation" }, GUIDE).map((n) => n.code), ["longForBriefQuotation"]);
  assert.deepEqual(quotationNotices({ quote: "", speaker: "" }, GUIDE), [], "no quotation, nothing to check");
  assert.deepEqual(quotationNotices({ quote: `${at}x`, speaker: "" }, undefined), [], "no guide, no guess");
  assert.match(rightsGuidanceText("permission", GUIDE), /who agreed and when.*does not check rights/);
  assert.equal(rightsGuidanceText("", GUIDE), GUIDE.statement);
});

test("the rights note is sent trimmed with the quotation and kept when editing", () => {
  const typed = { source: "source-1", kind: "timestamp", value: "1:02", to: "", quote: "Line one\nLine two", speaker: "Ada", rights: "permission", rightsNote: "  Agreed by email, 3 March  ", provenance: "supplied", observation: "", publish: true };
  const { moment } = momentPayload(typed);
  assert.equal(moment.quotation.rightsNote, "Agreed by email, 3 March");
  assert.equal(moment.quotation.text, "Line one\nLine two", "multiline quotations are sent exactly");
  assert.equal(momentPayload({ ...typed, rightsNote: "   " }).moment.quotation.rightsNote, undefined);
  assert.equal(momentPayload({ ...typed, quote: "" , observation: "Mine" }).moment.quotation, undefined, "no quotation, no note");
});

test("the form shows neutral rights guidance and live warnings that never block saving", withDom(async () => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  const guidance = panel.querySelector("#oba-moments-0-rights-guidance");
  const notices = panel.querySelector("#oba-moments-0-quote-notices");
  assert.equal(guidance.attributes["aria-live"], "polite");
  assert.equal(momentField(panel, "rights").attributes["aria-describedby"], "oba-moments-0-rights-guidance");
  assert.match(textOf(guidance), /does not check rights/, "the statement shows before a status is chosen");
  await typeMoment(panel, { source: "source-1", value: "1:02", quote: "a".repeat(301), rights: "briefQuotation", provenance: "transcribed" });
  assert.match(textOf(guidance), /quoted briefly to comment on/);
  assert.match(textOf(notices), /No speaker is named/);
  assert.match(textOf(notices), /long for a brief quotation/);
  assert.match(textOf(panel.querySelector("#oba-moments-0-quote-count")), /301 of 1000 characters/);
  await typeMoment(panel, { speaker: "The host" });
  assert.doesNotMatch(textOf(notices), /No speaker is named/);
  await typeMoment(panel, { rights: "permission", rightsNote: "Agreed by the host" });
  assert.match(textOf(guidance), /who agreed and when/);
  assert.match(textOf(notices), /longer than 300 characters\. Consider quoting only/);
  // Saving goes ahead with the warnings: they are advice.
  await momentSubmit(panel);
  await settle();
  const sent = lastCall(api).body.change.moment;
  assert.equal(sent.quotation.rightsNote, "Agreed by the host");
  assert.equal(sent.quotation.speaker, "The host");
  const [item] = momentItems(panel);
  assert.match(textOf(item), new RegExp(`— The host, in A talk on video \\(Video\\), at 1:02`));
  assert.match(textOf(item), /Rights, as you state them: The rights holder gave permission\. I transcribed it from the media\. Rights note: Agreed by the host/);
  assert.match(textOf(item), /longer than 300 characters/);
  // Editing brings the note back.
  await button(panel, "Edit moment 1 of 1").click();
  assert.equal(momentField(panel, "rightsNote").value, "Agreed by the host");
}));

test("the panel never implies permission or fair use, and fetches nothing from a source", withDom(async () => {
  const start = admin.indexOf("// ---------------------------------------------------------------- media moments");
  const end = admin.indexOf("The page an invitation link opens");
  const panelStart = admin.indexOf("momentsPanel(publication, index) {");
  for (const text of [admin.slice(start, admin.indexOf("export function momentsFailure")), admin.slice(panelStart, end), ...QUOTATION_RIGHTS.map((r) => r.label)]) {
    assert.doesNotMatch(text, /fair use|fair dealing|is allowed|is permitted|you may (re)?publish|safe to (re)?publish|cleared for|no permission needed/i);
  }
  // The panel reaches only the Admin API; it never fetches a source's text or media itself.
  assert.doesNotMatch(admin.slice(panelStart, end), /\bfetch\(|XMLHttpRequest|new Image\(|<iframe|"iframe"/);
  const api = fakeApi();
  api.state.moments = { ...api.state.moments, shared: [{ participant: { id: "p-grace", displayName: "Grace" }, moments: [storedMoment({ id: "moment-7", observation: null, intent: "publication", attribution: "Dr <b>Host</b>, in A talk on video (Video), at 1:02", quotation: { text: "<img src=x onerror=alert(1)>", speaker: "Dr <b>Host</b>", rights: "openLicense", provenance: "copied", rightsNote: "CC BY <script>x</script>" }, notices: [] })] }] };
  const { panel } = await openDraft(api);
  const shared = momentsRoot(panel).querySelector(".oba-moments-shared");
  assert.match(textOf(shared), /— Dr <b>Host<\/b>, in A talk on video \(Video\), at 1:02/, "untrusted metadata stays text");
  assert.match(textOf(shared), /Rights, as Grace states them: The source is under an open licence\./);
  assert.match(textOf(shared), /Rights note: CC BY <script>x<\/script>/);
  assert.equal(shared.querySelector("img"), null);
  assert.equal(shared.querySelector("script"), null);
  assert.equal(shared.querySelector("b"), null);
  assert.ok(api.state.calls.every((call) => call.key.split(" ")[1].startsWith("collaboration/")), "only Admin API calls");
}));

// A moments save that stays in flight until the test lets it finish.
const holdMomentSaves = (api) => {
  const real = api.call.bind(api);
  const held = { release: null, started: 0 };
  api.call = (method, path, options) => {
    if (method !== "POST" || !path.startsWith("collaboration/moments")) return real(method, path, options);
    held.started += 1;
    return new Promise((resolve, reject) => {
      held.release = () => real(method, path, options).then(resolve, reject);
    });
  };
  return held;
};
const momentSaves = (api) => api.state.calls.filter((call) => call.key === "POST collaboration/moments");

test("a double submit of a moment sends one request and the buttons wait for the save", withDom(async () => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  const held = holdMomentSaves(api);
  await typeMoment(panel, { source: "source-1", value: "1:02", observation: "Noticed the pause." });
  const first = momentSubmit(panel);
  await settle();
  const second = momentSubmit(panel);
  await settle();
  assert.equal(held.started, 1, "the repeat submit is ignored");
  const save = button(panel, "Add moment");
  assert.equal(save.disabled, true);
  assert.equal(save.attributes["aria-disabled"], "true");
  held.release();
  await Promise.all([first, second]);
  await settle();
  assert.equal(momentSaves(api).length, 1);
  assert.equal(momentItems(panel).length, 1);
  assert.equal(button(panel, "Add moment").disabled, false);
  assert.equal(alertOf(panel).hidden, true, "no conflict against its own first save");
}));

test("text typed while a moment is being saved survives the save", withDom(async () => {
  const api = fakeApi();
  const { panel } = await openDraft(api);
  const held = holdMomentSaves(api);
  await typeMoment(panel, { source: "source-1", value: "1:02", observation: "First." });
  const saving = momentSubmit(panel);
  await settle();
  await typeMoment(panel, { observation: "Typed during the save." });
  held.release();
  await saving;
  await settle();
  assert.equal(momentItems(panel).length, 1);
  assert.equal(momentField(panel, "observation").value, "Typed during the save.");
}));

test("the moment buttons are enabled again after a failed save, and the typed text stays", withDom(async () => {
  const api = fakeApi({ failures: { "POST collaboration/moments": new FakeApiError("The moments changed since you read them.", 500, null) } });
  const { panel } = await openDraft(api);
  await typeMoment(panel, { source: "source-1", value: "1:02", observation: "Keep me." });
  await momentSubmit(panel);
  await settle();
  const save = button(panel, "Add moment");
  assert.equal(save.disabled, false);
  assert.equal(save.attributes["aria-disabled"], undefined);
  assert.equal(momentField(panel, "observation").value, "Keep me.");
  await momentSubmit(panel);
  await settle();
  assert.equal(momentItems(panel).length, 1, "a retry goes through");
}));
