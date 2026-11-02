export function safeFilename(value) {
  const clean =
    String(value || "download")
      .normalize("NFC")
      .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "-")
      .replace(/^[. ]+|[. ]+$/g, "")
      .slice(0, 120) || "download";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)
    ? `_${clean}`
    : clean;
}
