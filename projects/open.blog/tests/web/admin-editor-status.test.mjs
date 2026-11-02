import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const admin = readFileSync(new URL("../../web/admin/admin.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../web/admin/admin.css", import.meta.url), "utf8");

test("editor reports document size and save state", () => {
  assert.match(admin, /ui\.documentStats/);
  assert.match(admin, /updateDocumentStats\(\)/);
  assert.match(admin, /\$\{lines\} line\$\{lines === 1/);
  assert.match(admin, /Unsaved changes/);
  assert.match(admin, /Saving…/);
  assert.match(admin, /Saved/);
  assert.match(admin, /const saveVersion = this\.app\.editVersion/);
  assert.match(admin, /saveStateForVersions\(saveVersion, this\.app\.editVersion\)/);
  assert.match(admin, /this\.app\.dirty = savedState\.dirty/);
  assert.match(admin, /if \(this\.saving \|\| this\.reviewing\) return/);
  assert.match(admin, /Saved the earlier version\. Your newer edits are still unsaved\./);
  assert.match(admin, /if \(this\.ui\.saveState\.textContent === "Unsaved changes"\) return/);
  assert.match(styles, /\.oba-editor-status/);
  assert.match(styles, /\.oba-save-state\.is-dirty/);
});

test("editor panes can be focused from Alt number shortcuts", () => {
  assert.match(admin, /e\.altKey && \["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"\]\.includes\(e\.key\)/);
  assert.match(admin, /\["write", "preview", "social", "release", "field", "optimize", "settings", "accessibility", "evidence"\]/);
  assert.match(admin, /e\.key === "0" \? "assistant"/);
  assert.match(admin, /this\.editor\.activatePane\(pane, true\)/);
  assert.match(admin, /target\?\.focus\(\)/);
});

test("Evidence Studio reports shared research findings without authority scoring", () => {
  assert.match(admin, /"data-pane": "evidence"/);
  assert.match(admin, /Evidence Studio/);
  assert.match(admin, /preview\.evidence/);
  assert.match(admin, /evidenceReview/);
  assert.match(admin, /does not score truth, authority, peer review, or claim support/);
  assert.match(admin, /insertResearchSection/);
  assert.doesNotMatch(admin, /evidenceScore/);
});

test("Accessibility Studio reports source findings without claiming conformance", () => {
  assert.match(admin, /"data-pane": "accessibility"/);
  assert.match(admin, /Accessibility Studio/);
  assert.match(admin, /No issues detected by the checks that ran\./);
  assert.match(admin, /does not test every accessibility requirement or certify WCAG conformance/);
  assert.match(admin, /preview\.accessibility/);
  assert.match(admin, /accessibilityReview/);
  assert.match(admin, /ui\.accessibilityFindings = h\("div", \{ class: "oba-accessibility-findings" \}\)/);
  assert.doesNotMatch(admin, /accessibilityScore/);
  assert.match(styles, /\.oba-accessibility-workspace/);
  assert.match(styles, /\.oba-accessibility-finding/);
});

test("optimizer separates search, answer, and trust guidance", () => {
  assert.match(admin, /"data-pane": "optimize"/);
  assert.match(admin, /SEO & answer readiness/);
  assert.match(admin, /Heuristic guidance, not a ranking guarantee/);
  assert.match(admin, /analyzeReadiness/);
  assert.match(styles, /\.oba-optimize-workspace/);
});

test("writer exposes source-preserving formatting controls", () => {
  assert.match(admin, /"aria-label": "Writing formatting"/);
  assert.match(admin, /this\.formatMarkdown\(command\)/);
  assert.match(admin, /document\.execCommand\("insertText", false, replacement\)/);
  assert.match(admin, /body\.setRangeText\(replacement/);
  assert.match(admin, /if \(!inputFired\) body\.dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/);
  assert.match(admin, /event\.key\.toLowerCase\(\) === "b"/);
  assert.match(styles, /\.oba-format-toolbar/);
});

test("writer offers a remembered visual mode without replacing Markdown storage", () => {
  assert.match(admin, /this\.app\.preferences\.editorMode/);
  assert.match(admin, /persistEditorMode\(mode\)/);
  assert.match(admin, /\["visual", "markdown"\]/);
  assert.match(admin, /contenteditable: "true"/);
  assert.match(admin, /Visual/);
  assert.match(admin, /Markdown/);
  assert.match(admin, /Paragraph/);
  assert.match(admin, /Heading 6/);
  assert.match(admin, /Edit in Markdown/);
  assert.match(admin, /ui\.body\.value = this\.richEditorMarkdown\(\)/);
  assert.match(styles, /\.oba-rich-body/);
  assert.match(styles, /\.oba-protected-block/);
});

test("social preview displays publishing-engine OpenGraph metadata", () => {
  assert.match(admin, /"data-pane": "social"/);
  assert.match(admin, /preview\.social/);
  assert.match(admin, /Matches generated OpenGraph metadata/);
  assert.match(admin, /ui\.socialCardPreview = h\(/);
  assert.match(admin, /ui\.socialCardType = h\("dd"/);
  assert.match(admin, /ui\.socialCardType\.textContent = social\.card/);
  assert.match(admin, /ui\.socialCardPreview\.setAttribute\("aria-busy"/);
  assert.match(styles, /\.oba-social-card/);
  assert.match(styles, /aspect-ratio:\s*1\.91 \/ 1/);
});

test("preview width controls expose wide, tablet, and mobile canvases", () => {
  assert.match(admin, /"aria-label": "Preview width"/);
  assert.match(admin, /\["wide", "tablet", "mobile"\]/);
  assert.match(admin, /this\.root\.dataset\.previewWidth = ui\.previewWidth\.value/);
  assert.match(styles, /data-preview-width="tablet"/);
  assert.match(styles, /data-preview-width="mobile"/);
});
