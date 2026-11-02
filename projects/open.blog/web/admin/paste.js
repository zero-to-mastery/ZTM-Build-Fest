// Clean pasted content into safe Markdown (ADR 0260).
//
// A pure converter: clipboard HTML in, the Markdown the Visual surfaces can hold out. It never
// touches the DOM and never builds markup. The HTML is read by a small tolerant tokenizer, only
// an allowlist of meaning survives (paragraphs, headings, bold, italic, links, lists, quotes,
// code, pictures that have a description), and everything else is dropped: styles, classes,
// scripts, event handlers, ids, tables (their text stays), tracking pixels, hidden content.
// Words that could read as a tag are written as `&lt;` so the Markdown never holds markup.

export const PASTE_LIMITS = Object.freeze({
  html: 1_000_000,
  depth: 100,
  blocks: 400,
  markdown: 200_000,
});

// Elements dropped together with everything inside them.
const DROPPED = new Set([
  "script", "style", "head", "title", "template", "iframe", "frame", "frameset", "object", "embed", "noscript",
  "svg", "math", "xml", "applet", "audio", "video", "canvas", "select", "textarea", "button", "meta", "link",
  "base", "map", "dialog", "nav",
]);
const VOID = new Set(["br", "img", "hr", "meta", "link", "input", "wbr", "col", "area", "base", "source", "track", "embed"]);
const BLOCKS = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "aside", "nav", "figure", "figcaption", "address",
  "details", "summary", "fieldset", "form", "center", "tr", "caption", "thead", "tbody", "tfoot", "table", "dl", "dt", "dd",
]);

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", bull: "\u2022", middot: "\u00b7", copy: "\u00a9",
  reg: "\u00ae", trade: "\u2122", laquo: "\u00ab", raquo: "\u00bb", euro: "\u20ac", pound: "\u00a3", yen: "\u00a5",
  cent: "\u00a2", deg: "\u00b0", times: "\u00d7", divide: "\u00f7", para: "\u00b6", sect: "\u00a7", shy: "",
  ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "",
};

function decode(text) {
  return String(text).replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,8});/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      if (code === 0xa0) return " ";
      return code < 32 && code !== 9 && code !== 10 ? "" : String.fromCodePoint(code);
    }
    const known = ENTITIES[body.toLowerCase()];
    return known === undefined ? whole : known;
  });
}

/** A tolerant tree of the clipboard HTML: elements with a lower-case tag, attributes and children. */
function parse(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const closeUntil = (names, stopAt) => {
    for (let i = stack.length - 1; i > 0; i -= 1) {
      if (stopAt.has(stack[i].tag)) return;
      if (names.has(stack[i].tag)) {
        stack.length = i;
        return;
      }
    }
  };
  const SCOPES = new Set(["ul", "ol", "table", "blockquote", "div", "td", "th"]);
  let pos = 0;
  const length = html.length;
  while (pos < length) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) {
      top().children.push(html.slice(pos));
      break;
    }
    if (lt > pos) top().children.push(html.slice(pos, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      pos = end === -1 ? length : end + 3;
      continue;
    }
    const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(html.slice(lt, lt + 4000));
    if (!match) {
      // A bare `<`, a doctype, a processing instruction or an over-long tag: skip to its end or keep it as text.
      if (/^<[!?]/.test(html.slice(lt, lt + 2))) {
        const end = html.indexOf(">", lt);
        pos = end === -1 ? length : end + 1;
      } else {
        top().children.push("<");
        pos = lt + 1;
      }
      continue;
    }
    pos = lt + match[0].length;
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase().replace(/^[a-z]+:/, "");
    if (closing) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs = {};
    for (const a of match[3].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const name = a[1].toLowerCase();
      if (name in attrs) continue;
      attrs[name] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    }
    if (DROPPED.has(tag)) {
      // Everything up to the matching close is skipped (script and style hold raw text).
      if (!VOID.has(tag) && !/\/\s*$/.test(match[3])) {
        const close = new RegExp(`</${tag}\\s*>`, "i");
        const rest = html.slice(pos);
        const found = close.exec(rest);
        pos = found ? pos + found.index + found[0].length : length;
      }
      continue;
    }
    // Implied closes: a new paragraph or list item ends the one before it.
    if (tag === "li") closeUntil(new Set(["li"]), SCOPES);
    else if (tag === "p" || /^h[1-6]$/.test(tag) || tag === "ul" || tag === "ol" || tag === "blockquote" || tag === "pre") closeUntil(new Set(["p"]), SCOPES);
    else if (tag === "td" || tag === "th") closeUntil(new Set(["td", "th"]), new Set(["tr", "table"]));
    else if (tag === "tr") closeUntil(new Set(["tr", "td", "th"]), new Set(["table"]));
    if (stack.length >= PASTE_LIMITS.depth) {
      // Too deep to read; its text still counts, its structure does not.
      continue;
    }
    const node = { tag, attrs, children: [] };
    top().children.push(node);
    if (!VOID.has(tag) && !/\/\s*$/.test(match[3])) stack.push(node);
  }
  return root;
}

