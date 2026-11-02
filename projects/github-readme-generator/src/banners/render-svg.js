import { normalizeBanner } from "./banner-model.js";
const xml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
export function seededRandom(seed) {
  let n = 2166136261;
  for (const c of String(seed)) {
    n ^= c.codePointAt(0);
    n = Math.imul(n, 16777619);
  }
  return () => {
    n += 0x6d2b79f5;
    let t = n;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function renderBanner(raw, mode = "light") {
  const b = normalizeBanner(raw);
  if (!["light", "dark"].includes(mode)) throw Error("Choose light or dark.");
  const { width: w, height: h } = b,
    p = b.palette,
    dark = mode === "dark",
    bg = "#" + (dark ? p.dark : p.light),
    fg = dark ? "#f8fafc" : "#" + p.foreground,
    accent = b.pattern === "monochrome" ? fg : "#" + p.accent;
  const random = seededRandom(b.seed),
    pieces = [];
  let background = bg;
  if (b.pattern === "gradient") {
    pieces.push(
      `<defs><linearGradient id="background" x2="1" y2="1"><stop stop-color="${bg}"/><stop offset="1" stop-color="#${p.accentAlt}" stop-opacity=".24"/></linearGradient></defs>`,
    );
    background = "url(#background)";
  }
  pieces.push(
    `<rect width="${w}" height="${h}" rx="14" fill="${background}"/>`,
  );
  if (b.pattern === "grid")
    for (let x = 0; x < w; x += 40)
      pieces.push(`<path d="M${x} 0V${h}" stroke="${accent}" opacity=".09"/>`);
  if (b.pattern === "grid")
    for (let y = 0; y < h; y += 40)
      pieces.push(`<path d="M0 ${y}H${w}" stroke="${accent}" opacity=".09"/>`);
  if (b.pattern === "constellation") {
    const points = Array.from({ length: 18 }, () => [
      Math.round(random() * w),
      Math.round(random() * h),
    ]);
    points.forEach(([x, y], i) => {
      pieces.push(
        `<circle cx="${x}" cy="${y}" r="2" fill="${accent}" opacity=".25"/>`,
      );
      if (i)
        pieces.push(
          `<path d="M${points[i - 1].join(" ")}L${x} ${y}" stroke="${accent}" opacity=".06"/>`,
        );
    });
  }
  if (b.pattern === "geometric")
    for (let i = 0; i < 8; i++) {
      const x = Math.round(random() * w),
        y = Math.round(random() * h),
        r = 20 + Math.round(random() * 55);
      pieces.push(
        `<path d="M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z" fill="${accent}" opacity=".05"/>`,
      );
    }
  if (b.pattern === "code-lines")
    for (let i = 0; i < 8; i++) {
      const x = Math.round(w * 0.7 + random() * w * 0.15),
        y = 20 + (i * (h - 40)) / 8;
      pieces.push(
        `<path d="M${x} ${y.toFixed(1)}h${Math.round(random() * w * 0.15)}" stroke="${accent}" stroke-width="3" opacity=".12"/>`,
      );
    }
  if (b.pattern === "terminal") {
    pieces.push(
      `<path d="M20 34H${w - 20}" stroke="${accent}" opacity=".25"/>`,
    );
    for (let i = 0; i < 3; i++)
      pieces.push(
        `<circle cx="${26 + i * 15}" cy="20" r="4" fill="${accent}" opacity="${0.3 + i * 0.2}"/>`,
      );
  }
  if (b.showAccent)
    pieces.push(
      `<rect x="24" y="${Math.max(42, h * 0.16)}" width="4" height="${h * 0.62}" rx="2" fill="${accent}"/>`,
    );
  const x =
      b.alignment === "center" ? w / 2 : b.alignment === "right" ? w - 44 : 44,
    anchor =
      b.alignment === "center"
        ? "middle"
        : b.alignment === "right"
          ? "end"
          : "start";
  const lines = [
    [b.name, 32, fg],
    [b.title, 22, accent],
    [b.subtitle, 16, fg],
    [b.website, 14, dark ? "#cbd5e1" : "#" + p.muted],
    [b.metadataLine, 12, dark ? "#cbd5e1" : "#" + p.muted],
  ].filter(([v]) => v);
  const spacing = Math.min(44, (h - 60) / Math.max(1, lines.length)),
    start = Math.max(54, (h - (lines.length - 1) * spacing) / 2);
  lines.forEach(([value, size, c], i) => {
    const fs = Math.min(size, h * 0.13, spacing * 0.85);
    const fit = Math.min(w - 88, [...value].length * fs * 0.62);
    pieces.push(
      `<text x="${x}" y="${(start + i * spacing).toFixed(1)}" text-anchor="${anchor}" font-size="${fs.toFixed(1)}" ${i === 0 ? 'font-weight="700"' : ""} fill="${c}"${[...value].length * fs * 0.62 > w - 88 ? ` textLength="${fit}" lengthAdjust="spacingAndGlyphs"` : ""}>${xml(value)}</text>`,
    );
  });
  if (b.showBorder)
    pieces.push(
      `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="14" fill="none" stroke="#${p.border}"/>`,
    );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc" font-family="${b.pattern === "terminal" ? "ui-monospace, monospace" : "system-ui, sans-serif"}"><title id="title">${xml(b.alt)}</title><desc id="desc">${xml([b.name, b.title, b.subtitle].filter(Boolean).join(" — "))}</desc>${pieces.join("")}</svg>`;
}
