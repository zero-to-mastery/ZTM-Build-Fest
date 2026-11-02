// Invite by QR (#97): the invitation screen shows a QR code only while the
// invitation waits, ended invitations say so, and a scanned invitation fills
// the join field. Without a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { installDom } from "../qr-test-dom.mjs";

const defined = installDom();
Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://kin.test", pathname: "/" } });
const { HouseholdViews } = await import("./views.js");
assert.ok(defined["kin-qr"] && defined["kin-qr-scanner"], "the views load both QR components");

function memberHost(pairing) {
  const host = document.createElement("div");
  Object.assign(host, {
    pairing,
    syncStatus: { memberKind: "adult", enabled: true },
    localFingerprint: "ab".repeat(32),
    text(content) { const p = document.createElement("p"); p.textContent = content; host.append(p); },
    message(content) { const p = document.createElement("p"); p.className = "household-message"; p.textContent = content; host.append(p); },
    button(label) { host.append(host.makeButton(label)); },
    makeButton(label, action) { const b = document.createElement("button"); b.textContent = label; b.addEventListener("click", () => action?.()); return b; },
    showFingerprint() {},
    setControlDisabled() {},
  });
  const ctx = { host, pairing: { updateCountdown() {}, pollPairing() {} }, api: {} };
  return { host, views: new HouseholdViews(ctx) };
}

const qrIn = (element) => element.find((node) => node.tagName === "KIN-QR" || node.constructor === defined["kin-qr"]);
const stateText = (element) => element.byClass("pairing-state")?.textContent;

test("a waiting invitation shows a QR code for its fragment link beside the code", () => {
  const expiresAt = Date.now() + 600_000;
  const { host, views } = memberHost({ state: "Pending", code: "F7KM-Q2DX", expiresAt, pairingId: "p1", version: 1 });
  views.renderMember();
  clearInterval(host.timer);
  const qr = qrIn(host);
  assert.ok(qr, "the QR is shown");
  assert.equal(qr.value, "https://kin.test/pair#code=F7KM-Q2DX", "the code rides in the fragment");
  assert.equal(qr.value.includes("?"), false, "never in the query");
  assert.equal(qr.expiresAt, expiresAt, "it expires with the invitation");
  assert.equal(qr.expiredMessage, "This invitation ended.");
  assert.equal(qr.code, "", "the screen's own code and Copy stay the text path");
  assert.equal(host.byClass("pairing-code").textContent, "F7KM-Q2DX");
  for (const label of ["Copy code", "Share invitation", "Revoke"]) assert.ok(host.byText(label), `${label} stays`);
});

test("a claimed invitation shows no QR: the code has been used", () => {
  const { host, views } = memberHost({ state: "Claimed", code: "F7KM-Q2DX", expiresAt: Date.now() + 600_000, syncKeyFingerprint: "cd".repeat(32), pairingId: "p1", version: 2 });
  views.renderMember();
  clearInterval(host.timer);
  assert.equal(qrIn(host), null);
});

for (const [state, wording] of [
  ["Expired", "This invitation ended: it expired."],
  ["Revoked", "This invitation ended: it was revoked."],
]) {
  test(`a ${state.toLowerCase()} invitation is replaced by "This invitation ended", never a stale code`, () => {
    const { host, views } = memberHost({ state, code: "F7KM-Q2DX", expiresAt: Date.now() - 1, pairingId: "p1", version: 3 });
    views.renderMember();
    clearInterval(host.timer);
    assert.equal(stateText(host), wording);
    assert.equal(qrIn(host), null);
    assert.equal(host.byClass("pairing-code"), null, "no code is offered either");
  });
}

function scanRig() {
  const { views } = memberHost(null);
  const area = document.createElement("div");
  const trigger = document.createElement("button");
  const field = document.createElement("input");
  field.value = "";
  const status = document.createElement("p");
  area.append(trigger, status);
  views.openInvitationScanner(area, trigger, field, status);
  const scanner = area.children.find((node) => node.constructor === defined["kin-qr-scanner"]);
  return { area, trigger, field, status, scanner };
}

test("a scanned invitation fills the code field and closes the scanner", () => {
  const r = scanRig();
  assert.ok(r.scanner, "the scanner opens in place of the button");
  assert.equal(r.trigger.hidden, true);
  r.scanner.dispatchEvent(new CustomEvent("kin-qr-scan", { detail: { url: "https://kin.test/pair#code=F7KM-Q2DX" } }));
  assert.equal(r.field.value, "F7KM-Q2DX", "the code is filled in; the person still continues");
  assert.equal(r.status.textContent, "Code filled in from the invitation. Check it, then continue.");
  assert.equal(r.area.children.includes(r.scanner), false, "the scanner closes");
  assert.equal(r.trigger.hidden, false);
  assert.equal(document.activeElement, r.field);
});

test("a Kin code that isn't an invitation leaves the field alone", () => {
  const r = scanRig();
  r.scanner.dispatchEvent(new CustomEvent("kin-qr-scan", { detail: { url: "https://kin.test/link#r=1&s=2&f=3" } }));
  assert.equal(r.field.value, "");
  assert.match(r.status.textContent, /isn't an invitation/);
});

test("typing the code instead closes the scanner and returns to the field", () => {
  const r = scanRig();
  r.scanner.dispatchEvent(new CustomEvent("kin-qr-manual"));
  assert.equal(r.area.children.includes(r.scanner), false);
  assert.equal(document.activeElement, r.field);
});

test("a pending invitation past its expiry shows as ended before the next poll", () => {
  const { host, views } = memberHost({ state: "Pending", code: "F7KM-Q2DX", expiresAt: Date.now() - 1000, pairingId: "p1", version: 1 });
  views.renderMember();
  clearInterval(host.timer);
  assert.equal(stateText(host), "This invitation ended: it expired.");
  assert.equal(qrIn(host), null);
  assert.equal(host.byClass("pairing-code"), null);
  assert.equal(host.byText("Copy code"), null);
  assert.equal(host.byText("Share invitation"), null);
});

test("a device that is already a member drops a captured invitation code and says so", () => {
  globalThis.window = { PublicKeyCredential: function PublicKeyCredential() {} };
  const { host, views } = memberHost(null);
  host.identity = { memberId: "m1", deviceId: "d1" };
  host.prefilledCode = "F7KM-Q2DX";
  host.renderMember = () => views.renderMember();
  views.render();
  assert.equal(host.prefilledCode, "", "the code is not kept");
  assert.ok(host.find((node) => node.className === "household-message" && /already in a household/.test(node.textContent)));
});
