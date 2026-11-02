// The Connected accounts screen (ADR 0301, #366): off and honest when social publishing is not set up,
// permissions reviewed before connecting, a provider link that only ever points at the provider, a
// destination choice with reasons, reconnect and disconnect with a confirmation, status as words, and
// nothing secret ever drawn.
import assert from "node:assert/strict";
import test from "node:test";

import { HEALTH, OFF_TEXT, SCOPE_WORDS, createSocialAccounts, safeAuthorizeUrl } from "../../web/admin/social.js";
import { ApiError, withDom } from "./dom-shim.mjs";
import { all, button, flush, link, one, text } from "./voice-harness.mjs";

const later = (ms = 10 * 60 * 1000) => new Date(Date.now() + ms).toISOString();
const ID = (n) => `${String(n).repeat(8)}-1111-4111-8111-${String(n).repeat(12)}`;
const SECRET = "AQX-secret-token-must-never-show";

const linkedin = { provider: "linkedin", label: "LinkedIn", redirectUri: "https://blog.example.com/api/social/callback/linkedin", version: "202510", scopes: ["openid", "profile", "w_member_social", "r_organization_admin"], requiredScopes: ["openid", "profile", "w_member_social"], organizations: true, pkce: false };
const facebook = { provider: "facebook", label: "Facebook", redirectUri: "https://blog.example.com/api/social/callback/facebook", version: "v23.0", scopes: ["pages_show_list", "pages_manage_posts"], requiredScopes: ["pages_show_list", "pages_manage_posts"], organizations: false, pkce: false };
const on = (providers = [linkedin, facebook], problems = []) => ({ enabled: true, state: "on", providers, problems });
const account = (over = {}) => ({
  id: ID(1), provider: "linkedin", kind: "member", externalId: "urn:li:person:abc", displayName: "Ada Lovelace", status: "connected", health: "ok", connectedBy: "mikey",
  createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z", disconnectedAt: null,
  credential: { status: "active", accessExpiresAt: "2026-12-01T00:00:00Z", refreshExpiresAt: "2027-10-01T00:00:00Z", scopes: ["openid", "w_member_social"], lastRefreshedAt: null }, ...over,
});
const connection = (over = {}) => ({ id: ID(2), provider: "linkedin", status: "pending", expiresAt: later(), createdAt: "2026-10-29T10:00:00Z", createdBy: "mikey", reauthAccountId: null, requestedScopes: [], grantedScopes: [], errorCode: null, message: null, destinations: [], notes: [], ...over });

