// Quick polls in chat (#135): the dialog that asks one, and the view of one
// in the log. Options are native radio buttons (one answer) or checkboxes
// (several) with labels; results are text, with who voted for what, never
// only a bar. Voting, closing and all rules live in the engine.
import { choiceOf, MAX_POLL_OPTIONS, MAX_POLL_OPTION_CHARS, MAX_POLL_QUESTION_CHARS, MIN_POLL_OPTIONS, pollProblem, tally } from "../chat/chat-polls.js";

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** The poll as it shows in a message row. `content` is { question, options };
 * `message.poll` has the votes. `onChoose(option numbers)` votes; `onClose()`
 * closes it (offered to its author only). */
export function renderPoll({ message, content, room, canVote, onChoose, onClose }) {
  const poll = message.poll;
  const me = room.identity.memberId;
  const mine = choiceOf(poll, me);
  const rows = tally(poll);
  const open = !poll.closed;
  const group = document.createElement("fieldset");
  group.className = "chat-poll";
  const legend = document.createElement("legend");
  legend.className = "chat-poll-question";
  legend.textContent = content.question;
  const hint = document.createElement("p");
  hint.className = "chat-poll-hint";
  hint.id = `chat-poll-hint-${message.messageId}`;
  hint.textContent = poll.closed ? "Poll closed. Final results." : !canVote ? "You can read this poll but not vote." : poll.multiple ? "Choose any that apply. You can change your vote until the poll closes." : "Choose one. You can change your vote until the poll closes.";
  group.setAttribute("aria-describedby", hint.id);
  group.append(legend, hint);
  const choose = (list) => {
    const inputs = [...list.querySelectorAll("input")];
    onChoose(inputs.filter((input) => input.checked).map((input) => Number(input.value)));
  };
  const list = document.createElement("ul");
  list.className = "chat-poll-options";
  content.options.forEach((text, index) => {
    const item = document.createElement("li");
    const label = document.createElement("label");
    label.className = "chat-poll-option";
    const input = document.createElement("input");
    input.type = poll.multiple ? "checkbox" : "radio";
    input.name = `poll-${message.messageId}`;
    input.value = String(index);
    input.checked = mine.includes(index);
    input.disabled = !open || !canVote;
    input.dataset.action = `poll-option-${index}`;
    input.addEventListener("change", () => choose(list));
    const name = document.createElement("span");
    name.className = "chat-poll-label";
    name.textContent = text;
    const count = document.createElement("span");
    count.className = "chat-poll-count";
    count.textContent = plural(rows[index].count, "vote", "votes");
    label.append(input, name, " ", count);
    item.append(label);
    if (rows[index].voters.length) {
      const voters = document.createElement("span");
      voters.className = "chat-poll-voters";
      voters.textContent = rows[index].voters.map((id) => room.authorLabel(id)).join(", ");
      item.append(voters);
    }
    list.append(item);
  });
  group.append(list);
  const total = document.createElement("p");
  total.className = "chat-poll-total";
  total.textContent = plural(poll.votes.length, "person has voted", "people have voted");
  group.append(total);
  if (open && canVote && mine.length) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "chat-poll-clear";
    clear.dataset.action = "poll-clear";
    clear.textContent = "Clear my vote";
    clear.addEventListener("click", () => onChoose([]));
    group.append(clear);
  }
  if (open && canVote && message.authorId === me) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "chat-poll-close";
    close.dataset.action = "poll-close";
    close.textContent = "Close poll";
    close.addEventListener("click", () => onClose());
    group.append(close);
  }
  return group;
}

/** The dialog that asks a poll. `open({ opener, submit })`: submit gets
 * { question, options, multiple } and may reject with an Error whose message
 * is shown; it resolves once the poll is stored. */
