// Progressive enhancement for an author-opted-in `rust runnable` fence. The
// original <pre><code> remains the no-JavaScript fallback; this component adds
// an editor and sends only the reader's source to the official Rust Playground.
//
// A fence written `rust runnable check` also carries the author's hidden tests in a
// <script data-ob-rust-checks> element. They never appear in the editor; "Check my code" appends
// them to what the reader wrote and shows the author's own feedback for each one that fails.

import { playgroundUrl, runRust, runRustChecks } from "./ob-rust-runner.js";
import { summarise } from "./ob-rust-check-model.js";
import { codeSettings, createCodeEditor } from "./ob-code-editor.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function combinedOutput({ stdout, stderr }) {
  if (!stdout) return stderr;
  if (!stderr) return stdout;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

// The hidden checks the build wrote beside the code, or null when this fence has none.
function authoredChecks(host) {
  const script = host.querySelector?.("script[data-ob-rust-checks]");
  if (!script) return null;
  try {
    const parsed = JSON.parse(script.textContent);
    return typeof parsed === "string" && parsed.trim() ? parsed : null;
  } catch {
    return null;
  }
}

class ObRustPlayground extends HTMLElement {
  connectedCallback() {
    if (this.dataset.enhanced) return;
    const pre = this.querySelector("pre");
    const code = pre?.querySelector("code");
    if (!code) return;
    pre.classList.add("ob-rust-source");
    const checks = authoredChecks(this);

    const initial = code.textContent;
    const { shell, editor, refresh } = createCodeEditor({
      prefix: "ob-rust",
      language: "rust",
      label: "Rust playground",
      ariaLabel: "Editable Rust code",
      value: initial,
      source: code,
      ...codeSettings(this),
    });

    const controls = element("div", "ob-code-editor-controls ob-rust-controls");
    const run = element("button", "ob-code-editor-run ob-rust-run", "Run Rust");
    const check = checks ? element("button", "ob-code-editor-run ob-rust-check", "Check my code") : null;
    const reset = element("button", "ob-rust-reset", "Reset");
    const copy = element("button", "ob-rust-copy", "Copy");
    for (const button of [run, check, reset, copy]) if (button) button.type = "button";
    const external =
      this.dataset.playgroundLink === "false"
        ? null
        : element("a", "ob-rust-external", "Open in Rust Playground");
    if (external) {
      external.target = "_blank";
      external.rel = "noopener noreferrer";
    }
    controls.append(run, ...(check ? [check] : []), reset, copy, ...(external ? [external] : []));

    const notice = element(
      "p",
      "ob-code-editor-note ob-rust-notice",
      "Code runs on the official Rust Playground. open.blog does not store it.",
    );
    const status = element("p", "ob-code-editor-status ob-rust-status", "Ready.");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const output = element("pre", "ob-rust-output");
    output.hidden = true;
    output.tabIndex = 0;
    output.setAttribute("aria-label", "Rust compiler and program output");

    const outputPanel = element("section", "ob-rust-output-panel");
    const outputLabel = element("div", "ob-rust-output-label", "Console output");
    outputPanel.hidden = true;
    outputPanel.append(outputLabel, output);

    const checkPanel = element("section", "ob-rust-check-panel");
    const checkSummary = element("p", "ob-rust-check-summary");
    const checkList = element("ul", "ob-rust-check-list");
    checkPanel.hidden = true;
    checkPanel.append(checkSummary, checkList);

    function hideResults() {
      output.textContent = "";
      output.hidden = true;
      outputPanel.hidden = true;
      checkPanel.hidden = true;
    }

    function updateExternal() {
      if (external) external.href = playgroundUrl(editor.value);
    }
    editor.addEventListener("input", updateExternal);
    updateExternal();

    reset.addEventListener("click", () => {
      editor.value = initial;
      hideResults();
      status.textContent = "Reset to the article's example.";
      refresh();
      updateExternal();
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

    // One request at a time, whether it is a run or a check.
    const withPlayground = async (button, working, task, timeoutMessage) => {
      if (this.runController) return;
      const controller = new AbortController();
      this.runController = controller;
      this.runTimer = setTimeout(() => controller.abort(), 20_000);
      button.setAttribute("aria-disabled", "true");
      button.setAttribute("aria-busy", "true");
      hideResults();
      status.textContent = working;
      try {
        await task(controller.signal);
      } catch (error) {
        output.textContent =
          error?.name === "AbortError"
            ? timeoutMessage
            : `${error?.message || "The Rust Playground request failed."}${external ? " You can still use the Open in Rust Playground link." : ""}`;
        output.hidden = false;
        outputPanel.hidden = false;
        status.textContent = "Could not run this example here.";
      } finally {
        clearTimeout(this.runTimer);
        this.runController = null;
        this.runTimer = null;
        button.removeAttribute("aria-disabled");
        button.removeAttribute("aria-busy");
      }
    };

    run.addEventListener("click", () =>
      withPlayground(
        run,
        "Compiling and running on the Rust Playground…",
        async (signal) => {
          const result = await runRust(editor.value, { signal });
          output.textContent = combinedOutput(result) || "Program finished without output.";
          output.hidden = false;
          outputPanel.hidden = false;
          status.textContent = result.success ? "Finished." : "Compilation failed.";
        },
        "The Rust Playground did not respond within 20 seconds.",
      ),
    );

    check?.addEventListener("click", () =>
      withPlayground(
        check,
        "Checking your code on the Rust Playground…",
        async (signal) => {
          const outcome = await runRustChecks(editor.value, checks, { signal });
          checkPanel.dataset.state = outcome.state;
          checkSummary.textContent = summarise(outcome);
          checkList.replaceChildren(
            ...(outcome.state === "failed"
              ? outcome.failures.map((failure) => element("li", "ob-rust-check-item", failure.feedback))
              : []),
          );
          checkPanel.hidden = false;
          // Compiler text helps when the code does not build; test output would only spoil the checks.
          if (outcome.state === "compile-error" || outcome.state === "unknown") {
            output.textContent = outcome.output || "The Rust Playground returned no output.";
            output.hidden = false;
            outputPanel.hidden = false;
          }
          status.textContent = summarise(outcome);
        },
        "The Rust Playground did not respond within 20 seconds.",
      ),
    );

    this.append(shell, controls, notice, status, checkPanel, outputPanel);
    this.dataset.enhanced = "true";
  }

  disconnectedCallback() {
    clearTimeout(this.copyTimer);
    clearTimeout(this.runTimer);
    this.runController?.abort();
  }
}

if (!customElements.get("ob-rust-playground")) {
  customElements.define("ob-rust-playground", ObRustPlayground);
}
