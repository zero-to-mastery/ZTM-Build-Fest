import { snippets } from "../data/snippets.js";
const setup = {
  constellation: [
    "Workflow or local generation",
    "GitHub Actions for automatic updates; local generation also available.",
    "Publish the generated SVG from the upstream studio/workflow, then paste its public URL. Studio does not configure Constellation.",
    "Repository-hosted SVG; light/dark output supported.",
  ],
  metrics: [
    "Upstream configuration",
    "GitHub Actions recommended; upstream offers other hosting options.",
    "Configure Metrics upstream and paste its resulting image URL. Its full plugin/configuration interface remains upstream.",
    "Generated SVG; repository or external hosting; light/dark variants may be supplied.",
  ],
  snake: [
    "Workflow setup",
    "GitHub Actions for scheduled updates.",
    "Set up the upstream workflow, publish the light/dark SVG files, then paste their output URLs.",
    "Animated SVG; published repository assets; light/dark supported.",
  ],
  typing: [
    "Guided URL",
    "GitHub Actions not required.",
    "Enter one text line per line below, or paste your own hosted typing URL.",
    "Animated SVG served by an external host; previews send only the configured URL and its text parameters.",
  ],
  streak: [
    "Upstream generator",
    "GitHub Actions not required for a hosted endpoint.",
    "Use the upstream generator or your own deployment, then paste the generated URL.",
    "External service availability and caching affect images.",
  ],
  stats: [
    "Upstream deployment or image URL",
    "GitHub Actions or self-hosting recommended upstream; public endpoint is best-effort.",
    "Follow upstream setup and paste an image URL. No tokens or private account data are requested by README Studio.",
    "Public endpoint may be rate limited; static repository-hosted images also work.",
  ],
  activity: [
    "Upstream image URL",
    "GitHub Actions not required for a hosted endpoint.",
    "Configure at the upstream project or your deployment, then paste its graph image URL.",
    "External service; wider graphs may need a mobile-friendly width.",
  ],
};
export const widgetRegistry = snippets.map((s) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  projectUrl: s.projectUrl,
  docsUrl: s.projectUrl + "#readme",
  setupType: setup[s.id][0],
  actions: setup[s.id][1],
  instructions: setup[s.id][2],
  notes: setup[s.id][3],
  externalHosting:
    "Image URLs contact their remote host. Published repository assets are also remote images.",
  attribution: s.name,
  fields: ["image", "link", "alt", "align", "width", "height", "light", "dark"],
}));
