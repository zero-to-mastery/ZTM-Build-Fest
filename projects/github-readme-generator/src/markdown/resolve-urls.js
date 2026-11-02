import { safeUrl } from "./url-safety.js";
export function isRelativeUrl(value = "") {
  return !!value.trim() && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value.trim());
}
export function validSourceContext(c) {
  return (
    c?.type === "github" &&
    typeof c.owner === "string" &&
    typeof c.repository === "string" &&
    /^[a-z\d-]+$/i.test(c.owner) &&
    /^[\w.-]+$/.test(c.repository) &&
    ![".", ".."].includes(c.repository) &&
    typeof c.ref === "string" &&
    !!c.ref &&
    !/[\x00-\x20?#\\]/.test(c.ref) &&
    !c.ref.split("/").some((s) => s === "." || s === "..") &&
    typeof c.readmePath === "string" &&
    !!c.readmePath &&
    !/[\x00-\x1f\\]/.test(c.readmePath) &&
    !c.readmePath.startsWith("/") &&
    !c.readmePath.split("/").includes("..")
  );
}
function resolve(value, context, image) {
  const url = safeUrl(value, { image });
  if (!url || /[\x00-\x1f\x7f\\]/.test(url)) return "";
  if (url.startsWith("#")) return image ? "" : url;
  if (/^(https?:\/\/|\/\/)/i.test(url)) return url;
  if (!image && /^mailto:/i.test(url)) return url;
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || !validSourceContext(context))
    return "";
  let target;
  try {
    target = new URL(
      url,
      "https://readme.invalid/" +
        context.readmePath.split("/").map(encodeURIComponent).join("/"),
    );
  } catch {
    return "";
  }
  if (target.origin !== "https://readme.invalid") return "";
  return `${image ? "https://raw.githubusercontent.com" : "https://github.com"}/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}/${image ? "" : "blob/"}${encodeURIComponent(context.ref)}${target.pathname}${target.search}${target.hash}`;
}
export const resolveImageUrl = (value, context) =>
  resolve(value, context, true);
export const resolveLinkUrl = (value, context) =>
  resolve(value, context, false);
export function srcsetCandidates(value = "") {
  if (/data:/i.test(value)) return [];
  return value
    .split(",")
    .map((part) => {
      const [url, ...descriptor] = part.trim().split(/\s+/);
      return { url, descriptor: descriptor.join(" ") };
    })
    .filter(
      (c) =>
        c.url && (!c.descriptor || /^\d+(?:\.\d+)?[wx]$/.test(c.descriptor)),
    );
}
export function resolveSrcset(value, context) {
  return srcsetCandidates(value)
    .map((c) => {
      const url = resolveImageUrl(c.url, context);
      return url ? url + (c.descriptor ? " " + c.descriptor : "") : "";
    })
    .filter(Boolean)
    .join(", ");
}
