import { namedColors } from "./contrast.js";
import { safeUrl } from "../markdown/url-safety.js";
export const styles = [
  "flat",
  "flat-square",
  "plastic",
  "for-the-badge",
  "social",
];
const escape = (s = "") =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const md = (s = "") =>
  String(s)
    .replace(/[\\`*_[\]<>#]/g, "\\$&")
    .replace(/[\r\n]/g, " ");
const dest = (s) =>
  s.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
export function normalizeColor(value = "") {
  const v = String(value).trim().replace(/^#/, "");
  if (!v) return "";
  if (
    /^(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(v) ||
    namedColors.has(v.toLowerCase())
  )
    return v;
  throw new Error("Use a named color or a 3, 6, or 8 digit hex color.");
}
export const encodeBadgeText = (value) =>
  encodeURIComponent(
    String(value).replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_"),
  ).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export function badgeOptions(s = {}) {
  if (s.style && !styles.includes(s.style))
    throw new Error("Choose a supported badge style.");
  const q = new URLSearchParams({
    style: styles.includes(s.style) ? s.style : "flat",
  });
  if (s.logo) {
    if (!/^[a-z0-9.+-]{1,100}$/i.test(s.logo))
      throw new Error(
        "Use a Simple Icons logo slug, such as react or nodedotjs.",
      );
    q.set("logo", s.logo);
  }
  for (const k of ["logoColor", "labelColor", "color"])
    if (s[k]) q.set(k, normalizeColor(s[k]));
  if (s.cacheSeconds !== undefined && s.cacheSeconds !== "") {
    if (!/^\d{1,8}$/.test(String(s.cacheSeconds)))
      throw new Error(
        "Cache seconds must be a non-negative integer (up to 8 digits).",
      );
    q.set("cacheSeconds", s.cacheSeconds);
  }
  return q;
}
export function buildStaticBadge(s = {}, dark = false) {
  const variant = {
    ...s,
    color: (dark ? s.darkColor : s.color) || s.brandColor || "6558d3",
    logoColor: (dark ? s.darkLogoColor : s.logoColor) || "white",
  };
  const q = badgeOptions(variant);
  q.delete("color");
  const label = s.label || s.name || "";
  const parts =
    s.message && label
      ? [label, s.message, normalizeColor(variant.color)]
      : [s.message || label || "badge", normalizeColor(variant.color)];
  return `https://img.shields.io/badge/${parts.map(encodeBadgeText).join("-")}?${q}`;
}
export function badgeImages(s) {
  const customize = (raw, dark = false) => {
    const safe = safeUrl(raw, { image: true });
    if (!safe) return "";
    let url;
    try {
      url = new URL(safe);
    } catch {
      return safe;
    }
    {
      if (url.origin === "https://img.shields.io") {
        const options = badgeOptions({
          ...s,
          color: dark ? s.darkColor : s.color,
          logoColor: dark ? s.darkLogoColor : s.logoColor,
        });
        for (const [k, v] of options) url.searchParams.set(k, v);
        return url.href;
      }
    }
    return safe;
  };
  const light = s.lightUrl ? customize(s.lightUrl) : buildStaticBadge(s);
  const dark = s.darkUrl
    ? customize(s.darkUrl, true)
    : s.darkColor
      ? s.lightUrl
        ? customize(s.lightUrl, true)
        : buildStaticBadge(s, true)
      : "";
  if (!light || (s.darkUrl && !dark))
    throw new Error("Use a safe HTTP(S) or relative badge image URL.");
  if (s.link && !safeUrl(s.link))
    throw new Error("Use a safe HTTP(S), mailto, relative, or anchor link.");
  return { light, dark };
}
export function buildPictureBadge(s) {
  const { light, dark } = badgeImages(s);
  let result = `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="${escape(dark || light)}">\n  <img src="${escape(light)}" alt="${escape(s.alt ?? s.label ?? s.name)}">\n</picture>`;
  if (s.link) result = `<a href="${escape(safeUrl(s.link))}">\n${result}\n</a>`;
  return result;
}
export function buildLinkedBadge(s, format = "markdown") {
  const { light, dark } = badgeImages(s);
  if (dark) return buildPictureBadge(s);
  const alt = s.alt ?? s.label ?? s.name ?? "";
  if (format === "html") {
    const img = `<img src="${escape(light)}" alt="${escape(alt)}">`;
    return s.link ? `<a href="${escape(safeUrl(s.link))}">${img}</a>` : img;
  }
  const img = `![${md(alt)}](${dest(light)})`;
  return s.link ? `[${img}](${dest(safeUrl(s.link))})` : img;
}
