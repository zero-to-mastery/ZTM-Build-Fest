import assert from "node:assert/strict";
import test from "node:test";

import {
  ObAdmin,
  Editor,
  accessibilityReview,
  assistantContextDisclosure,
  postContextFields,
  assistantStatusPresentation,
  evidenceReview,
  evidenceStudioState,
  fieldJournalReview,
  applyPaneSelection,
  applyProfileFieldDrafts,
  analyzeGpx,
  buildVideoReleaseKit,
  creditHasAuthor,
  creditPayload,
  contributorDraftPayload,
  contributorSaveState,
  focusCreditControl,
  moveCredit,
  normalizeStatusFilter,
  normalizeCreditDraft,
  normalizeContributorDraft,
  parseAdminHash,
  preserveProfileFieldDrafts,
  destinationPolicyForDisplay,
  destinationTagsForDisplay,
  destinationContentForDisplay,
  portabilityAcknowledgementScope,
  portabilityGroups,
  portabilitySourceSelection,
  portableDiagnosticsForDisplay,
  portablePreviewArtifact,
  previewWarningsForDisplay,
  resolveProfileSelection,
  researchSectionIsPresent,
  researchActionIsCurrent,
  saveStateForVersions,
  toggleCreditRole,
  validateCreditDraft,
  validateContributorDraft,
} from "../../web/admin/admin.js";

test("assistant context disclosure names selected documents, visibility, and character counts", () => {
  assert.deepEqual(
    assistantContextDisclosure(
      [
        { id: "portable:author", name: "author.md", visibility: "portable", characters: 120, exists: true, valid: true },
        { id: "private:site", name: "site.md", visibility: "private", characters: 48, exists: true, valid: true },
        { id: "private:author", name: "author.md", visibility: "private", characters: 0, exists: true, valid: false },
      ],
      new Set(["portable:author", "private:site", "private:author"]),
    ),
    {
      documents: [
        { name: "author.md", visibility: "portable", characters: 120 },
        { name: "site.md", visibility: "private", characters: 48 },
      ],
      totalCharacters: 168,
    },
  );
});

test("assistant disclosure includes selected references and immutable post snapshots", () => {
  assert.deepEqual(
    assistantContextDisclosure(
      [
        { id: "portable:reference:notes.md", name: "notes.md", visibility: "portable", kind: "reference", characters: 18, exists: true, valid: true },
        { id: "post:posts/lesson.md", name: "lesson.md", path: "posts/lesson.md", visibility: "source", kind: "postSnapshot", characters: 42, exists: true, valid: true },
      ],
      new Set(["portable:reference:notes.md", "post:posts/lesson.md"]),
    ),
    {
      documents: [
        { name: "notes.md", visibility: "portable", characters: 18, kind: "reference", path: undefined },
        { name: "lesson.md", visibility: "source", characters: 42, kind: "postSnapshot", path: "posts/lesson.md" },
      ],
      totalCharacters: 60,
    },
  );
});

test("post context fields round-trip from the spec-defined Markdown headings", () => {
  assert.deepEqual(
    postContextFields("## Goal\n\nTeach context.\n\n## Audience\n\nAuthors\n\n## Learning outcomes\n\nSelect sources.\n\n## Sources\n\nSpec\n\n## Constraints\n\nStay bounded.\n"),
    {
      goal: "Teach context.",
      audience: "Authors",
      learningOutcomes: "Select sources.",
      sources: "Spec",
      constraints: "Stay bounded.",
    },
  );
  assert.equal(
    postContextFields("<!-- openblog:constraints:start -->\n## Constraints\n\nKeep this heading:\n\n## Required examples\n\nTwo.\n<!-- openblog:constraints:end -->\n").constraints,
    "Keep this heading:\n\n## Required examples\n\nTwo.",
  );
});

test("assistant provider status presents configured and unconfigured states without credentials", () => {
  assert.deepEqual(
    assistantStatusPresentation({
      providerType: "generic-https",
      model: "story-model",
      destination: "https://assistant.example",
      configured: true,
      message: "Assistant provider is ready.",
      capabilities: { review: false, interactions: true, context: false, knowledgeChecks: true },
    }),
    {
      providerType: "Custom HTTPS",
      model: "story-model",
      destination: "https://assistant.example",
      configured: "Configured",
      statusLabel: "Ready",
      statusTone: "ready",
      capabilities: "Interactions, Knowledge checks",
      message: "Assistant provider is ready.",
    },
  );

  assert.deepEqual(
    assistantStatusPresentation({ providerType: "generic-https", model: "", configured: false, destination: null, capabilities: {} }),
    {
      providerType: "Custom HTTPS",
      model: "Provider default",
      destination: "Not configured",
      configured: "Not configured",
      statusLabel: "Setup needed",
      statusTone: "missing",
      capabilities: "No generation capabilities",
      message: "Assistant provider is not configured. Non-AI authoring remains available.",
    },
  );
});

