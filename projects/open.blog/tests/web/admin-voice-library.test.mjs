import assert from "node:assert/strict";
import test from "node:test";

import { createVoiceLibrary } from "../../web/admin/voice-library.js";
import { EMPTY_LIBRARY_TEXT, STAGE_BADGES, coverageText, gapLines, groupLibrary, voiceHash } from "../../web/admin/voice.js";
import { ApiError, withDom } from "./dom-shim.mjs";
import { all, flush, link, one, text } from "./voice-harness.mjs";

// The sample library (ADR 0274, #448): packs as groups in the catalog's order, prompts with stage badges,
// words, visibility and date, newest first inside a pack, invalid files with guidance, an empty state that says
// what a sample is, and a draw from one pack.

const file = (over) => ({ valid: true, visibility: "private", words: 100, bytes: 500, guidance: null, revision: "r", ...over });
const rough = (prompt, pack, day, over = {}) =>
  file({ id: `${day}-${prompt}-rough`, file: `${day}-${prompt}-rough.md`, stage: "rough", pack, prompt, promptTitle: prompt.replace(/-/g, " "), title: prompt, date: `${day}T09:00:00Z`, roughOf: null, ...over });
const polished = (prompt, pack, day, over = {}) =>
  file({ id: `${day}-${prompt}-polished`, file: `${day}-${prompt}-polished.md`, stage: "polished", pack, prompt, promptTitle: prompt.replace(/-/g, " "), title: prompt, date: `${day}T09:00:00Z`, roughOf: `${day}-${prompt}-rough.md`, ...over });

const coverage = [
  { id: "teaching", title: "Teaching", summary: "Explain what you know.", total: 3, withRough: 0, withPolished: 0, prompts: [{ id: "teach-it", title: "Teach it", rough: false, polished: false }, { id: "step-by-step", title: "Step by step", rough: false, polished: false }, { id: "beginner-mistakes", title: "Beginner mistakes", rough: false, polished: false }] },
  { id: "stories", title: "Stories", summary: "Tell what happened.", total: 3, withRough: 3, withPolished: 1, prompts: [{ id: "a-mistake", title: "A mistake", rough: true, polished: true }, { id: "a-surprise", title: "A surprise", rough: true, polished: false }, { id: "a-journey", title: "A journey", rough: true, polished: false }] },
  { id: "opinions", title: "Opinions", summary: "Say what you think.", total: 3, withRough: 1, withPolished: 0, prompts: [{ id: "hot-take", title: "Hot take", rough: true, polished: false }, { id: "disagree", title: "Disagree", rough: false, polished: false }, { id: "change-mind", title: "Change my mind", rough: false, polished: false }] },
];
const samples = () => [
  rough("a-surprise", "stories", "2026-10-20"),
  rough("a-mistake", "stories", "2026-10-22", { words: 120 }),
  polished("a-mistake", "stories", "2026-10-22", { words: 135, visibility: "portable", date: "2026-10-25T09:00:00Z" }),
  rough("a-journey", "stories", "2026-10-10"),
  rough("hot-take", "opinions", "2026-10-26"),
];
const listing = (over = {}) => ({ samples: samples(), coverage, warnings: [], ...over });

async function mount(data) {
  const api = { calls: [], async call(method, path) { this.calls.push(`${method} ${path}`); if (data instanceof Error) throw data; return structuredClone(data); } };
  const library = createVoiceLibrary({ api });
  document.body.append(library.element);
  await library.load();
  await flush();
  return { api, library, root: library.element };
}
const packs = (root) => all(root, "section").filter((n) => n.dataset.pack);
const rows = (section) => all(section, "li").filter((n) => n.dataset.prompt).map((n) => n.dataset.prompt);

test("the pure grouping follows the catalog's pack order and puts the newest prompt first", () => {
  const library = groupLibrary(listing());
  assert.deepEqual(library.groups.map((g) => g.id), ["teaching", "stories", "opinions"]);
  assert.deepEqual(library.groups[1].rows.map((r) => r.prompt), ["a-mistake", "a-surprise", "a-journey"]);
  assert.deepEqual(library.groups[0].rows, []);
  assert.equal(library.empty, false);
});

test("a prompt with both stages is one row with both badges, and the polished words and place show", () => {
  const [row] = groupLibrary(listing()).groups[1].rows;
  assert.deepEqual(row.badges, ["rough", "polished"]);
  assert.equal(row.words, 135);
  assert.equal(row.visibility, "portable");
  assert.equal(row.date, "2026-10-25T09:00:00Z", "the newest file's date");
});

