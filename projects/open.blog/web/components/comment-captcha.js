// Optional captcha for hosted comments (ADR 0322). The provider script is a
// single allowlisted origin, requested only when the reader first interacts
// with the comment form. Nothing here is secret: the site key arrives as an
// attribute and the server alone decides whether a token or pass is valid.

export const PROVIDER_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const LOAD_TIMEOUT_MS = 15000;
const PASS_SKEW_SECONDS = 5;

export const MESSAGES = {
  checking: "Checking that you are human…",
  ready: "Verified. You can submit your comment.",
  interactive: "Please complete the human check below, then submit your comment.",
  waiting: "Still checking that you are human. Your comment is kept; submit again in a moment.",
  retrying: "Your verification needed refreshing. Checking again; your comment is kept and will be sent automatically.",
  blocked: "The human check could not load. A browser extension or privacy setting may be blocking it. Your comment is kept. Choose Retry verification, or try again later.",
  error: "The human check did not work. Your comment is kept. Choose Retry verification.",
  expired: "The human check expired. Your comment is kept. Choose Retry verification.",
  disclosure: "To keep spam out, Cloudflare Turnstile checks that you are human when you start a comment. Cloudflare receives your IP address and basic browser details; nothing loads until you click into this form.",
};

let loading;
function loadProvider() {
  if (globalThis.turnstile) return Promise.resolve(globalThis.turnstile);
  if (!loading) loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PROVIDER_SCRIPT;
    script.async = true;
    const fail = () => {
      clearTimeout(timer);
      script.remove?.();
      loading = undefined;
      reject(new Error("blocked"));
    };
    const timer = setTimeout(fail, LOAD_TIMEOUT_MS);
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timer);
      if (globalThis.turnstile) resolve(globalThis.turnstile);
      else fail();
    };
    document.head.append(script);
  });
  return loading;
}

function element(tag, attributes = {}, text = "") {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text) node.textContent = text;
  return node;
}

export function commentCaptcha(host, { form, submit, status }, { now = () => Date.now(), storage = () => globalThis.sessionStorage, load = loadProvider } = {}) {
  const scope = host.getAttribute("captcha-scope") === "every-comment" ? "every-comment" : "session";
  const siteKey = host.getAttribute("captcha-site-key") || "";
  const endpoint = (host.getAttribute("endpoint") || "").replace(/\/$/, "");
  const key = `openblog.commentPass.v1:${endpoint}:${siteKey}`;
  let session = null;
  let token = "";
  let widget;
  let provider;
  let starting;
  let interactive = false;
  let destroyed = false;
  let announced = "";
  let failure = "error";
  let tokenListener = null;

  const disclosure = element("p", { class: "ob-comments-captcha-note", id: `ob-comments-captcha-note-${Math.random().toString(36).slice(2, 8)}` }, MESSAGES.disclosure);
  const container = element("div", { class: "ob-comments-captcha", role: "group", "aria-label": "Human check", "aria-describedby": disclosure.getAttribute("id"), tabindex: "-1" });
  container.hidden = true;
  const retry = element("button", { type: "button", class: "ob-comments-captcha-retry" }, "Retry verification");
  retry.hidden = true;

  const announce = (name) => {
    const text = MESSAGES[name];
    if (announced === name && status.textContent === text) return;
    announced = name;
    status.textContent = text;
  };
  const forget = () => {
    session = null;
    try { storage().removeItem(key); } catch { /* storage may be blocked */ }
  };
  const stored = () => {
    try {
      const value = JSON.parse(storage().getItem(key));
      return value && typeof value.pass === "string" && Number.isFinite(value.expiresAt) ? value : null;
    } catch { return null; }
  };
  const pass = () => {
    if (scope !== "session") return "";
    session = session || stored();
    if (!session) return "";
    if (session.expiresAt - PASS_SKEW_SECONDS <= now() / 1000) { forget(); return ""; }
    return session.pass;
  };
  const failed = (name) => {
    failure = name;
    token = "";
    interactive = false;
    container.hidden = true;
    retry.hidden = false;
    announce(name);
  };
  const discard = () => {
    if (widget !== undefined) {
      try { provider?.remove?.(widget); } catch { /* the provider may already be gone */ }
    }
    widget = undefined;
  };
  const start = async () => {
    if (destroyed || pass() || widget !== undefined || starting) return;
    announce("checking");
    retry.hidden = true;
    starting = load();
    try {
      provider = await starting;
      if (destroyed || pass()) return;
      widget = provider.render(container, {
        sitekey: siteKey,
        action: "comment",
        appearance: "interaction-only",
        callback: (value) => {
          token = value;
          retry.hidden = true;
          container.hidden = true;
          const moveFocus = interactive;
          interactive = false;
          announce("ready");
          if (moveFocus) submit.focus();
          tokenListener?.();
        },
        "before-interactive-callback": () => {
          interactive = true;
          container.hidden = false;
          announce("interactive");
          container.focus();
        },
        "after-interactive-callback": () => { container.hidden = true; },
        "error-callback": () => failed("error"),
        "expired-callback": () => failed("expired"),
        "timeout-callback": () => failed("expired"),
      });
    } catch {
      failed("blocked");
    } finally {
      starting = undefined;
    }
  };
  const begin = () => { void start(); };
  retry.addEventListener("click", () => {
    discard();
    token = "";
    submit.focus();
    begin();
  });
  form.addEventListener("focusin", begin);
  form.addEventListener("input", begin);

  return {
    nodes: [disclosure, container, retry],
    scope,
    // What a submit should send, or null when the reader still has to be checked.
    proof() {
      const current = pass();
      if (current) return { captchaPass: current };
      if (token) return { captchaToken: token };
      return null;
    },
    // Called when submit is pressed with no proof yet: explains why, and keeps the text.
    needed() {
      begin();
      if (!retry.hidden) announce(failure);
      else announce(interactive ? "interactive" : "waiting");
      if (interactive) container.focus();
    },
    // A token is single use: it is spent whether or not the comment was stored.
    spent() {
      token = "";
      if (widget === undefined) return;
      try { provider.reset(widget); } catch { discard(); begin(); }
    },
    accepted(result) {
      token = "";
      if (scope === "session" && result && typeof result.captchaPass === "string" && Number.isFinite(result.captchaPassExpiresAt)) {
        session = { pass: result.captchaPass, expiresAt: result.captchaPassExpiresAt };
        try { storage().setItem(key, JSON.stringify(session)); } catch { /* kept in memory for this page */ }
        discard();
      } else if (widget !== undefined) {
        try { provider?.reset?.(widget); } catch { discard(); }
      }
    },
    // The server did not accept the pass or token: drop it and run one fresh challenge.
    rejected() {
      forget();
      token = "";
      if (widget !== undefined) {
        try { provider.reset(widget); announce("checking"); } catch { discard(); begin(); }
      } else begin();
    },
    onToken(listener) { tokenListener = listener; },
    destroy() {
      destroyed = true;
      discard();
    },
  };
}
