import { html } from "../markdown/serialize.js";
import { fillSourceDiff, sourceDiffMarkup } from "../components/source-diff.js";
import {
  checklist,
  checklistMarkdown,
  lessonReview,
  lineRange,
  projectTypes,
  writingExamples,
} from "./model.js";
import {
  progressFor,
  readLearningProgress,
  saveChecklistProgress,
} from "./progress.js";

const statusLabel = {
  observed: "Observed",
  "not-detected": "Not detected",
  unknown: "Unknown",
};

export function openLearningStudio(app) {
  const draft = app.store.draft,
    source = draft.markdown,
    examples = writingExamples();
  app.modal(
    `<h1>Learning studio</h1><p>Optional, skippable practice using your real editor. Lessons inspect only the current local source and never insert, rewrite or publish content.</p><label>Project type<select data-learning-type>${projectTypes()
      .map((type) => `<option value="${type.id}">${type.label}</option>`)
      .join(
        "",
      )}</select></label><section aria-labelledby="learning-lessons"><h2 id="learning-lessons">Guided writing lessons</h2><p>Open a relevant heading in the Markdown editor, make only changes you can verify, then return when you choose.</p><ol data-learning-tasks></ol><button data-learning-skip>Skip lessons for now</button></section><section aria-labelledby="learning-example"><h2 id="learning-example">Before-and-after explanations</h2><label>Synthetic example<select data-learning-example>${examples.map((example) => `<option value="${example.id}">${html(example.label)}</option>`).join("")}</select></label><div data-learning-annotations></div><div data-learning-example-diff>${sourceDiffMarkup({ beforeLabel: "Synthetic before", afterLabel: "Synthetic after", label: "Annotated writing example" })}</div><p class="hint">Placeholders are intentionally unverified. Examples are never applied to your README.</p></section><section aria-labelledby="learning-checklist"><h2 id="learning-checklist">Reusable checklist</h2><p>Progress is local, advisory and separate from README source.</p><div data-learning-checklist></div><button data-learning-export>Download ordinary Markdown checklist</button></section><p data-learning-status role="status">Learning tools are local and read-only. Your source is unchanged.</p>`,
  );
  const type = app.querySelector("[data-learning-type]"),
    tasks = app.querySelector("[data-learning-tasks]"),
    example = app.querySelector("[data-learning-example]"),
    annotations = app.querySelector("[data-learning-annotations]"),
    checklistArea = app.querySelector("[data-learning-checklist]"),
    status = app.querySelector("[data-learning-status]"),
    diff = app.querySelector("[data-learning-example-diff]");
  let completed = [];
  const renderExample = () => {
    const value = examples.find((item) => item.id === example.value);
    annotations.innerHTML = `<h3>${html(value.label)}</h3><ul>${value.annotations.map((note) => `<li>${html(note)}</li>`).join("")}</ul>`;
    fillSourceDiff(diff, value.before, value.after);
  };
  const render = () => {
    const review = lessonReview(source, type.value);
    tasks.innerHTML = review.tasks
      .map(
        (task) =>
          `<li data-lesson="${task.id}" data-state="${task.status}"><strong>${html(task.label)} — ${statusLabel[task.status]}</strong><p>${html(task.why)}</p><p>${html(task.evidence)}</p><button data-practice="${task.id}">Practice in Markdown editor</button></li>`,
      )
      .join("");
    tasks.onclick = (event) => {
      const button = event.target.closest("[data-practice]");
      if (!button) return;
      const task = review.tasks.find(
        (item) => item.id === button.dataset.practice,
      );
      app.dispatchEvent(
        new CustomEvent("learning-practice", {
          detail: {
            source,
            range: lineRange(source, task.line),
            label: task.label,
          },
        }),
      );
    };
    try {
      completed = progressFor(readLearningProgress(), draft.id, type.value);
      status.textContent = `${review.caveat} Your source is unchanged.`;
    } catch (error) {
      completed = [];
      status.textContent = `${error.message} Lessons and export still work; your source is unchanged.`;
    }
    const items = checklist(type.value);
    checklistArea.innerHTML = items
      .map(
        (item) =>
          `<label class="check"><input type="checkbox" data-checklist="${item.id}" ${completed.includes(item.id) ? "checked" : ""}> ${html(item.label)} — ${html(item.why)}</label>`,
      )
      .join("");
    checklistArea.onchange = (event) => {
      const input = event.target.closest("[data-checklist]");
      if (!input) return;
      const before = [...completed];
      completed = [
        ...checklistArea.querySelectorAll("[data-checklist]:checked"),
      ].map((item) => item.dataset.checklist);
      try {
        saveChecklistProgress(draft.id, type.value, completed);
        status.textContent = `Checklist progress saved locally (${completed.length}/${items.length}). README source is unchanged.`;
      } catch (error) {
        completed = before;
        for (const box of checklistArea.querySelectorAll("[data-checklist]"))
          box.checked = completed.includes(box.dataset.checklist);
        status.textContent = error.message;
      }
    };
  };
  type.onchange = render;
  example.onchange = renderExample;
  app.querySelector("[data-learning-skip]").onclick = () => {
    status.textContent =
      "Lessons skipped. Nothing changed; return whenever useful.";
  };
  app.querySelector("[data-learning-export]").onclick = () =>
    app.dispatchEvent(
      new CustomEvent("learning-download", {
        detail: {
          content: checklistMarkdown(type.value, completed),
          name: `${type.value}-readme-checklist.md`,
        },
      }),
    );
  render();
  renderExample();
  type.focus();
}
