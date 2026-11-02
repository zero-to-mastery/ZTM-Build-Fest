// Usability regression for the first-run member/device decision (#264).
// This checks real rendered Custom Element content; no browser framework.
import assert from "node:assert/strict";
import test from "node:test";
import { installDom } from "../qr-test-dom.mjs";

installDom();
Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://kin.test", pathname: "/" } });
const { HouseholdViews } = await import("./views.js");

function setup() {
  const host = document.createElement("div");
  const intents = [];
  host.intent = null;
  host.claim = null;
  host.text = (text) => {
    const el = document.createElement("p");
    el.textContent = text;
    host.append(el);
    return el;
  };
  host.makeButton = (label, action) => {
    const el = document.createElement("button");
    el.textContent = label;
    el.addEventListener("click", action);
    return el;
  };
  host.button = (label, action) => host.append(host.makeButton(label, action));
  host.startIntent = (intent) => intents.push(intent);
  host.login = () => intents.push("login");
  new HouseholdViews({ host }).renderSetup();
  return { host, intents };
}

test("first-run choices explain distinct membership and device paths", () => {
  const { host, intents } = setup();
  const choices = [
    ["Start a new household", "create"],
    ["Join my household", "join"],
    ["Sign in using my phone", "phone"],
    ["Add my device", "device"],
    ["Sign in with my passkey", "login"],
  ];
  for (const [label, intent] of choices) {
    const button = host.byText(label);
    assert.ok(button, `missing choice: ${label}`);
    button.dispatchEvent(new Event("click"));
    assert.equal(intents.at(-1), intent);
  }
  const copy = host.textContent;
  assert.match(copy, /nobody in your household has set up Kin yet/);
  assert.match(copy, /code and approval/);
  assert.match(copy, /without joining again/);
  assert.match(copy, /already belong to a household/);
});
