export const badgePresets = [
  ["Technology", "JavaScript", "", "javascript", "F7DF1E"],
  ["Social", "GitHub", "Follow", "github", "181717"],
  ["Portfolio", "Portfolio", "Visit", "", "6558d3"],
  ["Blog", "Blog", "Read", "", "blue"],
  ["Resume", "Resume", "Read", "", "blue"],
  ["Deployment", "Deployment", "status", "", "grey"],
  ["Build", "Build", "status", "githubactions", "grey"],
  ["Package", "Package", "version", "npm", "CB3837"],
  ["License", "License", "MIT", "", "green"],
  ["Custom", "Your label", "Your message", "", "6558d3"],
].map(([name, label, message, logo, color]) => ({
  name,
  badge: {
    label,
    message,
    logo,
    color,
    style: "flat",
    logoColor: name === "Technology" ? "000000" : "white",
    alt: [label, message].filter(Boolean).join(": "),
  },
}));
