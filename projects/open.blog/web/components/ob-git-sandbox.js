// <ob-git-sandbox> is a miniature, in-memory Git for lessons. Children of the element are the
// fallback shown without JavaScript (for example a static diagram or a worked example);
// they are hidden once the sandbox starts. Nothing is stored or sent anywhere.
import { initialState, run, layout, headCommit } from "./ob-git-model.js";
import { ObLab, defineLab, el as html, svgEl as svg } from "./ob-lab.js";

const CELL_X = 74;
const CELL_Y = 78;
const PAD = 44;

class ObGitSandbox extends ObLab {
  setup() {
    this.state = initialState();
    this.undo = [];

    this.graph = html("div", { class: "ob-git-graph" });
    this.refs = html("ul", { class: "ob-git-refs", "aria-label": "Branches" });
    this.actions = html("div", { class: "ob-git-actions", role: "group", "aria-label": "Quick actions" });
    this.resolveActions = html("span", { class: "ob-git-resolve-actions" });
    const button = (text, onClick) => {
      const node = html("button", { type: "button" }, text);
      node.addEventListener("click", onClick);
      return node;
    };
    this.undoButton = button("Undo", () => {
      this.state = this.undo.pop() ?? this.state;
      this.log.textContent = "Undone.";
      this.render();
    });
    this.actions.append(
      button("Commit", () => this.execute("git commit")),
      button("New branch…", () => this.prefill("git switch -c ")),
      this.undoButton,
      button("Reset", () => this.execute("reset")),
      this.resolveActions,
    );
    this.log = html("pre", { class: "ob-git-log", role: "log", "aria-live": "polite", tabindex: "0", "aria-label": "Command output" });
    this.input = html("input", {
      id: `ob-git-input-${Math.random().toString(36).slice(2, 8)}`, class: "ob-git-input", type: "text",
      autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: 'git commit -m "message"',
    });
    const label = html("label", { for: this.input.id }, "Command");
    const form = html("form", { class: "ob-git-form" });
    form.append(label, this.input, html("button", { type: "submit" }, "Run"));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.execute(this.input.value);
      this.input.value = "";
    });

    this.append(
      html("p", { class: "ob-git-note" }, "A sandbox, not a real repository: nothing here touches your files. Each commit edits one file (README.md unless you pass -f name). Type help for commands."),
      this.graph, this.refs, this.actions, form, this.log);
    this.log.textContent = "Ready. Try: git commit, then git switch -c feature, then git commit.";
    this.render();
  }

  execute(line) {
    if (!line.trim()) return;
    const before = this.state;
    const result = run(before, line);
    if (result.state !== before && !line.trim().startsWith("reset")) this.undo.push(before);
    if (line.trim().startsWith("reset")) this.undo = [];
    this.state = result.state;
    this.log.textContent = `$ ${line.trim()}\n${result.output}`;
    this.log.dataset.error = String(result.error);
    this.render();
  }

  render() {
    this.renderGraph();
    this.renderControls();
  }

  renderGraph() {
    const { state } = this;
    const { nodes, columns, rows } = layout(state);
    const at = Object.fromEntries(nodes.map((n) => [n.id, { x: PAD + n.x * CELL_X, y: PAD + n.y * CELL_Y }]));
    const width = PAD * 2 + (columns - 1) * CELL_X;
    const height = PAD * 2 + (rows - 1) * CELL_Y + 18;
    const canvas = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "ob-git-svg", role: "img", style: `min-width:${Math.min(width, 520)}px` });
    canvas.append(svg("title", {}, "Commit graph"));
    for (const commit of Object.values(state.commits)) {
      for (const parent of commit.parents) {
        const from = at[parent];
        const to = at[commit.id];
        const mid = (from.x + to.x) / 2;
        canvas.append(svg("path", { class: "ob-git-edge", d: `M${from.x} ${from.y}C${mid} ${from.y} ${mid} ${to.y} ${to.x} ${to.y}` }));
      }
    }
    const tips = {};
    for (const [name, id] of Object.entries(state.branches)) (tips[id] ??= []).push(name);
    const current = headCommit(state);
    for (const node of nodes) {
      const { x, y } = at[node.id];
      const group = svg("g", { class: `ob-git-node${node.id === current ? " is-head" : ""}${state.commits[node.id].parents.length > 1 ? " is-merge" : ""}` });
      group.append(svg("circle", { cx: x, cy: y, r: 11 }), svg("text", { x, y: y + 28, class: "ob-git-id" }, node.id.slice(0, 4)));
      (tips[node.id] ?? []).forEach((name, i) => {
        group.append(svg("text", { x, y: y - 20 - i * 14, class: `ob-git-branch${name === state.head ? " is-current" : ""}` }, name));
      });
      canvas.append(group);
    }
    this.graph.replaceChildren(canvas);
    const summary = `${Object.keys(state.commits).length} commits. ${
      Object.entries(state.branches).map(([name, id]) => `${name} at ${id}`).join("; ")
    }. HEAD is ${state.head in state.branches ? `on ${state.head}` : `detached at ${state.head}`}.${state.merging ? " A merge is in progress." : ""}`;
    canvas.setAttribute("aria-label", summary);
  }

  renderControls() {
    const { state } = this;
    this.refs.replaceChildren(...Object.entries(state.branches).map(([name, id]) => {
      const item = html("li", {});
      item.append(html("span", { class: "ob-git-ref" }, `${name === state.head ? "HEAD → " : ""}${name} @ ${id}`));
      if (name !== state.head) {
        const go = html("button", { type: "button" }, `Switch to ${name}`);
        go.addEventListener("click", () => this.execute(`git switch ${name}`));
        const join = html("button", { type: "button" }, `Merge ${name} here`);
        join.addEventListener("click", () => this.execute(`git merge ${name}`));
        item.append(go, join);
      }
      return item;
    }));

    this.undoButton.disabled = !this.undo.length;
    this.resolveActions.replaceChildren();
    if (state.merging?.conflicts.length) {
      const [file] = state.merging.conflicts;
      for (const side of ["ours", "theirs"]) {
        const pick = html("button", { type: "button", class: "ob-git-resolve" }, `Keep ${side} for ${file}`);
        pick.addEventListener("click", () => this.execute(`resolve --${side} ${file}`));
        this.resolveActions.append(pick);
      }
    }
  }

  prefill(text) {
    this.input.value = text;
    this.input.focus();
  }
}

defineLab("ob-git-sandbox", ObGitSandbox);
