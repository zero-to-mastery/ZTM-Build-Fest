// The polished draft editor (ADR 0272): the author's own revision of one rough draft. It is used after a
// session locks and when a polished sample is opened from the library. The text is the author's, so the
// browser's spell-check is welcome here (the rough draft is the only text that turns it off). Saving is
// revision-checked by the server; this editor keeps a copy of unsaved edits on the device, offers it back
// after a reload, asks what to do when the draft changed somewhere else, and never loses edits typed while a
// save was in flight.

import { el } from "./block-forms.js";
import { PORTABLE_NOTE, PRIVATE_NOTE, ROUGH_NOTE, VOICE_LIMITS, byteLength, createPolishedDraftStore, polishedDirty, voiceErrorText, wordCount, wordsText } from "./voice.js";

let uid = 0;

/**
 * Keeps the action bar reachable on a phone (ADR 0276), as the landing builder's bar is: it floats at the bottom
 * of the screen, rides above the on-screen keyboard, and joins the flow of the page when its own height would
 * take more than 40% of the screen (wide fallback fonts, large text, a short screen), so it can never cover
 * the work. Returns the function that decides, for a caller that wants to run it again.
 */
export function keepBarReachable(bar, isCurrent) {
  if (!bar) return () => {};
  const viewport = globalThis.visualViewport;
  let observer = null;
  const stop = () => {
    observer?.disconnect?.();
    observer = null;
    globalThis.removeEventListener?.("resize", settle);
    viewport?.removeEventListener("resize", lift);
    viewport?.removeEventListener("scroll", lift);
  };
  function settle() {
    if (!isCurrent()) return stop();
    const height = bar.getBoundingClientRect?.().height ?? 0;
    bar.classList?.toggle?.("oba-voice-bar-static", height > globalThis.innerHeight * 0.4);
  }
  function lift() {
    if (!isCurrent()) return stop();
    if (!viewport) return;
    const covered = Math.max(0, Math.round(globalThis.innerHeight - viewport.height - viewport.offsetTop));
    bar.style.transform = covered ? `translateY(-${covered}px)` : "";
  }
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(settle);
    observer.observe(bar);
  }
  globalThis.addEventListener?.("resize", settle);
  viewport?.addEventListener("resize", lift);
  viewport?.addEventListener("scroll", lift);
  settle();
  settle.stop = stop;
  return settle;
}

/**
 * A locked rough draft, shown and never edited (ADR 0266, ADR 0272): the words in a labelled region that is a plain
 * `div` (nothing to type into, nothing for an extension to attach to), the sentence that says why, where it is kept
 * and a button that moves the pair to the other folder. `sample` is the rough sample as the server describes it
 * (`id`, `body`, `words`, `visibility`). Returns `{ element, status }`.
 */
export function buildRoughView({ api, sample }) {
  const id = `oba-voice-rough-${++uid}`;
  const where = el("p", { class: "oba-small", "data-voice-where": "true" });
  const paintWhere = () => {
    where.textContent = `${wordsText(sample.words)}. ${sample.visibility === "portable" ? PORTABLE_NOTE : PRIVATE_NOTE}`;
  };
  paintWhere();
  const status = el("p", { class: "oba-small", role: "status", "aria-live": "polite", "data-voice-move-status": "true" });
  const label = () => (sample.visibility === "portable" ? "Make private" : "Make portable");
  const move = el(
    "button",
    {
      class: "oba-btn",
      type: "button",
      "data-action": "voice-move",
      onClick: async () => {
        const to = sample.visibility === "portable" ? "private" : "portable";
        move.disabled = true;
        try {
          const reply = await api.call("POST", `voice/samples/${sample.id}/visibility`, { json: { visibility: to } });
          sample.visibility = reply.visibility;
          paintWhere();
          move.textContent = label();
          status.textContent = `Moved to ${sample.visibility}. The rough draft was copied byte for byte.`;
        } catch (error) {
          status.textContent = voiceErrorText(error);
        } finally {
          move.disabled = false;
        }
      },
    },
    label(),
  );
  const element = el(
    "section",
    { class: "oba-voice-rough", "aria-labelledby": `${id}-title`, "data-voice-rough-view": "true" },
    el("h3", { id: `${id}-title` }, "Rough draft"),
    el("p", { class: "oba-small", "data-voice-rough-note": "true" }, ROUGH_NOTE),
    el("div", { class: "oba-voice-rough-text", tabindex: "0", role: "region", "aria-label": "Your rough draft, locked and read only", "data-voice-rough-text": "true" }, sample.body),
    where,
    el("div", { class: "oba-landing-actions" }, move),
    status,
  );
  return { element, status };
}

