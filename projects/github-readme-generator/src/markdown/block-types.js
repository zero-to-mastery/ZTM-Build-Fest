import { documentationSections } from "../documentation/sections.js";

// Canonical visual-builder types. Keep labels with the registry so UI choices
// and untrusted ownership-record validation cannot drift apart.
export const blockTypes = {
  hero: "Hero",
  about: "About Me",
  stack: "Tech Stack",
  social: "Social Links",
  projects: "Projects",
  widget: "Dynamic Widgets",
  learning: "Current Learning",
  writing: "Writing / Blog",
  contact: "Contact",
  divider: "Divider",
  custom: "Custom Markdown",
  badge: "Badge",
  badges: "Badge Row",
  picture: "Light / Dark Image",
  callout: "Callout",
  details: "Collapsible Details",
  code: "Code Sample",
  columns: "Two Columns",
  ...Object.fromEntries(
    Object.entries(documentationSections).map(([type, definition]) => [
      type,
      definition.name,
    ]),
  ),
};

export const isBuilderBlockType = (type) =>
  type !== "custom" && Object.hasOwn(blockTypes, type);