test("portable preview diagnostics retain source scope and severity in readable warnings", () => {
  assert.deepEqual(
    portableDiagnosticsForDisplay([
      {
        code: "canonical-only-interaction",
        severity: "warning",
        sourcePath: "posts/lesson.md",
        message: "Timeline remains on the canonical article.",
        recommendedAction: "Keep the canonical link.",
      },
      { code: "invalid", message: "" },
      null,
    ]),
    ["posts/lesson.md: warning: Timeline remains on the canonical article. Action: Keep the canonical link."],
  );
});

test("portable preview shows exactly the selected representation without changing the draft", () => {
  const frame = {
    hidden: false,
    removeAttribute(name) { delete this[name]; },
  };
  const editor = {
    ui: {
      preview: frame,
      previewMarkdown: { hidden: true, textContent: "", setAttribute() {} },
      previewCopy: { disabled: true },
      previewDownload: { disabled: true },
      previewMode: { value: "portable-html" },
      previewTheme: { textContent: "" },
    },
    previewResult: {
      social: { title: "A <lesson>" },
      previewUrl: "/admin/preview/native",
      theme: "paper",
      portablePreview: { html: "<p>Public</p>", markdown: "**Public**", text: "Public" },
    },
  };
  Editor.prototype.showPreviewRepresentation.call(editor);
  assert.equal(frame.hidden, false, "HTML preview must be visible");
  assert.equal(editor.ui.previewMarkdown.hidden, true);
  assert.match(frame.srcdoc, /A &lt;lesson&gt;/);
  assert.equal(editor.ui.previewCopy.disabled, false);
  for (const mode of ["portable-markdown", "portable-text"]) {
    editor.ui.previewMode.value = mode;
    Editor.prototype.showPreviewRepresentation.call(editor);
    assert.equal(frame.hidden, true);
    assert.equal(editor.ui.previewMarkdown.hidden, false);
    assert.equal(editor.ui.previewMarkdown.textContent, mode === "portable-text" ? "Public" : "**Public**");
  }
  editor.ui.previewMode.value = "site";
  Editor.prototype.showPreviewRepresentation.call(editor);
  assert.equal(frame.hidden, false);
  assert.equal(editor.ui.previewMarkdown.hidden, true);
  assert.equal(frame.src, "/admin/preview/native");
  assert.equal(frame.srcdoc, undefined);
  assert.equal(editor.ui.previewCopy.disabled, true);
});

test("portable export actions use exact preview bytes and fail closed for unavailable policies", () => {
  const preview = { portablePreview: {
    html: "<p>&lt;script&gt;</p>",
    markdown: "```html\n<script>\n```",
    text: "Literal <script>",
    destinations: [
      { version: 1, provider: "ghost", representation: "portable-html" },
      { version: 1, provider: "medium", representation: "manual-markdown" },
      { version: 2, provider: "dev", representation: "portable-markdown" },
    ],
  } };
  assert.deepEqual(portablePreviewArtifact(preview, "portable-text"), {
    content: "Literal <script>", extension: "txt", mime: "text/plain;charset=utf-8",
  });
  assert.equal(portablePreviewArtifact(preview, "destination:ghost").content, preview.portablePreview.html);
  assert.equal(portablePreviewArtifact(preview, "destination:medium").content, preview.portablePreview.markdown);
  assert.equal(portablePreviewArtifact(preview, "destination:unknown"), null);
  assert.equal(portablePreviewArtifact(preview, "destination:dev"), null);
  assert.equal(portablePreviewArtifact(preview, "site"), null);
  assert.equal(portablePreviewArtifact(null, "portable-text"), null);
  const editor = {
    previewRequest: 7,
    previewResult: preview,
    root: { dataset: { editorView: "write" } },
    ui: { previewCopy: { disabled: false }, previewDownload: { disabled: false } },
  };
  Editor.prototype.schedulePreview.call(editor);
  assert.equal(editor.previewResult, null);
  assert.equal(editor.ui.previewCopy.disabled, true);
  assert.equal(editor.ui.previewDownload.disabled, true);
  assert.ok(editor.previewRequest > 7);
});

