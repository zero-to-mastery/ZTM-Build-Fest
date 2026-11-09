export const glyphs = ["✦", "◆", "◇", "•", "→", "›", "⌘", "_", "$"];
export const mdText = (s) =>
  String(s || "")
    .replace(/[\\`*_[\]<>#|]/g, "\\$&")
    .replace(/[\r\n]/g, " ");
export const escapeHtml = (s) =>
  String(s || "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function heading(title, p = {}, level = 2) {
  level = Math.max(1, Math.min(6, Number(level) || 2));
  if (p.heading === "centered")
    return `<h${level} align="center">${escapeHtml(title)}</h${level}>`;
  const prefix =
    p.heading === "emoji-accent"
      ? mdText(p.decoration || "✦") + " "
      : p.heading === "minimal-prefix"
        ? "› "
        : p.heading === "terminal-prompt"
          ? "$ "
          : "";
  return (
    `${"#".repeat(level)} ${prefix}${mdText(title)}` +
    (p.heading === "divider-heading" ? "\n\n---" : "")
  );
}
export function divider(style = "rule", glyph = "✦") {
  return style === "none"
    ? ""
    : style === "glyph"
      ? `<p align="center">${escapeHtml(glyph)} ${escapeHtml(glyph)} ${escapeHtml(glyph)}</p>`
      : style === "ascii"
        ? "```text\n------------------------\n```"
        : style === "dots"
          ? '<p align="center">···</p>'
          : "---";
}
export function present(markdown, b) {
  if (b.type === "custom" || !b.settings.presentation) return markdown;
  const p = b.settings.presentation,
    match = markdown.match(/^(#{1,6}) (.*)(?:\n|$)/);
  if (match) {
    const original = match[2].replace(/\\([\\`*_[\]<>#|])/g, "$1");
    markdown =
      heading(original, p, match[1].length) +
      markdown.slice(match[0].length - (match[0].endsWith("\n") ? 1 : 0));
  }
  return (
    markdown +
    (b.type !== "divider" && p.divider && p.divider !== "none"
      ? "\n\n" + divider(p.divider, p.decoration)
      : "")
  );
}
