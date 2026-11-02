// Small DOM builders shared by components. They create native elements and
// set text through textContent only, so household text is never parsed as
// markup. `parent` appends the new node when given.

/** A native `type="button"` button that runs `action` on click. */
export function button(label, action, { className = "", disabled = false, parent = null } = {}) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  if (className) node.className = className;
  node.disabled = Boolean(disabled);
  node.addEventListener("click", action);
  parent?.append(node);
  return node;
}

/** A text element, a paragraph by default. */
export function text(value, { parent = null, tag = "p", className = "" } = {}) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  parent?.append(node);
  return node;
}

/** A `<section>` with a heading. */
export function section(title, { className = "", heading = "h3", parent = null } = {}) {
  const node = document.createElement("section");
  if (className) node.className = className;
  const label = document.createElement(heading);
  label.textContent = title;
  node.append(label);
  parent?.append(node);
  return node;
}

/**
 * One reusable live region inside `host`, found by `className` and created on
 * first use. It announces politely, or assertively when `alert` is set.
 */
export function message(host, value, { alert = false, className = "message" } = {}) {
  let region = host.querySelector(`.${className}`);
  if (!region) {
    region = document.createElement("p");
    region.className = className;
    host.append(region);
  }
  region.setAttribute("role", alert ? "alert" : "status");
  region.textContent = value;
  return region;
}

/** A `<label>` wrapping its caption and control, with an optional hint. */
export function field(caption, control, { hint = "", className = "", parent = null } = {}) {
  const label = document.createElement("label");
  if (className) label.className = className;
  const span = document.createElement("span");
  span.textContent = caption;
  label.append(span, control);
  if (hint) {
    const small = document.createElement("small");
    small.textContent = hint;
    label.append(small);
  }
  parent?.append(label);
  return label;
}

/** Home Screen install steps from platform.js installHelp(), as a card. */
export function installHelpCard(help, { parent = null } = {}) {
  const node = document.createElement("section");
  node.className = "install-help";
  node.setAttribute("aria-label", help.title);
  text(help.title, { parent: node, tag: "h3" });
  const steps = document.createElement("ol");
  for (const step of help.steps) text(step, { parent: steps, tag: "li" });
  node.append(steps);
  text(help.note, { parent: node });
  parent?.append(node);
  return node;
}
