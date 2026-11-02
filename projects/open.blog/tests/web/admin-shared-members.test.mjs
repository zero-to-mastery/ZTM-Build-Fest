import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ObAdmin, invitationStatusText, memberRolesLabel, memberWarnings, removalImpact, roleChangeImpact, sharedManagementError } from "../../web/admin/admin.js";

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
  append(...children) {
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
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
  for (let i = 0; i < 6; i += 1) await tick();
};

class FakeApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const PUBLICATION = "shared-0a1b2c3d4e5f";
const member = (overrides) => ({
  participantId: "participant-2",
  displayName: "Grace",
  adminUser: "grace",
  contributorId: "grace",
  roles: ["contributor"],
  isYou: false,
  canChangeRoles: true,
  canRemove: true,
  hasContributions: true,
  bindingCurrent: true,
  ...overrides,
});
const MEMBERS = () => [
  member({ participantId: "participant-1", displayName: "Ada", adminUser: "ada", contributorId: "ada", roles: ["siteOwner", "contributor"], isYou: true, canRemove: false, canChangeRoles: true, hasContributions: false }),
  member(),
  member({ participantId: "participant-3", displayName: "Linus", adminUser: "linus", contributorId: "linus", roles: ["coordinator"], canChangeRoles: false, canRemove: false, bindingCurrent: false }),
];

/** A stand-in for the Admin API that behaves like the server: it checks the revision. */
function fakeApi({ failures = {} } = {}) {
  const state = { revision: 4, members: MEMBERS(), invitations: [], calls: [], gets: 0 };
  const stale = () => new FakeApiError("The members changed while you were working. Reload to see the current list, then try again.", 409, null);
  return {
    state,
    async call(method, path, options = {}) {
      const key = `${method} ${path.split("?")[0]}`;
      if (method !== "GET") state.calls.push({ key, body: options.json });
      if (failures[key]) {
        const failure = failures[key];
        delete failures[key];
        throw failure;
      }
      switch (key) {
        case "GET contributors":
          return { contributors: { ada: { name: "Ada" }, grace: { name: "Grace" }, kay: { name: "Kay" } } };
        case "GET collaboration/members":
          state.gets += 1;
          return { revision: state.revision, members: state.members };
        case "GET collaboration/invitations":
          return { invitations: state.invitations };
        case "POST collaboration/members/roles": {
          if (options.json.expectedRevision !== state.revision) throw stale();
          state.members = state.members.map((item) => (item.participantId === options.json.participantId ? { ...item, roles: options.json.roles } : item));
          state.revision += 1;
          return { revision: state.revision };
        }
        case "POST collaboration/members/remove": {
          if (options.json.expectedRevision !== state.revision) throw stale();
          state.members = state.members.filter((item) => item.participantId !== options.json.participantId);
          state.revision += 1;
          return { revision: state.revision };
        }
        case "POST collaboration/invitations": {
          const invitation = { id: "invitation-1", adminUser: options.json.adminUser, contributorId: options.json.contributorId, roles: options.json.roles, state: "pending", createdAt: 1, expiresAt: 4_000_000_000 };
          state.invitations = [invitation];
          return { invitation, token: "t", link: `/admin/#/shared/accept/${PUBLICATION}.${"a".repeat(64)}` };
        }
        case "POST collaboration/invitations/revoke":
          state.invitations = state.invitations.map((item) => ({ ...item, state: "revoked" }));
          return {};
        default:
          throw new FakeApiError(`unexpected ${key}`, 500, null);
      }
    },
  };
}

async function openPanel(api, roles = ["siteOwner", "contributor"]) {
  const app = new ObAdmin();
  app.api = api;
  const panel = app.invitationPanel({ publicationId: PUBLICATION, roles }, 0);
  if (!panel) return { panel };
  document.body.append(panel);
  panel.open = true;
  await panel.dispatch("toggle");
  await settle();
  return { panel };
}

const button = (root, label) => root.querySelectorAll("button").find((node) => node.attributes["aria-label"] === label || node.textContent === label);
const confirmButton = (root, label) => root.querySelector(".oba-confirm").querySelectorAll("button").find((node) => node.textContent === label);
const textOf = (root) => root.textContent.replace(/\s+/g, " ");
const alertOf = (root) => root.querySelectorAll("p").find((node) => node.attributes.role === "alert");

