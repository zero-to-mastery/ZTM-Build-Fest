// The shared editable-code surface used by runnable Rust, configured-runner, and
// web-sandbox lessons: a labelled shell, a transparent textarea, and a
// highlighted copy of its text painted underneath with the same tokenizer and
// line numbers as static code blocks. Every element carries a shared
// `ob-code-editor-*` class for styling plus the owning component's own class
// (for example `ob-rust-editor`), so existing theme selectors keep matching.

import { enhanceCode } from "./ob-code.js";

function element(tag, classes, text) {
  const node = document.createElement(tag);
  node.className = classes;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Build an editor. `prefix` names the component-specific classes
 * (`${prefix}-editor-shell`, `${prefix}-editor`, ...); `language` is a fence
 * language such as `rust`, `html`, `css`, or `js`; `source` supplies the
 * fence's line-number data attributes; `colour` and `numbers` follow the
 * surrounding `<ob-code>` settings.
 */
export function createCodeEditor({ prefix, language, label, ariaLabel, value = "", source, colour = true, numbers = false }) {
  const cls = (part) => `ob-code-${part} ${prefix}-${part}`;
  const shell = element("div", cls("editor-shell"));
  const bar = element("div", cls("editor-bar"));
  const live = element("span", cls("editor-live"), "EDITABLE");
  const cursor = element("span", `ob-code-cursor ${prefix}-cursor`, "_");
  cursor.setAttribute("aria-hidden", "true");
  live.append(cursor);
  bar.append(element("span", cls("editor-label"), label), live);

  const stack = element("div", cls("editor-stack"));
  const decoration = element("pre", cls("editor-decoration"));
  decoration.setAttribute("aria-hidden", "true");
  const painted = element("code", `language-${language}`);
  for (const name of ["lineNumbers", "lineStart", "highlightLines"]) {
    if (source?.dataset[name] !== undefined) painted.dataset[name] = source.dataset[name];
  }
  decoration.append(painted);

  const editor = element("textarea", cls("editor"));
  editor.value = value;
  editor.rows = Math.min(24, Math.max(6, value.replace(/\n$/, "").split("\n").length));
  editor.spellcheck = false;
  editor.setAttribute("aria-label", ariaLabel);
  editor.setAttribute("autocapitalize", "off");
  editor.setAttribute("autocomplete", "off");
  editor.setAttribute("wrap", "off");
  stack.append(decoration, editor);
  shell.append(bar, stack);

  const refresh = () => {
    const lineCount = editor.value.replace(/\n$/, "").split("\n").length;
    const asked = painted.dataset.lineNumbers;
    const numbered = asked === "true" || (asked !== "false" && numbers && lineCount >= 2);
    if (numbered) {
      const start = Math.max(1, Number(painted.dataset.lineStart) || 1);
      shell.dataset.lineNumbers = "true";
      shell.style.setProperty("--ob-code-line-digits", String(String(start + lineCount - 1).length));
    } else {
      delete shell.dataset.lineNumbers;
    }
    painted.className = `language-${language}`;
    painted.textContent = editor.value;
    delete painted.dataset.enhanced;
    delete painted.dataset.highlighted;
    delete painted.dataset.language;
    enhanceCode(painted, { colour, numbers });
  };
  refresh();
  editor.addEventListener("input", refresh);
  editor.addEventListener("scroll", () => {
    decoration.scrollTop = editor.scrollTop;
    decoration.scrollLeft = editor.scrollLeft;
  });
  return { shell, editor, refresh };
}

/** The `<ob-code>` highlight and line-number settings around `host`. */
export function codeSettings(host) {
  const codeHost = host.closest?.("ob-code");
  return {
    colour: codeHost?.hasAttribute("highlight") ?? true,
    numbers: codeHost?.hasAttribute("line-numbers") ?? false,
  };
}