test("portable copy and download actions preserve bytes, clean URLs, and announce failures", async (t) => {
  const copied = [];
  const attributes = {};
  let clicked = false;
  let removed = false;
  let blob;
  let revoked;
  for (const [key, value] of Object.entries({
    navigator: { clipboard: { async writeText(content) { copied.push(content); } } },
    document: {
      createElement: () => ({
        setAttribute(key, value) { attributes[key] = value; },
        click() { clicked = true; },
        remove() { removed = true; },
      }),
      body: { append() {} },
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  t.mock.method(URL, "createObjectURL", (value) => { blob = value; return "blob:test"; });
  t.mock.method(URL, "revokeObjectURL", (value) => { revoked = value; });
  t.mock.method(globalThis, "setTimeout", (callback) => { callback(); return 0; });
  const editor = {
    previewResult: { portablePreview: { text: "Literal <script>\n42\n" } },
    ui: { previewMode: { value: "portable-text" }, previewTheme: {} },
  };
  await Editor.prototype.exportPreviewArtifact.call(editor, false);
  assert.deepEqual(copied, ["Literal <script>\n42\n"]);
  assert.match(editor.ui.previewTheme.textContent, /copied; source unchanged/);
  await Editor.prototype.exportPreviewArtifact.call(editor, true);
  assert.equal(await blob.text(), copied[0]);
  assert.equal(blob.type, "text/plain;charset=utf-8");
  assert.equal(attributes.download, "portable-preview.txt");
  assert.equal(clicked, true);
  assert.equal(removed, true);
  assert.equal(revoked, "blob:test");
  navigator.clipboard.writeText = async () => { throw new Error("permission denied"); };
  await Editor.prototype.exportPreviewArtifact.call(editor, false);
  assert.match(editor.ui.previewTheme.textContent, /Portable export failed: permission denied/);
  editor.previewResult = null;
  await Editor.prototype.exportPreviewArtifact.call(editor, true);
  assert.match(editor.ui.previewTheme.textContent, /Render a current portable preview/);
});

test("destination preview policy discloses canonical behavior and manual workflows", () => {
  const policies = [
    {
      version: 1,
      provider: "wordpress",
      label: "WordPress",
      representation: "portable-html",
      canonicalBehavior: "WordPress core cannot set an external canonical URL.",
      workflow: "Remote draft by default.",
    },
    {
      version: 1,
      provider: "medium",
      label: "Medium",
      representation: "manual-markdown",
      canonicalBehavior: "Check the canonical URL during import.",
      workflow: "Manual import only.",
    },
  ];
  assert.deepEqual(destinationPolicyForDisplay(policies, "destination:wordpress"), [
    "WordPress: WordPress core cannot set an external canonical URL.",
    "WordPress: Remote draft by default.",
  ]);
  assert.deepEqual(destinationPolicyForDisplay(policies, "destination:medium"), [
    "Medium: Check the canonical URL during import.",
    "Medium: Manual import only.",
  ]);
  assert.deepEqual(destinationPolicyForDisplay([], "destination:unknown"), [
    "Destination policy is unavailable; do not publish until the policy can be loaded.",
  ]);
  assert.match(destinationPolicyForDisplay([{
    version: 1, provider: "hashnode", label: "Hashnode",
    canonicalBehavior: "Canonical URL is retained.", workflow: "Draft only.",
    maxRequestBodyBytes: 100000,
  }], "destination:hashnode")[2], /100000-byte limit.*cannot certify request size/);
  const futurePolicy = [{ version: 2, provider: "medium", representation: "manual-markdown" }];
  assert.match(destinationPolicyForDisplay(futurePolicy, "destination:medium")[0], /unavailable/);
  assert.equal(portabilityAcknowledgementScope(futurePolicy, "destination:medium"), null);
  assert.deepEqual(portabilityAcknowledgementScope(policies, "destination:medium"), {
    destination: "medium",
    representation: "manual-markdown",
  });
  assert.deepEqual(portabilityAcknowledgementScope(policies, "portable-html"), {
    destination: "portable-export",
    representation: "portable-html",
  });
  assert.deepEqual(portabilityAcknowledgementScope(policies, "portable-text"), {
    destination: "portable-export",
    representation: "portable-text",
  });
  assert.equal(portabilityAcknowledgementScope(policies, "site"), null);
});

test("destination tag review shows selected metadata, omissions, and blocking errors only for its provider", () => {
  const plans = [{
    policy: { version: 1, provider: "dev", label: "DEV" },
    tags: ["Rust", "<invalid>"],
    omittedTags: ["fifth"],
    diagnostics: [{
      code: "destination-tag-invalid", severity: "error", sourcePath: "posts/lesson.md",
      message: "Invalid DEV tag.", recommendedAction: "Choose a valid tag.",
    }],
  }];
  const display = destinationTagsForDisplay(plans, "destination:dev");
  assert.match(display[0], /Rust, <invalid>.*Omitted tags: fifth/);
  assert.match(display[1], /posts\/lesson.md: error: Invalid DEV tag.*Choose a valid tag/);
  assert.deepEqual(destinationTagsForDisplay(plans, "portable-markdown"), []);
  assert.deepEqual(destinationTagsForDisplay(plans, "destination:hashnode"), []);
  plans[0].policy.version = 2;
  assert.deepEqual(destinationTagsForDisplay(plans, "destination:dev"), []);
});

test("portable findings group deterministic capability levels without scores and navigate Unicode source without edits", () => {
  const diagnostic = { capabilityId: "knowledge-check", portabilityLevel: "gracefully-transformed", message: "Static answer." };
  const preview = { portablePreview: {
    destinations: [{ version: 1, provider: "dev", representation: "portable-markdown" }],
    diagnosticsByRepresentation: { "portable-markdown": [diagnostic, diagnostic] },
  } };
  const groups = portabilityGroups(preview, "destination:dev");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].diagnostics.length, 2);
  assert.equal(groups[0].level, "gracefully-transformed");
  assert.equal(groups[0].destination, "dev");
  assert.equal(groups[0].representation, "portable-markdown");
  assert.deepEqual(portabilityGroups(preview, "site"), []);
  assert.equal(portabilityGroups({ portablePreview: { diagnostics: [diagnostic] } }, "site")[0].level,
    "gracefully-transformed", "native previews retain the existing portability warning visibility");
  const body = "😀 heading\n> ```quiz\n> Question?\n> ```\n";
  const range = { startLine: 2, startColumn: 3, endLine: 4, endColumn: 6 };
  const selection = portabilitySourceSelection(body, range);
  assert.equal(body.slice(selection.start, selection.end), "```quiz\n> Question?\n> ```");
  assert.equal(portabilitySourceSelection(body, { ...range, startLine: 99 }), null);
  const calls = [];
  const editor = {
    previewResult: preview,
    syncRichToMarkdown() { calls.push("sync"); },
    setEditorMode(mode) { calls.push(mode); },
    activatePane(pane) { calls.push(pane); },
    ui: {
      body: { value: body, setSelectionRange(start, end) { calls.push({ start, end }); }, focus() { calls.push("focus"); } },
      live: {}, previewTheme: {},
    },
  };
  Editor.prototype.navigatePortabilitySource.call(editor, range, preview);
  assert.deepEqual(calls, ["sync", "markdown", "write", selection, "focus"]);
  assert.equal(editor.ui.body.value, body);
  assert.match(editor.ui.live.textContent, /line 2.*unchanged/);
  calls.length = 0;
  Editor.prototype.navigatePortabilitySource.call(editor, range, {});
  assert.deepEqual(calls, []);
  assert.match(editor.ui.previewTheme.textContent, /Source changed/);
});

test("destination content findings disclose hosted-media uncertainty and stay scoped and literal", () => {
  const plans = [
    { policy: { version: 1, provider: "ghost" }, diagnostics: [
      { sourcePath: "posts/media.md", severity: "warning", message: "Ghost source=html is lossy; <script>literal</script>." },
      { sourcePath: "posts/media.md", severity: "warning", message: "Hosted media bytes remain unverified." },
    ] },
    { policy: { version: 2, provider: "dev" }, diagnostics: [{ message: "Unknown policy" }] },
  ];
  const messages = destinationContentForDisplay(plans, "destination:ghost");
  assert.equal(messages.length, 2);
  assert.match(messages[0], /<script>literal<\/script>/);
  assert.match(messages[1], /unverified/);
  assert.deepEqual(destinationContentForDisplay(plans, "destination:dev"), []);
  assert.deepEqual(destinationContentForDisplay(plans, "site"), []);
  assert.deepEqual(destinationContentForDisplay(null, "destination:ghost"), []);
  const policies = [{ version: 1, provider: "ghost", label: "Ghost", conversionReview: "Lossy HTML to Lexical conversion." }];
  assert.ok(destinationPolicyForDisplay(policies, "destination:ghost").some((message) => message.includes("Lossy HTML")));
});

const SAMPLE_GPX = `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>
  <trkpt lat="42.0000" lon="-72.0000"><ele>100</ele><time>2026-10-23T10:00:00Z</time></trkpt>
  <trkpt lat="42.0010" lon="-72.0000"><ele>130</ele><time>2026-10-23T10:10:00Z</time></trkpt>
  <trkpt lat="42.0020" lon="-72.0000"><ele>120</ele><time>2026-10-23T10:20:00Z</time></trkpt>
  <trkpt lat="42.0030" lon="-72.0000"><ele>160</ele><time>2026-10-23T10:30:00Z</time></trkpt>
</trkseg></trk></gpx>`;

test("GPX analysis derives portable facts and enforces route privacy", () => {
  const exact = analyzeGpx(SAMPLE_GPX, { privacy: "exact" });
  assert.equal(exact.pointCount, 4);
  assert.ok(exact.distanceKm > 0.3 && exact.distanceKm < 0.4);
  assert.equal(exact.elevationGainM, 70);
  assert.equal(exact.durationSeconds, 1800);
  assert.match(exact.routeShape, /^0,/);
  assert.doesNotMatch(exact.routeShape, /42\.|-72\./, "published SVG data is normalized, never geographic coordinates");

  const trimmed = analyzeGpx(SAMPLE_GPX, { privacy: "trimmed", trimMeters: 100 });
  assert.ok(trimmed.keptPointCount < exact.pointCount);
  assert.ok(trimmed.routeShape);
  assert.equal(analyzeGpx(SAMPLE_GPX, { privacy: "hidden" }).routeShape, "");
  assert.throws(() => analyzeGpx("<html>not a track</html>"), /valid GPX track/);

  const split = analyzeGpx(`<gpx><trk><trkseg><trkpt lat="0" lon="0"></trkpt><trkpt lat="0" lon="0.001"></trkpt></trkseg><trkseg><trkpt lat="40" lon="40"></trkpt><trkpt lat="40" lon="40.001"></trkpt></trkseg></trk></gpx>`, { privacy: "approximate" });
  assert.ok(split.distanceKm < 0.3, "recording gaps between track segments are not counted");
  assert.equal(split.routeShape.split("|").length, 2, "each track segment remains visible without an invented connection");

  const trimmedSplit = analyzeGpx(`<gpx><trk><trkseg><trkpt lat="0" lon="0"></trkpt><trkpt lat="0" lon="0.001"></trkpt><trkpt lat="0" lon="0.002"></trkpt></trkseg><trkseg><trkpt lat="1" lon="1"></trkpt><trkpt lat="1" lon="1.001"></trkpt><trkpt lat="1" lon="1.002"></trkpt></trkseg></trk></gpx>`, { privacy: "trimmed", trimMeters: 50 });
  assert.equal(trimmedSplit.keptPointCount, 4, "privacy trimming removes only the overall route endpoints, not pause boundaries");
  assert.equal(trimmedSplit.routeShape.split("|").length, 2);
});

test("field review makes exact-location risk and missing observations explicit", () => {
  assert.equal(fieldJournalReview({ profile: "article" }).active, false);
  const review = fieldJournalReview({ profile: "field-journal", locationPrivacy: "exact", distanceKm: "3.4" });
  assert.equal(review.active, true);
  assert.match(review.issues.join(" "), /sensitive species/);
  assert.match(review.issues.join(" "), /conditions/);
  assert.doesNotMatch(fieldJournalReview({ profile: "field-journal", locationPrivacy: "hidden", location: "North woods", conditions: "Dry", distanceKm: "3.4" }).status, /^\d/);
});

test("video release kits compose copy and enforce YouTube chapter rules", () => {
  const kit = buildVideoReleaseKit({
    profile: "video",
    description: "Seven adventurers enter a forbidden ruin.",
    body: "## Chapters\n\n00:00 The gate opens\n00:14 A warning\n01:02 Into the ruin\n\n```text\n00:01 ignored code\n```",
    duration: "1 min 20 sec",
    aiDisclosure: "AI-assisted animation with human direction and editing.",
    productionStatus: "editing",
  });

  assert.equal(kit.active, true);
  assert.deepEqual(
    kit.chapters.map(({ label, seconds }) => ({ label, seconds })),
    [
      { label: "The gate opens", seconds: 0 },
      { label: "A warning", seconds: 14 },
      { label: "Into the ruin", seconds: 62 },
    ],
  );
  assert.deepEqual(kit.issues, []);
  assert.equal(kit.workflow.find((stage) => stage.stage === "editing").current, true);
  assert.equal(kit.workflow.find((stage) => stage.stage === "scheduled").complete, false);
  assert.equal(
    kit.description,
    "Seven adventurers enter a forbidden ruin.\n\nChapters\n00:00 The gate opens\n00:14 A warning\n01:02 Into the ruin\n\nAI assistance: AI-assisted animation with human direction and editing.",
  );

  assert.deepEqual(
    buildVideoReleaseKit({ profile: "video", body: "00:05 Late start\n00:10 Too close", duration: "1:15" }).issues,
    ["The first chapter must start at 00:00.", "Add at least three chapters.", "Keep every chapter at least 10 seconds long."],
  );
  assert.deepEqual(buildVideoReleaseKit({ profile: "video", body: "00:00 Intro\n00:20 Story\n01:00 Credits", duration: "1:05" }).issues, [
    "Keep every chapter at least 10 seconds long.",
  ]);
  assert.equal(buildVideoReleaseKit({ profile: "article", body: "00:00 Intro" }).active, false);
});

test("contributor drafts preserve stable ids and prefill editable identity fields", () => {
  const draft = normalizeContributorDraft({
    ada: { name: " Ada Lovelace ", url: "/people/ada/", sameAs: ["https://example.test/ada"], orcid: "0000-0002-1825-0097" },
  });
  assert.deepEqual(draft, [
    {
      id: "ada",
      originalId: "ada",
      name: " Ada Lovelace ",
      url: "/people/ada/",
      sameAs: "https://example.test/ada",
      orcid: "0000-0002-1825-0097",
    },
  ]);
  assert.equal(validateContributorDraft(draft), "");
  assert.deepEqual(contributorDraftPayload(draft), {
    ada: {
      name: "Ada Lovelace",
      url: "/people/ada/",
      sameAs: ["https://example.test/ada"],
      orcid: "0000-0002-1825-0097",
    },
  });
  assert.match(validateContributorDraft([{ ...draft[0], id: "Ada Lovelace" }]), /lowercase ASCII slug/);
  assert.match(validateContributorDraft([{ ...draft[0], id: "renamed", originalId: "ada" }]), /cannot be renamed/);
  assert.match(validateContributorDraft([{ ...draft[0], sameAs: "javascript:alert(1)" }]), /HTTP/);
});

test("late contributor saves retain newer edits and cannot alter a replacement view", () => {
  assert.deepEqual(contributorSaveState(2, 3, 7, 7), {
    active: true,
    dirty: true,
    label: "Unsaved changes",
    messageIsCurrent: false,
  });
  assert.deepEqual(contributorSaveState(2, 2, 7, 8), {
    active: false,
    dirty: null,
    messageIsCurrent: false,
  });
});

test("credit drafts preserve inherited, explicit empty, and ordered contributor semantics", () => {
  const credits = normalizeCreditDraft([
    { contributor: "ada", roles: [{ vocabulary: "crossref", role: "author" }] },
    { contributor: "grace", roles: [{ vocabulary: "credit", role: "software" }] },
    null,
  ]);
  assert.equal(creditPayload("unresolved", credits), undefined);
  assert.equal(creditPayload("inherited", credits), null);
  assert.deepEqual(creditPayload("explicit", []), []);
  assert.deepEqual(moveCredit(credits, 1, 0).map((credit) => credit.contributor), ["grace", "ada"]);
  assert.deepEqual(credits.map((credit) => credit.contributor), ["ada", "grace"], "moving does not mutate the saved draft");
});

test("controlled credit roles toggle without duplicates and validate author intent", () => {
  const author = { vocabulary: "crossref", role: "author" };
  const software = { vocabulary: "credit", role: "software" };
  let credit = { contributor: "ada", roles: [author] };
  credit = toggleCreditRole(credit, software, true);
  credit = toggleCreditRole(credit, software, true);
  assert.deepEqual(credit.roles, [author, software]);
  credit = toggleCreditRole(credit, author, false);
  assert.deepEqual(credit.roles, [software]);
  assert.equal(validateCreditDraft("unresolved", []), "Choose how to repair the malformed contributor credits.");
  assert.equal(validateCreditDraft("inherited", []), "");
  assert.equal(validateCreditDraft("explicit", []), "");
  assert.match(validateCreditDraft("explicit", [{ contributor: "ada", roles: [] }]), /at least one role/);
  assert.match(
    validateCreditDraft("explicit", [
      { contributor: "ada", roles: [author] },
      { contributor: "ada", roles: [software] },
    ]),
    /only once/,
  );
  assert.equal(creditHasAuthor([{ contributor: "ada", roles: [author] }], { ada: { name: "Ada" } }), true);
  assert.equal(creditHasAuthor([{ contributor: "ada", roles: [software] }], { ada: { name: "Ada" } }), false);
  assert.equal(creditHasAuthor([{ contributor: "missing", roles: [author] }], {}), false);
  assert.deepEqual(normalizeCreditDraft([{ contributor: "ada", roles: [author, author] }])[0].roles, [author]);
});

test("credit list rerenders restore keyboard focus to a row or the add control", () => {
  let selector = "";
  let rowFocused = false;
  let addFocused = false;
  const ui = {
    creditList: {
      querySelector: (value) => {
        selector = value;
        return { focus: () => (rowFocused = true) };
      },
    },
    addCredit: { focus: () => (addFocused = true) },
  };
  const immediately = (callback) => callback();
  focusCreditControl(ui, 2, immediately);
  assert.equal(selector, "#oba-credit-2-contributor");
  assert.equal(rowFocused, true);
  focusCreditControl(ui, -1, immediately);
  assert.equal(addFocused, true);
});

test("profile metadata drafts survive profile switches including explicit clears", () => {
  const saved = new Map([
    ["doi", "10.1000/original"],
    ["license", "https://creativecommons.org/licenses/by/4.0/"],
  ]);
  const switched = preserveProfileFieldDrafts(
    saved,
    new Map([
      ["doi", { value: "10.1000/revised" }],
      ["license", { value: "" }],
    ]),
  );

  assert.equal(switched.get("doi"), "10.1000/revised");
  assert.equal(switched.get("license"), "");
  assert.equal(saved.get("doi"), "10.1000/original");
  assert.deepEqual(
    applyProfileFieldDrafts(
      { title: "Study", doi: "10.1000/original", license: "https://example.test/old" },
      switched,
    ),
    { title: "Study", doi: "10.1000/revised" },
  );
});

test("toggling an open command palette closes it and restores its opener", () => {
  let closed = false;
  let removed = false;
  let focused = false;
  const activeDialog = {
    classList: { contains: (name) => name === "oba-command-dialog" },
    returnFocus: { focus: () => (focused = true) },
    close: () => (closed = true),
    remove: () => (removed = true),
  };
  const previousDocument = globalThis.document;
  globalThis.document = {
    activeElement: {},
    querySelector: () => activeDialog,
  };
  try {
    new ObAdmin().openCommandPalette();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  assert.deepEqual({ closed, removed, focused }, { closed: true, removed: true, focused: true });
});

test("rejecting dirty navigation preserves the editor route and state", async () => {
  const previousLocation = globalThis.location;
  const previousHistory = globalThis.history;
  let restoredHash = "";
  globalThis.location = { hash: "#/posts" };
  globalThis.history = { replaceState: (_state, _title, hash) => (restoredHash = hash) };
  try {
    const app = new ObAdmin();
    app.dirty = true;
    app.currentHash = "#/edit/posts%2Fdraft.md";
    app.confirmLeave = async () => false;
    await app.onHash();
    assert.equal(restoredHash, "#/edit/posts%2Fdraft.md");
    assert.equal(app.dirty, true);
    assert.equal(app.currentHash, "#/edit/posts%2Fdraft.md");
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousHistory === undefined) delete globalThis.history;
    else globalThis.history = previousHistory;
  }
});

test("an edit made during save remains dirty after the earlier response", () => {
  assert.deepEqual(saveStateForVersions(7, 7), { dirty: false, label: "Saved", messageIsCurrent: true });
  assert.deepEqual(saveStateForVersions(7, 8), { dirty: true, label: "Unsaved changes", messageIsCurrent: false });
});

test("editor view selection updates the container and every toggle", () => {
  const root = { dataset: { editorView: "write" } };
  const pressed = new Map();
  const buttons = ["write", "preview", "social", "optimize", "settings", "accessibility"].map((paneTarget) => ({
    dataset: { paneTarget },
    setAttribute: (name, value) => pressed.set(paneTarget, [name, value]),
  }));
  applyPaneSelection(root, buttons, "preview");
  assert.equal(root.dataset.editorView, "preview");
  assert.deepEqual(Object.fromEntries(pressed), {
    write: ["aria-pressed", "false"],
    preview: ["aria-pressed", "true"],
    social: ["aria-pressed", "false"],
    optimize: ["aria-pressed", "false"],
    settings: ["aria-pressed", "false"],
    accessibility: ["aria-pressed", "false"],
  });
});

test("accessibility findings are grouped by outcome with precise source labels", () => {
  assert.deepEqual(
    accessibilityReview([
      {
        code: "link-name-empty",
        outcome: "detected",
        scope: "content",
        source: { path: "posts/example.md", line: 7, column: 1, field: null },
        message: "This link has no accessible name.",
        repair: "Add descriptive link text.",
        references: ["WCAG-2.2-2.4.4"],
      },
      {
        code: "document-language-missing",
        outcome: "detected",
        scope: "site",
        source: { path: "openblog.json", line: null, column: null, field: "language" },
        message: "Generated pages have no configured default language.",
        repair: "Set the site language.",
        references: ["WCAG-2.2-3.1.1"],
      },
      {
        code: "image-alt-review",
        outcome: "needs-review",
        scope: "content",
        source: { path: "posts/example.md", line: 10, column: 1, field: null },
        message: "Review this image.",
        repair: "Decide whether it needs alternative text.",
        references: [],
      },
      { outcome: "unknown", message: "Ignore unsupported payloads" },
    ]),
    {
      total: 3,
      counts: { detected: 2, potential: 0, "needs-review": 1 },
      groups: [
        {
          outcome: "detected",
          label: "Detected",
          findings: [
            {
              code: "link-name-empty",
              outcome: "detected",
              scope: "content",
              sourceLabel: "posts/example.md:7:1",
              message: "This link has no accessible name.",
              repair: "Add descriptive link text.",
              references: ["WCAG-2.2-2.4.4"],
            },
            {
              code: "document-language-missing",
              outcome: "detected",
              scope: "site",
              sourceLabel: "openblog.json · language",
              message: "Generated pages have no configured default language.",
              repair: "Set the site language.",
              references: ["WCAG-2.2-3.1.1"],
            },
          ],
        },
        {
          outcome: "needs-review",
          label: "Needs review",
          findings: [
            {
              code: "image-alt-review",
              outcome: "needs-review",
              scope: "content",
              sourceLabel: "posts/example.md:10:1",
              message: "Review this image.",
              repair: "Decide whether it needs alternative text.",
              references: [],
            },
          ],
        },
      ],
    },
  );
});

test("evidence findings are grouped without inventing quality scores", () => {
  const review = evidenceReview([
    {
      code: "doi-invalid",
      outcome: "detected",
      source: { path: "posts/study.md", line: null, column: null, field: "doi" },
      message: "The DOI is malformed.",
      repair: "Use a DOI name or resolver URL.",
    },
    {
      code: "reference-link-review",
      outcome: "needs-review",
      source: { path: "posts/study.md", line: 14, column: 1, field: null },
      message: "This reference has no resolvable link.",
      repair: "Add a stable URL when one exists.",
    },
  ]);

  assert.equal(review.total, 2);
  assert.deepEqual(review.counts, { detected: 1, potential: 0, "needs-review": 1 });
  assert.equal(review.groups[0].findings[0].sourceLabel, "posts/study.md · doi");
  assert.equal(review.groups[1].findings[0].sourceLabel, "posts/study.md:14:1");
});

test("evidence studio distinguishes an inactive profile from a clean research audit", () => {
  assert.deepEqual(evidenceStudioState([], null), {
    active: false,
    status: "Evidence checks are not active for this content profile.",
    review: null,
  });
  assert.deepEqual(evidenceStudioState([], { referenceCount: 0 }), {
    active: true,
    status: "0 evidence findings",
    review: { total: 0, counts: { detected: 0, potential: 0, "needs-review": 0 }, groups: [] },
  });
});

test("research section presence comes from the publishing-engine evidence result", () => {
  const research = { referenceCount: 0 };
  assert.equal(researchSectionIsPresent([], research, "abstract"), true);
  assert.equal(researchSectionIsPresent([{ code: "abstract-missing" }], research, "abstract"), false);
  assert.equal(researchSectionIsPresent([{ code: "references-missing" }], research, "references"), false);
  assert.equal(researchSectionIsPresent([], null, "abstract"), null);
});

test("a delayed research action rejects a profile switch before its response", () => {
  const request = { version: 7, path: "posts/study.md", profile: "research", body: "Draft" };
  assert.equal(researchActionIsCurrent(request, { ...request }), true);
  assert.equal(researchActionIsCurrent(request, { ...request, version: 8, profile: "article" }), false);
  assert.equal(researchActionIsCurrent(request, { ...request, path: "posts/renamed.md" }), false);
});

test("overview drill-down routes retain validated status filters and issue focus", () => {
  const drafts = parseAdminHash("#/posts?status=draft");
  assert.equal(drafts.head, "posts");
  assert.equal(normalizeStatusFilter(drafts.params.get("status")), "draft");
  assert.equal(normalizeStatusFilter("unknown"), "all");
  const issues = parseAdminHash("#/overview?focus=issues");
  assert.equal(issues.head, "overview");
  assert.equal(issues.params.get("focus"), "issues");
});

test("profile selection honors canonical values and legacy recipes without losing unknown ids", () => {
  const profiles = [{ id: "article" }, { id: "recipe" }];
  assert.deepEqual(resolveProfileSelection({}, profiles), {
    value: "article",
    unknown: false,
  });
  assert.deepEqual(resolveProfileSelection({ recipe: "true" }, profiles, "recipe"), {
    value: "recipe",
    unknown: false,
  });
  assert.deepEqual(resolveProfileSelection({ profile: "Recipe" }, profiles), {
    value: "recipe",
    unknown: false,
  });
  assert.deepEqual(resolveProfileSelection({ profile: "field-notes", recipe: "true" }, profiles), {
    value: "field-notes",
    unknown: true,
  });
});

test("preview warnings preserve profile fallback and contradiction messages for display", () => {
  assert.deepEqual(
    previewWarningsForDisplay([
      "posts/log.md: unknown content profile `field-notes`; rendering as an article",
      "posts/log.md: profile `article` overrides the legacy recipe marker",
      42,
    ]),
    [
      "posts/log.md: unknown content profile `field-notes`; rendering as an article",
      "posts/log.md: profile `article` overrides the legacy recipe marker",
    ],
  );
});
