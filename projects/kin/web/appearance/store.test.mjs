import test from "node:test";
import assert from "node:assert/strict";
import { appearanceOwner, validateAppearance } from "./store.js";

const vault = { vaultId: "a".repeat(32) };
const actor = "b".repeat(32);

test("appearance ownership binds trusted member and vault identities", () => {
  assert.equal(appearanceOwner(vault, actor), `${vault.vaultId}:${actor}`);
  assert.equal(appearanceOwner(vault, "display-name"), null);
  assert.equal(appearanceOwner(null, actor), null);
});

test("appearance records reject another owner and impossible image source", () => {
  const owner = appearanceOwner(vault, actor);
  const base = { version: 1, owner, mode: "system", colorSource: "default", seed: "#984D38", manual: null, image: null };
  assert.deepEqual(validateAppearance(base, owner), base);
  assert.throws(() => validateAppearance({ ...base, owner: `c${owner.slice(1)}` }, owner));
  assert.throws(() => validateAppearance({ ...base, colorSource: "background" }, owner));
});

test("manual override remains valid when a background is replaced", () => {
  const owner = appearanceOwner(vault, actor);
  const image = { seed: "#CC7722", bytes: new Uint8Array([1, 2]), type: "image/webp", width: 2, height: 1 };
  const record = validateAppearance({ version: 1, owner, mode: "dark", colorSource: "preset", seed: "#74507D", manual: { source: "preset", name: "Plum", seed: "#74507D" }, image }, owner);
  assert.equal(record.seed, "#74507D");
  assert.equal(record.image.seed, "#CC7722");
});

test("version two records preserve independent household inheritance", () => {
  const owner = appearanceOwner(vault, actor);
  const partial = { version: 2, owner, mode: "dark", colorSource: undefined, seed: undefined, manual: undefined, image: null };
  assert.deepEqual(validateAppearance(partial, owner), partial);
  assert.throws(() => validateAppearance({ ...partial, colorSource: "custom" }, owner));
});
