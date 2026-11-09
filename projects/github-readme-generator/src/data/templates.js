import { createBlock as b } from "../markdown/serialize.js";
import technologies from "./technologies.json";
export const templateNames = [
  "Minimal",
  "Developer Showcase",
  "Open Source",
  "Student",
  "Terminal",
];
export function template(name = "Developer Showcase") {
  const hero = b("hero", {
    name: "Your Name",
    subtitle: "Building thoughtful software, one commit at a time.",
  });
  const about = b("about", {
    title: "About Me",
    body: "I turn curious questions into useful tools. I care about accessible interfaces, clear code, and learning in public.",
  });
  const skills = b("stack", {
    items: technologies.filter((t) =>
      ["js", "react", "node", "rust"].includes(t.id),
    ),
    style: "badges",
    headings: true,
  });
  const projects = b("projects", {
    items: [
      {
        name: "Project One",
        icon: "↗",
        subtitle: "Small tools. Meaningful impact.",
        description: "A local-first workspace for organizing ideas.",
        highlights:
          "Designed an accessible, keyboard-friendly interface\nKept data on-device for a fast, private experience",
        stack: "JavaScript · Web Components",
        github: "https://github.com/your-name/project-one",
        layout: "detailed",
      },
    ],
  });
  const contact = b("social", {
    style: "links",
    items: [
      { name: "Portfolio", url: "https://example.com" },
      { name: "GitHub", url: "https://github.com/your-name" },
    ],
  });
  if (name === "Minimal") return [hero, about, skills, projects, contact];
  if (name === "Student")
    return [
      hero,
      b("learning", {
        title: "Currently Learning",
        body: "Exploring web development and computer science through small, practical projects.",
      }),
      skills,
      projects,
      b("about", {
        title: "Education",
        body: "Your program · Your school · Graduation year",
      }),
      contact,
    ];
  if (name === "Terminal")
    return [
      b("custom", {
        markdown:
          "# Your Name\n\n```text\n$ whoami\nDeveloper. Curious builder. Open-source contributor.\n```",
      }),
      about,
      skills,
      projects,
      contact,
    ];
  if (name === "Open Source")
    return [
      hero,
      b("about", {
        title: "Current Work",
        body: "Making useful tools easier to use and contribute to.",
      }),
      b("custom", {
        markdown:
          "## Contributions\n\nAdd a contribution widget from the widget library.",
      }),
      projects,
      skills,
      contact,
    ];
  return [
    hero,
    b("custom", {
      markdown:
        "> A little about what I build, use, and explore.\n\n<!-- Add your own widget image with the widget library. -->",
    }),
    about,
    skills,
    projects,
    b("writing", {
      title: "Writing & Notes",
      body: "- [An engineering lesson worth sharing](https://example.com/blog)",
    }),
    contact,
  ];
}
