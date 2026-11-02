// <ob-code highlight> wraps rendered Markdown. It adds a "Copy" button to every
// code block and, when the `highlight` attribute is present, colours the code
// with a small built-in tokenizer: no external library, no network request.
//
// Colours come from theme tokens (--ob-color-code-keyword and friends), so a
// theme restyles the palette without touching this file. A theme that ships
// its own highlighter sets "codeHighlighting": false in theme.json, which
// drops the attribute, and loads its script through "scripts".
//
// With the `line-numbers` attribute, blocks of two or more lines are numbered.
// The numbers are drawn by CSS (a counter on each .ob-line), so they are never
// part of the text: copying, by button or by selection, gives only the code.
// Plain-text fences (`text`, `output`), terminal fences (`bash`, `sh`, `console`,
// `powershell`, ...) and unrecognised untagged blocks, which are usually program
// output, shell commands or prose, are not numbered unless the fence asks.
//
// A fence can override this and more (the Markdown renderer turns its options
// into data attributes): ```js title="app.js" {2,4-6} showLineNumbers=10
// numbers from 10 and highlights lines 2 and 4 to 6. `no-copy` on the element
// (from "copyButton": false in openblog.json) leaves out the Copy buttons.
//
// The tokenizer lives in ob-highlight.js. Blocks without a language are
// guessed from their content. Tokens are emitted as <span class="tok-…">
// elements built with DOM calls, never innerHTML, so code can never inject markup.

import { detectLanguage, highlight, isKnownLanguage, isPlainText, isTerminal, parseLineRanges, splitLines } from "./ob-highlight.js";

/** Append one token to `parent`: a classed span, or plain text. */
function append(parent, token) {
  if (token.cls) {
    const span = document.createElement("span");
    span.className = `tok-${token.cls}`;
    span.textContent = token.text;
    parent.append(span);
  } else {
    parent.append(token.text);
  }
}

export function enhanceCode(codeEl, { colour, numbers }) {
  if (codeEl.dataset.enhanced) return;
  const text = codeEl.textContent;
  const match = /(?:^|\s)language-([\w+#-]+)/.exec(codeEl.className || "");
  // A fence without a language (common in imported posts) is guessed from its
  // content; an unknown or plain-text language stays as written.
  const language = match ? match[1].toLowerCase() : detectLanguage(text);
  if (language && !match && colour) codeEl.dataset.language = language;

  let tokens = null;
  if (colour && language && isKnownLanguage(language)) {
    const painted = highlight(text, language);
    if (painted.some((t) => t.cls)) tokens = painted;
  }
  // A fence's own options win: ```js showLineNumbers=10 {2-3}
  const asked = codeEl.dataset.lineNumbers; // "true" | "false" | undefined
  const lineCount = text.replace(/\n$/, "").split("\n").length;
  const numbered =
    asked === "true" || (asked !== "false" && numbers && lineCount >= 2 && Boolean(language) && !isPlainText(language) && !isTerminal(language));
  const marked = parseLineRanges(codeEl.dataset.highlightLines);
  if (!tokens && !numbered && !marked.size) return;

  const frag = document.createDocumentFragment();
  const all = tokens || [{ text, cls: null }];
  if (numbered || marked.size) {
    const lines = splitLines(all);
    lines.forEach((line, i) => {
      const row = document.createElement("span");
      row.className = marked.has(i + 1) ? "ob-line ob-line-hl" : "ob-line";
      for (const t of line) append(row, t);
      frag.append(row);
      if (i < lines.length - 1) frag.append("\n");
    });
    if (text.endsWith("\n")) frag.append("\n"); // keep the text exactly as written
    // Lines can be wider than the block; sizing the code to its widest line
    // lets a highlight band reach across when the block scrolls sideways.
    if (marked.size) codeEl.classList.add("ob-has-hl");
    if (numbered) {
      const start = Math.max(1, Number(codeEl.dataset.lineStart) || 1);
      codeEl.classList.add("ob-numbered");
      codeEl.style.setProperty("counter-reset", `ob-line ${start - 1}`);
      codeEl.style.setProperty("--ob-line-digits", String(String(start + lines.length - 1).length));
    }
  } else {
    for (const t of all) append(frag, t);
  }
  codeEl.replaceChildren(frag);
  codeEl.dataset.enhanced = "true";
  if (tokens) codeEl.dataset.highlighted = "true";
}

class ObCode extends HTMLElement {
  connectedCallback() {
    const options = { colour: this.hasAttribute("highlight"), numbers: this.hasAttribute("line-numbers") };
    const copy = !this.hasAttribute("no-copy");
    for (const pre of this.querySelectorAll("pre")) {
      const code = pre.querySelector("code");
      if (code) {
        try {
          enhanceCode(code, options);
        } catch {
          // A tokenizer bug must never blank out the code; the plain text stays.
        }
      }
      if (copy && navigator.clipboard && !pre.querySelector(".ob-copy")) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ob-copy";
        button.textContent = "Copy";
        button.setAttribute("aria-label", "Copy code to clipboard");
        button.addEventListener("click", async () => {
          try {
            // Without a <code>, read the <pre> but not this button's own label.
            const text = code
              ? code.textContent
              : [...pre.childNodes].filter((n) => n !== button).map((n) => n.textContent).join("");
            await navigator.clipboard.writeText(text);
            button.textContent = "Copied";
          } catch {
            button.textContent = "Failed";
          }
          setTimeout(() => (button.textContent = "Copy"), 1600);
        });
        pre.append(button);
      }
    }
  }
}

if (!customElements.get("ob-code")) {
  customElements.define("ob-code", ObCode);
}
