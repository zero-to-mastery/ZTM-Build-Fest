import { html } from "../markdown/serialize.js";
import {
  languageAwareness,
  languages,
  translationReview,
  validateLocalization,
} from "./model.js";

const statusLabel = {
  observed: "Observed",
  "not-detected": "Not detected",
  unknown: "Unknown",
  available: "Available",
  unchanged: "Unchanged",
  changed: "Changed",
  added: "Added",
  removed: "Removed",
  reordered: "Reordered",
};

export function openTranslationReview(app) {
  const draft = app.store.draft;
  let localization;
  try {
    localization = validateLocalization(
      draft.metadata?.workspaceDocument?.localization,
    );
  } catch (error) {
    app.modal(
      `<h1>Translation review</h1><p role="status">${html(error.message)} Your Markdown and stored metadata are unchanged. Open Workspace documents to replace these settings explicitly.</p>`,
    );
    return;
  }
  if (!localization) {
    app.modal(
      '<h1>Translation review</h1><p role="status">This document has no language metadata. Open Workspace documents to select a language, an explicit target path, and an optional source document. Nothing changed.</p>',
    );
    return;
  }
  const language =
    languages.find(([id]) => id === localization.locale)?.[1] ||
    localization.locale;
  const awareness = languageAwareness(localization.locale, draft.markdown);
  const source = localization.sourceDocumentId
    ? app.data.drafts.find(
        (candidate) => candidate.id === localization.sourceDocumentId,
      )
    : null;
  const draftSource = draft.markdown;
  const sourceMarkdown = source?.markdown;
  const previousLocalization = JSON.stringify(localization);
  let review = null;
  let failure = "";
  if (localization.sourceDocumentId) {
    try {
      review = translationReview(source, draft);
    } catch (error) {
      failure = error.message;
    }
  }
  app.modal(`<h1>Translation review</h1>
    <p>${html(draft.name)} · ${html(language)}. Review is local and read-only until you explicitly acknowledge the current source revision.</p>
    <section aria-labelledby="language-awareness-title"><h2 id="language-awareness-title">Language-aware Health boundaries</h2>
      <ul>${awareness.structural
        .map(
          (item) =>
            `<li><strong>${html(item.label)} — ${statusLabel[item.status]}</strong><p>${html(item.detail)}</p></li>`,
        )
        .join("")}</ul>
      <p><strong>Language-sensitive guidance — ${statusLabel[awareness.languageSensitive.status]}</strong></p><p>${html(awareness.languageSensitive.detail)}</p>
    </section>
    <section aria-labelledby="translation-drift-title"><h2 id="translation-drift-title">Source changes since translation review</h2>
      ${
        !localization.sourceDocumentId
          ? "<p>This is a source edition; it has no upstream translation revision.</p>"
          : failure
            ? `<p>${html(failure)} The saved revision is preserved.</p>`
            : `<p>Source document: ${html(source.name)}. Revision ${review.changed ? "changed" : "is unchanged"}; section results are conservative and never edit either document.</p><ul>${review.findings
                .map(
                  (finding) =>
                    `<li data-translation-state="${finding.status}"><strong>${html(finding.title)} — ${statusLabel[finding.status]}</strong><p>${html(finding.reason)}</p></li>`,
                )
                .join(
                  "",
                )}</ul><label class="check"><input type="checkbox" data-translation-approve> I manually reviewed these source changes against this translation</label><button class="primary" data-translation-accept disabled>Mark current source revision reviewed</button>`
      }
    </section>
    <p data-translation-status role="status">Your Markdown is unchanged. No network request or publish action occurred.</p>`);
  const approve = app.querySelector("[data-translation-approve]");
  const accept = app.querySelector("[data-translation-accept]");
  if (approve && accept) {
    approve.onchange = () => {
      accept.disabled = !approve.checked;
    };
    accept.onclick = () => {
      if (!approve.checked) return;
      app.dispatchEvent(
        new CustomEvent("translation-review-accept", {
          detail: {
            draftId: draft.id,
            draftSource,
            sourceId: source.id,
            sourceMarkdown,
            previousLocalization,
            localization: review.nextLocalization,
          },
        }),
      );
    };
  }
  (approve || app.querySelector("[data-translation-status]")).focus();
}