class KinChatPoll extends HTMLElement {
  connectedCallback() {
    if (this.dialog) return;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "chat-poll-dialog quick-add-dialog";
    this.dialog.setAttribute("aria-labelledby", "chat-poll-heading");
    const heading = document.createElement("h2");
    heading.id = "chat-poll-heading";
    heading.textContent = "Ask a poll";
    this.form = document.createElement("form");
    this.form.method = "dialog";
    this.form.className = "quick-add-form chat-poll-form";
    const questionLabel = document.createElement("label");
    questionLabel.htmlFor = "chat-poll-question";
    questionLabel.textContent = "Question";
    this.question = document.createElement("input");
    this.question.id = "chat-poll-question";
    this.question.type = "text";
    this.question.autocomplete = "off";
    this.question.maxLength = MAX_POLL_QUESTION_CHARS;
    this.options = document.createElement("fieldset");
    this.options.className = "chat-poll-fields";
    const legend = document.createElement("legend");
    legend.textContent = `Options (${MIN_POLL_OPTIONS} to ${MAX_POLL_OPTIONS})`;
    this.optionList = document.createElement("ol");
    this.optionList.className = "chat-poll-field-list";
    this.add = document.createElement("button");
    this.add.type = "button";
    this.add.textContent = "Add option";
    this.add.addEventListener("click", () => this.addOption({ focus: true }));
    this.options.append(legend, this.optionList, this.add);
    const manyLabel = document.createElement("label");
    manyLabel.className = "chat-poll-many";
    this.many = document.createElement("input");
    this.many.type = "checkbox";
    manyLabel.append(this.many, " Allow choosing more than one answer");
    this.error = document.createElement("p");
    this.error.className = "quick-add-error";
    this.error.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "quick-add-actions";
    this.cancel = document.createElement("button");
    this.cancel.type = "button";
    this.cancel.textContent = "Cancel";
    this.cancel.addEventListener("click", () => { if (!this.pending) this.dialog.close(); });
    this.post = document.createElement("button");
    this.post.type = "submit";
    this.post.className = "add-button";
    this.post.textContent = "Post poll";
    actions.append(this.cancel, this.post);
    this.form.append(questionLabel, this.question, this.options, manyLabel, this.error, actions);
    this.dialog.append(heading, this.form);
    this.append(this.dialog);
    this.form.addEventListener("submit", (event) => { event.preventDefault(); void this.submit(); });
    this.dialog.addEventListener("cancel", (event) => {
      if (this.pending) { event.preventDefault(); this.error.textContent = "Please wait for the poll to send."; }
    });
    this.dialog.addEventListener("close", () => {
      if (this.pending && this.submitter) { this.dialog.showModal(); return; }
      const target = this.opener?.isConnected ? this.opener : null;
      this.opener = null;
      this.submitter = null;
      target?.focus();
    });
  }

  open({ opener = null, submit }) {
    if (typeof submit !== "function" || this.dialog.open) return false;
    this.opener = opener;
    this.submitter = submit;
    this.pending = false;
    this.question.value = "";
    this.many.checked = false;
    this.error.textContent = "";
    this.optionList.replaceChildren();
    for (let at = 0; at < MIN_POLL_OPTIONS; at += 1) this.addOption();
    this.setBusy(false);
    this.dialog.showModal();
    this.question.focus();
    return true;
  }

  addOption({ focus = false } = {}) {
    if (this.optionList.children.length >= MAX_POLL_OPTIONS) return;
    const item = document.createElement("li");
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.maxLength = MAX_POLL_OPTION_CHARS;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      const at = [...this.optionList.children].indexOf(item);
      item.remove();
      this.numberOptions();
      const next = this.optionList.children[Math.min(at, this.optionList.children.length - 1)];
      (next?.querySelector("input") ?? this.add).focus();
    });
    item.append(input, " ", remove);
    this.optionList.append(item);
    this.numberOptions();
    if (focus) input.focus();
  }

  /** Every option has its own label ("Option 2"); extras can be removed. */
  numberOptions() {
    [...this.optionList.children].forEach((item, index) => {
      const input = item.querySelector("input");
      const remove = item.querySelector("button");
      input.setAttribute("aria-label", `Option ${index + 1}`);
      remove.setAttribute("aria-label", `Remove option ${index + 1}`);
      remove.hidden = this.optionList.children.length <= MIN_POLL_OPTIONS;
    });
    this.add.disabled = this.optionList.children.length >= MAX_POLL_OPTIONS;
  }

  setBusy(busy) {
    this.pending = busy;
    for (const control of this.form.querySelectorAll("input, button")) control.disabled = busy;
    if (!busy) this.numberOptions();
    this.post.textContent = busy ? "Sending…" : "Post poll";
  }

  async submit() {
    if (this.pending) return;
    const poll = {
      question: this.question.value,
      options: [...this.optionList.querySelectorAll("input")].map((input) => input.value),
      multiple: this.many.checked,
    };
    const problem = pollProblem(poll);
    if (problem) {
      this.error.textContent = problem;
      const empty = [...this.optionList.querySelectorAll("input")].find((input) => !input.value.trim());
      (!poll.question.trim() ? this.question : empty ?? this.question).focus();
      return;
    }
    this.error.textContent = "";
    this.setBusy(true);
    try {
      await this.submitter(poll);
    } catch (error) {
      this.setBusy(false);
      this.error.textContent = error?.message || "Kin couldn't send the poll. Try again.";
      this.question.focus();
      return;
    }
    this.pending = false;
    this.submitter = null;
    this.dialog.close();
  }

  /** The chat closed or Kin locked: nothing stays open or typed. */
  reset() {
    this.pending = false;
    this.submitter = null;
    this.opener = null;
    if (this.dialog?.open) this.dialog.close();
    if (this.question) {
      this.question.value = "";
      this.optionList.replaceChildren();
    }
  }
}

if (!customElements.get("kin-chat-poll")) customElements.define("kin-chat-poll", KinChatPoll);
