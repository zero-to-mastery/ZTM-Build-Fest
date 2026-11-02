// <ob-evolution-lab> compares older and newer JavaScript for the same task: pick a milestone,
// read both versions, run the two fixed functions against the same sample data and see that
// they agree. Nothing is editable, and nothing is fetched, stored or evaluated from text.
// Children of the element are the no-JavaScript fallback. Both versions run in the reader's own
// browser, so no timing or compatibility claim is made.
import { highlight } from "./ob-highlight.js";
import { evolutionExamples, runExample } from "./ob-evolution-model.js";
import { ObLab, defineLab, el } from "./ob-lab.js";

function paint(pre, code) {
  pre.replaceChildren(...highlight(code, "javascript").map((token) => {
    if (!token.cls) return token.text;
    return el("span", { class: `tok-${token.cls}` }, token.text);
  }));
}

class ObEvolutionLab extends ObLab {
  setup() {
    this.selected = 0;
    this.revision = 0;

    this.eras = el("div", { class: "ob-evo-eras", role: "group", "aria-label": "Choose a language milestone" });
    this.buttons = evolutionExamples.map((example, index) => {
      const button = el("button", { type: "button" }, example.label);
      button.addEventListener("click", () => this.select(index));
      this.eras.append(button);
      return button;
    });
    this.context = el("p", { class: "ob-evo-context" });
    this.titles = [el("h3"), el("h3")];
    this.code = [
      el("pre", { class: "ob-evo-code", tabindex: "0", "aria-label": "Older approach, source" }),
      el("pre", { class: "ob-evo-code", tabindex: "0", "aria-label": "Newer approach, source" }),
    ];
    this.results = [
      el("pre", { class: "ob-evo-code", tabindex: "0", "aria-label": "Older approach, result" }),
      el("pre", { class: "ob-evo-code", tabindex: "0", "aria-label": "Newer approach, result" }),
    ];
    this.caveat = el("p", { class: "ob-evo-caveat" });
    this.input = el("pre", { class: "ob-evo-code", tabindex: "0", "aria-label": "Shared input" });
    this.run = el("button", { type: "button" }, "Run both examples");
    this.run.addEventListener("click", () => this.execute());
    this.status = el("p", { class: "ob-evo-status", role: "status" });

    const column = (index, kind) => {
      const box = el("div", { class: "ob-evo-column" });
      box.append(this.titles[index], this.code[index], el("h4", {}, `${kind} result`), this.results[index]);
      return box;
    };
    const compare = el("div", { class: "ob-evo-compare" });
    compare.append(column(0, "Older approach"), column(1, "Newer approach"));
    const details = el("details", { class: "ob-evo-input" });
    details.append(el("summary", {}, "Inspect the shared input"), this.input);

    this.append(
      el("p", { class: "ob-evo-note" }, "Pick a milestone, then run both fixed examples against the same sample data. They run in your current browser, not in an emulated older engine."),
      this.eras, this.context, compare, this.caveat, details, this.run, this.status);
    this.select(0);
  }

  select(index) {
    this.selected = index;
    this.revision++;
    const example = evolutionExamples[index];
    this.context.textContent = example.context;
    this.titles[0].textContent = example.beforeTitle;
    this.titles[1].textContent = example.afterTitle;
    paint(this.code[0], example.before);
    paint(this.code[1], example.after);
    this.caveat.textContent = example.caveat;
    this.input.textContent = JSON.stringify(example.input, null, 2);
    for (const result of this.results) result.textContent = "Not run";
    this.status.textContent = `${example.label} selected. Run both examples to compare their output.`;
    this.buttons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
    this.run.disabled = false;
  }

  async execute() {
    const current = this.revision;
    const example = evolutionExamples[this.selected];
    this.run.disabled = true;
    try {
      const { before, after, same } = await runExample(example);
      if (current !== this.revision) return;
      this.results[0].textContent = before;
      this.results[1].textContent = after;
      if (!same) throw new Error("The fixed examples produced different outputs");
      this.status.textContent = "Matching output from both examples in your current browser. No timing or compatibility comparison is implied.";
    } catch (error) {
      console.error("JavaScript evolution lab:", error);
      if (current === this.revision) this.status.textContent = `Example failed: ${error.message}.`;
    } finally {
      if (current === this.revision) this.run.disabled = false;
    }
  }
}

defineLab("ob-evolution-lab", ObEvolutionLab);