test("the order does not depend on the order the server listed the files in", () => {
  const forward = JSON.stringify(groupLibrary(listing()));
  const reversed = JSON.stringify(groupLibrary(listing({ samples: samples().reverse() })));
  assert.equal(forward, reversed);
});

test("equal dates are ordered by file name so the page is always the same", () => {
  const tied = listing({ samples: [rough("a-surprise", "stories", "2026-10-20"), rough("a-journey", "stories", "2026-10-20")] });
  assert.deepEqual(groupLibrary(tied).groups[1].rows.map((r) => r.prompt), ["a-journey", "a-surprise"]);
});

test("samples of a pack the site no longer offers are kept in a last group, and unreadable files are apart", () => {
  const data = listing({ samples: [...samples(), rough("old-prompt", "retired", "2026-09-01"), file({ valid: false, file: "2026-10-01-x-rough.md", guidance: "Repair it.", visibility: "portable" })] });
  const library = groupLibrary(data);
  assert.deepEqual(library.other.rows.map((r) => r.prompt), ["old-prompt"]);
  assert.deepEqual(library.invalid.map((f) => f.file), ["2026-10-01-x-rough.md"]);
  assert.equal(groupLibrary(listing({ samples: [file({ valid: false, file: "a.md" })] })).empty, false, "an invalid file is not an empty library");
  assert.equal(groupLibrary({ samples: [], coverage }).empty, true);
});

test("coverage is said in words", () => {
  assert.equal(coverageText({ total: 3, withRough: 2, withPolished: 0 }), "2 of 3 prompts written");
  assert.equal(coverageText({ total: 1, withRough: 1, withPolished: 1 }), "1 of 1 prompt written, 1 polished");
});

test("packs are groups with a heading, a coverage line and their prompts", async () => {
  await withDom(async () => {
    const m = await mount(listing());
    assert.deepEqual(packs(m.root).map((n) => n.dataset.pack), ["teaching", "stories", "opinions"]);
    const stories = packs(m.root)[1];
    assert.equal(text(one(stories, "h3")), "Stories");
    assert.equal(text(one(stories, "[data-voice-coverage]")), "3 of 3 prompts written, 1 polished");
    assert.deepEqual(rows(stories), ["a-mistake", "a-surprise", "a-journey"]);
    assert.match(text(one(m.root, "[data-voice-summary]")), /4 samples written, 1 polished/);
    assert.equal(text(one(packs(m.root)[0], "[data-voice-none]")), "Nothing written in this pack yet.");
    assert.equal(m.api.calls.length, 1);
  })();
});

test("badges say the stage in a word and a shape, and each row shows words, where it is kept and when", async () => {
  await withDom(async () => {
    const m = await mount(listing());
    const first = all(packs(m.root)[1], "li").find((n) => n.dataset.prompt === "a-mistake");
    const stages = all(first, "span").filter((n) => n.dataset.stage).map((n) => n.dataset.stage);
    assert.deepEqual(stages, ["rough", "polished"]);
    const badgeText = text(one(first, ".oba-voice-badges"));
    assert.ok(badgeText.includes(STAGE_BADGES.rough.symbol) && badgeText.includes("Rough"));
    assert.ok(badgeText.includes(STAGE_BADGES.polished.symbol) && badgeText.includes("Polished"));
    assert.notEqual(STAGE_BADGES.rough.symbol, STAGE_BADGES.polished.symbol);
    assert.match(text(one(first, "[data-voice-meta]")), /^135 words · Portable · /);
    const hot = all(packs(m.root)[2], "li")[0];
    assert.match(text(one(hot, "[data-voice-meta]")), /^100 words · Private/);
  })();
});

test("each pack with prompts left offers a draw from just that pack", async () => {
  await withDom(async () => {
    const m = await mount(listing());
    const teaching = link(packs(m.root)[0], "voice-draw-pack");
    assert.equal(teaching.attributes.href, voiceHash("teaching"));
    assert.equal(teaching.attributes.href, "#/voice?pack=teaching");
    assert.match(teaching.attributes["aria-label"], /Teaching/);
    assert.equal(link(packs(m.root)[1], "voice-draw-pack"), null, "a pack that is fully written has nothing left to draw");
    assert.ok(link(packs(m.root)[2], "voice-draw-pack"));
  })();
});

