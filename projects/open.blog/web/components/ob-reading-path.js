// <ob-reading-path> adds optional, local progress to a reading path page
// (ADR 0215, #78). The page is complete without it: the whole path is an
// ordered list, every step links to its post or atlas entry, says in the
// author's words how it relates to the step it follows, and has previous and
// next links to the steps around it.
//
// With JavaScript the component adds a "Mark as read" checkbox to each step,
// a status line that says how many steps are read, a link to the first step
// not yet read, and a button that forgets all progress. Progress is a list of
// step targets (`post:slug`, `atlas:id`) kept in this browser's localStorage
// under one key per path. Nothing is sent anywhere, no account is needed, and
// progress never changes what the page says or the order of the steps. When
// storage is refused or unavailable the component says so and adds nothing
// else, so the path reads exactly as it does without it. Stored data that
// cannot be read is ignored and left as it is until the reader changes
// something; entries for steps the path no longer has are ignored.

const STORAGE_PREFIX = "openblog:reading-path:";
const VERSION = 1;
const MAX_STORED_CHARS = 20000;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** The key progress for a path is kept under. */
export function storageKey(slug) {
  return `${STORAGE_PREFIX}${slug}`;
}

/**
 * The steps read, from what storage held: only targets the path still has.
 * Anything that is not the expected shape is nothing read.
 */
export function parseProgress(raw, validKeys) {
  const valid = new Set(validKeys);
  const read = new Set();
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_STORED_CHARS) return read;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return read;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== VERSION) return read;
  if (!Array.isArray(value.read)) return read;
  for (const key of value.read) {
    if (typeof key === "string" && valid.has(key)) read.add(key);
  }
  return read;
}

/** What is stored for `read`, in the path's own order. */
export function serializeProgress(read, orderedKeys) {
  return JSON.stringify({ version: VERSION, read: orderedKeys.filter((key) => read.has(key)) });
}

/** The same set with `key` read or not. */
export function withRead(read, key, isRead) {
  const next = new Set(read);
  if (isRead) next.add(key);
  else next.delete(key);
  return next;
}

/**
 * Counts for the status line. Optional steps never count toward finishing:
 * a reader who skips them has read the whole path.
 */
export function summarize(steps, read) {
  const required = steps.filter((step) => !step.optional);
  const optional = steps.filter((step) => step.optional);
  const requiredRead = required.filter((step) => read.has(step.key)).length;
  const optionalRead = optional.filter((step) => read.has(step.key)).length;
  return {
    required: required.length,
    requiredRead,
    optional: optional.length,
    optionalRead,
    started: requiredRead + optionalRead > 0,
    complete: required.length > 0 && requiredRead === required.length,
  };
}

/** What the status line says, in words. */
export function statusText(steps, read) {
  const counts = summarize(steps, read);
  if (!counts.started) {
    return "You have not marked any step as read. Marking steps is optional and stays in this browser.";
  }
  let text = `${counts.requiredRead} of ${plural(counts.required, "step", "steps")} read`;
  if (counts.optional) {
    text += `, and ${counts.optionalRead} of ${plural(counts.optional, "optional step", "optional steps")}`;
  }
  text += counts.complete ? ". You have read every step that is not optional." : ".";
  return `${text} Saved in this browser only.`;
}

/** The index of the first step not yet read that is not optional, or -1. */
export function nextUnread(steps, read) {
  return steps.findIndex((step) => !step.optional && !read.has(step.key));
}

/** A storage that works, or null: some browsers refuse access outright. */
function openStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    storage.getItem(storageKey("probe"));
    return storage;
  } catch {
    return null;
  }
}

const BaseElement = globalThis.HTMLElement ?? class {};

export class ObReadingPath extends BaseElement {
  #controller = null;
  #added = [];