// ---------------------------------------------------------------- pure helpers

test("roles, invitation states, and warnings are always words, never color alone", () => {
  assert.equal(memberRolesLabel(["contributor", "siteOwner"]), "Contributor, Site owner");
  assert.equal(memberRolesLabel(["bogus"]), "Unknown role");
  for (const state of ["pending", "accepted", "declined", "revoked", "expired"]) {
    assert.match(invitationStatusText({ state, expiresAt: 4_000_000_000 }), /[A-Za-z]{5,}/, state);
  }
  assert.match(invitationStatusText({ state: "pending", expiresAt: 4_000_000_000 }), /Expires/);
  assert.match(invitationStatusText({ state: "revoked" }), /no longer works/);
  assert.deepEqual(memberWarnings(member()), []);
  assert.match(memberWarnings(member({ bindingCurrent: false }))[0], /no longer exists/);
});

test("destructive changes explain their impact on access and on credit separately", () => {
  assert.match(removalImpact(member()), /no longer be able to sign in/);
  assert.match(removalImpact(member()), /stays credited/);
  assert.match(removalImpact(member({ hasContributions: false })), /no credit changes/);
  assert.deepEqual(roleChangeImpact(member(), ["contributor"]), []);
  assert.deepEqual(roleChangeImpact(member({ roles: ["contributor"] }), ["reader"]), ["Adds: Reader.", "Removes: Contributor.", "Their existing drafts and credit stay as they are."]);
  assert.ok(roleChangeImpact(member({ roles: ["siteOwner"] }), ["reader"]).includes("They will lose full control of this reflection."));
});

test("failures are mapped to a message and whether stale state should be reloaded", () => {
  assert.deepEqual(sharedManagementError(new FakeApiError("changed", 409, null)), { message: "changed", reload: true });
  assert.equal(sharedManagementError(new FakeApiError("nope", 404, { error: "denied" })).reload, true);
  assert.match(sharedManagementError(new FakeApiError("nope", 404, { error: "denied" })).message, /^denied .*reload/);
  assert.equal(sharedManagementError(new FakeApiError("boom", 500, null)).reload, false);
  assert.match(sharedManagementError(undefined).message, /Reload/);
});

// ---------------------------------------------------------------- the panel

test("only owners and coordinators get the panel, and it loads only when opened", withDom(async () => {
  const api = fakeApi();
  assert.equal((await openPanel(api, ["contributor"])).panel, null);
  assert.equal((await openPanel(api, ["reader", "editor"])).panel, null);
  assert.equal(api.state.gets, 0);
  const { panel } = await openPanel(api, ["coordinator"]);
  assert.ok(panel);
  assert.equal(api.state.gets, 1);
  assert.equal(panel.querySelectorAll("input").some((input) => input.value === "siteOwner"), false, "a coordinator cannot hand out ownership");
}));

test("members show roles, state and allowed actions as text, with sign-in and credit explained apart", withDom(async () => {
  const { panel } = await openPanel(fakeApi());
  const text = textOf(panel);
  assert.match(text, /Sign-in access.*decides who can open/);
  assert.match(text, /Credit.*Ending access never removes credit/);
  assert.match(text, /Ada.*You/);
  assert.match(text, /Signs in as grace\. Credited as grace\./);
  assert.match(text, /Sign-in roles: Contributor, Site owner/);
  assert.match(text, /Warning: This sign-in account or contributor profile no longer exists/);
  assert.match(text, /You cannot change this member\./);
  const labels = panel.querySelectorAll("button").map((node) => node.attributes["aria-label"]).filter(Boolean);
  assert.ok(labels.includes("Remove access for Grace") && labels.includes("Change roles for Grace"));
  assert.equal(labels.includes("Remove access for Ada"), false, "the last owner has no remove action");
  assert.equal(panel.querySelectorAll("li").find((li) => li.textContent.includes("Linus")).querySelectorAll("button").length, 0);
}));

