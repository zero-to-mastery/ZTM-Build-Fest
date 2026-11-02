import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MAX_SHARED_SOURCES,
  applySourceSuggestion,
  lookupSourceDetails,
  SHARED_SOURCE_KINDS,
  contributorSaveRefusalDetail,
  emptySharedSource,
  sharedReflectionFieldId,
  sharedReflectionPayload,
  sharedReflectionProblemFromError,
  sharedSourceHref,
  showSharedReflectionProblem,
  submitSharedReflection,
  validateSharedReflectionDraft,
} from "../../web/admin/admin.js";

const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");

const draft = (overrides = {}) => ({
  title: "On attention",
  guidingQuestion: "",
  contributorId: "ada",
  sources: [{ ...emptySharedSource("video"), title: "The Art of Noticing", url: "https://www.youtube.com/watch?v=abc" }],
  ...overrides,
});

test("shared source kinds cover video, article, podcast, book, and other with examples", () => {
  assert.deepEqual(
    SHARED_SOURCE_KINDS.map((kind) => kind.value),
    ["video", "article", "podcast", "book", "other"],
  );
  for (const kind of SHARED_SOURCE_KINDS) {
    assert.ok(kind.label && kind.example, kind.value);
  }
  assert.deepEqual(emptySharedSource(), { kind: "video", title: "", url: "", creator: "", publisher: "", published: "", isbn: "" });
});

test("a draft needs a title or guiding question and a titled source", () => {
  assert.equal(validateSharedReflectionDraft(draft()), null);
  assert.equal(validateSharedReflectionDraft(draft({ title: "", guidingQuestion: "What changed?" })), null);
  assert.equal(validateSharedReflectionDraft(draft({ title: "  ", guidingQuestion: " " })).field, "title");
  assert.equal(validateSharedReflectionDraft(draft({ sources: [] })).field, "sources");
  assert.equal(
    validateSharedReflectionDraft(draft({ sources: [{ ...emptySharedSource("book"), title: " " }] })).field,
    "sources.0.title",
  );
  assert.equal(validateSharedReflectionDraft(draft({ contributorId: "" })).field, "contributorId");
  // Problems are reported in the order the form presents its fields: sources come first.
  assert.equal(
    validateSharedReflectionDraft({ title: "", guidingQuestion: "", contributorId: "", sources: [emptySharedSource()] }).field,
    "sources.0.title",
  );
});

test("a source without a link is valid and books keep their metadata", () => {
  const book = { ...emptySharedSource("book"), title: "Über das Zuhören — 聴く", creator: "Ada", publisher: "Press", published: "1843", isbn: "0-86547-454-X" };
  assert.equal(validateSharedReflectionDraft(draft({ sources: [book] })), null);
  const payload = sharedReflectionPayload(draft({ sources: [book] }));
  assert.deepEqual(payload.sources[0], {
    kind: "book",
    title: "Über das Zuhören — 聴く",
    url: "",
    creator: "Ada",
    publisher: "Press",
    published: "1843",
    isbn: "0-86547-454-X",
  });
});

test("links must be HTTP(S) without credentials, and unsafe schemes are refused", () => {
  for (const url of ["https://example.org/a", "http://example.com", "https://bücher.example/straße"]) {
    const sources = [{ ...emptySharedSource("article"), title: "Link", url }];
    assert.equal(validateSharedReflectionDraft(draft({ sources })), null, url);
  }
  for (const url of [
    "javascript:alert(1)",
    " JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "mailto:ada@example.org",
    "//example.org",
    "example.org",
    "https://ada:secret@example.org/",
  ]) {
    const sources = [video(), { ...emptySharedSource("article"), title: "Link", url }];
    const problem = validateSharedReflectionDraft(draft({ sources }));
    assert.equal(problem?.field, "sources.1.url", url);
    assert.doesNotMatch(problem.message, /secret|alert|passwd/);
  }
});

