import { cardContent } from "./card.js";
export function twoColumn(items) {
  const rows = [];
  for (let i = 0; i < items.length; i += 2)
    rows.push(
      `<tr>\n<td valign="top"${i + 1 === items.length ? ' colspan="2"' : ""}>${cardContent(items[i])}</td>${items[i + 1] ? `\n<td valign="top">${cardContent(items[i + 1])}</td>` : ""}\n</tr>`,
    );
  return items.length ? `<table>\n${rows.join("\n")}\n</table>` : "";
}