test("removing a member asks first, explains the impact, and Escape or Cancel changes nothing", withDom(async (dom) => {
  const api = fakeApi();
  const { panel } = await openPanel(api);
  const remove = button(panel, "Remove access for Grace");
  await remove.click();
  const box = panel.querySelector(".oba-confirm");
  assert.ok(box, "a confirmation appears");
  assert.equal(dom.document.activeElement, box, "focus moves to the confirmation");
  assert.equal(box.attributes.role, "group");
  assert.ok(panel.querySelector(`#${box.attributes["aria-labelledby"]}`));
  assert.match(box.textContent, /Remove Grace\?/);
  assert.match(box.textContent, /stays credited/);
  assert.equal(api.state.calls.length, 0, "nothing is sent before confirming");
  await box.dispatch("keydown", { key: "Escape" });
  assert.equal(panel.querySelector(".oba-confirm"), null);
  assert.equal(dom.document.activeElement, remove, "focus returns to the trigger");
  await remove.click();
  await button(panel, "Cancel").click();
  assert.equal(api.state.calls.length, 0);
  assert.equal(api.state.members.length, 3);
}));

test("confirming removal sends the revision it saw, refreshes, and announces the result", withDom(async (dom) => {
  const api = fakeApi();
  const { panel } = await openPanel(api);
  await button(panel, "Remove access for Grace").click();
  await confirmButton(panel, "Remove access").click();
  await settle();
  assert.deepEqual(api.state.calls, [{ key: "POST collaboration/members/remove", body: { publicationId: PUBLICATION, participantId: "participant-2", expectedRevision: 4 } }]);
  assert.equal(api.state.members.some((item) => item.adminUser === "grace"), false);
  assert.equal(panel.querySelectorAll("li").some((li) => li.textContent.includes("Signs in as grace")), false);
  assert.match(textOf(panel), /Grace can no longer sign in to this reflection\./);
  assert.equal(dom.document.activeElement.tagName, "H3", "focus lands on the section heading, not on a removed button");
}));

test("changing roles previews the change and confirms before sending", withDom(async () => {
  const api = fakeApi();
  const { panel } = await openPanel(api);
  await button(panel, "Change roles for Grace").click();
  const boxes = panel.querySelectorAll("input").filter((input) => input.attributes.type === "checkbox" && input.attributes.name.includes("-roles-"));
  assert.deepEqual(boxes.filter((input) => input.checked).map((input) => input.value), ["contributor"]);
  boxes.find((input) => input.value === "contributor").checked = false;
  boxes.find((input) => input.value === "reader").checked = true;
  await button(panel, "Review change").click();
  assert.equal(api.state.calls.length, 0);
  assert.match(textOf(panel.querySelector(".oba-confirm")), /Adds: Reader\..*Removes: Contributor\..*Credit for what they wrote is separate/);
  await confirmButton(panel, "Change roles").click();
  await settle();
  assert.deepEqual(api.state.calls[0].body, { publicationId: PUBLICATION, participantId: "participant-2", roles: ["reader"], expectedRevision: 4 });
  assert.match(textOf(panel), /Roles updated for Grace/);
  assert.match(textOf(panel), /Sign-in roles: Reader/);
}));

test("an empty or unchanged role choice never reaches the server", withDom(async () => {
  const api = fakeApi();
  const { panel } = await openPanel(api);
  await button(panel, "Change roles for Grace").click();
  await button(panel, "Review change").click();
  assert.match(textOf(panel), /No roles changed\./);
  await button(panel, "Change roles for Grace").click();
  panel.querySelectorAll("input").find((input) => input.attributes.name?.includes("-roles-") && input.checked).checked = false;
  await button(panel, "Review change").click();
  assert.equal(alertOf(panel).hidden, false);
  assert.match(alertOf(panel).textContent, /at least one role/);
  assert.equal(api.state.calls.length, 0);
}));

test("stale state is reported, the list reloads, and nothing is half applied", withDom(async (dom) => {
  const api = fakeApi();
  const { panel } = await openPanel(api);
  await button(panel, "Remove access for Grace").click();
  api.state.revision = 5; // someone else changed the members meanwhile
  const gets = api.state.gets;
  await confirmButton(panel, "Remove access").click();
  await settle();
  assert.equal(alertOf(panel).hidden, false);
  assert.match(alertOf(panel).textContent, /changed while you were working/);
  assert.equal(api.state.gets, gets + 1, "the current list is fetched again");
  assert.ok(panel.contains(dom.document.activeElement), "focus stays inside the panel after the reload");
  assert.equal(dom.document.activeElement, alertOf(panel), "focus lands on the message");
  assert.equal(api.state.members.length, 3, "the server kept every member");
  // The retry now carries the fresh revision and succeeds.
  await button(panel, "Remove access for Grace").click();
  await confirmButton(panel, "Remove access").click();
  await settle();
  assert.equal(api.state.calls.at(-1).body.expectedRevision, 5);
  assert.equal(api.state.members.length, 2);
}));

