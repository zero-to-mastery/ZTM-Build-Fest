// Signing in on a new device (#568): the "Which device is this?" list,
// without a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { FakeElement, installDom } from "../qr-test-dom.mjs";

installDom();
// The step focuses its checked choice afterwards; nothing here to focus.
FakeElement.prototype.querySelector ??= () => null;
Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { origin: "https://kin.test", pathname: "/" } });
const { SecuritySignIn } = await import("./sign-in.js");

function deviceStep(devices) {
  const host = document.createElement("section");
  host.heading = document.createElement("h2");
  host.message = document.createElement("p");
  host.text = (value) => { const element = document.createElement("p"); element.textContent = value; host.append(element); return element; };
  const signIn = new SecuritySignIn({ host });
  signIn.reset();
  Object.assign(signIn.state, { step: "device", view: { username: "sam.lee", devices, deviceLimit: { maximum: 16, active: devices.length } } });
  host.replaceChildren();
  signIn.render();
  return host;
}

/** Each choice: its value and the hint beside it. */
const choices = (host) => [...host.all()].filter((node) => node.className === "device-choice-option").map((label) => ({
  value: label.find((node) => node.tagName === "INPUT").value,
  hint: label.find((node) => node.className === "household-choice-hint")?.textContent ?? "",
}));

test("a device from the old address says so, and can still be the one this replaces (#780)", () => {
  const trustedAt = Date.UTC(2026, 0, 2);
  const added = ` added ${new Date(trustedAt).toLocaleDateString()}`;
  const host = deviceStep([
    { deviceId: "old-laptop", label: "Laptop", trustedAt, carriedOver: true },
    { deviceId: "phone", label: "Phone", trustedAt, carriedOver: false },
    // An older server says nothing about the old address.
    { deviceId: "tablet", label: "Tablet", trustedAt },
  ]);
  assert.equal(host.dataset.firstRunStep, "sign-in-device");
  assert.deepEqual(choices(host), [
    { value: "new", hint: "" },
    { value: "replace:old-laptop", hint: `${added} · From the old address` },
    { value: "replace:phone", hint: added },
    { value: "replace:tablet", hint: added },
  ]);
});
