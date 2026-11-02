// Help on every screen (#621) and the plain-language pass (#618).
import test from "node:test";
import assert from "node:assert/strict";
import { HELP_COPY, HELP_TOPICS, helpKey, helpTopic, screenText } from "./help-content.js";
import { GLOSSARY, JARGON, glossFor, jargonIn } from "./glossary.js";
import { TIP_COPY } from "./tips.js";
import { EASY_MODE_COPY } from "../easy/easy-mode.js";
import { ROUTE_PAGES, SEGMENTS, resolveRoute } from "../routes.js";

// Every page and segment a route can name.
const ROUTE_KEYS = ROUTE_PAGES.flatMap((page) => SEGMENTS[page] ? SEGMENTS[page].map((entry) => `${page}/${entry.id}`) : [page]);

test("every page and segment in routes.js has its own Help", () => {
  assert.ok(ROUTE_KEYS.length >= 20);
  for (const key of ROUTE_KEYS) {
    assert.ok(HELP_TOPICS[key], `Help for ${key}`);
    assert.equal(helpTopic(key).key, key);
    assert.equal(helpKey(resolveRoute({ hash: `#${key}` })), key, `${key} is the key its route gives`);
  }
  // And nothing for a route that doesn't exist.
  for (const key of Object.keys(HELP_TOPICS)) assert.ok(key.startsWith("dialog:") || ROUTE_KEYS.includes(key), `${key} is a route or a dialog`);
});

test("each topic says what it is for, two or three things to do, and who sees it", () => {
  for (const [key, topic] of Object.entries(HELP_TOPICS)) {
    assert.ok(topic.title && topic.about && topic.who, key);
    assert.ok(topic.actions.length >= 1 && topic.actions.length <= 3, `${key}: one to three things`);
    for (const action of topic.actions) {
      assert.ok(action.text.length <= 120, `${key}: "${action.text}" is short`);
      if (action.show) assert.doesNotThrow(() => { if (/[<>]/.test(action.show)) throw new Error("not a selector"); }, key);
    }
    assert.ok(topic.about.length <= 160, `${key}: the purpose is a sentence or two`);
  }
  // Major dialogs have Help too.
  for (const key of ["dialog:quick-add", "dialog:item-detail", "dialog:shopping-mode"]) assert.ok(HELP_TOPICS[key], key);
});

test("an unknown key falls back to its page's Help, then Today's", () => {
  assert.equal(helpTopic("lists/whatever").title, "To do");
  assert.equal(helpTopic("nowhere").title, "Today");
  assert.equal(helpTopic("nowhere").key, null);
});

test("each glossary entry is one plain sentence, and every hard word has one", () => {
  for (const [term, text] of Object.entries(GLOSSARY)) {
    assert.match(text, /^[A-Z].*[.]$/, term);
    assert.equal((text.match(/[.!?](\s|$)/g) ?? []).length, 1, `${term}: one sentence`);
    assert.ok(text.length <= 160, `${term}: short`);
  }
  for (const [word, term] of Object.entries(JARGON)) assert.ok(GLOSSARY[term], `${word} → ${term}`);
  // The words the story names.
  for (const term of ["sync", "archive", "passkey", "backup key", "household", "admin"]) assert.ok(GLOSSARY[term], term);
});

test("jargon is found as whole words, ignoring case", () => {
  assert.deepEqual(jargonIn("Sync your Passkeys and archived handoffs."), ["sync", "archive", "passkey", "handoff"]);
  assert.deepEqual(jargonIn("Syncopation, pinned-up pineapples, a spinning top"), ["pin"], "only whole words: 'pinned' counts, 'pineapples' doesn't");
  assert.deepEqual(jargonIn("Nothing hard here."), []);
  assert.deepEqual(glossFor(["sync", "nonsense"]).map((entry) => entry.term), ["sync"]);
});

test("every hard word easy mode shows on a screen is explained in that screen's Help", () => {
  for (const key of [...ROUTE_KEYS, ...Object.keys(HELP_TOPICS).filter((entry) => entry.startsWith("dialog:"))]) {
    const topic = helpTopic(key);
    const glossed = new Set(topic.words.map((entry) => entry.term));
    const shown = [topic.title, topic.about, topic.who, ...topic.actions.map((entry) => entry.text), ...Object.values(HELP_COPY).filter((value) => typeof value === "string"), ...screenText(key)];
    for (const text of shown) {
      const unglossed = jargonIn(text).filter((term) => !glossed.has(term));
      assert.deepEqual(unglossed, [], `${key}: "${text}" needs ${unglossed.join(", ")} explained`);
    }
  }
});

test("the tips and the easy mode setting use no hard words at all", () => {
  const strings = [
    ...Object.values(TIP_COPY).flatMap((copy) => Object.values(copy)),
    ...Object.values(EASY_MODE_COPY),
  ];
  for (const text of strings) assert.deepEqual(jargonIn(text), [], `"${text}"`);
});