test("a permission-denied response shows a clear message and leaves the controls usable", withDom(async (dom) => {
  const denied = new FakeApiError("denied", 404, { error: "That shared reflection or member was not found, or you cannot manage it." });
  const api = fakeApi({ failures: { "POST collaboration/members/remove": denied } });
  const { panel } = await openPanel(api);
  await button(panel, "Remove access for Grace").click();
  await confirmButton(panel, "Remove access").click();
  await settle();
  assert.match(alertOf(panel).textContent, /cannot manage it\. If your access changed, reload this page\./);
  assert.equal(api.state.members.length, 3);
  assert.ok(panel.contains(dom.document.activeElement), "focus stays inside the panel");
  assert.doesNotMatch(textOf(panel), /undefined|\[object/);
}));

test("revoking an invitation is confirmed and explains that the link stops working", withDom(async () => {
  const api = fakeApi();
  api.state.invitations = [{ id: "invitation-1", adminUser: "kay", contributorId: "kay", roles: ["reader"], state: "pending", expiresAt: 4_000_000_000 }];
  const { panel } = await openPanel(api);
  assert.match(textOf(panel), /kay.*pending.*Waiting for an answer\. Expires/);
  await button(panel, "Revoke kay's invitation").click();
  assert.match(textOf(panel.querySelector(".oba-confirm")), /link stops working at once/);
  assert.equal(api.state.calls.length, 0);
  await confirmButton(panel, "Revoke invitation").click();
  await settle();
  assert.equal(api.state.calls[0].key, "POST collaboration/invitations/revoke");
  assert.match(textOf(panel), /revoked.*Withdrawn\. The link no longer works\./);
}));

test("a new link can be copied by hand when the clipboard is unavailable", withDom(async (dom) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: undefined }, configurable: true });
  try {
    const { panel } = await openPanel(fakeApi());
    const form = panel.querySelector("form");
    form.querySelectorAll("input").find((input) => input.attributes.type === "text").value = "kay";
    await form.dispatch("submit");
    await settle();
    const link = panel.querySelector("input[readonly]");
    assert.equal(link.value, `https://blog.example/admin/#/shared/accept/${PUBLICATION}.${"a".repeat(64)}`);
    assert.equal(link.attributes["aria-label"], "Invitation link");
    await button(panel, "Copy link").click();
    assert.equal(dom.document.activeElement, link, "the link is focused so it can be copied with the keyboard");
    assert.match(textOf(panel), /Copying is not available here/);
    assert.match(textOf(panel), /nothing is emailed/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  }
}));

test("hostile names and accounts render as text, never markup, script, or links", withDom(async () => {
  const api = fakeApi();
  api.state.members = [member({ displayName: "<img src=x onerror=alert(1)>", adminUser: "javascript:alert(1)" })];
  const { panel } = await openPanel(api);
  assert.equal(panel.querySelectorAll("img").length, 0);
  assert.match(textOf(panel), /<img src=x onerror=alert\(1\)>/);
  assert.equal(panel.querySelectorAll("a").length, 0, "no member data becomes a link");
}));

test("the markup is keyboard-first, announces changes, and fits small screens", () => {
  const panel = admin.slice(admin.indexOf("invitationPanel(publication, index)"), admin.indexOf("async showInvitationAccept"));
  assert.doesNotMatch(panel, /localStorage|sessionStorage|console\.|innerHTML/);
  assert.match(panel, /role: "status", "aria-live": "polite"/);
  assert.match(panel, /role: "alert"/);
  assert.match(panel, /event\.key === "Escape"/);
  assert.match(panel, /Remove access for \$\{name\}/);
  assert.doesNotMatch(panel, /onclick/);
  assert.match(styles, /\.oba-member \.oba-btn \{\s*min-height: 2\.75rem;/);
  assert.match(styles, /@media \(max-width: 44rem\) \{\s*\.oba-member \.oba-toolbar \.oba-btn,[^}]*flex: 1 1 100%/);
  assert.match(styles, /\.oba-confirm:focus-visible/);
});
