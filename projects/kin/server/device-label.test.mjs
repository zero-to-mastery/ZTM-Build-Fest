// Since v1.1 the server keeps only a device's automatic name (#71): typed
// names become "Device" on the way in, and names stored by v1.0 are reset
// when the service starts.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";
import { DEVICE_BROWSER_NAMES, DEVICE_OS_NAMES, deviceLabel } from "./pairing-service/device-label.mjs";
import * as platform from "../web/platform.js";

const credential = (id) => ({ id, publicKey: `synthetic-key-${id}`, algorithm: -7 });

test("the server's name lists match what the client can report", () => {
  assert.deepEqual([...DEVICE_OS_NAMES].sort(), [...platform.DEVICE_OS_NAMES].sort());
  assert.deepEqual([...DEVICE_BROWSER_NAMES].sort(), [...platform.DEVICE_BROWSER_NAMES].sort());
  // Every name the client builds is kept as it is.
  for (const os of [null, ...platform.DEVICE_OS_NAMES])
    for (const browser of [null, ...platform.DEVICE_BROWSER_NAMES])
      for (const standalone of [false, true]) {
        const name = platform.householdDeviceName({ os, browser, ios: os === "iPhone" || os === "iPad", standalone });
        assert.equal(deviceLabel(name), name, name);
      }
});

test("automatic names are kept and anything else becomes Device", () => {
  for (const kept of ["Chrome on iPhone", "Samsung Internet on Android", "iPad", "Firefox", "Device"])
    assert.equal(deviceLabel(kept), kept);
  assert.equal(deviceLabel("  Chrome   on  iPhone "), "Chrome on iPhone");
  for (const typed of ["Mikey's phone", "Kitchen tablet", "This device", "chrome on iphone", "Chrome on iPhone 17", "", "x".repeat(500), null, undefined, 42, {}])
    assert.equal(deviceLabel(typed), "Device", String(typed));
});

test("pairing stores only automatic names", () => {
  let now = 10_000;
  const pairing = new PairingService({ now: () => now });
  const adult = pairing.bootstrap({ credential: credential("adult"), deviceLabel: "Mikey's phone" });
  assert.equal(pairing.devices.get(adult.deviceId).label, "Device");
  now += 60_001;
  const invitation = pairing.createPairing(adult.sessionToken);
  const claim = pairing.claimPairing({ code: invitation.code, credential: credential("partner"), deviceLabel: "Edge on Windows" });
  pairing.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const partner = pairing.activateClaim(claim.claimToken);
  assert.deepEqual(
    pairing.listDevices(adult.sessionToken).map(({ id, label }) => [id, label]).sort(),
    [[adult.deviceId, "Device"], [partner.deviceId, "Edge on Windows"]].sort(),
  );
  const defaulted = new PairingService({ now: () => now }).bootstrap({ credential: credential("other") });
  assert.ok(defaulted.deviceId);
});

test("labels typed before v1.1 are reset in storage when the service starts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kin-device-label-"));
  let store;
  // Close before removing: Windows can't delete an open database file.
  t.after(() => {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const databasePath = join(directory, "kin.sqlite");
  store = new DurableStore(databasePath);
  const adult = new PairingService({ store, now: () => 10_000 })
    .bootstrap({ credential: credential("adult"), deviceLabel: "Safari on Mac" });
  // What a v1.0 server could have stored: any 1–48 character label.
  const row = store.db.prepare("SELECT device_json FROM devices WHERE id = ?").get(adult.deviceId);
  store.db.prepare("UPDATE devices SET device_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...JSON.parse(row.device_json), label: "Mikey's work laptop" }), adult.deviceId);
  store.close();

  store = new DurableStore(databasePath);
  assert.equal(store.resetDeviceLabels(deviceLabel), 1);
  assert.equal(JSON.parse(store.db.prepare("SELECT device_json FROM devices").get().device_json).label, "Device");
  for (const file of [databasePath, `${databasePath}-wal`].filter(existsSync))
    assert.equal(readFileSync(file).includes("Mikey's work laptop"), false, `the typed label is gone from ${file}`);
  assert.equal(store.resetDeviceLabels(deviceLabel), 0, "a second start changes nothing");
  store.db.prepare("UPDATE devices SET device_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...JSON.parse(row.device_json), label: "Kitchen" }), adult.deviceId);
  const service = new PairingService({ store, now: () => 20_000 });
  assert.equal(service.devices.get(adult.deviceId).label, "Device");
  assert.equal(JSON.parse(store.db.prepare("SELECT device_json FROM devices").get().device_json).label, "Device");
  store.validate();
});
