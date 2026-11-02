// Shared by builder serialization and preview resolution. Raw source never passes through this helper.
export function safeUrl(value = "", { image = false, relative = true } = {}) {
  if (typeof value !== "string") return "";
  const url = value.trim();
  if (!url || /[\x00-\x1f\x7f\\]/.test(url)) return "";
  if (url.startsWith("#")) return image ? "" : url;
  if (/^(https?:\/\/|\/\/)/i.test(url)) {
    try {
      const parsed = new URL(url, "https://readme.invalid");
      return ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
        ? url
        : "";
    } catch {
      return "";
    }
  }
  if (!image && /^mailto:/i.test(url)) return url;
  if (/^[a-z][a-z\d+.-]*:/i.test(url)) return "";
  return relative ? url : "";
}
