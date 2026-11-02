import { normalizeBanner } from "./banner-model.js";
import { renderBanner } from "./render-svg.js";
import { safeFilename } from "../state/download.js";
import { picture, html } from "../markdown/serialize.js";
function descriptors(b) {
  const base = safeFilename(b.filename.replace(/\.svg$/i, "")) || "banner";
  return (b.themeMode === "both" ? ["light", "dark"] : [b.themeMode]).map(
    (mode) => ({ name: `${base}-${mode}.svg`, mode }),
  );
}
export function bannerFiles(raw) {
  const b = normalizeBanner(raw);
  return descriptors(b).map((file) => ({
    ...file,
    source: renderBanner(b, file.mode),
  }));
}
export function bannerMarkup(raw) {
  const b = normalizeBanner(raw),
    files = descriptors(b),
    prefix = b.assetDirectory.replace(/\/+$/, "");
  const path = (f) => (prefix ? prefix + "/" : "") + f.name;
  return files.length === 2
    ? picture({ light: path(files[0]), dark: path(files[1]), alt: b.alt })
    : `<img src="${html(path(files[0]))}" alt="${html(b.alt)}">`;
}
