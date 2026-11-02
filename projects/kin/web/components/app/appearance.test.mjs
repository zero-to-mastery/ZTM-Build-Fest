import assert from "node:assert/strict";
import test from "node:test";
import { AppearanceController } from "./appearance.js";

function mark() {
  return {
    hidden: false,
    style: {},
    textContent: "",
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; if (name === "style") this.style = {}; },
  };
}

function harness() {
  const app = {
    vault: { locked: false },
    brandGenericMark: mark(),
    brandLetterMark: mark(),
    brandUploadedMark: mark(),
    brandTitle: mark(),
    brandLink: mark(),
  };
  const ctx = { app };
  ctx.appearance = new AppearanceController(ctx);
  return { app, controller: ctx.appearance };
}

const settings = (brand) => ({
  version: 1,
  revision: 4,
  name: "Willow",
  appearance: { seed: "#397052" },
  brand,
});

test("an unlocked household gets its generated initial and accessible name", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { title: "Kin" };
  try {
    const { app, controller } = harness();
    controller.setHouseholdIdentity("Willow", settings({ version: 1, iconSource: "letter", icon: null }));
    assert.equal(app.brandGenericMark.hidden, true);
    assert.equal(app.brandLetterMark.hidden, false);
    assert.equal(app.brandLetterMark.textContent, "W");
    assert.equal(app.brandLink.attributes["aria-label"], "Willow — Today");
    assert.equal(document.title, "Willow — Kin");
  } finally { globalThis.document = previousDocument; }
});

test("an uploaded private icon appears only after decoding and falls back without a broken image", () => {
  const previousDocument = globalThis.document;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const revoked = [];
  globalThis.document = { title: "Kin" };
  URL.createObjectURL = () => "blob:private-brand";
  URL.revokeObjectURL = (value) => revoked.push(value);
  try {
    const { app, controller } = harness();
    const brand = { version: 1, iconSource: "upload", icon: { type: "image/png", bytes: new Uint8Array([1]) } };
    controller.setHouseholdIdentity("Willow", settings(brand));
    assert.equal(app.brandLetterMark.hidden, false, "the generated initial is the decode fallback");
    assert.equal(app.brandUploadedMark.hidden, true);
    app.brandUploadedMark.onload();
    assert.equal(app.brandUploadedMark.hidden, false);
    assert.equal(app.brandLetterMark.hidden, true);
    controller.setHouseholdIdentity("Willow", settings(brand));
    assert.equal(app.brandLetterMark.hidden, true, "refreshing the same revision does not expose the fallback beneath the loaded icon");

    controller.setHouseholdIdentity("Willow", { ...settings(brand), revision: 5 });
    app.brandUploadedMark.onerror();
    assert.equal(app.brandUploadedMark.hidden, true);
    assert.equal(app.brandLetterMark.hidden, true);
    assert.equal(app.brandGenericMark.hidden, false);
    assert.ok(revoked.includes("blob:private-brand"));
  } finally {
    globalThis.document = previousDocument;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
  }
});

test("clearing the private session restores generic Kin branding", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { title: "Willow — Kin", documentElement: { dataset: {} }, querySelector: () => null };
  try {
    const { app, controller } = harness();
    app.removeAttribute = () => {};
    controller.setHouseholdIdentity("Willow", settings({ version: 1, iconSource: "letter", icon: null }));
    controller.clearAppliedAppearance();
    assert.equal(app.brandGenericMark.hidden, false);
    assert.equal(app.brandLetterMark.hidden, true);
    assert.equal(app.brandTitle.textContent, "Kin");
    assert.equal(app.brandLink.attributes["aria-label"], "Kin — Today");
    assert.equal(document.title, "Kin");
  } finally { globalThis.document = previousDocument; }
});

test("publishing a home-screen icon first saves the same choice in encrypted household settings", async () => {
  const { app, controller } = harness();
  const calls = [];
  const privateBrand = { version: 1, iconSource: "upload", icon: { type: "image/png", width: 512, height: 512, bytes: new Uint8Array([1]) } };
  app.householdSettings = { version: 1, revision: 3, name: "Willow", appearance: { version: 1, owner: "household", mode: "light", colorSource: "default", seed: "#984D38", manual: null, image: null }, brand: { version: 1, iconSource: "letter", icon: null } };
  app.syncCoordinator = {
    async saveHouseholdSettings(value) { calls.push(["private", value.brand]); return { ...value, revision: 4 }; },
    async publishInstallIdentity(value) { calls.push(["public", value]); return { rev: 2 }; },
  };
  app.householdDefaults = { initialize: ({ value }) => calls.push(["editor", value.revision]) };
  const session = { vault: app.vault };
  controller.ctx.session = { captureSession: () => session, assertCurrentSession: () => {}, isCurrentSession: () => true };
  controller.applyEffectiveAppearance = () => calls.push(["header", app.householdSettings.revision]);
  controller.refreshInstallIdentity = async () => calls.push(["reload-public"]);
  let completion;
  await controller.handleInstallIdentity({ detail: { value: { name: "Willow" }, brand: privateBrand,
    complete: (result, error) => { completion = { result, error }; } } }, false);
  assert.deepEqual(calls.map(([kind]) => kind), ["private", "editor", "header", "public", "reload-public"]);
  assert.equal(app.householdSettings.brand.iconSource, "upload");
  assert.deepEqual(completion, { result: { rev: 2 }, error: null });
});

