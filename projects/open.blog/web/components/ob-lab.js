// Shared pieces for the interactive lesson labs (<ob-git-sandbox>, <ob-fetch-lab>, ...).
// A lab owns its element: children written in the post are the no-JavaScript fallback, hidden
// as soon as the lab starts. Nothing a lab does is stored or sent anywhere.

const SVG = "http://www.w3.org/2000/svg";

export function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

let counter = 0;

export function uid(prefix = "ob-lab") {
  return `${prefix}-${counter++}`;
}

// A labelled form control with a unique id, so the label is always programmatically linked.
export function field(label, control, className = "ob-lab-field") {
  control.id = uid();
  const wrap = el("div", { class: className });
  wrap.append(el("label", { for: control.id }, label), control);
  return wrap;
}

export function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export class ObLab extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = "true";
    this.fallback = el("div", { "data-ob-fallback": "" });
    this.fallback.hidden = true;
    this.fallback.append(...this.childNodes);
    this.append(this.fallback);
    this.setup();
  }

  setup() {}
}

export function defineLab(name, constructor) {
  if (!customElements.get(name)) customElements.define(name, constructor);
}
