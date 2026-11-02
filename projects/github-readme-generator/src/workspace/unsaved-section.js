import { serializeBlock } from "../markdown/serialize.js";

// A section form's edits reach the README only through Save section (or Add
// to README). Export README, Copy Markdown, Save Studio project and the draft
// backups use the saved Source, so they ask first rather than leaving unsaved
// edits out without a word. Saving is always the author's explicit choice;
// nothing here changes a document.

// The Markdown a section would add, or null when its fields cannot produce
// any (the form shows why).
export function sectionMarkdown(block) {
  try {
    return serializeBlock(block);
  } catch {
    return null;
  }
}

// Whether `current` would change the README compared with the section as it
// was opened. Edits that serialize to the same Markdown change nothing in an
// export, so they do not count.
export function unsavedSection(opened, current) {
  return sectionMarkdown(current) !== opened;
}

// The tools that ask, by AppShell action. `verb` words the dialog's buttons.
const verbs = {
  download: { verb: "export", tool: "Export README" },
  copy: { verb: "copy", tool: "Copy Markdown" },
  "save-project": { verb: "continue", tool: "Save Studio project" },
  "backup-all": { verb: "download", tool: "Download all drafts backup" },
  backup: { verb: "download", tool: "Download draft backup" },
};
export const UNSAVED_SECTION_ACTIONS = Object.keys(verbs);

// The question asked before `action` runs while a section form has unsaved
// edits. `added` is false for a new section not yet added. When `valid` is
// false the fields cannot be saved, so there is no save choice (`save` is
// null) and the body says why.
export function unsavedSectionPrompt(
  action,
  { title, added = true, valid = true } = {},
) {
  const { verb, tool } = verbs[action] || verbs.download;
  const name = title ? `The ${title} section` : "This section";
  const save = added ? "Save section" : "Add section";
  return {
    heading: "Save your section edits first?",
    body: `${name} has edits that are not in your README yet. ${tool} uses only saved sections.${valid ? "" : " Some of its fields need fixing before it can be saved."}`,
    save: valid ? `${save} and ${verb}` : null,
    skip: `${verb[0].toUpperCase()}${verb.slice(1)} without these edits`,
    keep: "Keep editing",
    // Shown when the form is replaced (for example by a pane shortcut) while
    // the question is open, so the save choice can no longer reach it.
    closed: `The section form closed before its edits were saved, so nothing was saved and ${tool} did not run. Open the section again to redo the edits.`,
  };
}