function styleOf(node) {
  const out = {};
  for (const part of String(node.attrs.style || "").split(";")) {
    const at = part.indexOf(":");
    if (at > 0) out[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim().toLowerCase();
  }
  return out;
}

function hidden(node) {
  if ("hidden" in node.attrs || node.attrs["aria-hidden"] === "true") return true;
  const style = styleOf(node);
  return style.display === "none" || style.visibility === "hidden" || style["mso-hide"] === "all";
}

/** Whether an address is one the editor keeps: https, http, mailto, or a path on the site. */
export function safePastedUrl(value) {
  const url = String(value || "").trim();
  if (!url || /[\u0000-\u001f\u007f\\]/.test(url)) return "";
  if (!(/^(?:https?:\/\/[^\s/]+|mailto:[^\s]+)/i.test(url) || /^(?:\/(?!\/)|#|\.\.?\/)/.test(url))) return "";
  return url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Words written as Markdown text: markers escaped, and anything that could open a tag written as `&lt;`. */
export function pastedText(value) {
  return String(value)
    .replace(/&(?=#?[a-z0-9]+;)/gi, "&amp;")
    .replace(/<(?=[a-z/!?])/gi, "&lt;")
    .replace(/([\\*_`[\]])/g, "\\$1");
}

function boldOf(node, style) {
  if (node.tag === "strong") return true;
  if (node.tag === "b") return !/^(normal|400|lighter)$/.test(style["font-weight"] || "");
  const weight = style["font-weight"];
  return weight === "bold" || weight === "bolder" || (/^\d+$/.test(weight || "") && Number(weight) >= 600);
}
function italicOf(node, style) {
  return node.tag === "em" || node.tag === "i" || style["font-style"] === "italic";
}

/**
 * Convert clipboard HTML to Markdown.
 * `{ markdown, blocks, droppedImages, keptImages, formatted }`; `markdown` is "" when nothing usable remains.
 * `options.headingLevel` pins every heading to one level (the landing page has one);
 * `options.minHeading` keeps headings below a page title (a post's own title is its h1).
 */
export function pasteToMarkdown(html, options = {}) {
  const result = { markdown: "", blocks: [], droppedImages: 0, keptImages: 0, formatted: false };
  let source = String(html ?? "");
  if (!source.trim() || source.length > PASTE_LIMITS.html) return { ...result, tooLong: source.length > PASTE_LIMITS.html };
  const from = source.indexOf("<!--StartFragment-->");
  const to = source.indexOf("<!--EndFragment-->");
  if (from !== -1 && to > from) source = source.slice(from + 20, to);
  const tree = parse(source);
  const blocks = [];

  // ----- inline content: a string of Markdown for the inline nodes below `node`
  const inline = (node, ctx) => {
    let out = "";
    for (const child of node.children) {
      if (typeof child === "string") {
        const text = decode(child).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g, "");
        out += pastedText(ctx.pre ? text : text.replace(/\s+/g, " "));
        continue;
      }
      if (hidden(child)) continue;
      const tag = child.tag;
      const style = styleOf(child);
      if (tag === "br") {
        out += "\n";
        continue;
      }
      if (tag === "img") {
        out += image(child);
        continue;
      }
      if (tag === "code" || tag === "kbd" || tag === "samp" || tag === "tt") {
        const text = plain(child).trim();
        if (text) {
          const ticks = "`".repeat(Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length)) + 1);
          out += `${ticks}${text.replace(/\s+/g, " ")}${ticks}`;
          result.formatted = true;
        }
        continue;
      }
      if (BLOCKS.has(tag) || /^h[1-6]$/.test(tag) || tag === "li" || tag === "ul" || tag === "ol" || tag === "blockquote" || tag === "pre") {
        // A block inside inline content (a div in a link, say) is read as inline text.
        out += ` ${inline(child, ctx)} `;
        continue;
      }
      const bold = boldOf(child, style);
      const italic = italicOf(child, style);
      let content = inline(child, { ...ctx, bold: ctx.bold || bold, italic: ctx.italic || italic });
      if (!content.trim()) {
        out += content;
        continue;
      }
      if (tag === "a") {
        const url = safePastedUrl(child.attrs.href);
        if (url) {
          content = `[${content.replace(/\n/g, " ").trim()}](${url})`;
          result.formatted = true;
        }
      } else {
        // Emphasis marks hug the words: spaces stay outside the marks.
        const lead = /^\s*/.exec(content)[0];
        const trail = /\s*$/.exec(content)[0];
        let core = content.trim();
        if (bold && !ctx.bold) core = `**${core}**`;
        if (italic && !ctx.italic) core = `_${core}_`;
        if (bold || italic) result.formatted = true;
        content = lead + core + trail;
      }
      out += content;
    }
    return out;
  };
  const plain = (node) => {
    let out = "";
    for (const child of node.children) {
      if (typeof child === "string") out += decode(child);
      else if (!hidden(child)) out += child.tag === "br" ? "\n" : plain(child);
    }
    return out;
  };

  const image = (node) => {
    const src = String(node.attrs.src || "").trim();
    const width = Number(node.attrs.width);
    const height = Number(node.attrs.height);
    const style = styleOf(node);
    const tiny = (Number.isFinite(width) && width > 0 && width <= 2) || (Number.isFinite(height) && height > 0 && height <= 2) || /^(?:0|1)px$/.test(style.width || "") || /^(?:0|1)px$/.test(style.height || "");
    const url = safePastedUrl(src);
    // Pictures that cannot be kept (data, blob and file sources) and tracking pixels are dropped quietly.
    if (tiny || !url || /^(?:data|blob|file|cid):/i.test(src)) return "";
    const alt = decode(node.attrs.alt || "").replace(/[\[\]\n\r]/g, " ").replace(/\s+/g, " ").trim();
    if (!alt) {
      result.droppedImages += 1;
      return "";
    }
    result.keptImages += 1;
    result.formatted = true;
    return `![${pastedText(alt).replace(/\\([[\]])/g, "$1")}](${url})`;
  };

  // ----- block structure
  const isBlock = (tag) => BLOCKS.has(tag) || /^h[1-6]$/.test(tag) || tag === "ul" || tag === "ol" || tag === "li" || tag === "blockquote" || tag === "pre" || tag === "td" || tag === "th";
  const containsBlock = (node) => node.children.some((c) => typeof c !== "string" && (isBlock(c.tag) || containsBlock(c)));
  const tidyLine = (text) =>
    text
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter((line, index, all) => line || (index > 0 && index < all.length - 1 && all[index - 1]))
      .join("\n")
      .trim();
  const guard = (line) => line.replace(/^(#{1,6}|>|[-+*]|\d+[.)])(\s|$)/, "\\$1$2").replace(/^(\s*)(---+|===+|___+)\s*$/, "$1\\$2");

  const walk = (node, ctx) => {
    let run = [];
    const emitRun = () => {
      if (!run.length) return;
      const holder = { children: run };
      run = [];
      const line = tidyLine(inline(holder, ctx));
      if (line) blocks.push(guard(line));
    };
    for (const child of node.children) {
      if (typeof child === "string") {
        run.push(child);
        continue;
      }
      if (hidden(child)) continue;
      const tag = child.tag;
      if (/^h[1-6]$/.test(tag)) {
        emitRun();
        const text = tidyLine(inline(child, { ...ctx, bold: true })).replace(/\n/g, " ");
        const level = options.headingLevel || Math.max(options.minHeading || 1, Number(tag[1]));
        if (text) {
          blocks.push(`${"#".repeat(Math.min(6, Math.max(1, level)))} ${text}`);
          result.formatted = true;
        }
      } else if (tag === "ul" || tag === "ol") {
        emitRun();
        const items = [];
        const collect = (list) => {
          for (const item of list.children) {
            if (typeof item === "string" || hidden(item)) continue;
            if (item.tag === "li") {
              // Nested lists are flattened into this one: the editor holds a single level.
              const own = { children: item.children.filter((c) => typeof c === "string" || (c.tag !== "ul" && c.tag !== "ol")) };
              const text = tidyLine(inline(own, ctx)).replace(/\n+/g, " ");
              if (text) items.push(text);
              for (const nested of item.children) if (typeof nested !== "string" && (nested.tag === "ul" || nested.tag === "ol")) collect(nested);
            } else if (item.tag === "ul" || item.tag === "ol") collect(item);
          }
        };
        collect(child);
        if (items.length) {
          const start = tag === "ol" ? Math.max(1, Math.min(9999, Number.parseInt(child.attrs.start, 10) || 1)) : 1;
          blocks.push(items.map((item, index) => `${tag === "ol" ? `${start + index}.` : "-"} ${item}`).join("\n"));
          result.formatted = true;
        }
      } else if (tag === "blockquote") {
        emitRun();
        const inner = [];
        const saved = blocks.length;
        walk(child, ctx);
        inner.push(...blocks.splice(saved));
        const text = inner.join(" ").replace(/\n+/g, " ").trim();
        if (text) {
          blocks.push(`> ${text.replace(/^>\s*/, "")}`);
          result.formatted = true;
        }
      } else if (tag === "pre") {
        emitRun();
        const text = plain(child).replace(/\r/g, "").replace(/^\n+|\s+$/g, "");
        if (text) {
          const fence = "`".repeat(Math.max(3, Math.max(0, ...(text.match(/`+/g) || []).map((run2) => run2.length)) + 1));
          blocks.push(`${fence}\n${text}\n${fence}`);
          result.formatted = true;
        }
      } else if (tag === "hr") {
        emitRun();
      } else if (tag === "li") {
        // A stray list item outside any list is a bullet.
        emitRun();
        const text = tidyLine(inline(child, ctx)).replace(/\n+/g, " ");
        if (text) blocks.push(`- ${text}`);
      } else if (tag === "td" || tag === "th") {
        run.push(" ");
        for (const part of child.children) run.push(part);
        run.push(" ");
      } else if (BLOCKS.has(tag) || tag === "body" || tag === "html" || tag === "tbody") {
        emitRun();
        // Word marks list paragraphs by class; they become bullets.
        if (/MsoListParagraph/i.test(String(child.attrs.class || ""))) {
          const text = tidyLine(inline(child, ctx)).replace(/^[\u00b7\u2022\u00a7o-]\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/\n+/g, " ");
          if (text) blocks.push(`- ${text}`);
        } else walk(child, ctx);
        emitRun();
      } else if (containsBlock(child)) {
        // An inline wrapper around blocks (Google Docs wraps everything in a bold) is only a container.
        emitRun();
        walk(child, ctx);
      } else run.push(child);
    }
    emitRun();
  };
  walk(tree, {});

  // Word's list paragraphs are separate paragraphs; side by side they are one list.
  const merged = [];
  for (const block of blocks) {
    if (block.startsWith("")) {
      const item = block.slice(1);
      if (merged.length && merged[merged.length - 1].marked) merged[merged.length - 1].text += `
${item}`;
      else merged.push({ text: item, marked: true });
    } else merged.push({ text: block, marked: false });
  }
  const kept = [];
  let size = 0;
  for (const { text: block } of merged) {
    if (kept.length >= PASTE_LIMITS.blocks || size + block.length > PASTE_LIMITS.markdown) break;
    kept.push(block);
    size += block.length + 2;
  }
  result.blocks = kept;
  result.markdown = kept.join("\n\n");
  return result;
}

/** A plain sentence about what the paste left out, or "". */
export function pasteNotice(result, { plain = false } = {}) {
  if (plain) return "Pasted as plain text.";
  const parts = [];
  if (result.droppedImages) {
    parts.push(
      result.droppedImages === 1
        ? "One picture was left out because it has no description. Add it with the Image button and describe it."
        : `${result.droppedImages} pictures were left out because they have no description. Add them with the Image button and describe them.`,
    );
  }
  if (result.formatted) parts.push("Pasted with headings, emphasis and links kept; fonts, colors and other styling were removed. Press Ctrl+Shift+V to paste plain text instead.");
  return parts.join(" ");
}
