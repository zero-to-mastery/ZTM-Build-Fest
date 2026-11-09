export const snippets = [
  {
    id: "constellation",
    name: "GitHub Constellation",
    description: "Visualize your connected GitHub universe.",
    projectUrl: "https://github.com/mnichols08/constellation",
    instructions:
      "Follow the project setup guide, publish the generated image, then paste its public URL here.",
  },
  {
    id: "metrics",
    name: "GitHub Metrics",
    description: "A configurable snapshot of your open-source activity.",
    projectUrl: "https://github.com/lowlighter/metrics",
    instructions:
      "Configure the Metrics action in your repository, then use the raw URL of the generated SVG.",
  },
  {
    id: "snake",
    name: "Contribution Snake",
    description: "Turn the contribution grid into an animated snake.",
    projectUrl: "https://github.com/Platane/snk",
    instructions:
      "Follow the action setup instructions and paste the URL of your published snake SVG.",
  },
  {
    id: "typing",
    name: "Typing SVG",
    description: "An animated introduction, one line at a time.",
    projectUrl: "https://github.com/DenverCoder1/readme-typing-svg",
    instructions:
      "Use the linked project’s generator and paste the generated SVG image URL.",
  },
  {
    id: "streak",
    name: "GitHub Streak Stats",
    description: "Show your contribution streak.",
    projectUrl: "https://github.com/DenverCoder1/github-readme-streak-stats",
    instructions:
      "Use the project’s generator or your own deployment to obtain an image URL.",
  },
  {
    id: "stats",
    name: "GitHub Stats",
    description: "A compact card of repository activity.",
    projectUrl: "https://github.com/anuraghazra/github-readme-stats",
    instructions:
      "Follow the project documentation to create or host your stats image URL.",
  },
  {
    id: "activity",
    name: "Activity Graph",
    description: "A graph of recent contributions.",
    projectUrl: "https://github.com/Ashutosh00710/github-readme-activity-graph",
    instructions:
      "Configure the graph using the linked documentation and paste the resulting image URL.",
  },
].map((s) => ({
  category: "Dynamic widgets",
  template: { image: "", link: "", alt: s.name, align: "center" },
  ...s,
}));
