// The plain-language suggestions panel (ADR 0262): the sentences from `checkMarkdown` as a list, each with a
// real "Fix it" button where a fix is safe. It is a list in a disclosure, announced politely, and it never
// blocks saving. A fix that needs words asks for them in a small form right under the sentence.

import { el } from "./block-forms.js";
import { applyFix, checkMarkdown, checksSummary } from "./checks.js";

let uid = 0;

/**
 * `getMarkdown()` reads the current text, `setMarkdown(text)` puts changed text back (and redraws the
 * surface), `options` goes to the checker. Returns `{ element, update(), schedule() }`.
 */
export function buildChecksPanel({ getMarkdown, setMarkdown, options = {}, wait = 600 }) {
  const id = `oba-checks-${++uid}`;
  const status = el("p", { class: "oba-small oba-checks-status", role: "status", "aria-live": "polite" });
  const summary = el("summary", { class: "oba-checks-summary" });
  const list = el("ul", { class: "oba-checks-list" });
  const details = el("details", { class: "oba-checks", "data-checks": "true", hidden: true }, summary, list);
  const element = el("div", { class: "oba-checks-wrap", id }, details, status);
  let issues = [];
  let timer = null;
  let announced = "";

  const close = (item) => item.querySelector(".oba-checks-ask")?.remove();

  function ask(item, issue) {
    close(item);
    const field = `${id}-ask-${issues.indexOf(issue)}`;
    const input = el("input", { type: "text", id: field, maxlength: "200", autocomplete: "off", class: "oba-checks-input" });
    const apply = () => {
      const result = applyFix(getMarkdown(), issue, input.value);
      if (!result.changed) {
        status.textContent = "Add a few words first, or cancel.";
        input.focus();
        return;
      }
      close(item);
      setMarkdown(result.markdown);
      update(`Fixed. ${issue.fix.label}.`);
    };
    const form = el(
      "div",
      { class: "oba-checks-ask" },
      el("label", { for: field }, issue.fix.prompt),
      input,
      el("div", { class: "oba-checks-actions" },
        el("button", { type: "button", class: "oba-btn oba-btn-primary", onClick: apply }, "Apply"),
        el("button", { type: "button", class: "oba-btn", onClick: () => { close(item); item.querySelector("[data-fix]")?.focus(); } }, "Cancel"),
      ),
    );
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        apply();
      } else if (event.key === "Escape") {
        event.preventDefault();
        close(item);
        item.querySelector("[data-fix]")?.focus();
      }
    });
    item.append(form);
    input.focus();
  }

  function update(message = "") {
    clearTimeout(timer);
    let markdown = "";
    try {
      markdown = String(getMarkdown() ?? "");
    } catch {
      markdown = "";
    }
    issues = checkMarkdown(markdown, options);
    // Keep an open question open while the owner types in it.
    const keep = list.querySelector(".oba-checks-ask input");
    if (keep && document.activeElement === keep) return;
    list.replaceChildren(
      ...issues.map((issue) => {
        const item = el("li", { class: "oba-checks-item", "data-check": issue.rule }, el("span", { class: "oba-checks-message" }, issue.message));
        if (issue.fix) {
          const button = el("button", { type: "button", class: "oba-btn", "data-fix": issue.fix.kind, "aria-label": `Fix it: ${issue.fix.label}. ${issue.message}` }, "Fix it");
          button.addEventListener("click", () => {
            if (issue.fix.kind === "describe") ask(item, issue);
            else {
              const result = applyFix(getMarkdown(), issue);
              if (!result.changed) return;
              setMarkdown(result.markdown);
              update(`Fixed. ${issue.fix.label}.`);
            }
          });
          item.append(button);
        }
        return item;
      }),
    );
    summary.textContent = issues.length === 1 ? "1 suggestion" : `${issues.length} suggestions`;
    details.hidden = issues.length === 0;
    // The button that was pressed is gone; keep the place in the page.
    if (message && issues.length && !element.contains(document.activeElement)) summary.focus();
    const next = issues.length ? checksSummary(issues) : "";
    // Announce when the count changes or a fix happened, not on every keystroke.
    if (message || next !== announced) status.textContent = message ? `${message} ${checksSummary(issues)}` : next;
    announced = next;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => update(), wait);
  }

  update();
  return { element, update, schedule };
}
