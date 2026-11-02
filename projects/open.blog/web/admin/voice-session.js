// <ob-voice-session>: the Voice view's session (ADR 0272). Three steps: draw three prompts and choose one,
// write a rough draft against a clock the server owns, then refine a polished copy of the locked rough
// draft. Nothing here edits rough text: the rough box turns off spell-check, autocorrect, autocapitalize
// and every writing assistant the browser lets a page refuse, and once the draft locks it is shown, not
// edited. Every rule about time and files lives on the server; this file displays it and asks.

import { el } from "./block-forms.js";
import { buildRoughView, createPolishedEditor, keepBarReachable } from "./voice-polished.js";
import {
  VOICE_LIMITS,
  createAnnouncer,
  createCountdown,
  createVoiceDraftStore,
  copyIsPastGrace,
  expiredPlan,
  formatClock,
  libraryHash,
  reconcileDraft,
  timerLabel,
  voiceErrorText,
  wordCount,
  wordsText,
} from "./voice.js";

let uid = 0;

/** What keeps the browser, and the tools that sit on top of it, away from the rough text. */
export const ROUGH_ATTRIBUTES = Object.freeze({
  spellcheck: "false",
  autocorrect: "off",
  autocapitalize: "off",
  autocomplete: "off",
  writingsuggestions: "false",
  "data-gramm": "false",
  "data-gramm_editor": "false",
  "data-enable-grammarly": "false",
  "data-voice-rough": "true",
});

const realClock = () => ({
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: (timer) => globalThis.clearInterval(timer),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
});

const one = (node, selector) => node.querySelector(selector);

const wordRange = (prompt) => (prompt.wordsMax ? `About ${prompt.wordsMin} to ${prompt.wordsMax} words.` : "");

/**
 * Returns `{ element, load, isDirty, isBusy, destroy }`. `api.call(method, path, { json })` is the Admin API.
 * `params` may name a `pack` to draw from. `go(hash)` moves to another Admin address.
 */
