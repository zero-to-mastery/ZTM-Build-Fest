// The Help button (#621): at the top of every page and in the major dialogs.
// It asks the app to open Help with `kin:open-help` ({ topic, opener });
// without a topic, Help is for the page on screen (app/help.js).
import { HELP_COPY } from "../../help/help-content.js";

// Static, source-controlled markup: a question mark in a circle.
const HELP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><path d="M12 17h.01"/></svg>';

export function helpButton(topic = null) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "help-button";
  button.setAttribute("aria-haspopup", "dialog");
  if (topic) button.dataset.helpTopic = topic;
  button.innerHTML = `${HELP_ICON}<span>${HELP_COPY.button}</span>`;
  button.addEventListener("click", () => {
    button.dispatchEvent(new CustomEvent("kin:open-help", { bubbles: true, composed: true, detail: { topic, opener: button } }));
  });
  return button;
}
