// The first run's screens and rules (#557, #559), without a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { installDom } from "../qr-test-dom.mjs";

installDom();
Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { origin: "https://kin.test", pathname: "/" } });
const { firstRunProblems, PASSWORD_TRADE_OFF, SecurityFirstRun } = await import("./first-run.js");
const { freshConfirmation } = await import("../household/fresh-confirmation.js");
const { PASSWORD_ITERATIONS } = await import("../../security/account-vault.js");

function panel() {
  const host = document.createElement("section");
  host.heading = document.createElement("h2");
  host.alert = document.createElement("p");
  host.message = document.createElement("p");
  host.text = (value) => { const element = document.createElement("p"); element.textContent = value; host.append(element); return element; };
  host.button = (label, action, className = "") => {
    const element = document.createElement("button");
    element.textContent = label;
    element.className = className;
    element.addEventListener("click", action);
    host.append(element);
    return element;
  };
  const ctx = { host };
  const firstRun = new SecurityFirstRun(ctx);
  host.render = () => { host.replaceChildren(); firstRun.render(); };
  host.render();
  return { host, firstRun };
}

const inputs = (host) => [...host.all()].filter((node) => node.tagName === "INPUT");

test("three screens: welcome, about you, then sign in", () => {
  const { host, firstRun } = panel();
  assert.equal(host.dataset.firstRunStep, "welcome");
  assert.equal(host.heading.textContent, "Welcome to Kin");
  assert.ok(host.byText("Start a new household"));
  assert.ok(host.byText("I have an invitation"));
  assert.ok(host.byText("Set up with a passkey instead"), "the earlier setup stays one tap away");
  assert.equal(inputs(host).length, 0, "nothing to type, and no keys, on the first screen");

  host.byText("Start a new household").click();
  assert.equal(host.dataset.firstRunStep, "about");
  assert.deepEqual(inputs(host).map((input) => [input.name, input.autocomplete]), [["name", "name"], ["household", "off"]]);

  firstRun.go("account");
  assert.equal(host.dataset.firstRunStep, "account");
  const fields = inputs(host);
  assert.deepEqual(fields.map((input) => [input.name, input.type, input.autocomplete]),
    [["username", "text", "username"], ["password", "password", "new-password"]], "password managers see a new account");
  assert.ok(host.textContent.includes(PASSWORD_TRADE_OFF), "the trade-off is said where the password is chosen");
  assert.ok(!/backup key|recovery key|[a-f0-9]{64}/i.test(host.textContent), "no keys or security choices up front");
  assert.ok(host.byText("Create household"));
});

test("joining asks for the invitation code instead of a household name", () => {
  const { host } = panel();
  host.byText("I have an invitation").click();
  assert.equal(host.heading.textContent, "Join your household");
  assert.deepEqual(inputs(host).map((input) => [input.name, input.autocomplete]), [["name", "name"], ["code", "one-time-code"]]);
});

test("each screen's answers are checked in plain words, and what was typed survives a re-render", () => {
  assert.deepEqual(firstRunProblems("about", "create", { name: " ", household: "" }), { name: "Enter your name." });
  assert.deepEqual(firstRunProblems("about", "create", { name: "Sam", household: "" }), {}, "the household name is optional");
  assert.match(firstRunProblems("about", "create", { name: "x".repeat(33) }).name, /at most 32/);
  assert.match(firstRunProblems("about", "create", { name: "You" }).name, /other than/);
  assert.match(firstRunProblems("about", "join", { name: "Sam", code: "F7KM" }).code, /8-character/);
  assert.deepEqual(firstRunProblems("about", "join", { name: "Sam", code: "f7km-q2dx" }), {});
  assert.match(firstRunProblems("account", "create", { username: "s", password: "four unrelated words" }).username, /3 to 32/);
  assert.match(firstRunProblems("account", "create", { username: "sam", password: "short" }).password, /at least 10/);
  assert.match(firstRunProblems("account", "create", { username: "sam", password: "1234567890" }).password, /too easy/);
  assert.deepEqual(firstRunProblems("account", "create", { username: "Sam", password: "four unrelated words" }), {});

  const { host, firstRun } = panel();
  firstRun.go("account", "create");
  const [username, password] = inputs(host);
  username.value = "sam";
  username.dispatchEvent({ type: "input" });
  password.value = "short";
  password.dispatchEvent({ type: "input" });
  firstRun.showProblems(firstRunProblems("account", "create", firstRun.state.draft));
  const [againName, againPassword] = inputs(host);
  assert.equal(againName.value, "sam");
  assert.equal(againPassword.value, "short", "a refused form isn't emptied");
  assert.equal(againPassword.getAttribute("aria-invalid"), "true");
  assert.match(againPassword.getAttribute("aria-describedby"), /first-run-password-error/);
  assert.equal(host.byClass("field-error").textContent, "Use at least 10 characters. A few unrelated words works well.");
});

test("an invitation link opens on joining with its code filled in", async () => {
  globalThis.location.pathname = "/pair";
  const { captureInvitationCode } = await import("../../pairing-link.js");
  captureInvitationCode({ pathname: "/pair", hash: "#code=F7KM-Q2DX", search: "" }, { replaceState() {} });
  try {
    const { host } = panel();
    assert.equal(host.dataset.firstRunStep, "about");
    assert.equal(inputs(host).find((input) => input.name === "code").value, "F7KM-Q2DX");
  } finally {
    globalThis.location.pathname = "/";
  }
});

test("a fresh confirmation uses the passkey when there is one, and the password otherwise", async () => {
  const asked = [];
  const salt = "AwMDAwMDAwMDAwMDAwMDAw";
  const viaPassword = await freshConfirmation({ flow: "f", password: { username: "sam", salt, iterations: PASSWORD_ITERATIONS } },
    { askPassword: async (params) => { asked.push(params.username); return "four unrelated words"; } });
  assert.deepEqual(asked, ["sam"]);
  assert.match(viaPassword.authKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.keys(viaPassword).join(), "authKey", "nothing but authKey is sent");

  const credentials = Object.getOwnPropertyDescriptor(globalThis.navigator, "credentials");
  const fakeCredential = { id: "cred", type: "public-key", response: { clientDataJSON: new Uint8Array([1]), authenticatorData: new Uint8Array([2]), signature: new Uint8Array([3]), userHandle: null } };
  Object.defineProperty(globalThis.navigator, "credentials", { configurable: true, value: { get: async () => fakeCredential } });
  try {
    const viaPasskey = await freshConfirmation({ flow: "f", publicKey: { challenge: "AA", allowCredentials: [{ id: "AA", type: "public-key" }] } },
      { askPassword: async () => { throw new Error("must not ask for a password"); } });
    assert.equal(viaPasskey.credential.id, "cred");
    assert.equal(viaPasskey.authKey, undefined);
  } finally {
    if (credentials) Object.defineProperty(globalThis.navigator, "credentials", credentials);
    else delete globalThis.navigator.credentials;
  }
});
