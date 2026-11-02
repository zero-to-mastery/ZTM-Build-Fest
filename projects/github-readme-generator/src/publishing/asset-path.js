import { relativeAssetPath } from "../assets/path.js";

export function assetPath(path) {
  try {
    relativeAssetPath(path);
  } catch {
    throw new Error(
      "Use a visible relative SVG path without traversal, hidden files or workflow paths.",
    );
  }
  if (!path.endsWith(".svg"))
    throw new Error(
      "Use a visible relative SVG path without traversal, hidden files or workflow paths.",
    );
  return path;
}
