// The sealed card of a prepared invitation (#613): the service stores it but
// can't read it; only the key in the link's fragment opens it.
import assert from "node:assert/strict";
import test from "node:test";
import { CARD_KEY_LENGTH, isCardKey, MAX_CARD_NAME, MAX_CARD_NOTE, openCard, randomDigits, sealCard, suggestUsername } from "./prepared-card.js";
import { normalizeUsername } from "./account-credentials.js";

test("a sealed card opens with its own key and with nothing else", async () => {
  const { card, key } = await sealCard({ name: " Rose ", helper: "Mikey", note: "Call me after lunch" });
  assert.equal(key.length, CARD_KEY_LENGTH);
  assert.ok(isCardKey(key));
  assert.match(card, /^[A-Za-z0-9_-]{40,2048}$/, "the service accepts it");
  assert.ok(!atob(card.replaceAll("-", "+").replaceAll("_", "/")).includes("Rose"), "the service can't read it");
  assert.deepEqual(await openCard(card, key), { name: "Rose", helper: "Mikey", note: "Call me after lunch" });
  const other = await sealCard({ name: "Sam", helper: "Mikey" });
  assert.notEqual(other.key, key, "every card has its own key");
  assert.equal(await openCard(card, other.key), null, "another invitation's key");
  assert.equal(await openCard(other.card, key), null, "a card moved to another invitation");
  assert.equal(await openCard(card, null), null, "a typed code has no key");
  assert.equal(await openCard(card.slice(0, -4), key), null, "damaged");
  assert.equal(await openCard(card, "short"), null);
  assert.equal(await openCard(42, key), null);
});

test("a card's fields are trimmed and bounded, and the largest fits the service's limit", async () => {
  const { card, key } = await sealCard({ name: "名".repeat(80), helper: "😀".repeat(80), note: "n".repeat(500) });
  assert.ok(card.length <= 2048, `${card.length} characters`);
  const opened = await openCard(card, key);
  assert.equal([...opened.name].length, MAX_CARD_NAME);
  assert.equal([...opened.helper].length, MAX_CARD_NAME);
  assert.equal(opened.note.length, MAX_CARD_NOTE);
  // A card without a name isn't one.
  const empty = await sealCard({ name: "  ", helper: "Mikey" });
  assert.equal(await openCard(empty.card, empty.key), null);
});

test("the offered username comes from the name and is always a valid username", () => {
  assert.equal(suggestUsername("Rose", "0042"), "rose.0042");
  assert.equal(suggestUsername("Zoë Ann-Marie O'Neil", "1234"), "zoeannmarieoneil.1234");
  assert.equal(suggestUsername("李", "5678"), "kin.5678");
  assert.equal(suggestUsername("", "0000"), "kin.0000");
  for (const name of ["Rose", "A", "a very long name that keeps on going and going", "🙂🙂"])
    assert.ok(normalizeUsername(suggestUsername(name, randomDigits())));
  assert.match(randomDigits(), /^\d{4}$/);
});
