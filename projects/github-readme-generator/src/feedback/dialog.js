import { version } from "../../package.json";
import { buildFeedbackDiagnostics } from "./diagnostics.js";

export function openFeedbackDiagnostics(app) {
  app.modal(
    `<h1>Local feedback export</h1><p>Nothing is recorded automatically. Nothing is sent by Studio. Choose what to include, review the redacted JSON, then download it yourself. The report accepts no free text and contains only coarse count buckets plus the allowlisted answers below; it never includes Markdown, draft names, repository names, URLs or credentials.</p><label class="check"><input type="checkbox" data-feedback-consent> I choose to create a local diagnostic</label><label>Task<select data-feedback-scenario><option value="">Prefer not to say</option><option value="authoring">Authoring</option><option value="import">Import</option><option value="offline-recovery">Offline recovery</option><option value="review">Review</option><option value="publishing-review">Publishing review</option></select></label><label>Outcome<select data-feedback-outcome><option value="">Prefer not to say</option><option value="completed">Completed</option><option value="completed-with-friction">Completed with friction</option><option value="not-completed">Not completed</option></select></label><fieldset><legend>What caused friction? (optional)</legend><label class="check"><input type="checkbox" data-feedback-friction value="navigation"> Navigation</label><label class="check"><input type="checkbox" data-feedback-friction value="wording"> Wording</label><label class="check"><input type="checkbox" data-feedback-friction value="keyboard"> Keyboard use</label><label class="check"><input type="checkbox" data-feedback-friction value="visual"> Visual clarity</label><label class="check"><input type="checkbox" data-feedback-friction value="recovery-copy"> Recovery wording</label><label class="check"><input type="checkbox" data-feedback-friction value="performance"> Performance</label></fieldset><button data-feedback-review disabled>Review local diagnostic</button><button data-feedback-download disabled>Download redacted diagnostic</button><p data-feedback-status role="status"></p><pre data-feedback-preview hidden></pre>`,
  );
  const consent = app.querySelector("[data-feedback-consent]"),
    review = app.querySelector("[data-feedback-review]"),
    download = app.querySelector("[data-feedback-download]"),
    preview = app.querySelector("[data-feedback-preview]"),
    status = app.querySelector("[data-feedback-status]");
  let report = null;
  const invalidate = () => {
    report = null;
    review.disabled = !consent.checked;
    download.disabled = true;
    preview.hidden = true;
    preview.textContent = "";
    status.textContent = consent.checked
      ? "Ready to create a local preview."
      : "Opt in to create a report.";
  };
  app
    .querySelectorAll(
      "[data-feedback-consent],[data-feedback-scenario],[data-feedback-outcome],[data-feedback-friction]",
    )
    .forEach((field) => field.addEventListener("input", invalidate));
  review.onclick = () => {
    const drafts = app.data.drafts || [];
    report = buildFeedbackDiagnostics({
      consent: consent.checked,
      appVersion: version,
      online: navigator.onLine,
      storageStatus: app.storageBlocked
        ? "temporary"
        : app.saveFailed
          ? "failed"
          : "saved",
      reducedMotion:
        app.data.settings.reduceMotion === true ||
        matchMedia("(prefers-reduced-motion: reduce)").matches,
      draftCount: drafts.length,
      totalMarkdownLength: drafts.reduce(
        (total, draft) => total + (draft.markdown?.length || 0),
        0,
      ),
      blockCount: drafts.reduce(
        (total, draft) => total + (draft.blocks?.length || 0),
        0,
      ),
      scenario: app.querySelector("[data-feedback-scenario]").value,
      outcome: app.querySelector("[data-feedback-outcome]").value,
      friction: [
        ...app.querySelectorAll("[data-feedback-friction]:checked"),
      ].map((field) => field.value),
    });
    preview.textContent = JSON.stringify(report, null, 2);
    preview.hidden = false;
    download.disabled = false;
    status.textContent =
      "Review complete. Nothing has been sent or saved by Studio.";
  };
  download.onclick = () => {
    if (!report) return;
    app.download(
      JSON.stringify(report, null, 2),
      "readme-studio-feedback.json",
      "application/json",
    );
  };
  invalidate();
  consent.focus();
}