  connectedCallback() {
    if (this.#controller) return;
    const items = [...this.querySelectorAll("li.ob-path-step")];
    const list = this.querySelector("ol.ob-path-steps");
    const slug = this.getAttribute("data-slug") || "";
    if (!list || items.length < 2 || !slug) return;
    const make = (tag, props = {}, text = "") => {
      const element = document.createElement(tag);
      for (const [name, value] of Object.entries(props)) element.setAttribute(name, value);
      if (text) element.textContent = text;
      return element;
    };
    const steps = items.map((item, index) => ({
      key: item.getAttribute("data-key") || `step:${index}`,
      optional: item.getAttribute("data-optional") === "true",
      title: item.querySelector(".ob-path-step-title a")?.textContent.trim() || `step ${index + 1}`,
    }));
    const keys = steps.map((step) => step.key);
    const controller = new AbortController();
    const { signal } = controller;
    this.#controller = controller;

    const storage = openStorage();
    if (!storage) {
      const note = make(
        "p",
        { class: "ob-meta ob-path-status", role: "status" },
        "Progress cannot be saved in this browser, so it is not offered. The path reads the same without it.",
      );
      this.insertBefore(note, list);
      this.#added.push(note);
      return;
    }

    const id = `ob-path-${slug}`;
    let read = new Set();
    try {
      read = parseProgress(storage.getItem(storageKey(slug)), keys);
    } catch {
      read = new Set();
    }
    let saveFailed = false;

    const tools = make("div", { class: "ob-path-tools", role: "group", "aria-label": "Your progress on this path" });
    const status = make("p", { class: "ob-meta ob-path-status", role: "status", "aria-live": "polite", tabindex: "-1" });
    const resume = make("a", { class: "ob-path-resume" });
    const reset = make("button", { type: "button", class: "ob-path-reset" }, "Reset progress");
    tools.append(status, resume, reset);
    this.insertBefore(tools, list);
    this.#added.push(tools);

    const boxes = items.map((item, index) => {
      const checkbox = make("input", { type: "checkbox", id: `${id}-${index + 1}` });
      const label = make("label", { for: checkbox.id }, `Mark step ${index + 1}, ${steps[index].title}, as read`);
      const wrapper = make("p", { class: "ob-path-progress" });
      wrapper.append(checkbox, " ", label);
      const nav = item.querySelector(".ob-path-nav");
      item.insertBefore(wrapper, nav);
      this.#added.push(wrapper);
      return checkbox;
    });

    const render = () => {
      boxes.forEach((box, index) => {
        box.checked = read.has(steps[index].key);
        items[index].classList.toggle("ob-path-read", box.checked);
      });
      let text = statusText(steps, read);
      if (saveFailed) text += " This browser did not let the change be saved, so it will be forgotten when you leave.";
      status.textContent = text;
      const next = nextUnread(steps, read);
      const counts = summarize(steps, read);
      if (counts.started && next >= 0) {
        resume.hidden = false;
        resume.setAttribute("href", `#step-${next + 1}`);
        resume.textContent = `Continue at step ${next + 1}, ${steps[next].title}`;
      } else {
        resume.hidden = true;
      }
      reset.hidden = !counts.started;
    };

    const save = () => {
      try {
        if (read.size === 0) storage.removeItem(storageKey(slug));
        else storage.setItem(storageKey(slug), serializeProgress(read, keys));
        saveFailed = false;
      } catch {
        saveFailed = true;
      }
    };

    boxes.forEach((box, index) => {
      box.addEventListener("change", () => {
        read = withRead(read, steps[index].key, box.checked);
        save();
        render();
      }, { signal });
    });
    reset.addEventListener("click", () => {
      read = new Set();
      save();
      render();
      // The button that was pressed is now hidden, so focus goes to the status
      // line, which has just said that nothing is marked.
      status.focus();
    }, { signal });
    globalThis.addEventListener?.("storage", (event) => {
      if (event.key !== storageKey(slug)) return;
      read = parseProgress(event.newValue, keys);
      render();
    }, { signal });

    render();
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#controller = null;
    for (const element of this.#added) element.remove();
    this.#added = [];
    for (const item of this.querySelectorAll("li.ob-path-step")) item.classList.remove("ob-path-read");
  }
}

if (globalThis.customElements && !customElements.get("ob-reading-path")) {
  customElements.define("ob-reading-path", ObReadingPath);
}
