// <ob-recipe> wraps a recipe post (front matter `recipe: true`). The page is
// complete without it: the summary card, ingredients and steps are plain HTML.
// Each attribute turns on one extra, and the blog owner can switch any of them
// off under "recipes" in openblog.json:
//
//   servings="4" scaling  - buttons that scale the ingredient amounts
//   checklists            - tick off ingredients and steps (remembered on this device)
//   timers                - "bake 25 minutes" in a step becomes a countdown button
//   cook-mode             - keep the screen awake while cooking (where supported)
//   print                 - print just the recipe
//
// Content is only ever inserted with DOM calls and textContent, never innerHTML.

import { findDurations, findQuantity, formatClock, scaleAlso, scaleQuantity } from "./ob-quantity.js";

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("aria-") || k.startsWith("data-")) node.setAttribute(k, v);
    else node[k] = v;
  }
  node.append(...children);
  return node;
};

const squash = (s) => (s || "").trim().replace(/\s+/g, " ");

/** A short, stable key for an item's text, so saved ticks follow the item
 * (not its position) when the author edits the recipe. */
function keyOf(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

class ObRecipe extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = "true";
    this.lifetime = new AbortController();
    this.storageKey = `ob-recipe:${this.getAttribute("key") || location.pathname}`;
    this.state = this.load();
    this.actions = this.querySelector(".ob-recipe-actions");
    if (!this.actions) {
      this.actions = el("div", { class: "ob-recipe-actions" });
      this.prepend(this.actions);
    }
    this.live = el("p", { class: "ob-visually-hidden", "aria-live": "polite" });
    this.append(this.live);
    // Remember each item's text as written, before scaling changes the numbers.
    // The key holds the section and an occurrence count, so two "Stir." steps
    // (or "Salt" as both an ingredient and a step) are ticked separately.
    const seen = new Map();
    this.items = [...this.querySelectorAll(".ob-ingredients > li, .ob-steps > li")].map((li) => {
      const kind = li.parentElement.classList.contains("ob-steps") ? "s" : "i";
      const base = keyOf(`${kind}:${squash(li.textContent)}`);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      return { li, key: n > 1 ? `${base}~${n}` : base };
    });

    const servings = Number(this.getAttribute("servings"));
    if (this.hasAttribute("checklists")) this.setupChecklists();
    if (this.hasAttribute("scaling") && Number.isInteger(servings) && servings > 0) this.setupScaling(servings);
    if (this.hasAttribute("timers")) this.setupTimers();
    if (this.hasAttribute("cook-mode") && "wakeLock" in navigator) this.setupCookMode();
    if (this.hasAttribute("print")) this.setupPrint();
  }

  disconnectedCallback() {
    this.lifetime?.abort();
    this.stopCooking?.();
    for (const t of this.timers || []) clearInterval(t.interval);
  }

  // ----- saved state (per device; a convenience, never required) -----

  load() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey));
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.state));
    } catch {
      // Private browsing or storage disabled: the page still works.
    }
  }

  announce(message) {
    this.live.textContent = "";
    requestAnimationFrame(() => (this.live.textContent = message));
  }

  // ----- servings -----

  setupScaling(base) {
    const max = Math.max(99, base * 4);
    this.quantities = [];
    const wrap = (node, start, end) => {
      const span = el("span", { class: "ob-qty" }, node.data.slice(start, end));
      const after = document.createTextNode(node.data.slice(end));
      node.replaceWith(node.data.slice(0, start), span, after);
      return [span, after];
    };
    for (const li of this.querySelectorAll(".ob-ingredients > li")) {
      const node = firstText(li);
      const found = node && findQuantity(node.data);
      if (!found) continue;
      const [span, after] = wrap(node, found.start, found.end);
      const entry = { span, found, original: span.textContent };
      if (found.also) {
        // "12 oz / 340 g": the second measure sits in the text after the first.
        const offset = found.end;
        const [alsoSpan] = wrap(after, found.also.start - offset, found.also.end - offset);
        entry.also = { span: alsoSpan, original: alsoSpan.textContent };
      }
      this.quantities.push(entry);
    }
    const output = el("output", { class: "ob-recipe-count" });
    const unit = el("span", {}, " servings");
    const less = el("button", { type: "button", class: "ob-recipe-button", "aria-label": "Fewer servings" }, "−");
    const more = el("button", { type: "button", class: "ob-recipe-button", "aria-label": "More servings" }, "+");
    const group = el("div", { class: "ob-recipe-scale", role: "group", "aria-label": "Servings" }, less, output, unit, more);
    const shown = this.querySelectorAll(".ob-recipe-servings");
    const apply = (n, announce) => {
      this.servings = Math.min(max, Math.max(1, n));
      output.textContent = String(this.servings);
      unit.textContent = this.servings === 1 ? " serving" : " servings";
      for (const s of shown) s.textContent = String(this.servings);
      // aria-disabled, not disabled: a disabled button would drop keyboard focus.
      less.setAttribute("aria-disabled", String(this.servings <= 1));
      more.setAttribute("aria-disabled", String(this.servings >= max));
      const factor = this.servings / base;
      for (const q of this.quantities) {
        q.span.textContent = factor === 1 ? q.original : scaleQuantity(q.found, factor);
        q.span.classList.toggle("ob-qty-scaled", factor !== 1);
        if (q.also) {
          q.also.span.textContent = factor === 1 ? q.also.original : scaleAlso(q.found, factor);
          q.also.span.classList.toggle("ob-qty-scaled", factor !== 1);
        }
      }
      this.relabel?.();
      this.state.servings = this.servings === base ? undefined : this.servings;
      this.save();
      if (announce) this.announce(`${this.servings} ${this.servings === 1 ? "serving" : "servings"}`);
    };
    less.addEventListener("click", () => this.servings > 1 && apply(this.servings - 1, true));
    more.addEventListener("click", () => this.servings < max && apply(this.servings + 1, true));
    const jump = this.actions.querySelector(".ob-recipe-jump");
    if (jump) jump.after(group);
    else this.actions.prepend(group);
    const saved = Number(this.state.servings);
    apply(Number.isInteger(saved) && saved >= 1 && saved <= max ? saved : base, false);
  }

  // ----- checklists -----

  setupChecklists() {
    this.classList.add("ob-has-checks");
    const saved = Array.isArray(this.state.checked) ? new Set(this.state.checked) : null;
    const boxes = [];
    const persist = () => {
      this.state.checked = boxes.filter((b) => b.box.checked).map((b) => b.key);
      this.save();
      reset.hidden = !boxes.some((b) => b.box.checked);
    };
    for (const { li, key } of this.items) {
      // A task-list item (`- [ ] ...`) already has a box: make it work.
      let box = li.querySelector(":scope > input[type=checkbox]");
      if (box) {
        box.disabled = false;
        box.classList.add("ob-check");
      } else {
        box = el("input", { type: "checkbox", class: "ob-check" });
        li.prepend(box);
      }
      box.checked = saved ? saved.has(key) : box.defaultChecked;
      li.classList.toggle("ob-done", box.checked);
      boxes.push({ box, key, li });
      box.addEventListener("change", () => {
        li.classList.toggle("ob-done", box.checked);
        persist();
      });
      // Messy hands: the whole line toggles, except links, buttons and selections.
      li.addEventListener("click", (event) => {
        if (event.target.closest("a, button, input, label, summary, code")) return;
        if (String(window.getSelection?.() || "")) return;
        box.click();
      });
    }
    // Names follow the text, so they show scaled amounts too.
    this.relabel = () => {
      for (const { box, li } of boxes) box.setAttribute("aria-label", `Done: ${squash(li.textContent).slice(0, 80)}`);
    };
    this.relabel();
    const reset = el("button", { type: "button", class: "ob-recipe-button" }, "Clear checks");
    reset.hidden = !boxes.some((b) => b.box.checked);
    reset.addEventListener("click", () => {
      // The button hides itself; keep keyboard focus on a neighbour.
      const next = [reset.nextElementSibling, reset.previousElementSibling].find((n) => n && !n.hidden);
      for (const { box } of boxes) {
        if (box.checked) box.click();
      }
      next?.focus();
      this.announce("All checks cleared");
    });
    this.actions.append(reset);
  }

  // ----- timers -----

  setupTimers() {
    this.timers = [];
    for (const li of this.querySelectorAll(".ob-steps > li")) {
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest("a, button, code, pre, .ob-timer") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const found = findDurations(node.data);
        if (!found.length) continue;
        const parts = [];
        let last = 0;
        for (const d of found) {
          parts.push(node.data.slice(last, d.index));
          parts.push(this.timerButton(node.data.slice(d.index, d.index + d.length), d.seconds));
          last = d.index + d.length;
        }
        parts.push(node.data.slice(last));
        node.replaceWith(...parts);
      }
    }
  }

  timerButton(label, seconds) {
    // The label stays in the text (it is what prints); the countdown sits beside it.
    const clock = el("span", { class: "ob-timer-clock", "aria-hidden": "true" });
    const button = el("button", { type: "button", class: "ob-timer", "aria-label": `Start a ${label} timer` }, el("span", { class: "ob-timer-label" }, label), clock);
    button.dataset.state = "idle";
    const timer = { button, label, seconds, end: 0, interval: 0 };
    this.timers.push(timer);
    const stop = (state) => {
      clearInterval(timer.interval);
      timer.interval = 0;
      button.dataset.state = state;
      clock.textContent = state === "done" ? "Done" : "";
      button.setAttribute("aria-label", state === "done" ? `${label} timer finished. Reset` : `Start a ${label} timer`);
    };
    button.addEventListener("click", () => {
      if (timer.interval || button.dataset.state === "done") {
        stop("idle");
        return;
      }
      this.prepareSound();
      timer.end = Date.now() + seconds * 1000;
      button.dataset.state = "running";
      button.setAttribute("aria-label", `${label} timer running. Stop`);
      const tick = () => {
        const left = (timer.end - Date.now()) / 1000;
        if (left <= 0) {
          stop("done");
          this.ring();
          this.announce(`Timer finished: ${label}`);
          return;
        }
        clock.textContent = formatClock(left);
      };
      tick();
      timer.interval = setInterval(tick, 250);
      this.announce(`Timer started: ${label}`);
    });
    return button;
  }

  // The sound needs an AudioContext created during a click, so make it then.
  prepareSound() {
    if (this.audio || !window.AudioContext) return;
    try {
      this.audio = new AudioContext();
    } catch {
      this.audio = null;
    }
  }

  ring() {
    navigator.vibrate?.([300, 150, 300, 150, 300]);
    const ctx = this.audio;
    if (!ctx) return;
    try {
      ctx.resume?.();
      for (let i = 0; i < 3; i += 1) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.value = 0.15;
        osc.connect(gain).connect(ctx.destination);
        const at = ctx.currentTime + i * 0.45;
        osc.start(at);
        osc.stop(at + 0.25);
      }
    } catch {
      // No sound is fine; the button already says "Done".
    }
  }

  // ----- cook mode -----

  setupCookMode() {
    const button = el("button", { type: "button", class: "ob-recipe-button", "aria-pressed": "false" }, "Cook mode");
    button.title = "Keep the screen awake and enlarge the recipe";
    let lock = null;
    let wanted = false;
    let busy = false;
    const release = async () => {
      const held = lock;
      lock = null;
      await held?.release().catch(() => {});
    };
    // One request at a time; a lock that arrives after cook mode was turned
    // off (or the page left) is released straight away.
    const acquire = async () => {
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (!wanted) {
          await sentinel.release().catch(() => {});
          return false;
        }
        await release();
        lock = sentinel;
        sentinel.addEventListener("release", () => {
          if (lock === sentinel) lock = null;
        });
        return true;
      } catch {
        return false;
      }
    };
    const show = () => {
      button.setAttribute("aria-pressed", String(wanted));
      this.classList.toggle("ob-cooking", wanted);
    };
    button.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      try {
        if (wanted) {
          wanted = false;
          await release();
          this.announce("Cook mode off");
        } else {
          wanted = true;
          wanted = await acquire();
          this.announce(wanted ? "Cook mode on: the screen stays awake" : "Cook mode is not available in this browser");
        }
        show();
      } finally {
        busy = false;
      }
    });
    // The browser drops the lock when the tab is hidden; take it back.
    document.addEventListener(
      "visibilitychange",
      () => {
        if (wanted && !lock && !busy && document.visibilityState === "visible") acquire();
      },
      { signal: this.lifetime.signal },
    );
    this.stopCooking = () => {
      wanted = false;
      release();
    };
    this.actions.append(button);
  }

  // ----- printing -----

  setupPrint() {
    const button = el("button", { type: "button", class: "ob-recipe-button" }, "Print recipe");
    const root = document.documentElement;
    window.addEventListener("afterprint", () => root.classList.remove("ob-print-recipe"), { signal: this.lifetime.signal });
    button.addEventListener("click", () => {
      root.classList.add("ob-print-recipe");
      window.print(); // afterprint removes the class once the dialog closes
    });
    this.actions.append(button);
  }
}

/** The first non-empty text node of an element, skipping inputs. */
function firstText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (/\S/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  return walker.nextNode();
}

if (!customElements.get("ob-recipe")) {
  customElements.define("ob-recipe", ObRecipe);
}
