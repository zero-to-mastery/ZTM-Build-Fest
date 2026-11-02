// A small element builder for the control panel's components. Text goes in
// through textContent only; nothing is ever parsed as markup.
//
//   el("p", { className: "hint", text: "Hello" })
//   el("button", { type: "button", onclick: save }, "Save")
//
// Keys: `text` (textContent), `className`, `on<event>` (a listener),
// `aria-*`, `data-*`, `role`, `for` and `hidden` as attributes, everything
// else as a property. Children are elements or strings.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key.startsWith("aria-") || key.startsWith("data-") || key === "role" || key === "for") node.setAttribute(key, value === true ? "" : String(value));
    else if (key === "hidden") node.hidden = true;
    else node[key] = value;
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** A definition list from [term, description] pairs (descriptions may be
 * elements). */
export function details(pairs, className = "control-facts") {
  const list = el("dl", { className });
  for (const [term, description] of pairs) {
    if (description === null || description === undefined) continue;
    list.append(el("div", {}, el("dt", { text: term }), el("dd", {}, description)));
  }
  return list;
}
