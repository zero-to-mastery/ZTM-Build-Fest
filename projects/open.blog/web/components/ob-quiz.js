// <ob-quiz> progressively enhances a quiz fence rendered by open.blog.
// Attempts stay in localStorage on this browser. No answer data is sent anywhere.

class ObQuiz extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = "true";
    this.inputs = [...this.querySelectorAll('input[type="radio"]')];
    this.feedback = this.querySelector(".ob-quiz-feedback");
    this.retry = this.querySelector(".ob-quiz-retry");
    if (!this.inputs.length || !this.feedback || !this.retry) return;

    this.storageKey = `ob-quiz:${location.pathname}:${this.dataset.key || "question"}`;
    this.inputs.forEach((input) => input.addEventListener("change", () => this.answer(input)));
    this.retry.addEventListener("click", () => this.reset());

    const saved = this.load();
    const selected = this.inputs.find((input) => input.value === saved);
    if (selected) {
      selected.checked = true;
      this.answer(selected, false);
    }
  }

  load() {
    try {
      return localStorage.getItem(this.storageKey);
    } catch {
      return null;
    }
  }

  save(value) {
    try {
      if (value === null) localStorage.removeItem(this.storageKey);
      else localStorage.setItem(this.storageKey, value);
    } catch {
      // Storage may be disabled; the interaction still works for this visit.
    }
  }

  answer(selected, persist = true) {
    const correct = selected.dataset.correct === "true";
    const correctInput = this.inputs.find((input) => input.dataset.correct === "true");
    const correctChoice = correctInput?.closest("label");
    const correctText = correctChoice?.querySelector("span")?.textContent.trim() || "the marked choice";
    for (const input of this.inputs) {
      input.disabled = true;
      const label = input.closest("label");
      label?.classList.toggle("ob-quiz-correct", input.dataset.correct === "true");
      label?.classList.toggle("ob-quiz-selected", input === selected);
      if (input.dataset.correct === "true" && label && !label.querySelector(".ob-quiz-answer-note")) {
        const note = document.createElement("span");
        note.className = "ob-visually-hidden ob-quiz-answer-note";
        note.textContent = " Correct answer.";
        label.append(note);
      }
    }
    let result = this.feedback.querySelector(".ob-quiz-result");
    if (!result) {
      result = document.createElement("strong");
      result.className = "ob-quiz-result";
      this.feedback.prepend(result);
    }
    result.textContent = correct ? "Correct." : `Not quite. The correct answer is ${correctText}.`;
    this.feedback.hidden = false;
    this.retry.hidden = false;
    if (persist) this.save(selected.value);
  }

  reset() {
    for (const input of this.inputs) {
      input.checked = false;
      input.disabled = false;
      input.closest("label")?.classList.remove("ob-quiz-correct", "ob-quiz-selected");
    }
    this.querySelectorAll(".ob-quiz-answer-note").forEach((note) => note.remove());
    this.feedback.hidden = true;
    this.retry.hidden = true;
    this.save(null);
    this.inputs[0]?.focus();
  }
}

if (!customElements.get("ob-quiz")) {
  customElements.define("ob-quiz", ObQuiz);
}
