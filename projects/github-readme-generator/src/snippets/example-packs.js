import { builtInComponents } from "../components-library/registry.js";
import { exportPack } from "./pack-schema.js";
export const examplePacks = [
  ["Minimal Profile Kit", ["left", "contact-line", "divider"]],
  [
    "Open Source Kit",
    ["detailed-project", "ci-row", "widget-stats", "contact-line"],
  ],
  ["Terminal Kit", ["terminal-intro", "terminal-heading", "terminal-contact"]],
  [
    "Developer Showcase Kit",
    ["featured-project", "technology-row", "article", "details"],
  ],
].map(([name, ids]) =>
  exportPack(
    {
      name,
      description:
        "Editable example starters. Configure placeholders and external assets before publishing.",
      author: "README Studio",
    },
    ids.map((id) => builtInComponents.find((c) => c.id === `builtin:${id}`)),
  ),
);