function video() {
  return { ...emptySharedSource("video"), title: "Talk" };
}

test("an ISBN is checked for shape and only sent for books", () => {
  for (const isbn of ["12345", "ISBN 0-86547-454-X", "X865474549"]) {
    const sources = [{ ...emptySharedSource("book"), title: "Book", isbn }];
    assert.equal(validateSharedReflectionDraft(draft({ sources })).field, "sources.0.isbn", isbn);
  }
  const switched = { ...emptySharedSource("video"), title: "Talk", isbn: "not used" };
  assert.equal(validateSharedReflectionDraft(draft({ sources: [switched] })), null);
  assert.equal(sharedReflectionPayload(draft({ sources: [switched] })).sources[0].isbn, "");
});

test("the payload keeps authored order and carries no identity claims", () => {
  const payload = sharedReflectionPayload(
    draft({
      title: "  Working title ",
      guidingQuestion: " What changed? ",
      sources: [
        { ...emptySharedSource("podcast"), title: " Second ", url: " https://example.org/2 " },
        { ...emptySharedSource("other"), title: "Third" },
      ],
    }),
  );
  assert.deepEqual(Object.keys(payload).sort(), ["contributorId", "guidingQuestion", "sources", "title"]);
  assert.equal(payload.title, "Working title");
  assert.equal(payload.guidingQuestion, "What changed?");
  assert.deepEqual(payload.sources.map((source) => source.title), ["Second", "Third"]);
  assert.equal(payload.sources[0].url, "https://example.org/2");
  assert.doesNotMatch(JSON.stringify(payload), /adminUser|participant|roles|binding/);
});

test("server field names map to focusable control ids", () => {
  assert.equal(sharedReflectionFieldId("title"), "oba-shared-title");
  assert.equal(sharedReflectionFieldId("guidingQuestion"), "oba-shared-question");
  assert.equal(sharedReflectionFieldId("contributorId"), "oba-shared-contributor");
  assert.equal(sharedReflectionFieldId("sources"), "oba-shared-add-source");
  assert.equal(sharedReflectionFieldId("sources.2.url"), "oba-shared-source-2-url");
  assert.equal(sharedReflectionFieldId("sources.0.isbn"), "oba-shared-source-0-isbn");
  assert.equal(sharedReflectionFieldId("sources.x.url"), "");
  assert.equal(sharedReflectionFieldId('"><img src=x>'), "");
  assert.equal(sharedReflectionFieldId(""), "");
});

test("stored source links render only as HTTP(S) hrefs", () => {
  assert.equal(sharedSourceHref("https://example.org/a"), "https://example.org/a");
  assert.equal(sharedSourceHref("javascript:alert(1)"), "");
  assert.equal(sharedSourceHref(undefined), "");
  assert.equal(sharedSourceHref("https://user:pass@example.org/"), "");
});

