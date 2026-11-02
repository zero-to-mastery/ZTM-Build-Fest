import test from "node:test";
import assert from "node:assert/strict";
import { ObAdmin } from "../../web/admin/admin.js";

function fixture(choice, response = { etag: "new", buildError: null }) {
  const calls = [];
  const app = new ObAdmin();
  app.api = {
    call: async (...args) => {
      calls.push(args);
      if (response instanceof Error) throw response;
      return response;
    },
  };
  const ui = {
    select: { value: choice },
    etag: "old",
    save: { disabled: false },
    status: { textContent: "", setAttribute(name, value) { this[name] = value; } },
  };
  return { app, ui, calls };
}

test("Appearance saves show, hide, and theme inheritance with the loaded revision", async () => {
  for (const [choice, expected] of [["show", true], ["hide", false], ["inherit", null]]) {
    const { app, ui, calls } = fixture(choice);
    await app.saveAppearanceSettings(ui);
    assert.deepEqual(calls, [["PUT", "appearance", { json: { colorSchemeToggle: expected, etag: "old" } }]]);
    assert.equal(ui.etag, "new");
    assert.equal(ui.save.disabled, false);
    assert.match(ui.status.textContent, /saved and rebuilt.*Publish/i);
  }
});

test("Appearance reports save failures without changing the loaded revision", async () => {
  const { app, ui } = fixture("hide", new Error("Site settings changed on disk; reload before saving"));
  await app.saveAppearanceSettings(ui);
  assert.equal(ui.etag, "old");
  assert.equal(ui.status.role, "alert");
  assert.match(ui.status.textContent, /not saved.*reload/i);
  assert.equal(ui.save.disabled, false);
});

test("Appearance distinguishes a saved setting from a failed public rebuild", async () => {
  const { app, ui } = fixture("hide", { etag: "saved", buildError: "Invalid post date" });
  await app.saveAppearanceSettings(ui);
  assert.equal(ui.etag, "saved");
  assert.equal(ui.status.role, "alert");
  assert.match(ui.status.textContent, /saved, but rebuilding failed: Invalid post date/);
  assert.equal(ui.save.disabled, false);
});
