// "Set up Kin for someone" (#613, #614): the admin's form checks, the
// one-page sheet and the plain-words invitation views. Without a browser
// (the browser regression, scripts/setup-for-someone-regression.mjs, walks
// the whole flow).
import assert from "node:assert/strict";
import test from "node:test";
import { installDom } from "../qr-test-dom.mjs";

const defined = installDom();
Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://kin.test", host: "kin.test", pathname: "/" } });
const { HouseholdPrepared, SETUP_DAYS, setupDate, setupProblems, sheetSteps } = await import("./prepared.js");

const KEY = "AbCdEfGhIjKlMnOpQrStUv";

function rig(pairing) {
  const host = document.createElement("div");
  Object.assign(host, {
    pairing,
    localFingerprint: "ab".repeat(32),
    identity: { memberId: "m1" },
    text(content) { const p = document.createElement("p"); p.textContent = content; host.append(p); return p; },
    message(content) { const p = document.createElement("p"); p.className = "household-message"; p.textContent = content; host.append(p); return p; },
    makeButton(label, action, className = "") { const b = document.createElement("button"); b.textContent = label; b.className = className; b.addEventListener("click", () => action?.()); return b; },
    showFingerprint(prompt, fingerprint) { const p = document.createElement("p"); p.className = "pairing-fingerprint"; p.textContent = `${prompt}: ${fingerprint}`; host.append(p); return p; },
    setControlDisabled(control, value) { control.disabled = Boolean(value); },
    render() {},
  });
  const ctx = { host, pairing: { pollPairing() {}, approve() {}, revoke() {} }, membership: { showDevices() {} } };
  const prepared = new HouseholdPrepared(ctx);
  return { host, prepared };
}

test("the form asks for a name, who they are, the helper's name and how long it lasts", () => {
  const now = Date.UTC(2026, 9, 21);
  const ok = { name: "Rose", kind: "adult", helper: "Mikey", note: "", days: 7, easyMode: true };
  assert.deepEqual(setupProblems(ok, now), {});
  assert.deepEqual(Object.keys(setupProblems({ ...ok, name: " ", helper: "" }, now)).sort(), ["helper", "name"]);
  assert.match(setupProblems({ ...ok, name: "You" }, now).name, /their own name/);
  assert.match(setupProblems({ ...ok, name: "R".repeat(33) }, now).name, /32/);
  assert.match(setupProblems({ ...ok, note: "n".repeat(201) }, now).note, /200/);
  assert.ok(setupProblems({ ...ok, kind: "owner" }, now).kind);
  assert.ok(setupProblems({ ...ok, kind: "temporary" }, now).memberEndsAt, "a babysitter's access needs an end");
  assert.deepEqual(setupProblems({ ...ok, kind: "temporary", memberEndsAt: now + 1000 }, now), {});
  assert.ok(setupProblems({ ...ok, days: 30 }, now).days);
  assert.deepEqual([...SETUP_DAYS], [1, 3, 7], "up to the service's 7 days");
});

test("the sheet's three steps are plain words and name the helper", () => {
  const steps = sheetSteps("Mikey");
  assert.equal(steps.length, 3);
  assert.match(steps[0], /camera/);
  assert.match(steps[1], /password/);
  assert.equal(steps[2], "Wait for Mikey to say yes. Then Kin opens, ready for you.");
  assert.match(sheetSteps("")[2], /the person who gave you this/);
  assert.match(setupDate(Date.UTC(2026, 9, 28, 12), "en-GB"), /Wednesday 28 October/);
});

test("the setup sheet shows a large QR for the link with its key, the code, the steps, who to call and when it ends", () => {
  const expiresAt = Date.UTC(2026, 9, 28, 12);
  const { host, prepared } = rig({ pairingId: "p1", prepared: true, state: "Pending", expiresAt, invitationExpiresAt: expiresAt, version: 1 });
  const link = `https://kin.test/pair#code=F7KM-Q2DX&k=${KEY}`;
  prepared.kept.set("p1", { code: "F7KM-Q2DX", key: KEY, link, fields: { name: "Rose", helper: "Mikey", note: "Call me after lunch" } });
  prepared.renderSheet("p1");
  const sheet = host.byClass("setup-sheet");
  assert.ok(sheet, "the sheet is on the page");
  assert.equal(sheet.byClass("setup-sheet-for").textContent, "For Rose, from Mikey");
  const qr = sheet.find((node) => node.constructor === defined["kin-qr"]);
  assert.equal(qr.value, link, "the QR carries the code and the card's key, in the fragment");
  assert.ok(qr.size >= 300, "a large QR");
  assert.equal(qr.code, "");
  assert.equal(sheet.byClass("setup-sheet-steps").children.length, 3);
  assert.match(sheet.byClass("setup-sheet-address").textContent, /pair#code=F7KM-Q2DX&k=/);
  assert.match(sheet.byClass("setup-sheet-code").textContent, /kin\.test\/pair.*F7KM-Q2DX/);
  assert.equal(sheet.byClass("setup-sheet-call").textContent, "If you get stuck, call Mikey.");
  assert.match(sheet.byClass("setup-sheet-note").textContent, /Call me after lunch/);
  assert.match(sheet.byClass("setup-sheet-ends").textContent, /works once, until .*28/);
  assert.ok(host.byText("Print") && host.byText("Back"), "Print and Back sit outside the sheet");
  assert.equal(sheet.byText("Print"), null, "the buttons aren't printed");
});

test("the invitation views say what's happening in plain words", () => {
  const expiresAt = Date.now() + 3 * 86_400_000;
  const pending = rig({ pairingId: "p1", prepared: true, state: "Pending", expiresAt, invitationExpiresAt: expiresAt, version: 1 });
  pending.prepared.kept.set("p1", { code: "F7KM-Q2DX", key: KEY, link: `https://kin.test/pair#code=F7KM-Q2DX&k=${KEY}`, fields: { name: "Rose", helper: "Mikey", note: "" } });
  pending.prepared.renderPairing();
  assert.equal(pending.host.byClass("pairing-path").textContent, "Rose's invitation is ready");
  for (const label of ["Print the setup sheet", "Share the link", "Cancel this invitation"]) assert.ok(pending.host.byText(label), label);

  const claimed = rig({ pairingId: "p1", prepared: true, state: "Claimed", expiresAt, syncKeyFingerprint: "cd".repeat(32), deviceLabel: "Safari on iPhone", version: 2 });
  claimed.prepared.kept.set("p1", { code: "F7KM-Q2DX", key: KEY, link: "x", fields: { name: "Rose", helper: "Mikey", note: "" } });
  claimed.prepared.renderPairing();
  assert.equal(claimed.host.byClass("pairing-path").textContent, "Rose is joining");
  const yes = claimed.host.byText("Yes, let Rose in");
  assert.ok(yes?.disabled, "approval waits for the comparison");
  assert.match(claimed.host.byClass("pairing-fingerprint").textContent, /cdcd/);

  const forgotten = rig({ pairingId: "p2", prepared: true, state: "Pending", expiresAt, version: 1 });
  forgotten.prepared.renderPairing();
  assert.equal(forgotten.host.byText("Print the setup sheet"), null, "without the code in memory there's nothing to print");
  assert.ok(forgotten.host.find((node) => /can't be printed again/.test(node._text ?? "")));
});
