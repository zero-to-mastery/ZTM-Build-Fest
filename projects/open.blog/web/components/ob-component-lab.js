// <ob-component-lab> is a live architecture explorer for Shadow DOM, slots, attributes and CSS
// custom properties. The demo card is a real custom element with a real shadow root; the lab
// shows its light DOM, its shadow tree and its slot assignments as they are right now.
// Children of the element are the no-JavaScript fallback. Nothing is stored or sent.
import {
  tag, TONES, defaults, normalize, shadowStyle, shadowBody,
  lightChildren, hostAttributes, lightMarkup, pageRules, notes,
} from "./ob-component-model.js";
import { ObLab, defineLab, el, field, uid } from "./ob-lab.js";

class ObLabCard extends HTMLElement {
  static observedAttributes = ["tone"];

  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = `<style>${shadowStyle}</style>${shadowBody}`;
  }

  connectedCallback() {
    this.paintTone();
  }

  attributeChangedCallback() {
    this.paintTone();
  }

  paintTone() {
    this.shadowRoot.querySelector(".tone").textContent = `tone: ${this.getAttribute("tone") ?? "none"}`;
  }
}

class ObComponentLab extends ObLab {
  setup() {
    if (!customElements.get(tag)) customElements.define(tag, ObLabCard);
    this.config = { ...defaults };

    const panel = (label) => {
      const box = el("section", { class: "ob-cl-panel", "aria-label": label });
      box.append(el("h3", {}, label));
      return box;
    };

    this.stage = el("div", { class: "ob-cl-stage" });
    this.pageStyle = el("style");
    const stageBox = panel("Live component");
    stageBox.append(this.stage, this.pageStyle);

    const form = el("div", { class: "ob-cl-controls", role: "group", "aria-label": "Component controls" });
    form.append(
      this.select("tone", "Attribute: tone", TONES),
      this.check("collapsed", "Attribute: collapsed"),
      this.check("title", 'Slot: element with slot="title"'),
      this.check("body", "Slot: default content"),
      this.check("footer", 'Slot: element with slot="footer"'),
      this.input("accent", "Property: --card-accent", { type: "color" }),
      this.input("radius", "Property: --card-radius", { type: "range", min: "0", max: "32" }),
      this.input("padding", "Property: --card-pad", { type: "range", min: "4", max: "40" }),
      this.check("pageCss", "Page CSS: color the card's text"),
      this.check("partCss", "Page CSS: style ::part(footer)"),
    );
    const controlBox = panel("Change something");
    controlBox.append(form);

    this.lightOut = el("pre", { class: "ob-cl-code", tabindex: "0", "aria-label": "Light DOM markup" });
    this.shadowOut = el("pre", { class: "ob-cl-code", tabindex: "0", "aria-label": "Shadow DOM source" });
    this.slotOut = el("ul", { class: "ob-cl-slots", "aria-label": "Slot assignments" });
    this.cssOut = el("pre", { class: "ob-cl-code", tabindex: "0", "aria-label": "Page CSS" });
    this.notesOut = el("ul", { class: "ob-cl-notes", role: "status", "aria-label": "What just happened" });

    const light = panel("Light DOM: what you write");
    light.append(this.lightOut, this.cssOut);
    const shadow = panel("Shadow DOM: what the component owns");
    shadow.append(this.shadowOut);
    const slots = panel("Slots: who goes where");
    slots.append(this.slotOut);
    const why = panel("Why it looks like this");
    why.append(this.notesOut);

    this.append(
      el("p", { class: "ob-cl-note" }, "A real custom element with a real shadow root, running right here. Change an attribute, a slot or a CSS property and see what the browser does."),
      stageBox, controlBox, light, shadow, slots, why);
    this.update();
  }

  bind(key, control, read) {
    control.addEventListener("input", () => {
      this.config[key] = read(control);
      this.update();
    });
  }

  select(key, label, options) {
    const control = el("select");
    options.forEach((option) => control.append(el("option", { value: option }, option)));
    this.bind(key, control, (node) => node.value);
    return field(label, control, "ob-cl-field");
  }

  check(key, label) {
    const control = el("input", { type: "checkbox", id: uid("ob-cl") });
    control.checked = Boolean(defaults[key]);
    this.bind(key, control, (node) => node.checked);
    const wrap = el("div", { class: "ob-cl-check" });
    wrap.append(control, el("label", { for: control.id }, label));
    return wrap;
  }

  input(key, label, attrs) {
    const control = el("input", { ...attrs, value: String(defaults[key]) });
    this.bind(key, control, (node) => node.value);
    const wrap = field(label, control, "ob-cl-field");
    if (attrs.type === "range") {
      const out = el("output", { for: control.id }, String(defaults[key]));
      control.addEventListener("input", () => { out.textContent = control.value; });
      wrap.append(out);
    }
    return wrap;
  }

  update() {
    const config = normalize(this.config);
    this.renderCard(config);
    const rules = pageRules(config);
    this.pageStyle.textContent = rules.map((rule) => `.ob-cl-stage ${rule}`).join("\n");
    this.lightOut.textContent = lightMarkup(config);
    this.cssOut.textContent = rules.length ? rules.join("\n") : "/* The page has no rules for this component. */";
    this.shadowOut.textContent = `#shadow-root (open)\n<style>\n${shadowStyle}\n</style>\n${shadowBody}`;
    this.notesOut.replaceChildren(...notes(config).map((line) => el("li", {}, line)));
    this.renderSlots();
  }

  // One card for the whole visit: changing its attributes fires the real attributeChangedCallback.
  renderCard(config) {
    if (!this.card) {
      this.card = document.createElement(tag);
      this.stage.append(this.card);
    }
    const { attrs, style } = hostAttributes(config);
    for (const name of ["collapsed", "style"]) this.card.removeAttribute(name);
    for (const [name, value] of attrs) this.card.setAttribute(name, value ?? "");
    if (style.length) this.card.setAttribute("style", style.join("; "));
    this.card.replaceChildren(...lightChildren(config).map((markup) => {
      const holder = document.createElement("div");
      holder.innerHTML = markup;
      return holder.firstElementChild;
    }));
  }

  renderSlots() {
    const items = [...this.card.shadowRoot.querySelectorAll("slot")].map((slot) => {
      const assigned = slot.assignedNodes();
      const detail = assigned.length
        ? assigned.map((node) => `<${node.localName}>`).join(", ")
        : "nothing assigned, fallback content shown";
      return el("li", {}, `${slot.name || "(default)"}: ${detail}`);
    });
    this.slotOut.replaceChildren(...items);
  }
}

defineLab("ob-component-lab", ObComponentLab);