test("saving a private icon does not require plaintext home-screen publication", async () => {
  const { app, controller } = harness();
  let publicCalls = 0;
  const privateBrand = { version: 1, iconSource: "letter", icon: null };
  app.householdSettings = { version: 1, revision: 0, name: "Willow", appearance: { version: 1, owner: "household", mode: "light", colorSource: "default", seed: "#984D38", manual: null, image: null }, brand: privateBrand };
  app.syncCoordinator = {
    async saveHouseholdSettings(value) { return { ...value, revision: 1 }; },
    async publishInstallIdentity() { publicCalls += 1; },
  };
  app.householdDefaults = { initialize() {} };
  controller.ctx.session = { captureSession: () => ({ vault: app.vault }), assertCurrentSession: () => {}, isCurrentSession: () => true };
  controller.applyEffectiveAppearance = () => {};
  let completion;
  await controller.handleInstallIdentity({ detail: { value: null, brand: privateBrand, publish: false,
    complete: (result, error) => { completion = { result, error }; } } }, false);
  assert.equal(publicCalls, 0);
  assert.deepEqual(completion, { result: { private: true }, error: null });
});

test("a failed plaintext publication reports that the private icon still saved", async () => {
  const { app, controller } = harness();
  const privateBrand = { version: 1, iconSource: "letter", icon: null };
  app.householdSettings = { version: 1, revision: 0, name: "Willow", appearance: { version: 1, owner: "household", mode: "light", colorSource: "default", seed: "#984D38", manual: null, image: null }, brand: privateBrand };
  app.syncCoordinator = {
    async saveHouseholdSettings(value) { return { ...value, revision: 1 }; },
    async publishInstallIdentity() { const error = new Error("conflict"); error.code = "install_identity_stale"; throw error; },
  };
  app.householdDefaults = { initialize() {} };
  controller.ctx.session = { captureSession: () => ({ vault: app.vault }), assertCurrentSession: () => {}, isCurrentSession: () => true };
  controller.applyEffectiveAppearance = () => {};
  controller.refreshInstallIdentity = async () => {};
  let completion;
  await controller.handleInstallIdentity({ detail: { value: { name: "Willow" }, brand: privateBrand, publish: true,
    complete: (result, error) => { completion = { result, error }; } } }, false);
  assert.equal(app.householdSettings.revision, 1);
  assert.equal(completion.result, null);
  assert.equal(completion.error.code, "install_identity_partial");
  assert.match(completion.error.message, /saved inside Kin.*not published/i);
});

test("a session change after the private write reports that the icon saved", async () => {
  const { app, controller } = harness();
  const privateBrand = { version: 1, iconSource: "letter", icon: null };
  app.householdSettings = { version: 1, revision: 0, name: "Willow", appearance: { version: 1, owner: "household", mode: "light", colorSource: "default", seed: "#984D38", manual: null, image: null }, brand: privateBrand };
  app.syncCoordinator = {
    async saveHouseholdSettings(value) { return { ...value, revision: 1 }; },
    async publishInstallIdentity() { assert.fail("publication must not start after the session changes"); },
  };
  let current = true;
  controller.ctx.session = {
    captureSession: () => ({ vault: app.vault }),
    assertCurrentSession: () => { current = false; throw new Error("session changed"); },
    isCurrentSession: () => current,
  };
  let completion;
  await controller.handleInstallIdentity({ detail: { value: { name: "Willow" }, brand: privateBrand, publish: true,
    complete: (result, error) => { completion = { result, error }; } } }, false);
  assert.equal(completion.result, null);
  assert.equal(completion.error.code, "install_identity_partial");
  assert.match(completion.error.message, /icon was saved inside Kin.*unlock Kin/i);
});

test("a committed settings save updates the header when only the offline cache failed", async () => {
  const { app, controller } = harness();
  const saved = settings({ version: 1, iconSource: "letter", icon: null });
  const warning = new Error("Household settings were saved, but the offline copy failed.");
  warning.code = "household_settings_cache_partial";
  warning.savedValue = saved;
  app.syncCoordinator = { async saveHouseholdSettings() { throw warning; } };
  let applied = false;
  controller.applyEffectiveAppearance = () => { applied = true; };
  controller.ctx.session = { captureSession: () => ({ vault: app.vault }), assertCurrentSession: () => {}, isCurrentSession: () => true };
  let completion;
  await controller.handleSaveHouseholdDefaults({ detail: { value: saved,
    complete: (result, error) => { completion = { result, error }; } } });
  assert.equal(app.householdSettings, saved);
  assert.equal(applied, true);
  assert.deepEqual(completion, { result: saved, error: warning });
});
