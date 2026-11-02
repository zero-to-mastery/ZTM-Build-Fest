import { mdText, escapeHtml as h } from "./presentation.js";
export const calloutStyles = [
  "quote",
  "note",
  "tip",
  "warning",
  "terminal",
  "plain",
];
export function codeSample(s) {
  const code = String(s.code || ""),
    language = String(s.language || "");
  if (!/^[a-z\d+#.-]{0,30}$/i.test(language))
    throw Error("Use a simple code language name such as js, rust, or c++.");
  const fence = "`".repeat(
    Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)),
  );
  const content = `${s.marker ? `${s.marker}\n` : ""}${fence}${language}\n${code}\n${fence}`;
  return s.collapsed === true
    ? details({
        summary: s.title || "Code example",
        body: content,
        open: s.open,
      })
    : [s.title && `### ${mdText(s.title)}`, content]
        .filter(Boolean)
        .join("\n\n");
}
export function details(s) {
  return `<details${s.open === true ? " open" : ""}>\n<summary>${h(s.summary || "Details")}</summary>\n\n${String(s.body || "")}\n\n</details>`;
}
export function callout(s) {
  const style = calloutStyles.includes(s.style) ? s.style : "note",
    body = String(s.body || "")
      .split(/\r?\n/)
      .map(mdText)
      .join("\n"),
    title = s.title ? `**${mdText(s.title)}**\n\n` : "";
  if (style === "terminal")
    return codeSample({
      language: "text",
      code: String(s.body || ""),
      title: s.title,
    });
  if (style === "plain") return title + body;
  return (
    (["note", "tip", "warning"].includes(style)
      ? `> [!${style.toUpperCase()}]\n`
      : "") +
    (title + body)
      .split("\n")
      .map((l) => "> " + l)
      .join("\n")
  );
}
export function columns(s) {
  return `<table>\n<tr>\n${[
    ["leftTitle", "leftBody"],
    ["rightTitle", "rightBody"],
  ]
    .map(
      ([t, b]) =>
        `<td valign="top">${s[t] ? `<h3>${h(s[t])}</h3>` : ""}<p>${h(s[b] || "").replace(/\r?\n/g, "<br>")}</p></td>`,
    )
    .join("\n")}\n</tr>\n</table>`;
}
