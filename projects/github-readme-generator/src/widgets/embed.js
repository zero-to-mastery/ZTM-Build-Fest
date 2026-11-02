import { safeUrl } from "../markdown/url-safety.js";
import { escapeHTML as html } from "../components-library/escape.js";
export function normalizeEmbed(raw = {}) {
  const s = {};
  for (const key of ["image", "light", "dark", "link"]) {
    const v = String(raw[key] ?? "");
    if (v.length > 8000) throw Error("Image/link URL is too long.");
    s[key] = safeUrl(v, { image: key !== "link" });
    if (v && !s[key]) throw Error(`${key} needs a safe URL.`);
  }
  s.alt = String(raw.alt ?? "");
  if (s.alt.length > 500)
    throw Error("Use concise alt text under 500 characters.");
  s.align = raw.align || "left";
  if (!["left", "center"].includes(s.align))
    throw Error("Choose left or center alignment.");
  for (const key of ["width", "height"]) {
    const v = raw[key];
    if (v === undefined || v === "") {
      s[key] = "";
      continue;
    }
    if (!/^\d+$/.test(String(v)) || Number(v) < 1 || Number(v) > 2000)
      throw Error(`${key} must be between 1 and 2000 pixels.`);
    s[key] = String(Number(v));
  }
  if (!(s.light || s.image))
    throw Error("Paste an image URL or light image URL.");
  return s;
}
const destination = (v) =>
  html(v.replace(/[()\s]/g, (c) => encodeURIComponent(c)));
export function embedMarkdown(raw) {
  const s = normalizeEmbed(raw),
    light = s.light || s.image,
    size = ["width", "height"]
      .filter((k) => s[k])
      .map((k) => ` ${k}="${s[k]}"`)
      .join("");
  let result;
  if (s.dark)
    result = `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="${html(s.dark)}">\n  <img src="${html(light)}" alt="${html(s.alt)}"${size}>\n</picture>`;
  else if (s.align === "center" || size)
    result = `<img src="${html(light)}" alt="${html(s.alt)}"${size}>`;
  else {
    const alt = html(s.alt)
      .replace(/[\\`*_[\]]/g, "\\$&")
      .replace(/[\r\n]/g, " ");
    const image = `![${alt}](${destination(light)})`;
    return s.link ? `[${image}](${destination(s.link)})` : image;
  }
  if (s.link) result = `<a href="${html(s.link)}">${result}</a>`;
  return s.align === "center" ? `<p align="center">\n${result}\n</p>` : result;
}
export function typingURL(raw) {
  const lines = String(raw.lines || "")
    .split(/\r?\n/)
    .filter(Boolean);
  if (
    !lines.length ||
    lines.length > 10 ||
    lines.some((l) => l.length > 160 || l.includes(";"))
  )
    throw Error(
      "Use 1–10 typing lines, up to 160 characters each; use newlines instead of semicolons.",
    );
  const font = String(raw.font || "monospace");
  if (!/^[a-z\d -]{1,60}$/i.test(font))
    throw Error("Use a plain font family name.");
  const color = String(raw.color || "36BCF7").replace(/^#/, "");
  if (!/^[a-f\d]{6}$/i.test(color))
    throw Error("Typing color needs six hex digits.");
  const size = Number(raw.size ?? 20),
    duration = Number(raw.duration ?? 5000);
  if (
    !Number.isInteger(size) ||
    size < 8 ||
    size > 100 ||
    !Number.isInteger(duration) ||
    duration < 100 ||
    duration > 60000
  )
    throw Error("Font size must be 8–100; duration 100–60000 ms.");
  const q = new URLSearchParams({
    lines: lines.join(";"),
    font,
    size: String(size),
    duration: String(duration),
    color,
    center: String(raw.center === true),
  });
  return "https://readme-typing-svg.demolab.com/?" + q;
}
