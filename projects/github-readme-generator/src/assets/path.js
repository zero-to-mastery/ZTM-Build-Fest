const pathPattern =
  /^(?:[A-Za-z0-9_-](?:[A-Za-z0-9_. -]*[A-Za-z0-9_-])?\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.[A-Za-z0-9]+$/;

export function relativeAssetPath(path) {
  if (
    typeof path !== "string" ||
    path.length > 240 ||
    !pathPattern.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(
      "Use a visible relative asset path without traversal, hidden segments or ambiguous edge characters.",
    );
  return path;
}
