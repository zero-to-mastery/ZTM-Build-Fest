// <ob-compare> turns two captioned figures into a reveal control. The page is complete without it:
// the figures sit side by side, and that is also what a reader with reduced motion keeps.
// No storage and no network.
import { clampPosition, positionFromPointer, shouldEnhance, valueText } from "./ob-compare-model.js";

class ObCompare extends HTMLElement {
  #query = null;
  #saved = null;
  #stage = null;
  #range = null;
  #labels = ["Before", "After"];
  #dragging = false;

  connectedCallback() {
    this.#query = matchMedia("(prefers-reduced-motion: reduce)");
    this.#query.addEventListener("change", this.#sync);
    this.#sync();
  }

  disconnectedCallback() {
    this.#query?.removeEventListener("change", this.#sync);
    this.#restore();
  }

  #sync = () => {
    const figures = [...this.children].filter((child) => child.tagName === "FIGURE");
    const pictures = figures.filter((figure) => figure.querySelector("img")).length;
    const wanted = shouldEnhance({ reducedMotion: this.#query.matches, pictures: figures.length === 2 ? pictures : 0 });
    if (wanted && !this.#saved) this.#enhance(figures);
    else if (!wanted && this.#saved) this.#restore();
  };

  #enhance(figures) {
    const images = figures.map((figure) => figure.querySelector("img"));
    this.#labels = figures.map((figure, index) => figure.querySelector(".ob-compare-label")?.textContent.trim() || ["Before", "After"][index]);
    this.#saved = images.map((image) => ({ image, parent: image.parentNode, next: image.nextSibling }));

    const stage = document.createElement("div");
    stage.className = "ob-compare-stage";
    stage.setAttribute("role", "group");
    stage.setAttribute("aria-label", `${this.#labels[0]} and ${this.#labels[1]} comparison`);

    const over = document.createElement("div");
    over.className = "ob-compare-over";
    over.append(images[1]);

    const range = document.createElement("input");
    range.type = "range";
    range.className = "ob-compare-range";
    range.min = "0";
    range.max = "100";
    range.step = "1";
    range.value = "50";
    range.setAttribute("aria-label", `Reveal: slide between ${this.#labels[0]} and ${this.#labels[1]}`);

    const bar = document.createElement("div");
    bar.className = "ob-compare-bar";
    bar.setAttribute("aria-hidden", "true");
    const knob = document.createElement("span");
    knob.className = "ob-compare-knob";
    bar.append(knob);

    const tags = this.#labels.map((label, index) => {
      const tag = document.createElement("span");
      tag.className = `ob-compare-tag ob-compare-tag-${index ? "after" : "before"}`;
      tag.setAttribute("aria-hidden", "true");
      tag.textContent = label;
      return tag;
    });

    stage.append(images[0], over, range, bar, ...tags);
    this.prepend(stage);
    this.setAttribute("data-enhanced", "");
    this.#stage = stage;
    this.#range = range;

    range.addEventListener("input", () => this.#show(range.value));
    stage.addEventListener("pointerdown", this.#down);
    stage.addEventListener("pointermove", this.#move);
    stage.addEventListener("pointerup", this.#up);
    stage.addEventListener("pointercancel", this.#up);
    for (const image of images) image.addEventListener("load", this.#ratio);
    this.#ratio();
    this.#show(50);
  }

  #restore() {
    if (!this.#saved) return;
    for (const { image, parent, next } of this.#saved) parent.insertBefore(image, next?.parentNode === parent ? next : null);
    this.#stage?.remove();
    this.removeAttribute("data-enhanced");
    this.style.removeProperty("--ob-compare-pos");
    this.style.removeProperty("--ob-compare-ratio");
    this.#saved = this.#stage = this.#range = null;
  }

  // The stage takes the shape of the "before" picture, so a pair shot the same way lines up.
  #ratio = () => {
    const image = this.#saved?.[0]?.image;
    if (image?.naturalWidth && image.naturalHeight) {
      this.style.setProperty("--ob-compare-ratio", `${image.naturalWidth} / ${image.naturalHeight}`);
    }
  };

  #show(value) {
    const position = clampPosition(value);
    this.style.setProperty("--ob-compare-pos", `${position}%`);
    this.#range.value = String(position);
    this.#range.setAttribute("aria-valuetext", valueText(position, this.#labels[0], this.#labels[1]));
  }

  #at(event) {
    this.#show(positionFromPointer(event.clientX, this.#stage.getBoundingClientRect()));
  }

  #down = (event) => {
    if (event.button > 0) return;
    this.#dragging = true;
    this.#stage.setPointerCapture?.(event.pointerId);
    this.#range.focus({ preventScroll: true });
    this.#at(event);
  };

  #move = (event) => {
    if (this.#dragging) this.#at(event);
  };

  #up = (event) => {
    this.#dragging = false;
    this.#stage?.releasePointerCapture?.(event.pointerId);
  };
}

if (!customElements.get("ob-compare")) {
  customElements.define("ob-compare", ObCompare);
}
