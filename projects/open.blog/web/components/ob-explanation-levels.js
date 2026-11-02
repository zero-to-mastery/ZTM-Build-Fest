// <ob-explanation-levels> adds a level selector to an interpretation comparison
// page (ADR 0232, #90). The page is complete without it: every explanation
// level is a section of the page, linked from a list of links, in a fixed
// order, and the interpretations and their evidence sit above the levels
// where no level can reach them.
//
// With JavaScript the component replaces the list of links with a group of
// buttons: "All levels" (the starting state, so nothing is hidden until the
// reader chooses) and one button per level that has explanations. Choosing a
// level hides the other level sections with the `hidden` attribute and says
// what is shown in a polite status line. It never moves focus, never touches
// anything outside the level sections (so the quoted evidence is the same at
// every level), and stores nothing. A link to a level, or to an explanation
// inside one, shows it. Print shows every level.
//
// Reading modes (ADR 0235, #219). An explanation may name the modes it is
// offered in (`data-modes`, "guided deep-dive"). The component reads the
// reader's saved reading mode, only to read it and never to write it, and
// hides an explanation that names modes without the current one. Standard
// mode filters nothing, so the page stays complete, and an explanation that
// names no modes is in every mode. The modes are cumulative like every other
// supplement's (ADR 0140): deep dive shows what is offered in guided or in
// deep dive. The comparison page has no reading-mode control, so the note that
// says something was left out carries a button that shows everything on this
// page only, without changing the saved mode. A level left with nothing to show gets no
// button, so no control leads nowhere. A blocked store reads as standard.
// The article, the interpretations and their evidence are never touched.

import { localStore, readPreference, resolveMode, shows, storageKey } from "./reading-modes.js";

const LEVELS = ["beginner", "student", "scholarly"];
const ALL = "all";

const label = (level) => level.charAt(0).toUpperCase() + level.slice(1);

/** The levels a page offers, in the fixed order, from its level sections. */
export function levelsOf(values) {
  return LEVELS.filter((level) => values.includes(level));
}

/**
 * The level a URL fragment asks for: `#level-student` names student, and
 * `#level-student-heading` too. Anything else is no request.
 */
export function levelFromHash(hash, levels) {
  const match = /^#level-([a-z]+)(?:-heading)?$/.exec(typeof hash === "string" ? hash : "");
  return match && levels.includes(match[1]) ? match[1] : null;
}

/**
 * Whether an explanation offered in `modes` (a space separated list, or
 * nothing) shows in `mode`. Standard shows every explanation; an unreadable
 * list shows it too, so a label the page cannot read never hides text. Deep
 * dive is a superset of guided, as for every supplement (`shows`).
 */
export function modeAllows(mode, modes) {
  const list = typeof modes === "string" ? modes.split(/\s+/).filter(Boolean) : [];
  if (mode === "standard" || list.length === 0) return true;
  const known = list.filter((m) => m === "guided" || m === "deep-dive");
  return known.length === 0 || known.some((m) => shows(mode, m));
}

/** What the status line says for the choice. */
export function statusFor(choice) {
  if (choice === ALL) return "Showing every explanation level.";
  return `Showing the ${choice} explanations. The interpretations and their evidence above are unchanged.`;
}

const BaseElement = globalThis.HTMLElement ?? class {};

export class ObExplanationLevels extends BaseElement {
  #controller = null;
  #added = [];
  #hiddenNav = null;
  #hiddenItems = [];
  /** Set by the note's button: this page shows every explanation until it is reloaded. */
  #showAll = false;

