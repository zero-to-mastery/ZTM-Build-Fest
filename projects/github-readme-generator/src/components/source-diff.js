import { html } from "../markdown/serialize.js";
import { publishDiff } from "../publishing/diff.js";
// Source is assigned as text/value, never parsed as HTML. All review flows can
// retain their own approval and snapshot logic around this shared surface.
export function sourceDiffMarkup({
  beforeLabel = "Current Markdown",
  afterLabel = "Generated Markdown",
  label = "Source diff",
} = {}) {
  return `<div class="source-diff"><div class="publish-sources"><label>${html(beforeLabel)}<textarea data-before rows="8" readonly></textarea></label><label>${html(afterLabel)}<textarea data-after rows="8" readonly></textarea></label></div><details open><summary>Unified source diff</summary><p class="hint">Minus lines are removed; plus lines are added. Full source panes are authoritative.</p><pre data-diff tabindex="0" aria-label="${html(label)}"></pre></details></div>`;
}
export function fillSourceDiff(root, before, after, diff) {
  root.querySelector("[data-before]").value = before;
  root.querySelector("[data-after]").value = after;
  root.querySelector("[data-diff]").textContent =
    diff ?? publishDiff(before, after).text;
}
