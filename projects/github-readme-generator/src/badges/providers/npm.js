export function npmBadge(kind, c) {
  const name = c.package || "";
  if (
    name.length > 214 ||
    !/^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/.test(name)
  )
    throw new Error(
      "Enter a lowercase npm package name, such as react or @scope/package.",
    );
  if (!["version", "downloads"].includes(kind))
    throw new Error("Unknown npm badge type.");
  const path = name.split("/").map(encodeURIComponent).join("/");
  return {
    path: `npm/${kind === "version" ? "v" : "dm"}/${path}`,
    link: `https://www.npmjs.com/package/${path}`,
    alt: `${name} npm ${kind === "downloads" ? "monthly downloads" : "version"}`,
  };
}