test("an empty library explains what a sample is and offers to start a session", async () => {
  await withDom(async () => {
    const m = await mount({ samples: [], coverage, warnings: [] });
    const empty = one(m.root, "[data-voice-empty]");
    assert.ok(empty);
    assert.equal(text(empty).includes(EMPTY_LIBRARY_TEXT), true);
    assert.match(EMPTY_LIBRARY_TEXT, /never become posts/);
    assert.equal(link(empty, "voice-start-session").attributes.href, "#/voice");
    assert.equal(packs(m.root).length, 0);
  })();
});

test("a file that cannot be used is listed with guidance and without anything from inside it", async () => {
  await withDom(async () => {
    const bad = file({ valid: false, file: "2026-10-01-broken-rough.md", visibility: "portable", guidance: "The field `voice.stage` is missing. Repair the file in a text editor, or erase it here.", stage: null, pack: null, prompt: null, title: null, words: null, date: null });
    const m = await mount(listing({ samples: [...samples(), bad] }));
    const box = one(m.root, "[data-voice-invalid]");
    assert.match(text(box), /2026-10-01-broken-rough\.md/);
    assert.match(text(box), /Portable\. The field `voice\.stage` is missing/);
    assert.match(text(box), /Nothing was changed/);
  })();
});

test("a library with only an unreadable file is not called empty", async () => {
  await withDom(async () => {
    const bad = file({ valid: false, file: "2026-10-01-broken-rough.md", guidance: "Repair it." });
    const m = await mount({ samples: [bad], coverage, warnings: [] });
    assert.equal(one(m.root, "[data-voice-empty]"), null);
    assert.ok(one(m.root, "[data-voice-invalid]"));
  })();
});

test("a failed load says so in words and offers to try again", async () => {
  await withDom(async () => {
    const m = await mount(new ApiError("down", 500, null));
    assert.match(text(one(m.root, "[data-voice-error]")), /server could not do that/);
    assert.ok(m.root.querySelectorAll("button").some((b) => b.dataset.action === "voice-retry"));
  })();
});

test("a prompt answered on several days lists every answer, each with its own polished draft", () => {
  const data = listing({
    samples: [
      rough("a-mistake", "stories", "2026-10-01", { visibility: "portable" }),
      polished("a-mistake", "stories", "2026-10-01", { visibility: "portable", words: 90 }),
      rough("a-mistake", "stories", "2026-10-02", { words: 40 }),
      rough("a-mistake", "stories", "2026-10-03", { words: 50 }),
    ],
  });
  const rows = groupLibrary(data).groups[1].rows;
  assert.deepEqual(rows.map((r) => r.rough.file), ["2026-10-03-a-mistake-rough.md", "2026-10-02-a-mistake-rough.md", "2026-10-01-a-mistake-rough.md"]);
  assert.equal(rows[1].polished, null, "day two's rough draft is not paired with day one's polished draft");
  assert.equal(rows[1].words, 40);
  assert.equal(rows[1].visibility, "private");
  assert.equal(rows[2].polished.file, "2026-10-01-a-mistake-polished.md");
  assert.equal(rows[2].visibility, "portable");
});

test("the library shows the same gap list as voice --list, in words", async () => {
  const gaps = { unansweredPacks: ["teaching"], unansweredPrompts: ["teach-it"], roughOnlyPrompts: ["a-surprise", "a-journey"], oneSampleTraits: [{ section: "Diction", statement: "Starts with so", sample: "x.md" }] };
  assert.deepEqual(gapLines(gaps, coverage).map((l) => l.text), [
    "Packs with no sample yet: Teaching.",
    "Rough only, no polished draft yet: A surprise, A journey.",
    "Voice guide traits that rest on one sample:",
  ]);
  assert.deepEqual(gapLines({ unansweredPacks: [], unansweredPrompts: [], roughOnlyPrompts: [], oneSampleTraits: [] }), []);
  await withDom(async () => {
    const m = await mount(listing({ gaps }));
    const box = one(m.root, "[data-voice-gaps]");
    assert.match(text(box), /Packs with no sample yet: Teaching\./);
    assert.match(text(box), /Rough only, no polished draft yet: A surprise, A journey\./);
    assert.match(text(box), /Starts with so \(Diction\)/);
  })();
});