test("the shared reflection flow is labelled, announced, and reachable from navigation", () => {
  assert.match(admin, /href: "#\/shared"/);
  assert.match(admin, /"#\/shared\/new"/);
  assert.match(admin, /api\.call\("GET", "collaboration\/publications"\)/);
  assert.match(admin, /api\.call\("POST", "collaboration\/publications"/);
  assert.match(admin, /Start a shared reflection/);
  assert.match(admin, /Original link \(optional\)/);
  assert.match(admin, /You don’t need Markdown/);
  assert.match(admin, /Nothing is published/);
  assert.match(admin, /h\("legend"/);
  assert.match(admin, /"aria-invalid"/);
  assert.match(admin, /setAttribute\("aria-describedby", `\$\{id\}-help`\)/);
  assert.match(admin, /class: "oba-error", role: "alert", tabindex: "-1"/);
  assert.match(admin, /category: "Create", keywords: "shared reflection collaborate source video book"/);
});

const fakeElement = (id = "") => {
  const element = {
    id,
    attributes: {},
    focused: false,
    hidden: true,
    textContent: "",
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    focus() {
      this.focused = true;
    },
  };
  return element;
};

// Mirrors the DOM: a bare "#" is an invalid selector and throws.
const fakeRoot = (controls) => ({
  queried: [],
  querySelector(selector) {
    this.queried.push(selector);
    if (!/^#[A-Za-z][\w-]*$/.test(selector)) throw new SyntaxError(`'${selector}' is not a valid selector`);
    return controls.find((control) => `#${control.id}` === selector) || null;
  },
});

test("a problem without a known field is announced and focuses the alert", () => {
  for (const field of ["", undefined, "participants", '"><img src=x>']) {
    const status = fakeElement();
    const root = fakeRoot([fakeElement("oba-shared-title")]);
    const focused = showSharedReflectionProblem(root, status, { field, message: "The shared reflection could not be saved" });
    assert.equal(focused, status, String(field));
    assert.equal(status.focused, true);
    assert.equal(status.hidden, false);
    assert.equal(status.textContent, "The shared reflection could not be saved");
    assert.deepEqual(root.queried, []);
  }
});

test("a problem with a known field marks and focuses that control", () => {
  const status = fakeElement();
  const url = fakeElement("oba-shared-source-1-url");
  const root = fakeRoot([fakeElement("oba-shared-title"), url]);
  assert.equal(showSharedReflectionProblem(root, status, { field: "sources.1.url", message: "Source 2: paste a full web address." }), url);
  assert.equal(url.attributes["aria-invalid"], "true");
  assert.equal(url.focused, true);
  assert.equal(status.focused, false);
  assert.equal(status.textContent, "Source 2: paste a full web address.");
});

test("a refused or failed creation keeps the draft and maps the server problem", async () => {
  const cases = [
    [{ status: 422, data: { field: "sources.0.url", error: "Source 1: paste a full web address." } }, { field: "sources.0.url", message: "Source 1: paste a full web address." }],
    [{ status: 500, data: { error: "The shared reflection could not be saved" } }, { field: "", message: "The shared reflection could not be saved" }],
    [Object.assign(new Error("Failed to fetch"), { status: 0 }), { field: "", message: "Failed to fetch" }],
  ];
  for (const [error, expected] of cases) {
    const current = draft({ guidingQuestion: "What changed?" });
    const before = structuredClone(current);
    const calls = [];
    await submitSharedReflection(current, {
      post: async (json) => {
        calls.push(["post", json]);
        throw error;
      },
      created: async () => calls.push(["created"]),
      failed: (received, problem) => calls.push(["failed", received, problem]),
    });
    assert.deepEqual(current, before);
    assert.deepEqual(calls.map(([name]) => name), ["post", "failed"]);
    assert.deepEqual(calls[0][1], sharedReflectionPayload(before));
    assert.equal(calls[1][1], error);
    assert.deepEqual(calls[1][2], expected);
  }
  assert.deepEqual(sharedReflectionProblemFromError(undefined), { field: "", message: "The shared reflection could not be saved." });
});

test("a successful creation runs only the created step", async () => {
  const calls = [];
  await submitSharedReflection(draft(), {
    post: async () => calls.push("post"),
    created: async () => calls.push("created"),
    failed: () => calls.push("failed"),
  });
  assert.deepEqual(calls, ["post", "created"]);
});

test("the source limit matches the record and is explained when reached", () => {
  assert.equal(MAX_SHARED_SOURCES, 20);
  assert.match(admin, /addSource\.disabled = full/);
  assert.match(admin, /You can add up to \$\{MAX_SHARED_SOURCES\} sources\./);
  assert.match(admin, /addSource\.setAttribute\("aria-describedby", sourceLimit\.id\)/);
});

test("a refused Contributors save names the blocking posts or registry keys", () => {
  assert.equal(contributorSaveRefusalDetail({ contributors: ["grace", "linus"] }), " grace, linus");
  assert.equal(contributorSaveRefusalDetail({ paths: ["content/posts/a.md"] }), " content/posts/a.md");
  assert.equal(contributorSaveRefusalDetail({ error: "x" }), "");
  assert.equal(contributorSaveRefusalDetail(undefined), "");
  assert.equal(contributorSaveRefusalDetail({ contributors: [1, "", "ada"] }), " ada");
});

const suggestion = { provider: "youtube", provenance: "provider", title: "Remote title", creator: "Remote channel", publisher: "YouTube" };

test("provider suggestions fill only empty fields and never replace what the author typed", () => {
  const source = { ...emptySharedSource("video"), url: "https://youtu.be/dQw4w9WgXcQ", title: "My own title", creator: "   " };
  assert.deepEqual(applySourceSuggestion(source, suggestion), ["creator", "publisher"]);
  assert.equal(source.title, "My own title");
  assert.equal(source.creator, "Remote channel");
  assert.equal(source.publisher, "YouTube");
  // A second lookup changes nothing, and unlabelled data is ignored.
  assert.deepEqual(applySourceSuggestion(source, { ...suggestion, creator: "Other" }), []);
  assert.deepEqual(applySourceSuggestion(emptySharedSource(), { title: "x" }), []);
  assert.deepEqual(applySourceSuggestion(emptySharedSource(), { ...suggestion, title: 7 }).includes("title"), false);
});

test("a failed, refused, or unsupported lookup never blocks authoring or edits the source", async () => {
  const make = () => ({ ...emptySharedSource("video"), url: "https://youtu.be/dQw4w9WgXcQ", title: "Keep me" });
  for (const call of [
    async () => { throw new Error("offline"); },
    async () => ({ status: "unavailable", message: "The provider took too long to answer." }),
    async () => ({ status: "unsupported" }),
    async () => null,
  ]) {
    const source = make();
    const outcome = await lookupSourceDetails(source, call);
    assert.deepEqual(outcome.applied, []);
    assert.ok(outcome.message.length > 10);
    assert.deepEqual(source, make());
  }
  const none = await lookupSourceDetails(emptySharedSource(), async () => assert.fail("no link, no request"));
  assert.match(none.message, /Paste a link/);
  const found = make();
  const outcome = await lookupSourceDetails(found, async (body) => {
    assert.deepEqual(body, { url: "https://youtu.be/dQw4w9WgXcQ" });
    return { status: "found", suggestion };
  });
  assert.deepEqual(outcome.applied, ["creator", "publisher"]);
  assert.match(outcome.message, /Suggested by YouTube/);
  assert.equal(found.title, "Keep me");
});

test("the form offers the optional lookup and shows its outcome politely", () => {
  assert.match(admin, /Suggest details from link/);
  assert.match(admin, /collaboration\/publications\/source-metadata/);
  assert.match(admin, /lookup-status[\s\S]{0,120}aria-live/);
});

test("a lookup answer is dropped when the link changes or the source goes away mid-flight", async () => {
  const source = { ...emptySharedSource("video"), url: "https://youtu.be/dQw4w9WgXcQ" };
  const changed = await lookupSourceDetails(source, async () => {
    source.url = "https://youtu.be/other";
    return { status: "found", suggestion };
  });
  assert.deepEqual(changed.applied, []);
  assert.equal(changed.stale, true);
  assert.equal(source.creator, "");

  const removed = { ...emptySharedSource("video"), url: "https://youtu.be/dQw4w9WgXcQ" };
  let present = true;
  const gone = await lookupSourceDetails(removed, async () => {
    present = false;
    return { status: "found", suggestion };
  }, () => present);
  assert.deepEqual(gone.applied, []);
  assert.equal(removed.publisher, "");
});

test("applied suggestions are written to controls by identity and labelled until edited", () => {
  assert.match(admin, /suggestedControls\[key\]/);
  assert.match(admin, /control\?\.isConnected/);
  assert.match(admin, /Suggested by \$\{outcome\.provider\}/);
});