/**
 * `rough` is `{ file, title, body }`, the locked rough draft. `polished` is the saved polished sample as the
 * server describes it, or null for a draft that has not been saved yet; it then starts as a copy of the rough
 * text. `heading` sets the section's heading text and `headingLevel` its level, so it fits the page it is on.
 * Returns `{ element, isDirty, isBusy, focus, current }`.
 */
export function createPolishedEditor({ api, user, rough, polished = null, storage, onChange = () => {}, onSaved = () => {}, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout, heading = "Your polished draft", headingLevel = 2 }) {
  const id = `oba-voice-polished-${++uid}`;
  const drafts = createPolishedDraftStore(`ob-voice-polished:${user}:${rough.file}`, storage);
  let saved = polished;
  let revision = polished?.revision ?? null;
  let baseline = polished ? { title: polished.title, body: polished.body } : { title: rough.title, body: rough.body };
  let busy = false;
  let timer = null;

  const title = el("input", { class: "oba-voice-title", id: `${id}-title`, type: "text", maxlength: "200", autocomplete: "off", "data-voice-polished-title": "true" });
  const body = el("textarea", { class: "oba-voice-body", id: `${id}-body`, rows: "12", autocomplete: "off", "aria-describedby": `${id}-help ${id}-count`, "data-voice-polished-body": "true" });
  const count = el("p", { class: "oba-small oba-voice-count", id: `${id}-count`, "data-voice-polished-count": "true" });
  const status = el("p", { class: "oba-voice-status oba-small", id: `${id}-status`, role: "status", "aria-live": "polite", "data-voice-polished-status": "true" });
  const dirtyNote = el("span", { class: "oba-small oba-voice-dirty", "data-voice-dirty": "true" });
  const restoreBox = el("div", { class: "oba-notice oba-voice-restore", role: "group", "aria-labelledby": `${id}-restore-title`, hidden: true, "data-voice-restore": "true" });
  const conflictBox = el("div", { class: "oba-error oba-voice-conflict", role: "group", "aria-labelledby": `${id}-conflict-title`, hidden: true, "data-voice-conflict": "true" });
  const resetBox = el("div", { class: "oba-notice oba-voice-reset", role: "group", "aria-labelledby": `${id}-reset-title`, hidden: true, "data-voice-reset": "true" });
  const saveButton = el("button", { class: "oba-btn oba-btn-primary", type: "button", "data-action": "save-polished", onClick: () => save() }, "Save polished draft");
  const resetButton = el("button", { class: "oba-btn", type: "button", "data-action": "reset-to-rough", onClick: () => askReset() }, "Reset to rough");

  const current = () => ({ title: title.value, body: body.value });
  const isDirty = () => polishedDirty(current(), baseline);
  const say = (text, kind = "small") => {
    status.className = `oba-voice-status oba-small${kind === "error" ? " oba-error" : kind === "ok" ? " oba-ok" : ""}`;
    status.textContent = text;
  };
  const fill = (values) => {
    title.value = values.title;
    body.value = values.body;
  };
  const renderState = () => {
    const bytes = byteLength(body.value);
    const words = wordCount(body.value);
    count.textContent = `${wordsText(words)}${bytes > VOICE_LIMITS.maxDraftBytes ? ". This is longer than a sample can hold; shorten it before saving." : ""}`;
    dirtyNote.textContent = isDirty()
      ? `You have unsaved changes. ${drafts.inMemoryOnly ? "This device would not keep a copy, so they are held only until you close or reload this page." : "A copy is kept on this device."}`
      : saved ? "All changes saved." : "Not saved yet. This starts as a copy of your rough draft.";
    resetButton.disabled = body.value === rough.body && title.value === rough.title;
  };
  const schedule = () => {
    clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      // An editor that was taken off the page (signing out, another view) writes nothing back.
      if (body.isConnected === false) return;
      if (isDirty()) drafts.save({ base: revision, ...current() });
      else drafts.clear();
    }, VOICE_LIMITS.localSaveMs);
  };
  const changed = () => {
    renderState();
    schedule();
    onChange(isDirty());
  };
  title.addEventListener("input", changed);
  body.addEventListener("input", changed);

  // ----- reset to the rough text
  function askReset() {
    if (!isDirty() && body.value === rough.body) return;
    resetBox.hidden = false;
    resetBox.replaceChildren(
      el("strong", { id: `${id}-reset-title`, tabindex: "-1" }, "Put your rough text back?"),
      el("p", {}, "This replaces what is in the editor with your rough draft. Your rough draft itself never changes, and nothing is saved until you press Save."),
      el(
        "div",
        { class: "oba-landing-actions" },
        el("button", { class: "oba-btn oba-btn-primary", type: "button", "data-action": "reset-confirm", onClick: () => {
          fill({ title: rough.title, body: rough.body });
          resetBox.hidden = true;
          changed();
          say("Your rough text is back in the editor. It is not saved yet.");
          body.focus();
        } }, "Replace with rough text"),
        el("button", { class: "oba-btn", type: "button", "data-action": "reset-cancel", onClick: () => {
          resetBox.hidden = true;
          resetButton.focus();
        } }, "Keep my edits"),
      ),
    );
    resetBox.querySelector("strong")?.focus();
  }

  // ----- restoring a copy kept on this device
  function offerRestore(copy) {
    restoreBox.hidden = false;
    restoreBox.replaceChildren(
      el("strong", { id: `${id}-restore-title` }, "Restore your unsaved changes?"),
      el("p", {}, copy.base === revision ? "A copy of edits you did not save is on this device." : "A copy of edits you did not save is on this device. The saved draft has changed since, so saving them will ask what to keep."),
      el(
        "div",
        { class: "oba-landing-actions" },
        el("button", { class: "oba-btn oba-btn-primary", type: "button", "data-action": "restore-draft", onClick: () => {
          fill(copy);
          // Edits made on top of an older draft are checked against that older draft, so a change made
          // elsewhere since then is a choice for the author and not an overwrite.
          revision = copy.base;
          restoreBox.hidden = true;
          renderState();
          onChange(isDirty());
          say("Your unsaved changes are back. They are not saved yet.");
          body.focus();
        } }, "Restore your unsaved changes"),
        el("button", { class: "oba-btn", type: "button", "data-action": "discard-draft", onClick: () => {
          drafts.clear();
          restoreBox.hidden = true;
          say("Threw away the unsaved changes.");
          body.focus();
        } }, "Discard them"),
      ),
    );
  }

  // ----- saving
  function applySaved(result, sent) {
    saved = result;
    revision = result.revision;
    baseline = { title: result.title, body: result.body };
    // Edits typed while the save was in flight stay: only an unchanged editor takes the saved text.
    const untouched = current().title === sent.title && current().body === sent.body;
    if (untouched) fill(baseline);
    conflictBox.hidden = true;
    conflictBox.replaceChildren();
    restoreBox.hidden = true;
    if (untouched) drafts.clear();
    else drafts.save({ base: revision, ...current() });
    return untouched;
  }
  async function save() {
    if (busy) return false;
    if (byteLength(body.value) > VOICE_LIMITS.maxDraftBytes) {
      say("Nothing was saved: this is longer than a sample can hold. Shorten it first.", "error");
      body.focus();
      return false;
    }
    if (!body.value.trim()) {
      say("Nothing was saved: the draft has no text.", "error");
      body.focus();
      return false;
    }
    busy = true;
    saveButton.disabled = true;
    say("Saving…");
    const sent = current();
    try {
      const result = saved
        ? await api.call("PUT", `voice/samples/${saved.id}`, { json: { revision, ...sent } })
        : await api.call("POST", "voice/samples", { json: { roughOf: rough.file, ...sent } });
      const untouched = applySaved(result, sent);
      renderState();
      onChange(isDirty());
      say(untouched ? "Saved." : "Saved. Changes you made while saving are still unsaved.", untouched ? "ok" : "small");
      onSaved(result);
      return untouched;
    } catch (error) {
      // Whatever went wrong, a copy of the work is on this device now.
      drafts.save({ base: revision, ...current() });
      if (error?.status === 409 && error.data?.conflict) showConflict(error.data.current);
      else say(voiceErrorText(error), "error");
      return false;
    } finally {
      busy = false;
      saveButton.disabled = false;
    }
  }

  // ----- the draft changed somewhere else
  function showConflict(latest) {
    conflictBox.hidden = false;
    const mine = current();
    conflictBox.replaceChildren(
      el("strong", { id: `${id}-conflict-title`, tabindex: "-1" }, "This polished draft was changed somewhere else"),
      el("p", {}, latest ? `Yours has ${wordsText(wordCount(mine.body))}. The saved one has ${wordsText(wordCount(latest.body))}. Nothing was lost: your edits are still here and a copy is on this device.` : "It was erased or replaced since you opened it. Your edits are still here."),
      el(
        "div",
        { class: "oba-landing-actions" },
        latest
          ? el("button", { class: "oba-btn oba-btn-primary", type: "button", "data-action": "keep-mine", onClick: () => {
              revision = latest.revision;
              saved = latest;
              conflictBox.hidden = true;
              save();
            } }, "Keep mine and save over it")
          : null,
        latest
          ? el("button", { class: "oba-btn", type: "button", "data-action": "use-saved", onClick: () => {
              saved = latest;
              revision = latest.revision;
              baseline = { title: latest.title, body: latest.body };
              fill(baseline);
              drafts.clear();
              conflictBox.hidden = true;
              renderState();
              onChange(false);
              say("Loaded the saved version. Your edits were discarded.");
              body.focus();
            } }, "Use the saved version")
          : null,
        el("button", { class: "oba-btn", type: "button", "data-action": "keep-editing", onClick: () => {
          conflictBox.hidden = true;
          body.focus();
        } }, "Keep editing"),
      ),
    );
    conflictBox.querySelector("strong")?.focus();
  }

  fill(baseline);
  renderState();
  const copy = drafts.load();
  if (copy && polishedDirty(copy, baseline)) offerRestore(copy);
  else if (copy) drafts.clear();

  const element = el(
    "section",
    { class: "oba-voice-polished", "aria-labelledby": `${id}-heading`, "data-voice-polished": "true" },
    el(`h${headingLevel}`, { id: `${id}-heading`, "data-voice-polish-heading": "true" }, heading),
    el("p", { class: "oba-small", id: `${id}-help` }, "This is yours to edit. It starts as a copy of your rough draft; fix typos, cut, reshape and give it a title. Your rough draft stays as it is."),
    restoreBox,
    el("div", { class: "oba-field" }, el("label", { for: `${id}-title` }, "Title"), title),
    el("div", { class: "oba-field" }, el("label", { for: `${id}-body` }, "Polished text"), body),
    count,
    resetBox,
    conflictBox,
    status,
    el("div", { class: "oba-voice-bar", "data-voice-bar": "true" }, dirtyNote, el("div", { class: "oba-landing-actions oba-voice-actions", role: "group", "aria-label": "Polished draft actions" }, saveButton, resetButton)),
  );
  return {
    element,
    isDirty,
    isBusy: () => busy,
    focus: () => body.focus(),
    current,
    save,
    bar: () => element.querySelector("[data-voice-bar]"),
  };
}
