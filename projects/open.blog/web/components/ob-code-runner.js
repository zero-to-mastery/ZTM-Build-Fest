// Progressive enhancement for author-opted-in code fences backed by an
// independently hosted runner. The original source remains as the no-JS
// fallback, and all returned output is rendered as plain text.

import { runCode } from "./ob-code-runner-client.js";
import { codeSettings, createCodeEditor } from "./ob-code-editor.js";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const label = (language) => language.charAt(0).toUpperCase() + language.slice(1);

function combinedOutput({ stdout, stderr }) {
  if (!stdout) return stderr;
  if (!stderr) return stdout;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

class ObCodeRunner extends HTMLElement {
  connectedCallback() {
    if (this.dataset.enhanced) return;
    const pre = this.querySelector("pre");
    const code = pre?.querySelector("code");
    const language = String(this.dataset.language || "").toLowerCase();
    const endpoint = this.dataset.endpoint;
    if (!code || !language || !endpoint) return;
    const languageLabel = label(language);
    const initial = code.textContent;
    pre.classList.add("ob-code-runner-source");

    const { shell, editor, refresh } = createCodeEditor({
      prefix: "ob-code-runner",
      language,
      label: languageLabel,
      ariaLabel: `Editable ${languageLabel} code`,
      value: initial,
      source: code,
      ...codeSettings(this),
    });

    const stdin = el("textarea", "ob-code-runner-stdin");
    stdin.rows = 3;
    stdin.spellcheck = false;
    stdin.setAttribute("aria-label", "Standard input (optional)");
    stdin.setAttribute("placeholder", "Standard input (optional)");

    const controls = el("div", "ob-code-editor-controls ob-code-runner-controls");
    const run = el("button", "ob-code-editor-run ob-code-runner-run", `Run ${languageLabel}`);
    const reset = el("button", "ob-code-runner-reset", "Reset");
    const copy = el("button", "ob-code-runner-copy", "Copy");
    for (const button of [run, reset, copy]) button.type = "button";
    controls.append(run, reset, copy);

    const notice = el(
      "p",
      "ob-code-editor-note ob-code-runner-notice",
      "Running sends this source and standard input to the site's external sandbox service. open.blog does not execute or store it.",
    );
    const status = el("p", "ob-code-editor-status ob-code-runner-status", "Ready.");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const output = el("pre", "ob-code-runner-output");
    output.hidden = true;
    output.tabIndex = 0;
    output.setAttribute("aria-label", `${languageLabel} program output`);

    reset.addEventListener("click", () => {
      editor.value = initial;
      stdin.value = "";
      output.textContent = "";
      output.hidden = true;
      status.textContent = "Reset to the post's example.";
      refresh();
      editor.focus();
    });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(editor.value);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Copy failed";
      }
      clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => (copy.textContent = "Copy"), 1600);
    });
    run.addEventListener("click", async () => {
      if (this.runController) return;
      const controller = new AbortController();
      this.runController = controller;
      this.runTimer = setTimeout(() => controller.abort(), 20_000);
      run.setAttribute("aria-disabled", "true");
      run.setAttribute("aria-busy", "true");
      output.hidden = true;
      status.textContent = `Sending ${languageLabel} to the external sandbox…`;
      try {
        const result = await runCode({ endpoint, language, source: editor.value, stdin: stdin.value }, { signal: controller.signal });
        output.textContent = combinedOutput(result) || "Program finished without output.";
        output.hidden = false;
        status.textContent = result.success ? "Finished." : `Run failed${result.exitCode === null ? "." : ` with exit code ${result.exitCode}.`}`;
      } catch (error) {
        output.textContent = error?.name === "AbortError"
          ? "The code runner did not respond within 20 seconds."
          : error?.message || "The code runner request failed.";
        output.hidden = false;
        status.textContent = "Could not run this example.";
      } finally {
        clearTimeout(this.runTimer);
        this.runController = null;
        this.runTimer = null;
        run.removeAttribute("aria-disabled");
        run.removeAttribute("aria-busy");
      }
    });

    this.append(shell, stdin, controls, notice, status, output);
    this.dataset.enhanced = "true";
  }

  disconnectedCallback() {
    clearTimeout(this.copyTimer);
    clearTimeout(this.runTimer);
    this.runController?.abort();
  }
}

if (!customElements.get("ob-code-runner")) customElements.define("ob-code-runner", ObCodeRunner);
