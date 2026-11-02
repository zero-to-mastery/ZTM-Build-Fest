export function cratesBadge(kind, c) {
  if (!/^[a-zA-Z][a-zA-Z\d_-]{0,63}$/.test(c.crate || ""))
    throw new Error(
      "Enter a crate name using letters, numbers, underscores or hyphens.",
    );
  if (!["version", "downloads"].includes(kind))
    throw new Error("Unknown crates.io badge type.");
  return {
    path: `crates/${kind === "version" ? "v" : "d"}/${encodeURIComponent(c.crate)}`,
    link: `https://crates.io/crates/${encodeURIComponent(c.crate)}`,
    alt: `${c.crate} crates.io ${kind}`,
  };
}
