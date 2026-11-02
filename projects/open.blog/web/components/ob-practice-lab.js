// <ob-practice-lab data-lesson="..."> is a guided practice terminal for Git lessons. The reader
// types each command themselves; the scripted rules live in ob-practice-model.js. Long output (a
// multi-page log, a manual page) opens in a simulated `less`, as it does in a real terminal, and
// answers to the same keys. Children of the element are the no-JavaScript fallback, hidden once
// the lab starts. Nothing is stored or sent.
import { start, submit, currentStep, isDone, pagerOpen, pagerKey, pagerView, recallNew, recallPush, recallKey } from "./ob-practice-model.js";
import { ObLab, defineLab, el as html } from "./ob-lab.js";

const WELCOME = [{ kind: "tip", text: "Practice terminal. Nothing here touches your computer." }];

class ObPracticeLab extends ObLab {
  setup() {
    this.session = start(this.dataset.lesson);
    if (!this.session) {
      this.fallback.hidden = false;
      return;
    }
    this.status = html("p", { class: "ob-practice-status" });
    this.goal = html("p", { class: "ob-practice-goal" });
    this.log = html("div", { class: "ob-practice-log", role: "log", "aria-live": "polite", tabindex: "0", "aria-label": "Terminal output" });
    this.input = html("input", {
      id: `ob-practice-input-${Math.random().toString(36).slice(2, 8)}`, class: "ob-practice-input", type: "text",
      autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "type a command, press Enter",
    });
    this.recall = recallNew();
    this.input.addEventListener("keydown", (event) => this.shellKey(event));
    this.submitButton = html("button", { type: "submit" }, "Run");
    this.restart = html("button", { type: "button", class: "ob-practice-restart", hidden: "" }, "Practice again");
    this.restart.addEventListener("click", () => {
      this.session = start(this.dataset.lesson);
      this.log.replaceChildren();
      this.print(WELCOME);
      this.render();
      this.input.focus();
    });
    this.form = html("form", { class: "ob-practice-form" });
    this.form.append(html("label", { for: this.input.id }, "Command"), this.input, this.submitButton);
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.recall = recallPush(this.recall, this.input.value);
      const result = submit(this.session, this.input.value);
      this.input.value = "";
      this.session = result.session;
      this.print(result.lines);
      if (result.pager) this.openPager(result.pager);
      else this.render();
    });
    this.buildPager();
    this.append(this.status, this.goal, this.log, this.pagerPanel, this.form, this.restart);
    this.print(WELCOME);
    this.render();
  }

  setLine(value, caret = value.length) {
    this.input.value = value;
    this.input.setSelectionRange(caret, caret);
  }

  // The shell keys a reader expects at a prompt: Up/Down (or Ctrl+P/N) for earlier commands, and the
  // usual readline edits. Ctrl+C only cancels the line when nothing is selected, so copying still works.
  shellKey(event) {
    if (event.isComposing || event.altKey || event.metaKey) return;
    const input = this.input;
    const plain = !event.ctrlKey && !event.shiftKey;
    const ctrl = event.ctrlKey && !event.shiftKey;
    const recalled = plain || ctrl ? recallKey(this.recall, event.key, input.value, ctrl) : { handled: false };
    if (recalled.handled) {
      event.preventDefault();
      this.recall = recalled.recall;
      this.setLine(recalled.value);
      return;
    }
    if (!ctrl) return;
    const caret = input.selectionStart ?? input.value.length;
    const key = event.key.toLowerCase();
    if (key === "a") this.setLine(input.value, 0);
    else if (key === "e") this.setLine(input.value);
    else if (key === "u") this.setLine(input.value.slice(caret), 0);
    else if (key === "w") {
      const before = input.value.slice(0, caret).replace(/\S+\s*$/, "");
      this.setLine(before + input.value.slice(caret), before.length);
    } else if (key === "l") this.log.replaceChildren();
    else if (key === "c" && input.selectionStart === input.selectionEnd) {
      this.print([{ kind: "cmd", text: `$ ${input.value}^C` }]);
      this.recall = { ...this.recall, at: null, draft: "" };
      this.setLine("");
    } else return;
    event.preventDefault();
  }

  buildPager() {
    this.pagerView = html("pre", { class: "ob-practice-pager-view" });
    this.pagerPrompt = html("p", { class: "ob-practice-pager-prompt", "aria-hidden": "true" });
    this.pagerSummary = html("p", { class: "ob-practice-pager-summary", role: "status" });
    const button = (text, label, key) => {
      const node = html("button", { type: "button", "aria-label": label }, text);
      node.addEventListener("click", () => {
        this.pagerPress(key);
        if (this.pagerPanel && !this.pagerPanel.hidden) this.pagerPanel.focus();
      });
      return node;
    };
    this.pagerBack = button("Back", "Previous page (b)", "b");
    this.pagerNext = button("Next page", "Next page (space)", " ");
    const quit = button("Quit (q)", "Quit the pager (q)", "q");
    const controls = html("div", { class: "ob-practice-pager-controls" });
    controls.append(this.pagerBack, this.pagerNext, quit);
    this.pagerPanel = html("div", { class: "ob-practice-pager", role: "group", tabindex: "-1", "aria-label": "Pager, like less" });
    this.pagerPanel.hidden = true;
    this.pagerPanel.append(
      this.pagerView,
      this.pagerPrompt,
      html("p", { class: "ob-practice-pager-keys" }, "Keys: space next page, b back, j or Enter down a line, k up, g top, G bottom, q quit."),
      this.pagerSummary,
      controls,
    );
    this.pagerPanel.addEventListener("keydown", (event) => {
      if (event.target.tagName === "BUTTON" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (this.pagerPress(event.key)) event.preventDefault();
    });
  }

  openPager({ text, after }) {
    this.pager = pagerOpen(text);
    this.pagerAfter = after;
    this.log.hidden = true;
    this.form.hidden = true;
    this.pagerPanel.hidden = false;
    this.paintPager();
    this.pagerPanel.focus();
  }

  // Returns true when the key means something to the pager.
  pagerPress(key) {
    if (!this.pager) return false;
    const result = pagerKey(this.pager, key);
    if (!result.handled) return false;
    if (result.quit) {
      this.pager = null;
      this.pagerPanel.hidden = true;
      this.log.hidden = false;
      this.form.hidden = false;
      this.print(this.pagerAfter);
      this.render();
      if (!this.input.disabled) this.input.focus();
      return true;
    }
    this.pager = result.pager;
    this.paintPager();
    return true;
  }

  paintPager() {
    const view = pagerView(this.pager);
    this.pagerView.textContent = view.text;
    this.pagerPrompt.textContent = view.prompt;
    this.pagerSummary.textContent = `${view.summary} Press q to quit.`;
    this.pagerBack.disabled = view.atStart;
    this.pagerNext.disabled = view.atEnd;
  }

  print(lines) {
    for (const { kind, text } of lines) this.log.append(html("p", { class: `ob-practice-line is-${kind}` }, text));
    this.log.scrollTop = this.log.scrollHeight;
  }

  render() {
    const total = this.session.lesson.steps.length;
    const done = isDone(this.session);
    this.status.textContent = done ? `All ${total} commands done` : `Command ${Math.min(this.session.index + 1, total)} of ${total}`;
    this.goal.textContent = done ? "You typed every command yourself. Nice work." : currentStep(this.session).goal;
    this.input.disabled = done;
    this.submitButton.disabled = done;
    this.restart.hidden = !done;
  }
}

defineLab("ob-practice-lab", ObPracticeLab);
