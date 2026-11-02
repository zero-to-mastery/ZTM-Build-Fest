// Emoji in chat (#113): what counts as an emoji-only message, and the
// picker's table.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { emojiOnlyCount, isEmojiGrapheme, isEmojiGraphemeFallback, loadEmojiTable, validateEmojiTable } from "./emoji.js";
import { chatTextProblem } from "./chat-room.js";

test("messages of only 1–3 emoji are counted by grapheme", () => {
  assert.equal(emojiOnlyCount("👍"), 1);
  assert.equal(emojiOnlyCount(" 🎉🎂 "), 2, "whitespace aside");
  assert.equal(emojiOnlyCount("👍🏽"), 1, "a skin tone is part of its emoji");
  assert.equal(emojiOnlyCount("👨‍👩‍👧"), 1, "a family is one grapheme");
  assert.equal(emojiOnlyCount("🇨🇦"), 1, "a flag is one");
  assert.equal(emojiOnlyCount("✌️❤️"), 2, "with variation selectors");
  assert.equal(emojiOnlyCount("1️⃣"), 1, "a keycap");
  assert.equal(emojiOnlyCount("😀😀😀😀"), 4, "past three, counted to four and stopped");
  assert.equal(emojiOnlyCount("ok 👍"), 0, "text with emoji isn't emoji-only");
  assert.equal(emojiOnlyCount("1"), 0, "a digit isn't an emoji");
  assert.equal(emojiOnlyCount("#"), 0);
  assert.equal(emojiOnlyCount(""), 0);
  assert.equal(emojiOnlyCount("   "), 0);
  assert.equal(isEmojiGrapheme("a"), false);
  // Text symbols stay text unless asked to show as emoji (U+FE0F); flags with
  // tag sequences count; unassigned code points don't.
  for (const [text, count] of [["✔", 0], ["✔️", 1], ["©", 0], ["™", 0], ["↔", 0], ["♥", 0], ["♥️", 1], ["🏴󠁧󠁢󠁳󠁣󠁴󠁿", 1], ["\u{1FC00}", 0], ["👩🏾‍💻", 1]])
    assert.equal(emojiOnlyCount(text), count, JSON.stringify(text));
});

test("browsers without the v flag use the same rule", () => {
  for (const text of ["👍", "👍🏽", "👨‍👩‍👧", "🇨🇦", "✌️", "1️⃣", "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "♥️"]) assert.equal(isEmojiGraphemeFallback(text), true, text);
  for (const text of ["✔", "©", "™", "↔", "♥", "\u{1FC00}", "1", "#", "a"]) assert.equal(isEmojiGraphemeFallback(text), false, text);
});

test("the picker table is about 300 named emoji, each one grapheme", async () => {
  const table = validateEmojiTable(JSON.parse(await readFile(new URL("./emoji.json", import.meta.url), "utf8")));
  const all = table.categories.flatMap((category) => category.emoji);
  assert.ok(all.length >= 280 && all.length <= 360, `${all.length} emoji`);
  assert.equal(new Set(all.map(([emoji]) => emoji)).size, all.length, "no duplicates");
  assert.equal(new Set(all.map(([, name]) => name)).size, all.length, "distinct names");
  // Every one is valid chat text by the client's copy of the engine's rule
  // (chatTextProblem; rust/src/chat_tests.rs checks the same counting).
  for (const [emoji] of all) assert.equal(chatTextProblem(emoji), null, emoji);
  // And a recommended emoji, as systems draw them.
  for (const [emoji] of all) assert.match(emoji, /^\p{RGI_Emoji}$/v, emoji);
  assert.throws(() => validateEmojiTable({ version: 1, categories: [{ id: "x", label: "X", emoji: [["ab", "letters"]] }] }));
  assert.throws(() => validateEmojiTable({ version: 2, categories: [] }));
});

test("the length limit counts scalar values, as Rust does, not graphemes or UTF-16", () => {
  const family = "👨\u200d👩\u200d👧";
  assert.equal([...family].length, 5);
  assert.equal(chatTextProblem(family.repeat(800)), null, "4,000 scalars (800 graphemes, 6,400 UTF-16 units)");
  assert.match(chatTextProblem(family.repeat(800) + "a"), /too long/);
  assert.equal(chatTextProblem("a".repeat(3_999) + "😀"), null, "4,000 scalars, 4,001 UTF-16 units");
});

test("the table loads once, and a failed load can be retried", async () => {
  const body = await readFile(new URL("./emoji.json", import.meta.url), "utf8");
  let calls = 0;
  const failing = async () => { calls += 1; return new Response("", { status: 503 }); };
  await assert.rejects(loadEmojiTable({ fetch: failing }));
  const working = async (url) => { calls += 1; assert.ok(String(url).endsWith("/chat/emoji.json")); return new Response(body); };
  const first = await loadEmojiTable({ fetch: working });
  const second = await loadEmojiTable({ fetch: working });
  assert.equal(first, second);
  assert.equal(calls, 2);
});
