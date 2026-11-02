// DOM-contract tests for the progressively enhanced knowledge check.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const saved = new Map();
let ObQuiz;

class Classes {
  values = new Set();
  toggle(name, on) {
    if (on) this.values.add(name);
    else this.values.delete(name);
  }
  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }
  has(name) {
    return this.values.has(name);
  }
}

const context = {
  HTMLElement: class {},
  customElements: {
    get: () => null,
    define: (_name, constructor) => (ObQuiz = constructor),
  },
  location: { pathname: "/lesson/" },
  localStorage: {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key),
  },
  document: {
    createElement: () => ({ className: "", textContent: "" }),
  },
};
vm.runInNewContext(fs.readFileSync(new URL("../../web/components/ob-quiz.js", import.meta.url), "utf8"), context);

function fixture(key = "question") {
  const makeLabel = (text) => {
    const notes = [];
    const label = {
      classList: new Classes(),
      answer: { textContent: text },
      notes,
      querySelector(selector) {
        if (selector === "span") return this.answer;
        if (selector === ".ob-quiz-answer-note") return notes[0] || null;
        return null;
      },
      append(note) {
        notes.push(note);
        note.remove = () => notes.splice(notes.indexOf(note), 1);
      },
    };
    return label;
  };
  const inputs = [
    { value: "0", dataset: { correct: "true" }, label: makeLabel("The right answer") },
    { value: "1", dataset: {}, label: makeLabel("A distractor") },
  ];
  for (const input of inputs) {
    input.checked = false;
    input.disabled = false;
    input.closest = () => input.label;
    input.addEventListener = (_name, callback) => (input.change = callback);
    input.focus = () => (input.focused = true);
  }
  const feedback = {
    hidden: true,
    result: null,
    querySelector: (selector) => (selector === ".ob-quiz-result" ? feedback.result : null),
    prepend: (node) => (feedback.result = node),
  };
  const retry = {
    hidden: true,
    addEventListener: (_name, callback) => (retry.click = callback),
  };
  const quiz = new ObQuiz();
  quiz.dataset = { key };
  quiz.querySelectorAll = (selector) =>
    selector === 'input[type="radio"]' ? inputs : inputs.flatMap((input) => input.label.notes);
  quiz.querySelector = (selector) => (selector === ".ob-quiz-feedback" ? feedback : retry);
  quiz.connectedCallback();
  return { quiz, inputs, feedback, retry };
}

test("answers immediately, announces the correction, persists, and retries", () => {
  saved.clear();
  const { quiz, inputs, feedback, retry } = fixture();
  inputs[1].checked = true;
  inputs[1].change();
  assert.equal(feedback.hidden, false);
  assert.equal(feedback.result.textContent, "Not quite. The correct answer is The right answer.");
  assert.equal(inputs[0].label.notes[0].textContent, " Correct answer.");
  assert.ok(inputs.every((input) => input.disabled));
  assert.equal(saved.get("ob-quiz:/lesson/:question"), "1");

  retry.click();
  assert.equal(feedback.hidden, true);
  assert.ok(inputs.every((input) => !input.disabled && !input.checked));
  assert.equal(inputs[0].focused, true);
  assert.equal(saved.has("ob-quiz:/lesson/:question"), false);
});

test("restores only an unchanged question's local attempt", () => {
  saved.clear();
  saved.set("ob-quiz:/lesson/:same-content", "0");
  const restored = fixture("same-content");
  assert.equal(restored.inputs[0].checked, true);
  assert.equal(restored.feedback.result.textContent, "Correct.");

  const changed = fixture("changed-content");
  assert.ok(changed.inputs.every((input) => !input.checked && !input.disabled));
  assert.equal(changed.feedback.hidden, true);
});
