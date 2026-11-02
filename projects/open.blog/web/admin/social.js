// <ob-social-accounts>: the Connected accounts screen of optional social publishing (ADR 0301).
// An author connects LinkedIn or Facebook, reviews the permissions asked for, chooses where posts
// may go, and reconnects or disconnects an account. Everything here is a request to the Admin
// server, which holds the key to the hosted function: this page never sees a token, a client
// secret or a database, and it shows only what the server rebuilt for it.
//
// Status is spoken as words plus a symbol (never colour alone), every control is a native button,
// link, fieldset or radio, focus goes somewhere sensible after each change, and the layout is one
// column that wraps long ids, so it does not depend on any font's width.

import { el } from "./block-forms.js";

let uid = 0;

/** Only these two hosts may be the target of "Continue to the provider"; the server checks too. */
export const AUTHORIZE_HOSTS = Object.freeze(["www.linkedin.com", "www.facebook.com"]);

export function safeAuthorizeUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password && !url.port && AUTHORIZE_HOSTS.includes(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

export const SCOPE_WORDS = Object.freeze({
  openid: "Know who you are (sign in)",
  profile: "Read your name",
  w_member_social: "Post as you",
  r_organization_admin: "See the organizations you administer",
  w_organization_social: "Post as an organization",
  pages_show_list: "See the Pages you manage",
  pages_manage_posts: "Create posts on your Pages",
  pages_read_engagement: "Read basic Page details (optional)",
});

export const HEALTH = Object.freeze({
  ok: { symbol: "✓", text: "Connected" },
  expiring: { symbol: "!", text: "Expiring soon" },
  "needs-reauth": { symbol: "!", text: "Needs reconnecting" },
  disconnected: { symbol: "–", text: "Disconnected" },
});

const KIND_WORDS = Object.freeze({ member: "Member", organization: "Organization", page: "Page" });

export const OFF_TEXT = Object.freeze({
  off: "Social publishing is not set up. It is optional and off by default; your blog, exports and cross-posting work the same without it. To turn it on, follow docs/social-publishing.md, then set OPENBLOG_SOCIAL_ENDPOINT and OPENBLOG_SOCIAL_ADMIN_KEY where Admin runs.",
  invalid: "Admin's social settings are not valid, so the feature stays off. Fix these settings, then reload:",
  unavailable: "Admin reached the social function, but it says social publishing is not enabled there. Set OPENBLOG_SOCIAL_ENABLED=true in its environment.",
});

const day = (stamp) => (stamp ? String(stamp).slice(0, 10) : "");
const providerName = (provider) => (provider === "linkedin" ? "LinkedIn" : provider === "facebook" ? "Facebook" : "Provider");
const errorText = (error) => String(error?.message || "That did not work. Try again.");

const badge = (health) => {
  const info = HEALTH[health] || HEALTH["needs-reauth"];
  return el("span", { class: `oba-social-badge oba-social-badge-${HEALTH[health] ? health : "needs-reauth"}`, "data-health": health }, el("span", { "aria-hidden": "true" }, `${info.symbol} `), info.text);
};

const scopeList = (scopes, required = null) =>
  el(
    "ul",
    { class: "oba-social-scopes" },
    scopes.map((scope) => el("li", {}, SCOPE_WORDS[scope] || "Permission", " ", el("code", {}, scope), required && !required.includes(scope) ? " (optional)" : null)),
  );

/** Returns `{ element, load, isDirty, isBusy, destroy }`. */
export function createSocialAccounts({ api, win = globalThis.window }) {
  const root = el("ob-social-accounts", { class: "oba-social", "data-social-accounts": "true" });
  const ids = `oba-social-${++uid}`;
  let generation = 0;
  let busy = false;
  let state = null;
  let focusTarget = null;
  let confirming = null;
  // The provider address of an attempt started in this page. The server never returns it again, so a
  // reload loses it and the author starts the attempt again.
  const links = new Map();

  const status = el("p", { class: "oba-small oba-social-status", role: "status", "aria-live": "polite", "data-social-status": "true", tabindex: "-1" });
  const say = (text, error = false) => {
    status.className = `oba-small oba-social-status${error ? " oba-error" : ""}`;
    status.setAttribute("role", error ? "alert" : "status");
    status.textContent = text;
  };

  async function load() {
    const mine = ++generation;
    root.replaceChildren(el("h2", { id: `${ids}-title`, tabindex: "-1" }, "Social accounts"), el("p", { class: "oba-small", role: "status", "data-social-loading": "true" }, "Loading connected accounts…"));
    try {
      const overview = await api.call("GET", "social/status");
      let accounts = [];
      let connections = [];
      if (overview.enabled) {
        [accounts, connections] = await Promise.all([api.call("GET", "social/accounts").then((r) => r.accounts || []), api.call("GET", "social/connections").then((r) => r.connections || [])]);
      }
      if (mine !== generation) return;
      state = { overview, accounts, connections };
    } catch (error) {
      if (mine !== generation) return;
      state = null;
      root.replaceChildren(
        el("h2", { id: `${ids}-title`, tabindex: "-1" }, "Social accounts"),
        el("p", { class: "oba-error", role: "alert", "data-social-error": "true" }, errorText(error)),
        el("button", { class: "oba-btn", type: "button", "data-action": "social-retry", onClick: () => load() }, "Try again"),
      );
      return;
    }
    render();
  }

  /** Runs one request with the controls locked, then draws the page again. */
  async function act(label, run, after) {
    if (busy) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    for (const control of root.querySelectorAll?.("button") || []) control.disabled = true;
    say(label);
    try {
      const result = await run();
      busy = false;
      root.removeAttribute("aria-busy");
      await after(result);
    } catch (error) {
      busy = false;
      root.removeAttribute("aria-busy");
      render();
      say(errorText(error), true);
    }
  }

  function connect(provider, label) {
    return act(`Starting the ${label} connection…`, () => api.call("POST", "social/connections", { json: { provider } }), async (reply) => {
      links.set(reply.connection?.id, reply.authorizeUrl);
      await load();
      focusTarget = "continue";
      render();
      say(`Continue to ${label} to approve access. Nothing is connected until you choose where to post.`);
    });
  }

  function reconnect(account) {
    return act(`Starting reconnection of ${account.displayName}…`, () => api.call("POST", `social/accounts/${account.id}/reconnect`, { json: {} }), async (reply) => {
      links.set(reply.connection?.id, reply.authorizeUrl);
      await load();
      focusTarget = "continue";
      render();
      say(`Continue to ${providerName(account.provider)} and sign in as the same account to reconnect ${account.displayName}.`);
    });
  }

  function disconnect(account) {
    return act(`Disconnecting ${account.displayName}…`, () => api.call("POST", `social/accounts/${account.id}/disconnect`, { json: {} }), async () => {
      confirming = null;
      await load();
      focusTarget = "accounts";
      render();
      say(`${account.displayName} is disconnected. Its stored tokens were erased.`);
    });
  }

  function cancel(connection) {
    return act("Canceling…", () => api.call("POST", `social/connections/${connection.id}/cancel`, { json: {} }), async () => {
      await load();
      focusTarget = "providers";
      render();
      say("The connection attempt was canceled.");
    });
  }

  function choose(connection, destination) {
    return act(`Connecting ${destination.name}…`, () => api.call("POST", `social/connections/${connection.id}/select`, { json: { destination: destination.id } }), async (reply) => {
      await load();
      focusTarget = "accounts";
      render();
      say(`${reply.account?.displayName || destination.name} is connected.`);
    });
  }

  // ---- pieces of the page

  function providerCard(provider) {
    const open = (state.connections || []).some((c) => c.provider === provider.provider && ["pending", "exchanging"].includes(c.status));
    const button = el("button", { class: "oba-btn oba-btn-primary", type: "button", "data-action": "social-connect", "data-provider": provider.provider, "aria-describedby": `${ids}-${provider.provider}-hint`, onClick: () => connect(provider.provider, provider.label) }, `Connect ${provider.label}`);
    return el(
      "li",
      { class: "oba-social-provider", "data-provider": provider.provider },
      el("h4", {}, provider.label),
      el("p", { class: "oba-small", id: `${ids}-${provider.provider}-hint` }, open ? "An attempt is already waiting below." : "You will sign in at the provider and approve access; nothing is connected until you choose where to post."),
      el(
        "details",
        { class: "oba-social-review" },
        el("summary", {}, `Review the permissions ${provider.label} will be asked for`),
        scopeList(provider.scopes, provider.requiredScopes),
        el("p", { class: "oba-small" }, "Redirect address to register in the provider's app, exactly:"),
        el("p", { class: "oba-small oba-social-wrap" }, el("code", { "data-social-redirect": provider.provider }, provider.redirectUri)),
        el("p", { class: "oba-small" }, `API version ${provider.version}. Verify it is still current when you set up.`),
      ),
      button,
    );
  }

  function waitingPanel(connection) {
    const label = providerName(connection.provider);
    // The link is built only if the server's address is one of the two providers' own hosts.
    const link = safeAuthorizeUrl(links.get(connection.id));
    return el(
      "li",
      { class: "oba-social-pending", "data-connection": connection.id },
      el("h4", {}, connection.reauthAccountId ? `Reconnecting ${label}` : `Waiting for ${label}`),
      el("p", {}, `Approve access in the ${label} tab, then come back here. This attempt expires at ${connection.expiresAt ? String(connection.expiresAt).slice(11, 16) + " UTC" : "soon"} and works once.`),
      link
        ? el("p", {}, el("a", { class: "oba-btn oba-btn-primary", href: link, target: "_blank", rel: "noopener noreferrer", "data-action": "social-continue" }, `Continue to ${label} (opens a new tab)`))
        : el("p", { class: "oba-small", "data-social-no-link": "true" }, "The link to the provider is not kept after the page is reloaded. Cancel this attempt and start again."),
      el(
        "div",
        { class: "oba-landing-actions" },
        el("button", { class: "oba-btn", type: "button", "data-action": "social-check", onClick: () => load().then(() => say("Checked for the latest result.")) }, "I have finished, check now"),
        el("button", { class: "oba-btn", type: "button", "data-action": "social-cancel", onClick: () => cancel(connection) }, "Cancel this attempt"),
      ),
    );
  }

  function choosePanel(connection) {
    const label = providerName(connection.provider);
    const group = `${ids}-choice-${connection.id}`;
    const radios = connection.destinations.map((destination, index) => {
      const id = `${group}-${index}`;
      const input = el("input", { type: "radio", name: group, id, value: destination.id, disabled: !destination.eligible, "aria-describedby": destination.eligible ? null : `${id}-why`, "data-destination": destination.id });
      return el(
        "li",
        { class: "oba-social-destination", "data-eligible": String(destination.eligible) },
        input,
        el("label", { for: id }, el("strong", {}, destination.name), " ", el("span", { class: "oba-small" }, `${KIND_WORDS[destination.kind] || "Destination"}`)),
        destination.eligible ? null : el("p", { class: "oba-small oba-social-why", id: `${id}-why` }, "Not available: ", destination.reasonText || reasonText(destination.reason)),
      );
    });
    const submit = el("button", { class: "oba-btn oba-btn-primary", type: "submit", "data-action": "social-choose" }, "Connect this destination");
    const problem = el("p", { class: "oba-small oba-error", role: "alert", hidden: true });
    const form = el(
      "form",
      {
        class: "oba-social-choice",
        onSubmit: (event) => {
          event.preventDefault();
          const picked = Array.from(form.querySelectorAll("input")).find((input) => input.checked);
          const destination = picked && connection.destinations.find((d) => d.id === picked.value);
          if (!destination) {
            problem.hidden = false;
            problem.textContent = "Choose where posts may go first.";
            return;
          }
          problem.hidden = true;
          choose(connection, destination);
        },
      },
      el("fieldset", {}, el("legend", {}, `Choose where ${label} posts may go`), el("ul", { class: "oba-social-destinations" }, radios)),
      problem,
      el("div", { class: "oba-landing-actions" }, submit, el("button", { class: "oba-btn", type: "button", "data-action": "social-cancel", onClick: () => cancel(connection) }, "Cancel")),
    );
    return el(
      "li",
      { class: "oba-social-pending", "data-connection": connection.id, "data-status": "authorized" },
      el("h4", { tabindex: "-1", "data-social-choose-title": "true" }, `${label} approved. Choose a destination.`),
      el("p", { class: "oba-small" }, "Permissions actually granted:"),
      scopeList(connection.grantedScopes),
      connection.notes.length ? el("ul", { class: "oba-social-notes" }, connection.notes.map((note) => el("li", { class: "oba-small", "data-note": note.code }, note.text))) : null,
      form,
    );
  }

  const REASONS = {
    "missing-scope": "A permission needed to post here was not granted.",
    "not-administrator": "LinkedIn did not list you as an administrator of this organization.",
    "no-posting-role": "Your role on this Page does not let you create posts.",
    "role-unverified": "Facebook did not say what you may do on this Page, so it cannot be offered.",
    "no-page-token": "Facebook gave no access for this Page.",
  };
  const reasonText = (reason) => REASONS[reason] || "It cannot be used.";

  function failedPanel(connection) {
    return el(
      "li",
      { class: "oba-social-failed", "data-connection": connection.id, "data-status": connection.status },
      el("p", { role: "group", "aria-label": `${providerName(connection.provider)} attempt` }, el("strong", {}, `${providerName(connection.provider)}: `), connection.message || "The attempt did not finish."),
      connection.destinations.length
        ? el("ul", { class: "oba-small" }, connection.destinations.map((d) => el("li", {}, `${d.name}: ${d.eligible ? "available" : reasonText(d.reason)}`)))
        : null,
    );
  }

  function accountCard(account) {
    const reauth = account.health === "needs-reauth" || account.health === "expiring";
    const heading = `${ids}-account-${account.id}`;
    const facts = [
      ["Provider", `${providerName(account.provider)} · ${KIND_WORDS[account.kind] || account.kind}`],
      ["Provider id", el("span", { class: "oba-social-wrap" }, account.externalId)],
      ["Connected by", account.connectedBy ? `${account.connectedBy}, ${day(account.createdAt)}` : day(account.createdAt)],
      account.credential?.accessExpiresAt ? ["Access valid until", day(account.credential.accessExpiresAt)] : null,
      account.credential?.refreshExpiresAt ? ["Can renew until", day(account.credential.refreshExpiresAt)] : null,
      account.disconnectedAt ? ["Disconnected", day(account.disconnectedAt)] : null,
    ].filter(Boolean);
    const actions = [];
    if (account.status !== "disconnected") {
      actions.push(el("button", { class: `oba-btn${reauth ? " oba-btn-primary" : ""}`, type: "button", "data-action": "social-reconnect", "aria-label": `Reconnect ${account.displayName}`, onClick: () => reconnect(account) }, "Reconnect"));
      actions.push(el("button", { class: "oba-btn", type: "button", "data-action": "social-disconnect", "aria-label": `Disconnect ${account.displayName}`, "aria-expanded": String(confirming === account.id), onClick: () => { confirming = confirming === account.id ? null : account.id; focusTarget = confirming ? `confirm-${account.id}` : null; render(); } }, "Disconnect…"));
    }
    const confirm = confirming === account.id
      ? el(
          "div",
          { class: "oba-notice oba-social-confirm", role: "group", "aria-label": `Confirm disconnecting ${account.displayName}`, "data-social-confirm": account.id },
          el("p", { tabindex: "-1", "data-confirm-text": account.id }, `Disconnect ${account.displayName}? Its stored tokens are erased and posts cannot be sent to it until you connect it again. The account stays in your history.`),
          el(
            "div",
            { class: "oba-landing-actions" },
            el("button", { class: "oba-btn oba-btn-danger", type: "button", "data-action": "social-disconnect-confirm", onClick: () => disconnect(account) }, `Disconnect ${account.displayName}`),
            el("button", { class: "oba-btn", type: "button", "data-action": "social-disconnect-cancel", onClick: () => { confirming = null; focusTarget = null; render(); } }, "Keep it connected"),
          ),
        )
      : null;
    return el(
      "li",
      { class: "oba-social-account", "data-account": account.id, "data-health": account.health, "aria-labelledby": heading },
      el("div", { class: "oba-social-account-head" }, el("h4", { id: heading }, account.displayName), badge(account.health)),
      account.health === "needs-reauth" && account.status !== "disconnected" ? el("p", { class: "oba-notice", "data-social-reauth": "true" }, "Access to this account ran out or was withdrawn. Reconnect it, signing in as the same account, so posts can be sent again.") : null,
      account.health === "expiring" ? el("p", { class: "oba-notice", "data-social-reauth": "true" }, "Access to this account runs out soon. Reconnect it before then.") : null,
      el("dl", { class: "oba-social-facts" }, facts.map(([name, value]) => el("div", {}, el("dt", {}, name), el("dd", {}, value)))),
      account.credential?.scopes?.length
        ? el("details", { class: "oba-social-review" }, el("summary", {}, "Permissions granted"), scopeList(account.credential.scopes))
        : null,
      el("div", { class: "oba-landing-actions" }, actions),
      confirm,
    );
  }

  function render() {
    const { overview, accounts, connections } = state;
    const children = [el("h2", { id: `${ids}-title`, tabindex: "-1" }, "Social accounts")];
    children.push(el("p", {}, "Connect LinkedIn or Facebook so a published post can be announced there. Your blog works the same without this. Access tokens stay on the server and are never shown here."));
    children.push(status);
    if (!overview.enabled) {
      children.push(el("p", { class: "oba-notice", "data-social-off": overview.state }, overview.message || OFF_TEXT[overview.state] || OFF_TEXT.off));
      if (overview.problems?.length) children.push(el("ul", {}, overview.problems.map((name) => el("li", {}, el("code", {}, name)))));
      root.replaceChildren(...children);
      return;
    }
    const providers = overview.providers || [];
    children.push(el("h3", { id: `${ids}-providers`, tabindex: "-1" }, "Connect an account"));
    children.push(
      providers.length
        ? el("ul", { class: "oba-social-providers", "aria-labelledby": `${ids}-providers` }, providers.map(providerCard))
        : el("p", { class: "oba-notice", "data-social-no-providers": "true" }, "No provider is set up on the server yet. Add a LinkedIn or Facebook app's client id and secret (see docs/social-publishing.md)."),
    );
    if (overview.problems?.length) {
      children.push(el("p", { class: "oba-small" }, "These provider settings are not valid and were skipped:"));
      children.push(el("ul", { class: "oba-small" }, overview.problems.map((name) => el("li", {}, el("code", {}, name)))));
    }
    const live = connections.filter((c) => ["pending", "exchanging", "authorized"].includes(c.status) && Date.parse(c.expiresAt || 0) > Date.now());
    const waiting = live.filter((c) => c.status !== "authorized" || c.reauthAccountId);
    const choosing = live.filter((c) => c.status === "authorized" && !c.reauthAccountId);
    const failed = connections.filter((c) => c.status === "failed").slice(0, 2);
    if (waiting.length || choosing.length || failed.length) {
      children.push(el("h3", { id: `${ids}-attempts`, tabindex: "-1" }, "Connections in progress"));
      children.push(el("ul", { class: "oba-social-attempts", "aria-labelledby": `${ids}-attempts` }, [...choosing.map(choosePanel), ...waiting.map(waitingPanel), ...failed.map(failedPanel)]));
    }
    children.push(el("h3", { id: `${ids}-accounts`, tabindex: "-1" }, "Connected accounts"));
    children.push(
      accounts.length
        ? el("ul", { class: "oba-social-accounts", "aria-labelledby": `${ids}-accounts` }, accounts.map(accountCard))
        : el("p", { class: "oba-small", "data-social-empty": "true" }, "No account is connected yet."),
    );
    root.replaceChildren(...children);
    placeFocus();
  }

  function placeFocus() {
    const target = focusTarget;
    focusTarget = null;
    if (!target) return;
    const within = (tag, test) => Array.from(root.querySelectorAll(tag)).find(test);
    let node = null;
    if (target === "continue") node = within("a", (a) => a.dataset.action === "social-continue") || within("h4", () => true);
    else if (target === "accounts" || target === "providers") node = within("h3", (h) => h.id === `${ids}-${target}`);
    else if (target.startsWith("confirm-")) node = within("p", (p) => p.dataset.confirmText === target.slice(8));
    (node || root.querySelector("h2"))?.focus?.();
  }

  // A tab the author comes back from: look again, but only while an attempt is waiting.
  const onFocus = () => {
    // Detached from the page (the author went elsewhere): stop listening instead of polling.
    if (root.isConnected === false) {
      win?.removeEventListener?.("focus", onFocus);
      return;
    }
    if (!busy && state?.connections?.some((c) => ["pending", "exchanging"].includes(c.status))) load();
  };
  win?.addEventListener?.("focus", onFocus);

  return {
    element: root,
    load,
    isDirty: () => false,
    isBusy: () => busy,
    destroy: () => win?.removeEventListener?.("focus", onFocus),
  };
}