export function createVoiceSession({ api, user = "", params = new URLSearchParams(), go = () => {}, clock = realClock(), onDirty = () => {}, onAnnounce = () => {}, storage }) {
  const root = el("ob-voice-session", { class: "oba-voice", "data-voice-session": "true" });
  const stage = el("div", { class: "oba-voice-stage" });
  // One polite live region for the whole view, outside the steps so a message made as a step changes is still
  // read. The clock itself is not live: only the one-minute and thirty-second marks and the lock are said.
  const live = el("p", { class: "oba-sr", role: "status", "aria-live": "polite", "data-voice-announce": "true" });
  root.append(live, stage);
  const announce = (message) => {
    if (!message) return;
    live.textContent = "";
    live.textContent = message;
    onAnnounce(message, clock.now());
  };
  const base = `oba-voice-${++uid}`;
  let editor = null;
  let finishing = false;
  let stopTicking = () => {};
  let generation = 0;
  // A bounded copy of the rough draft on this device, one per site and sign-in (ADR 0273).
  const drafts = createVoiceDraftStore(`ob-voice-draft:${user}`, storage);

  const render = (...nodes) => {
    stopTicking();
    stopTicking = () => {};
    // A real DOM turns null and arrays into text, so only nodes are passed on.
    stage.replaceChildren(...nodes.flat().filter((node) => node !== null && node !== undefined && node !== false));
  };
  const heading = (text, id) => el("h2", { id, tabindex: "-1", "data-voice-heading": "true" }, text);
  const errorBox = (text) => el("p", { class: "oba-error", role: "alert", "data-voice-error": "true" }, text);

  async function load() {
    const mine = ++generation;
    finishing = false;
    editor = null;
    render(el("p", { class: "oba-small", role: "status", "data-voice-loading": "true" }, "Loading…"));
    try {
      // A copy on this device may hold more than the server does after a lost connection. If the time has
      // run out, the server still decides: it takes that text only within its grace, otherwise it locks what
      // it saved. Either way the page never gives time back.
      const local = drafts.load();
      if (local) {
        const standing = await api.call("GET", "voice/status");
        if (mine !== generation) return;
        if (!standing.session?.open && copyIsPastGrace(local)) drafts.clear();
        else if (expiredPlan(standing.session, local).useDevice) {
          try {
            const reply = await api.call("POST", "voice/session/lock", { json: { sessionId: standing.session.sessionId, text: local.text } });
            if (mine !== generation) return;
            drafts.clear();
            showRefine(reply.sample, { expired: reply.expired, resumed: true });
            return;
          } catch {
            // The server's own resume below locks from what it saved.
          }
        }
      }
      const answer = await api.call("GET", "voice/session");
      if (mine !== generation) return;
      enter(answer);
    } catch (error) {
      if (mine === generation) showProblem(error);
    }
  }

  function enter(answer) {
    // The time has just run out and another page may still be handing over its last words.
    if (answer.state === "finishing") return showFinishing(answer);
    // A session that is over leaves no copy behind: the locked draft is on the server.
    if (answer.state !== "active") drafts.clear();
    if (answer.state === "active") showWrite(answer);
    else if (answer.state === "locked") showRefine(answer.sample, { expired: answer.expired, resumed: true });
    else if (answer.state === "discarded") showDraw({ notice: "Your last session ran out of time with nothing written, so it was discarded." });
    else showDraw();
  }

  function showFinishing(answer) {
    const mine = generation;
    render(
      heading("Time is up", `${base}-heading`),
      el("p", { role: "status" }, "The page or window that was writing is handing over its last words. This page will check again in a moment."),
      el("button", { class: "oba-btn", type: "button", "data-action": "voice-retry", onClick: () => load() }, "Check again"),
    );
    clock.setTimeout(() => {
      if (mine === generation && root.isConnected !== false) load();
    }, Math.max(1, Number(answer.retryAfterSeconds) || 10) * 1000 + 500);
  }

  function showProblem(error) {
    render(
      heading("Voice", `${base}-heading`),
      errorBox(voiceErrorText(error)),
      el("button", { class: "oba-btn", type: "button", "data-action": "voice-retry", onClick: () => load() }, "Try again"),
    );
  }

  // ----- step 1: draw
  async function showDraw({ notice = "", focus = false } = {}) {
    const mine = ++generation;
    editor = null;
    finishing = false;
    let pack = params.get("pack") || null;
    let drawn;
    try {
      try {
        drawn = await api.call("POST", "voice/draw", { json: pack ? { pack } : {} });
      } catch (error) {
        // A pack the site no longer offers falls back to a draw from every pack.
        if (!pack || error.status !== 404) throw error;
        pack = null;
        drawn = await api.call("POST", "voice/draw", { json: {} });
      }
    } catch (error) {
      if (mine === generation) showProblem(error);
      return;
    }
    if (mine !== generation) return;
    let shown = drawn.prompts;
    let selected = null;
    let visibility = "private";
    const headingId = `${base}-draw`;
    const status = el("p", { class: "oba-small", role: "status", "aria-live": "polite", "data-voice-status": "true" });
    const cards = el("div", { class: "oba-voice-cards", "data-voice-cards": "true" });
    const startButton = el("button", { class: "oba-btn oba-btn-primary", type: "button", disabled: true, "data-action": "voice-start", onClick: () => start() }, "Start the 3:00 timer");
    const notices = el("div", { class: "oba-voice-notices" });
    const renderCards = () => {
      selected = null;
      startButton.disabled = true;
      cards.replaceChildren(
        el(
          "fieldset",
          { class: "oba-voice-fieldset" },
          el("legend", {}, "Choose one prompt"),
          el(
            "div",
            { class: "oba-voice-grid" },
            shown.map((prompt, index) =>
              el(
                "label",
                { class: "oba-voice-card", "data-prompt": prompt.id, for: `${base}-prompt-${index}` },
                el("input", {
                  type: "radio",
                  name: `${base}-prompt`,
                  id: `${base}-prompt-${index}`,
                  value: prompt.id,
                  onChange: () => {
                    selected = prompt.id;
                    startButton.disabled = false;
                  },
                }),
                el(
                  "span",
                  { class: "oba-voice-card-text" },
                  el("span", { class: "oba-voice-eyebrow" }, prompt.packTitle),
                  el("strong", { class: "oba-voice-card-title" }, prompt.title),
                  el("span", { class: "oba-voice-card-invitation" }, prompt.invitation),
                  el("span", { class: "oba-small" }, wordRange(prompt)),
                ),
              ),
            ),
          ),
        ),
      );
    };
    const redraw = async (button) => {
      button.disabled = true;
      try {
        const next = await api.call("POST", "voice/draw", { json: { exclude: shown.map((p) => p.id), ...(pack ? { pack } : {}) } });
        if (mine !== generation) return;
        shown = next.prompts;
        renderCards();
        status.textContent = "Drew three new prompts.";
        cards.querySelector("input")?.focus();
      } catch (error) {
        status.textContent = voiceErrorText(error);
      } finally {
        button.disabled = false;
      }
    };
    const redrawButton = el("button", { class: "oba-btn", type: "button", "data-action": "voice-redraw", onClick: () => redraw(redrawButton) }, "Draw three more");
    const choice = (value, label, note) =>
      el(
        "label",
        { class: "oba-voice-choice" },
        el("input", { type: "radio", name: `${base}-visibility`, value, checked: value === visibility, onChange: () => { visibility = value; } }),
        el("span", {}, el("strong", {}, label), el("span", { class: "oba-small" }, ` ${note}`)),
      );
    async function start() {
      if (!selected) return;
      startButton.disabled = true;
      status.textContent = "Starting…";
      try {
        const session = await api.call("POST", "voice/session/start", { json: { promptId: selected, visibility } });
        if (mine === generation) showWrite(session);
      } catch (error) {
        if (mine !== generation) return;
        startButton.disabled = false;
        if (error.status === 409 && error.data?.alreadyOpen) showOpen(error.data, notices);
        else status.textContent = voiceErrorText(error);
      }
    }
    renderCards();
    render(
      heading("Choose what to write about", headingId),
      notice ? el("p", { class: "oba-notice", role: "status", "data-voice-notice": "true" }, notice) : null,
      pack ? el("p", { class: "oba-notice", "data-voice-pack": pack }, "Drawing from one pack. ", el("a", { href: "#/voice" }, "Draw from every pack")) : null,
      el("p", { class: "oba-voice-rule", "data-voice-rule": "true" }, drawn.rule),
      el("p", { class: "oba-small" }, "You get three minutes. Write it the way you would say it; nothing is corrected, and it never becomes a post."),
      notices,
      cards,
      el(
        "fieldset",
        { class: "oba-voice-fieldset oba-voice-visibility" },
        el("legend", {}, "Where it is kept"),
        choice("private", "Private", "Only in this project's private folder. The default."),
        choice("portable", "Portable", "With your project's Assistant files, so it can be committed and shared."),
      ),
      status,
      el("div", { class: "oba-landing-actions oba-voice-actions", role: "group", "aria-label": "Voice session actions" }, startButton, redrawButton, el("a", { class: "oba-btn", href: libraryHash(), "data-action": "voice-library" }, "Your samples")),
    );
    // After the author chose to start over, focus goes to the new step's heading.
    if (focus) stage.querySelector("[data-voice-heading]")?.focus();
  }

  /** A session is already open (from the command line, or another tab): continue it or scrap it. */
  function showOpen(info, slot) {
    const confirm = el("div", { class: "oba-landing-actions", hidden: true });
    const scrap = el("button", { class: "oba-btn", type: "button", "data-action": "voice-scrap", onClick: () => { confirm.hidden = false; confirm.querySelector("button")?.focus(); } }, "Scrap it");
    const box = el(
      "div",
      { class: "oba-notice", role: "group", "aria-labelledby": `${base}-open`, "data-voice-open": "true" },
      el("strong", { id: `${base}-open`, tabindex: "-1" }, "A session is already open"),
      el("p", {}, info.error),
      el(
        "div",
        { class: "oba-landing-actions" },
        el("button", { class: "oba-btn oba-btn-primary", type: "button", "data-action": "voice-continue", onClick: () => load() }, info.expired ? "Lock what was saved" : "Continue that session"),
        scrap,
      ),
      confirm,
    );
    confirm.append(
      el("button", { class: "oba-btn oba-btn-danger", type: "button", "data-action": "voice-scrap-confirm", onClick: async () => {
        try {
          await api.call("DELETE", "voice/session", { json: { sessionId: info.sessionId } });
          drafts.clear();
          showDraw({ notice: "Scrapped the open session. Nothing was saved.", focus: true });
        } catch (error) {
          box.append(errorBox(voiceErrorText(error)));
        }
      } }, "Yes, scrap it and save nothing"),
      el("button", { class: "oba-btn", type: "button", "data-action": "voice-scrap-keep", onClick: () => { confirm.hidden = true; scrap.focus(); } }, "No, keep it"),
    );
    slot.replaceChildren(box);
    box.querySelector("strong")?.focus();
  }

  // ----- step 2: write
  function showWrite(session) {
    const mine = ++generation;
    finishing = false;
    editor = null;
    const countdown = createCountdown(clock.now);
    const announcer = createAnnouncer();
    countdown.sync(session.remainingSeconds);
    const sessionId = session.sessionId;
    const roughId = `${base}-rough`;
    const rough = el("textarea", {
      ...ROUGH_ATTRIBUTES,
      class: "oba-voice-rough-input",
      id: roughId,
      rows: "12",
      "aria-describedby": `${base}-rule ${base}-count`,
    });
    // The longer of this device's copy and the server's draft wins when both are this session's; a copy of
    // another session is stale and is dropped.
    const copy = drafts.load();
    if (copy && copy.sessionId !== sessionId) drafts.clear();
    const choice = reconcileDraft({ sessionId, serverDraft: session.draft }, copy);
    rough.value = choice.text;
    const clockText = el("span", { class: "oba-voice-clock", role: "timer", "aria-label": "Time remaining", "data-voice-clock": "true" }, formatClock(countdown.remaining()));
    const symbol = el("span", { class: "oba-voice-symbol", "aria-hidden": "true" });
    const stateText = el("span", { class: "oba-voice-timer-state", "data-voice-timer-state": "true" });
    const timerBox = el("div", { class: "oba-voice-timer", "data-state": "running", "data-voice-timer": "true" }, symbol, clockText, stateText);
    const count = el("p", { class: "oba-small oba-voice-count", id: `${base}-count`, "data-voice-count": "true" });
    const saveNote = el("p", { class: "oba-small oba-voice-savenote", "data-voice-savenote": "true" });
    const message = el("p", { class: "oba-small", role: "status", "aria-live": "polite", "data-voice-status": "true" });
    const finishButton = el("button", { class: "oba-btn oba-btn-primary", type: "button", "data-action": "voice-finish", onClick: () => finish("early") }, "Finish early");
    const overButton = el("button", { class: "oba-btn", type: "button", "data-action": "voice-over", onClick: () => askScrap() }, "Start over");
    const scrapBox = el("div", { class: "oba-notice", role: "group", "aria-labelledby": `${base}-scrap`, hidden: true, "data-voice-scrap": "true" });
    let lastShown = -1;
    let lastSent = session.draft || "";
    let saving = false;
    let timer = null;
    let copyTimer = null;
    const deviceNote = el("span", { class: "oba-small", "data-voice-device": "true" });
    const keepCopy = ({ evenWhileFinishing = false } = {}) => {
      clock.clearTimeout(copyTimer);
      // A view that was replaced (signing out, another view) never writes private text back.
      if (mine !== generation || root.isConnected === false) return;
      if ((finishing && !evenWhileFinishing) || !rough.value) return;
      drafts.save({ sessionId, deadline: session.deadline, text: rough.value });
      deviceNote.textContent = drafts.inMemoryOnly ? "This device would not keep a copy, so your writing is protected by the server only." : "A copy is kept on this device.";
    };
    const leaving = () => {
      if (mine !== generation) {
        globalThis.removeEventListener?.("pagehide", leaving);
        return;
      }
      keepCopy();
    };
    globalThis.addEventListener?.("pagehide", leaving);

    const paintCount = () => {
      count.textContent = `${wordsText(wordCount(rough.value))}. ${wordRange(session)}`.trim();
    };
    const paintTimer = () => {
      const remaining = countdown.remaining();
      if (remaining === lastShown) return;
      lastShown = remaining;
      const label = timerLabel(remaining, finishing);
      clockText.textContent = formatClock(remaining);
      timerBox.setAttribute("data-state", label.state);
      symbol.textContent = label.symbol;
      stateText.textContent = label.text;
    };
    const freeze = () => {
      rough.readOnly = true;
      rough.setAttribute("readonly", "");
    };

    async function flush() {
      if (finishing || mine !== generation) return;
      if (saving) return;
      const text = rough.value;
      if (text === lastSent) return;
      saving = true;
      saveNote.textContent = "Saving…";
      try {
        const reply = await api.call("PUT", "voice/session/draft", { json: { sessionId, text } });
        lastSent = text;
        countdown.sync(reply.remainingSeconds);
        saveNote.textContent = "Saved on the server.";
      } catch (error) {
        if (mine !== generation) return;
        if (error.status === 409 && error.data?.timeUp) finish("time");
        else if (error.status === 409 && (error.data?.noSession || error.data?.otherSession)) load();
        else saveNote.textContent = voiceErrorText(error);
      } finally {
        saving = false;
        if (mine === generation && !finishing && rough.value !== lastSent) schedule(VOICE_LIMITS.autosaveMs * 2);
      }
    }
    function schedule(ms = VOICE_LIMITS.autosaveMs) {
      clock.clearTimeout(timer);
      timer = clock.setTimeout(() => flush(), ms);
    }
    rough.addEventListener("input", () => {
      paintCount();
      schedule();
      clock.clearTimeout(copyTimer);
      copyTimer = clock.setTimeout(keepCopy, VOICE_LIMITS.localSaveMs);
    });

    async function finish(reason) {
      if (finishing || mine !== generation) return;
      // The latest words go to this device first, in case the lock never reaches the server.
      if (rough.value !== lastSent) keepCopy();
      finishing = true;
      clock.clearTimeout(timer);
      clock.clearTimeout(copyTimer);
      freeze();
      finishButton.disabled = true;
      overButton.disabled = true;
      lastShown = -1;
      paintTimer();
      message.textContent = "Locking your rough draft…";
      announce(announcer.lock(reason !== "early"));
      const text = rough.value;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const reply = await api.call("POST", "voice/session/lock", { json: { sessionId, text } });
          if (mine === generation) {
            // The rough draft is on the server and can never change: the copy has done its job.
            drafts.clear();
            showRefine(reply.sample, { expired: reply.expired });
          }
          return;
        } catch (error) {
          if (mine !== generation) return;
          if (error.status === 409 && error.data?.empty) {
            // Nothing written: an early finish carries on, and a finished clock leaves the server to discard it.
            if (reason === "early" && !countdown.expired()) {
              finishing = false;
              rough.readOnly = false;
              rough.removeAttribute("readonly");
              finishButton.disabled = false;
              overButton.disabled = false;
              message.textContent = "Nothing is written yet, so there is nothing to lock. Write something, or start over.";
              rough.focus();
              schedule();
            } else load();
            return;
          }
          if (error.status === 409 && (error.data?.noSession || error.data?.otherSession)) {
            load();
            return;
          }
          message.textContent = `${voiceErrorText(error)} Trying again…`;
          await new Promise((done) => clock.setTimeout(done, 3000));
          if (mine !== generation) return;
        }
      }
      message.textContent = text === lastSent
        ? "Your rough draft could not be locked just now. Your writing is on the server; reload this page to finish."
        : drafts.inMemoryOnly
          ? "Your rough draft could not be locked just now, and the server does not have your latest words. Keep this page open and try again once the connection is back."
          : "Your rough draft could not be locked just now, and the server does not have your latest words. A copy is kept on this device; reload this page once the connection is back to finish.";
    }

    function askScrap() {
      scrapBox.hidden = false;
      scrapBox.replaceChildren(
        el("strong", { id: `${base}-scrap`, tabindex: "-1" }, "Start over and save nothing?"),
        el("p", {}, "This throws away what you have written in this session. Nothing is kept."),
        el(
          "div",
          { class: "oba-landing-actions" },
          el("button", { class: "oba-btn oba-btn-danger", type: "button", "data-action": "voice-over-confirm", onClick: async () => {
            try {
              await api.call("DELETE", "voice/session", { json: { sessionId } });
              drafts.clear();
              if (mine === generation) showDraw({ notice: "Started over. Nothing was saved.", focus: true });
            } catch (error) {
              // A newer session opened elsewhere: this page is out of date and nothing was thrown away.
              if (error.status === 409 && error.data?.otherSession) load();
              else message.textContent = voiceErrorText(error);
            }
          } }, "Yes, start over"),
          el("button", { class: "oba-btn", type: "button", onClick: () => { scrapBox.hidden = true; rough.focus(); } }, "No, keep writing"),
        ),
      );
      scrapBox.querySelector("strong")?.focus();
    }

    paintCount();
    paintTimer();
    if (choice.push) {
      // The server is behind this device's copy (a lost connection): bring it up to date at once.
      saveNote.textContent = "Restored the longer copy kept on this device.";
      schedule(0);
    }
    if (rough.value) keepCopy();
    render(
      heading(session.title, `${base}-write`),
      el("p", { class: "oba-voice-invitation" }, session.invitation),
      el("p", { class: "oba-voice-rule", id: `${base}-rule`, "data-voice-rule": "true" }, session.rule),
      timerBox,
      el("div", { class: "oba-field" }, el("label", { for: roughId }, "Your rough draft"), rough),
      count,
      saveNote,
      deviceNote,
      message,
      scrapBox,
      el("div", { class: "oba-voice-bar", "data-voice-bar": "true" }, el("div", { class: "oba-landing-actions oba-voice-actions", role: "group", "aria-label": "Voice session actions" }, finishButton, overButton)),
    );
    keepBarReachable(one(root, "[data-voice-bar]"), () => mine === generation);
    const tick = clock.setInterval(() => {
      if (mine !== generation) return;
      // Admin moved to another view: the clock stops with this one.
      if (root.isConnected === false) {
        generation += 1;
        stopTicking();
        return;
      }
      paintTimer();
      if (!finishing) announce(announcer.update(countdown.remaining(), clock.now()));
      if (!finishing && countdown.expired()) finish("time");
    }, 250);
    stopTicking = () => {
      clock.clearInterval(tick);
      clock.clearTimeout(timer);
      clock.clearTimeout(copyTimer);
      globalThis.removeEventListener?.("pagehide", leaving);
    };
    // The cursor is in the box the moment writing starts, so typing can begin without a click or a Tab.
    rough.focus();
    // A page that was away may find the time already gone.
    if (countdown.expired()) finish("time");
  }

  // ----- step 3: refine
  function showRefine(sample, { expired = false, resumed = false } = {}) {
    const mine = ++generation;
    finishing = false;
    const roughView = buildRoughView({ api, sample });
    editor = createPolishedEditor({
      api,
      user,
      storage,
      setTimer: clock.setTimeout,
      clearTimer: clock.clearTimeout,
      rough: { file: sample.file, title: sample.title, body: sample.body },
      onChange: (dirty) => onDirty(dirty),
    });
    render(
      heading("Your rough draft is locked", `${base}-refine`),
      el(
        "p",
        { class: "oba-notice", role: "status", "data-voice-locked": "true" },
        expired || resumed ? "The time ran out, so your rough draft was locked from what was saved. " : "",
        "It is saved exactly as you wrote it.",
      ),
      roughView.element,
      editor.element,
      el(
        "div",
        { class: "oba-landing-actions oba-voice-after" },
        el("button", { class: "oba-btn", type: "button", "data-action": "voice-another", onClick: () => {
          if (editor?.isDirty()) {
            roughView.status.textContent = "Your polished draft has unsaved changes. Save it first, then start another session.";
            return;
          }
          editor = null;
          onDirty(false);
          showDraw({ focus: true });
        } }, "Start another session"),
        el("a", { class: "oba-btn", href: libraryHash(), "data-action": "voice-library" }, "Open your samples"),
      ),
    );
    keepBarReachable(editor.bar(), () => mine === generation);
    if (mine === generation) editor.focus();
  }

  return {
    element: root,
    load,
    isDirty: () => Boolean(editor?.isDirty()),
    isBusy: () => Boolean(finishing || editor?.isBusy()),
    destroy() {
      generation += 1;
      stopTicking();
    },
  };
}

if (typeof HTMLElement !== "undefined" && globalThis.customElements && !globalThis.customElements.get("ob-voice-session")) {
  globalThis.customElements.define("ob-voice-session", class ObVoiceSession extends HTMLElement {});
}
