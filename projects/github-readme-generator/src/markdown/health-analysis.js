import { analyzeCompatibility } from "../compatibility/analyze.js";
import { analyzeDocument } from "../analysis/analyze.js";
import { componentHealth } from "../component-instances/health.js";
import { widgetHealth } from "../widgets/health.js";
import { stylingHealth } from "../styling/health.js";
import { projectHealth } from "../projects/project-health.js";
import { normalizeProject } from "../projects/project-model.js";
import { analyze } from "./compatibility.js";
import { documentSegments } from "./source-context.js";
import { isRelativeUrl, validSourceContext } from "./resolve-urls.js";
import { duplicateWarnings } from "./merge.js";
import { contextResolver } from "../state/import-plan.js";
import { validateLocalization } from "../localization/metadata.js";
export function analyzeDraft(draft, core) {
  const analysis = analyze(draft.markdown),
    warnings = duplicateWarnings(draft.markdown, contextResolver(draft));
  analysis.issues.push(...componentHealth(draft.blocks || []));
  analysis.issues.push(...widgetHealth(analysis.images));
  analysis.issues.push(...stylingHealth(draft.blocks || []));
  const projects = (draft.blocks || [])
    .filter((b) => b.type === "projects" && b.settings?.version === 1)
    .flatMap((b) => b.settings.items || []);
  try {
    analysis.issues.push(...projectHealth(projects.map(normalizeProject)));
  } catch {
    warnings.push(
      "Some structured projects could not be analyzed. Original Markdown remains available.",
    );
  }
  for (const block of draft.blocks || []) {
    if (
      block.type === "projects" &&
      block.settings?.version === 1 &&
      (["card", "two-column"].includes(block.settings.layout) ||
        block.settings.items?.some((p) => p.imagePlacement === "side-by-side"))
    )
      analysis.issues.push({
        category: "Layout",
        message:
          "Project tables may scroll on narrow screens. Preview at mobile width or choose a linear layout.",
      });
  }
  for (const segment of documentSegments(draft)) {
    if (validSourceContext(segment.sourceContext)) continue;
    const a =
      segment.source === draft.markdown ? analysis : analyze(segment.source);
    if (a.images.some((i) => isRelativeUrl(i.url)))
      warnings.push(
        "Relative image cannot be previewed from this local or mixed-source import.",
      );
    if (a.links.some((i) => isRelativeUrl(i.url)))
      warnings.push(
        "Relative repository link has no known source; its destination cannot be opened in preview.",
      );
  }
  analysis.detail = analyzeDocument(draft.markdown, { core });
  let localization = null;
  try {
    localization = validateLocalization(
      draft.metadata?.workspaceDocument?.localization,
    );
  } catch {
    // Import validation reports malformed metadata; Health remains available.
  }
  if (localization?.locale && localization.locale !== "en") {
    analysis.detail.issues = analysis.detail.issues.filter(
      (issue) => issue.ruleId !== "image-alt-quality",
    );
    analysis.languageAwareness = {
      locale: localization.locale,
      status: "unknown",
      detail:
        "English wording and conventional-section heuristics are Unknown for this language and are not shown. Structural, link, media and source checks remain available.",
    };
  }
  analysis.detail.compatibility = analyzeCompatibility(analysis.detail);
  return { analysis, warnings: [...new Set(warnings)] };
}