  connectedCallback() {
    if (this.#controller) return;
    const sections = [...this.querySelectorAll("section.ob-level[data-level]")];
    const key = storageKey(this.getAttribute("data-ob-base") ?? "");
    const saved = resolveMode(readPreference(localStore(), key), null);
    const mode = this.#showAll ? "standard" : saved;
    // Hide what the mode leaves out; a section with nothing left is not a level to choose.
    for (const section of sections) {
      let any = false;
      for (const item of section.querySelectorAll(".ob-explanation")) {
        const allowed = modeAllows(mode, item.getAttribute("data-modes"));
        item.hidden = !allowed;
        item.toggleAttribute("data-mode-hidden", !allowed);
        any ||= allowed;
      }
      section.toggleAttribute("data-mode-empty", !any);
    }
    const open = sections.filter((section) => !section.hasAttribute("data-mode-empty"));
    for (const section of sections) section.hidden = section.hasAttribute("data-mode-empty");
    const levels = levelsOf(open.map((section) => section.getAttribute("data-level")));
    const controller = new AbortController();
    const { signal } = controller;
    this.#controller = controller;
    // Another tab chose a reading mode: follow it by starting again.
    globalThis.addEventListener?.(
      "storage",
      (event) => {
        if (event.key !== key && event.key !== null) return;
        this.#showAll = false;
        this.disconnectedCallback();
        this.connectedCallback();
      },
      { signal },
    );
    for (const link of this.querySelectorAll("nav.ob-level-links a[href^='#level-']")) {
      const level = link.getAttribute("href").slice("#level-".length);
      if (!levels.includes(level)) {
        link.parentElement.hidden = true;
        this.#hiddenItems.push(link.parentElement);
      }
    }
    const restart = (showAll) => {
      this.#showAll = showAll;
      this.disconnectedCallback();
      this.connectedCallback();
    };
    const addNote = (message, buttonText, showAll) => {
      const note = document.createElement("p");
      note.className = "ob-meta ob-level-mode-note";
      note.append(`${message} `);
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-mode-toggle", showAll ? "all" : "mode");
      button.textContent = buttonText;
      button.addEventListener("click", () => restart(showAll), { signal });
      note.append(button);
      (this.querySelector("nav.ob-level-links") ?? this.firstChild)?.before(note);
      this.#added.push(note);
    };
    if (this.querySelector("[data-mode-hidden]")) {
      addNote(
        `Some explanations are offered only in other reading modes, so the ${mode === "guided" ? "Guided" : "Deep dive"} mode leaves them out.`,
        "Show all explanations",
        true,
      );
    } else if (this.#showAll) {
      addNote("Showing every explanation on this page.", "Follow my reading mode again", false);
    }
    // A link into something the mode left out shows it: a link is never dead.
    const reveal = () => {
      const target = this.#target();
      const item = target?.closest("[data-mode-hidden], section.ob-level[data-mode-empty]");
      if (!item) return;
      item.hidden = false;
      const section = item.closest("section.ob-level");
      if (section) {
        section.hidden = false;
        section.setAttribute("data-mode-revealed", "");
        // An emptied level opened by a link shows what the mode left out of it.
        if (section.hasAttribute("data-mode-empty")) {
          for (const inner of section.querySelectorAll("[data-mode-hidden]")) inner.hidden = false;
        }
      }
    };
    if (levels.length < 2) {
      globalThis.addEventListener?.("hashchange", reveal, { signal });
      reveal();
      return;
    }

    const make = (tag, props = {}, text = "") => {
      const element = document.createElement(tag);
      for (const [name, value] of Object.entries(props)) element.setAttribute(name, value);
      if (text) element.textContent = text;
      return element;
    };
    const nav = this.querySelector("nav.ob-level-links");
    const group = make("div", { class: "ob-level-switch", role: "group", "aria-label": "Explanation level" });
    const status = make("p", { class: "ob-meta ob-level-status", role: "status", "aria-live": "polite" });
    const buttons = new Map();
    for (const choice of [ALL, ...levels]) {
      const button = make("button", { type: "button", "aria-pressed": "false", "data-choice": choice }, choice === ALL ? "All levels" : label(choice));
      buttons.set(choice, button);
      group.append(button);
    }
    if (nav) {
      this.insertBefore(group, nav);
      nav.hidden = true;
      this.#hiddenNav = nav;
    } else {
      this.prepend(group);
    }
    group.after(status);
    this.#added.push(group, status);

    let current = ALL;
    const choose = (choice, announce = true) => {
      current = choice;
      for (const section of sections) {
        const left = section.hasAttribute("data-mode-empty") && !section.hasAttribute("data-mode-revealed");
        section.hidden = left || (choice !== ALL && section.getAttribute("data-level") !== choice);
      }
      for (const [name, button] of buttons) button.setAttribute("aria-pressed", String(name === choice));
      status.textContent = announce ? statusFor(choice) : "";
    };
    choose(ALL, false);

    group.addEventListener(
      "click",
      (event) => {
        const button = event.target instanceof Element ? event.target.closest("button[data-choice]") : null;
        if (button) choose(button.getAttribute("data-choice"));
      },
      { signal },
    );

    // A link to a level shows that level; a link to anything inside a hidden
    // level shows every level so the target is never hidden.
    const follow = () => {
      const hash = globalThis.location?.hash ?? "";
      const level = levelFromHash(hash, levels);
      if (level) return choose(level);
      reveal();
      if (current === ALL || !hash) return;
      const target = this.#target();
      if (target && target.closest("[hidden]")) choose(ALL);
    };
    globalThis.addEventListener?.("hashchange", follow, { signal });
    follow();
  }

  /** The element the URL fragment points at inside this component, if any. */
  #target() {
    const hash = globalThis.location?.hash ?? "";
    if (!hash || hash.length < 2) return null;
    try {
      return this.querySelector(`#${CSS.escape(decodeURIComponent(hash.slice(1)))}`);
    } catch {
      return null;
    }
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#controller = null;
    for (const element of this.#added) element.remove();
    this.#added = [];
    if (this.#hiddenNav) this.#hiddenNav.hidden = false;
    this.#hiddenNav = null;
    for (const node of this.#hiddenItems) node.hidden = false;
    this.#hiddenItems = [];
    for (const node of this.querySelectorAll("[data-mode-hidden], [data-mode-empty], [data-mode-revealed]")) {
      node.removeAttribute("data-mode-revealed");
      node.removeAttribute("data-mode-hidden");
      node.removeAttribute("data-mode-empty");
    }
    for (const node of this.querySelectorAll("section.ob-level[hidden], .ob-explanation[hidden]")) node.hidden = false;
  }
}

if (globalThis.customElements && !globalThis.customElements.get("ob-explanation-levels")) {
  globalThis.customElements.define("ob-explanation-levels", ObExplanationLevels);
}