// A server stand-in with state, so a click is followed by the list the real server would give.
function server(initial = {}) {
  const state = { overview: on(), accounts: [], connections: [], ...initial };
  const fake = {
    state,
    calls: [],
    failWith: null,
    async call(method, path, options = {}) {
      this.calls.push({ method, path, body: options.json });
      if (this.failWith) {
        const error = this.failWith;
        this.failWith = null;
        throw error;
      }
      if (method === "GET" && path === "social/status") return structuredClone(state.overview);
      if (method === "GET" && path === "social/accounts") return structuredClone({ accounts: state.accounts, leak: SECRET });
      if (method === "GET" && path === "social/connections") return structuredClone({ connections: state.connections });
      if (method === "POST" && path === "social/connections") {
        const started = connection({ id: ID(3), provider: options.json.provider });
        state.connections = [started, ...state.connections];
        return { connection: started, authorizeUrl: `https://www.${options.json.provider}.com/oauth/authorize?state=abc` };
      }
      const select = /^social\/connections\/(.+)\/select$/.exec(path);
      if (select) {
        const chosen = state.connections.find((c) => c.id === select[1]);
        const picked = chosen.destinations.find((d) => d.id === options.json.destination);
        chosen.status = "completed";
        state.accounts = [account({ id: ID(4), displayName: picked.name, externalId: picked.id }), ...state.accounts];
        return { account: state.accounts[0], accessToken: SECRET };
      }
      const cancel = /^social\/connections\/(.+)\/cancel$/.exec(path);
      if (cancel) {
        state.connections.find((c) => c.id === cancel[1]).status = "canceled";
        return {};
      }
      const disconnect = /^social\/accounts\/(.+)\/disconnect$/.exec(path);
      if (disconnect) {
        Object.assign(state.accounts.find((a) => a.id === disconnect[1]), { status: "disconnected", health: "disconnected", disconnectedAt: "2026-10-29T12:00:00Z" });
        return {};
      }
      const reconnect = /^social\/accounts\/(.+)\/reconnect$/.exec(path);
      if (reconnect) {
        const started = connection({ id: ID(5), reauthAccountId: reconnect[1] });
        state.connections = [started, ...state.connections];
        return { connection: started, authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization?state=def" };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return fake;
}

async function mount(api, win) {
  const view = createSocialAccounts({ api, win });
  document.body.append(view.element);
  await view.load();
  await flush();
  return { view, root: view.element, api };
}
const click = async (node) => {
  await node.dispatch("click");
  await flush();
};
const buttons = (root, action) => all(root, "button").filter((b) => b.dataset.action === action);

test("not set up: the page says so, offers nothing, and names an invalid setting without its value", withDom(async () => {
  for (const [overview, expected] of [
    [{ enabled: false, state: "off" }, OFF_TEXT.off],
    [{ enabled: false, state: "invalid", problems: ["OPENBLOG_SOCIAL_ENDPOINT"] }, OFF_TEXT.invalid],
    [{ enabled: false, state: "unavailable", message: "The social function says social publishing is not enabled." }, "The social function says social publishing is not enabled."],
  ]) {
    const api = server({ overview });
    const { root } = await mount(api);
    assert.ok(text(one(root, "[data-social-off]") || all(root, "p").find((p) => p.dataset.socialOff)).includes(expected.slice(0, 40)));
    assert.equal(all(root, "button").filter((b) => b.dataset.action === "social-connect").length, 0);
    assert.deepEqual(api.calls.map((c) => c.path), ["social/status"], "no accounts or connections are requested when it is off");
    if (overview.problems) assert.ok(text(root).includes("OPENBLOG_SOCIAL_ENDPOINT"));
  }
}));

test("connect: each provider shows the permissions it asks for in plain words, the exact redirect, and its version", withDom(async () => {
  const { root } = await mount(server());
  const cards = all(root, "li").filter((li) => li.dataset.provider);
  assert.deepEqual(cards.map((c) => c.dataset.provider), ["linkedin", "facebook"]);
  const card = cards[0];
  const summary = text(all(card, "summary")[0]);
  assert.match(summary, /Review the permissions LinkedIn will be asked for/);
  const scopes = all(card, "li").map(text);
  assert.ok(scopes.some((line) => line.startsWith(SCOPE_WORDS.w_member_social) && line.includes("w_member_social") && !line.includes("(optional)")));
  assert.ok(scopes.some((line) => line.includes("r_organization_admin") && line.includes("(optional)")), "an optional scope is labelled");
  assert.equal(text(one(card, "code") && all(card, "code").find((c) => c.dataset.socialRedirect)), linkedin.redirectUri);
  assert.match(text(card), /API version 202510\. Verify it is still current/);
  const connect = buttons(card, "social-connect")[0];
  assert.equal(text(connect), "Connect LinkedIn");
  assert.ok(connect.attributes["aria-describedby"], "the button is described by the note that nothing is connected yet");
}));

test("no provider configured, and a skipped provider setting, are both said plainly", withDom(async () => {
  const { root } = await mount(server({ overview: on([], ["OPENBLOG_SOCIAL_LINKEDIN_API_VERSION"]) }));
  assert.ok(all(root, "p").some((p) => p.dataset.socialNoProviders));
  assert.ok(text(root).includes("OPENBLOG_SOCIAL_LINKEDIN_API_VERSION"));
}));

test("connecting posts only the provider, then offers a link that opens the provider in a new tab and takes focus", withDom(async (dom) => {
  const api = server();
  const { root } = await mount(api);
  await click(buttons(root, "social-connect")[0]);
  assert.deepEqual(api.calls.find((c) => c.method === "POST"), { method: "POST", path: "social/connections", body: { provider: "linkedin" } });
  const continueLink = link(root, "social-continue");
  assert.equal(continueLink.attributes.href, "https://www.linkedin.com/oauth/authorize?state=abc");
  assert.equal(continueLink.attributes.target, "_blank");
  assert.equal(continueLink.attributes.rel, "noopener noreferrer");
  assert.equal(dom.document.activeElement, continueLink);
  assert.match(text(one(root, "[data-social-status]") || all(root, "p").find((p) => p.dataset.socialStatus)), /Continue to LinkedIn to approve access/);
  assert.match(text(root), /Waiting for LinkedIn/);
  assert.ok(buttons(root, "social-cancel").length === 1 && buttons(root, "social-check").length === 1);
  await click(buttons(root, "social-cancel")[0]);
  assert.equal(link(root, "social-continue"), null, "a canceled attempt is gone");
  assert.ok(api.calls.some((c) => c.path === `social/connections/${ID(3)}/cancel` && c.method === "POST"));
}));

test("a provider address that is not the provider's own is never rendered as a link", withDom(async () => {
  for (const bad of ["https://evil.example/oauth", "http://www.linkedin.com/x", "https://www.linkedin.com.evil.example/", "https://u:p@www.linkedin.com/", "javascript:alert(1)", "https://www.linkedin.com:8443/x", null, ""]) {
    assert.equal(safeAuthorizeUrl(bad), null, String(bad));
  }
  assert.equal(safeAuthorizeUrl("https://www.facebook.com/v23.0/dialog/oauth?x=1"), "https://www.facebook.com/v23.0/dialog/oauth?x=1");
  const api = server();
  api.call = new Proxy(api.call, {
    apply: async (target, self, args) => {
      const reply = await Reflect.apply(target, self, args);
      return reply.authorizeUrl ? { ...reply, authorizeUrl: "https://evil.example/phish" } : reply;
    },
  });
  const { root } = await mount(api);
  await click(buttons(root, "social-connect")[0]);
  assert.equal(link(root, "social-continue"), null);
  assert.ok(all(root, "p").some((p) => p.dataset.socialNoLink), "the author is told to start again");
  assert.ok(!text(root).includes("evil.example"));
}));

test("after a reload an attempt still waits, but its provider link is gone and the page says to start again", withDom(async () => {
  const { root } = await mount(server({ connections: [connection({ id: ID(6) })] }));
  assert.match(text(root), /Waiting for LinkedIn/);
  assert.equal(link(root, "social-continue"), null);
  assert.ok(all(root, "p").some((p) => p.dataset.socialNoLink));
}));

test("choosing a destination: ineligible ones are shown disabled with the reason, nothing is sent without a choice, and the choice is posted once", withDom(async () => {
  const destinations = [
    { id: "urn:li:person:abc", kind: "member", name: "Ada Lovelace", eligible: true, reason: null },
    { id: "urn:li:organization:7", kind: "organization", name: "Lantern Studios", eligible: false, reason: "missing-scope" },
  ];
  const api = server({ connections: [connection({ id: ID(7), status: "authorized", grantedScopes: ["openid", "w_member_social"], destinations, notes: [{ code: "organizations-not-approved", text: "LinkedIn refused the organization lookup." }] })] });
  const { root } = await mount(api);
  const form = all(root, "form")[0];
  assert.match(text(all(form, "legend")[0]), /Choose where LinkedIn posts may go/);
  const radios = all(form, "input");
  assert.deepEqual(radios.map((r) => r.disabled), [false, true]);
  for (const radio of radios) assert.ok(all(form, "label").some((label) => label.attributes.for === radio.id), "every radio has a label");
  assert.ok(radios[1].attributes["aria-describedby"] && text(all(form, "p").find((p) => p.id === radios[1].attributes["aria-describedby"])).includes("A permission needed to post here was not granted."));
  assert.match(text(root), /LinkedIn refused the organization lookup\./);
  assert.match(text(root), /Post as you/);
  // No choice: an inline message and no request.
  const before = api.calls.length;
  await form.dispatch("submit");
  assert.match(text(all(form, "p").find((p) => p.attributes.role === "alert")), /Choose where posts may go first/);
  assert.equal(api.calls.length, before);
  radios[0].checked = true;
  await form.dispatch("submit");
  await flush();
  assert.deepEqual(api.calls.find((c) => c.path.endsWith("/select")), { method: "POST", path: `social/connections/${ID(7)}/select`, body: { destination: "urn:li:person:abc" } });
  assert.match(text(all(root, "p").find((p) => p.dataset.socialStatus)), /Ada Lovelace is connected\./);
  assert.equal(all(root, "li").filter((li) => li.dataset.account).length, 1);
  assert.equal(all(root, "form").length, 0, "the choice is gone once made");
}));

test("accounts show their status as words, dates, ids and granted permissions, and never a token", withDom(async () => {
  const api = server({
    accounts: [
      account({ id: ID(1) }),
      account({ id: ID(2), displayName: "Expiring Page", provider: "facebook", kind: "page", externalId: "123", health: "expiring" }),
      account({ id: ID(3), displayName: "Lost Access", health: "needs-reauth", status: "needs-reauth" }),
      account({ id: ID(4), displayName: "Old One", health: "disconnected", status: "disconnected", disconnectedAt: "2026-09-01T00:00:00Z", credential: null }),
    ],
  });
  api.state.accounts[0].accessToken = SECRET;
  const { root } = await mount(api);
  const cards = all(root, "li").filter((li) => li.dataset.account);
  assert.deepEqual(cards.map((c) => c.dataset.health), ["ok", "expiring", "needs-reauth", "disconnected"]);
  assert.deepEqual(cards.map((c) => text(all(c, "span").find((s) => s.dataset.health))), [`${HEALTH.ok.symbol} Connected`, "! Expiring soon", "! Needs reconnecting", "– Disconnected"]);
  assert.match(text(cards[0]), /Access valid until\s*2026-12-01/);
  assert.match(text(cards[0]), /Connected by\s*mikey, 2026-10-01/);
  assert.match(text(cards[0]), /urn:li:person:abc/);
  assert.match(text(cards[0]), /Permissions granted/);
  assert.match(text(cards[2]), /Access to this account ran out or was withdrawn\. Reconnect it, signing in as the same account/);
  assert.ok(all(cards[2], "button").find((b) => b.dataset.action === "social-reconnect").className.includes("oba-btn-primary"), "expired access leads with Reconnect");
  assert.ok(!all(cards[0], "button").find((b) => b.dataset.action === "social-reconnect").className.includes("oba-btn-primary"));
  assert.equal(all(cards[3], "button").length, 0, "a disconnected account has no actions");
  assert.match(text(cards[3]), /Disconnected\s*2026-09-01/);
  assert.ok(!text(root).includes(SECRET));
  for (const control of all(root, "button")) assert.ok(text(control) && (control.attributes["aria-label"] || text(control)).length > 3);
}));

test("disconnect asks first, says what it does, can be backed out of, and then reports and moves focus", withDom(async (dom) => {
  const api = server({ accounts: [account({ id: ID(1) })] });
  const { root } = await mount(api);
  const open = buttons(root, "social-disconnect")[0];
  assert.equal(open.attributes["aria-label"], "Disconnect Ada Lovelace");
  await click(open);
  assert.equal(api.calls.filter((c) => c.path.includes("disconnect")).length, 0, "opening the question changes nothing");
  assert.equal(buttons(root, "social-disconnect")[0].attributes["aria-expanded"], "true");
  const confirm = all(root, "div").find((d) => d.dataset.socialConfirm);
  assert.match(text(confirm), /Its stored tokens are erased/);
  assert.match(text(confirm), /stays in your history/);
  assert.equal(dom.document.activeElement.dataset.confirmText, ID(1), "focus moves to the question");
  await click(buttons(root, "social-disconnect-cancel")[0]);
  assert.equal(all(root, "div").find((d) => d.dataset.socialConfirm), undefined);
  assert.equal(api.calls.filter((c) => c.path.includes("disconnect")).length, 0);
  await click(buttons(root, "social-disconnect")[0]);
  await click(buttons(root, "social-disconnect-confirm")[0]);
  assert.deepEqual(api.calls.find((c) => c.path.includes("disconnect")), { method: "POST", path: `social/accounts/${ID(1)}/disconnect`, body: {} });
  assert.match(text(all(root, "p").find((p) => p.dataset.socialStatus)), /Ada Lovelace is disconnected\. Its stored tokens were erased\./);
  assert.equal(all(root, "li").find((li) => li.dataset.account).dataset.health, "disconnected");
  assert.equal(dom.document.activeElement.id.endsWith("-accounts"), true, "focus returns to the accounts heading");
}));

test("reconnect starts a fresh attempt for that account and offers the provider link", withDom(async () => {
  const api = server({ accounts: [account({ id: ID(1), health: "needs-reauth", status: "needs-reauth" })] });
  const { root } = await mount(api);
  await click(buttons(root, "social-reconnect")[0]);
  assert.deepEqual(api.calls.find((c) => c.path.endsWith("/reconnect")), { method: "POST", path: `social/accounts/${ID(1)}/reconnect`, body: {} });
  assert.equal(link(root, "social-continue").attributes.href, "https://www.linkedin.com/oauth/v2/authorization?state=def");
  assert.match(text(root), /Reconnecting LinkedIn/);
  assert.match(text(all(root, "p").find((p) => p.dataset.socialStatus)), /sign in as the same account to reconnect Ada Lovelace/);
}));

test("a failed attempt is explained with its reasons; an error is announced and the controls come back", withDom(async () => {
  const failed = connection({ id: ID(8), status: "failed", errorCode: "no-destination", message: "Nothing this app may post to was found for that account.", destinations: [{ id: "9", kind: "page", name: "Read Only Page", eligible: false, reason: "no-posting-role" }] });
  const api = server({ connections: [failed], accounts: [account()] });
  const { root } = await mount(api);
  assert.match(text(all(root, "li").find((li) => li.dataset.status === "failed")), /Nothing this app may post to was found/);
  assert.match(text(root), /Read Only Page: Your role on this Page does not let you create posts\./);
  api.failWith = new ApiError("Too many connection attempts are open.", 429, {});
  await click(buttons(root, "social-connect")[0]);
  const alert = all(root, "p").find((p) => p.dataset.socialStatus);
  assert.equal(alert.attributes.role, "alert");
  assert.match(text(alert), /Too many connection attempts are open\./);
  assert.ok(buttons(root, "social-connect").every((b) => !b.disabled), "controls are usable again");
}));

test("a load error offers Try again; only one request runs at a time", withDom(async () => {
  const api = server();
  api.failWith = new ApiError("The social function could not be reached", 502, {});
  const { view, root } = await mount(api);
  assert.match(text(one(root, "[data-social-error]") || all(root, "p").find((p) => p.dataset.socialError)), /could not be reached/);
  await click(buttons(root, "social-retry")[0]);
  assert.ok(buttons(root, "social-connect").length === 2);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const real = api.call.bind(api);
  api.call = async (...args) => (args[1] === "social/connections" && args[0] === "POST" ? (await gate, real(...args)) : real(...args));
  const first = buttons(root, "social-connect")[0].dispatch("click");
  const second = buttons(root, "social-connect")[0].dispatch("click");
  assert.equal(view.isBusy(), true);
  release();
  await Promise.all([first, second]);
  await flush();
  assert.equal(api.calls.filter((c) => c.method === "POST" && c.path === "social/connections").length, 1);
  assert.equal(view.isBusy(), false);
  assert.equal(view.isDirty(), false);
}));

test("coming back to the tab refreshes only while an attempt is waiting, and destroy stops listening", withDom(async () => {
  const listeners = new Map();
  const win = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  const idle = server();
  const { view: first } = await mount(idle, win);
  const loads = () => idle.calls.filter((c) => c.path === "social/status").length;
  const before = loads();
  await listeners.get("focus")();
  await flush();
  assert.equal(loads(), before, "nothing is waiting, so nothing is fetched");
  first.destroy();
  assert.equal(listeners.has("focus"), false);

  const waiting = server({ connections: [connection({ id: ID(6) })] });
  await mount(waiting, win);
  const count = waiting.calls.filter((c) => c.path === "social/status").length;
  await listeners.get("focus")();
  await flush();
  assert.equal(waiting.calls.filter((c) => c.path === "social/status").length, count + 1);
}));

test("a view that left the page stops polling on the next focus, even if destroy was never called", withDom(async () => {
  const listeners = new Map();
  const win = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  const api = server({ connections: [connection()] });
  const { view } = await mount(api, win);
  Object.defineProperty(view.element, "isConnected", { value: false });
  const before = api.calls.length;
  await listeners.get("focus")();
  await flush();
  assert.equal(api.calls.length, before, "no social request once the view is detached");
  assert.equal(listeners.has("focus"), false);
}));
