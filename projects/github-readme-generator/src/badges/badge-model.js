import technologies from "../data/technologies.json";
export const logos = technologies.map((t) => ({ ...t, shieldsLogo: t.logo }));
if (!logos.some((t) => t.id === "wasm"))
  logos.push({
    id: "wasm",
    name: "WebAssembly",
    shieldsLogo: "webassembly",
    brandColor: "654FF0",
    aliases: ["wasm"],
    category: "Languages",
  });
export function searchLogos(query) {
  const q = query.trim().toLowerCase();
  return logos.filter((t) =>
    [t.id, t.name, t.shieldsLogo, t.category, ...t.aliases].some((v) =>
      v.toLowerCase().includes(q),
    ),
  );
}
export function technologyBadge(t) {
  return {
    label: t.name,
    name: t.name,
    message: "",
    logo: t.shieldsLogo || t.logo,
    color: t.id === "react" ? "20232A" : t.brandColor,
    logoColor:
      t.id === "react"
        ? "61DAFB"
        : ["F7DF1E", "E34F26"].includes(t.brandColor)
          ? "000000"
          : "white",
    alt: t.name,
    style: "for-the-badge",
    category: t.category,
  };
}
export const defaultBadge = () => ({
  label: "Built with",
  message: "care",
  color: "6558d3",
  logoColor: "white",
  style: "flat",
  alt: "Built with care",
});
