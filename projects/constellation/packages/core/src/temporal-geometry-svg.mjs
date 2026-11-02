import { animateTemporalSVG } from "./temporal-svg-motion.mjs";
import { activityForNode } from "./activity.mjs";
import { activityMarkup, activityCSS } from "./activity-effects.mjs";
import { temporalSceneLayers } from "./temporal-scene-layers.mjs";
import { temporalGeometryDrawing } from "./temporal-geometry-drawing.mjs";
import { renderNodeIcon } from "./theme-packs.mjs";
import { shapeDefinitions } from "./visual-mapping.mjs";
import { visualCSS } from "./visual-style.mjs";

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char],
  );
export function renderTemporalGeometrySVG(scene, { interactive = false } = {}) {
  const drawing = temporalGeometryDrawing(scene),
    stack = scene.temporalStack,
    options = scene.presentation.options;
  const layers = temporalSceneLayers(scene, drawing.viewBox);
  const selected =
    scene.layers.find((layer) => layer.id === "selection")?.visible === false
      ? null
      : options.selection?.start;
  const palette = {
    background: "#080e20",
    foreground: "#e6edff",
    accent: "#9ab9ff",
    line: "#596f98",
    star: "#f6d99b",
    ...(options.theme === "light" || options.theme === "auto"
      ? {
          background: "#f7f8fc",
          foreground: "#18213a",
          accent: "#395bbe",
          line: "#6c7c99",
          star: "#966500",
        }
      : {}),
    ...options.colors,
  };
  const markup = (item) => {
    if (item.kind === "dust")
      return `<g data-geometry-key="${item.key}">${layers.world}</g>`;
    const common = `data-geometry-key="${escape(item.key)}" data-camera-depth="${item.depth}"${item.layerId !== undefined ? ` data-layer-id="${escape(item.layerId)}"` : ""}${item.year ? ` data-year="${item.year}"` : ""} opacity="${item.opacity}"`;
    if (item.kind === "node") {
      const { node, point, placement } = item,
        { x, y, radius } = node.geometry;
      const activity =
        item.year === new Date(scene.metadata.referenceDate).getUTCFullYear()
          ? activityForNode(node.id, options.activityData)
          : null;
      const effects = activityMarkup({
        x,
        y,
        radius,
        id: node.id,
        activity,
        effect: options.activityEffect || "off",
        detail: options.activityDetail,
        seed: scene.metadata.seed,
        animate: options.animate !== false && options.activityAnimate !== false,
      });
      const transform = `matrix(${point.scale} 0 0 ${point.scale} ${point.x - x * point.scale} ${point.y - y * point.scale})`;
      return `<g class="repository" id="temporal-${escape(encodeURIComponent(`${item.layerId}::${node.id}`))}" ${common} data-node-id="${escape(node.id)}"${placement ? ` data-ring="${placement.ring}" data-ring-point="${placement.point}"` : ""}${selected === node.id ? ' data-related=""' : ""} transform="${transform}" style="color:${node.style.color || "var(--sky-star)"};--node-color:${node.style.color || "var(--sky-star)"}"><title>${escape(node.metadata.name)} · ${escape(stack.layers.find((layer) => (layer.id ?? layer.year) === item.layerId)?.label ?? item.year)}${placement ? ` · Ring ${placement.ring + 1}, point ${placement.point + 1}` : ""}${item.birth ? " · First visible in this window" : ""}</title>${effects}${item.birth ? `<circle class="temporal-birth" cx="${x}" cy="${y}" r="${radius + 5}"/>` : ""}<circle class="star" data-repo="${escape(node.id)}" data-label="${escape(node.metadata.name)}" data-kind="${escape(node.metadata.nodeKind || "repository")}" cx="${x}" cy="${y}" r="${radius}" style="${node.style.shape !== "circle" ? `clip-path:url(#shape-${node.style.shape});` : ""}${node.icon ? "fill:transparent" : ""}"/>${renderNodeIcon(node.icon, { x, y, radius }) || ""}</g>`;
    }
    const path =
      item.points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join("") +
      (item.kind === "surface" ? "Z" : "");
    const classes = {
      ring: "temporal-ring",
      mesh: "temporal-mesh",
      surface: "temporal-surface",
      relationship: "shared-language",
      temporal: "temporal-bridge",
    };
    const semantic =
      item.kind === "relationship"
        ? `data-from="${escape(item.from)}" data-to="${escape(item.to)}"`
        : item.kind === "temporal"
          ? `data-node-id="${escape(item.nodeId)}" data-from-layer="${escape(item.fromLayer ?? item.fromYear)}" data-to-layer="${escape(item.toLayer ?? item.toYear)}"${item.fromYear !== undefined ? ` data-from-year="${item.fromYear}" data-to-year="${item.toYear}"` : ""}${selected === item.nodeId ? ' data-related=""' : ""}`
          : `data-geometric-guide=""${item.rear ? ' data-rear=""' : ""} aria-hidden="true"`;
    return `<path class="${classes[item.kind]}" ${common} ${semantic} d="${path}"/>`;
  };
  const labels = drawing.labels
    .map(
      (item) =>
        `<text class="repo-label" data-geometry-key="${escape(item.key)}" data-layer-id="${escape(item.layerId)}"${item.year ? ` data-year="${item.year}"` : ""} data-repo="${escape(item.label.id)}" x="${item.label.x}" y="${item.label.y}" transform="translate(${item.x - item.label.x} ${item.y - item.label.y})" opacity="${item.opacity}">${escape(item.label.text)}</text>`,
    )
    .join("");
  const frameList = stack.frames || scene.timeline.frames;
  const frameMap = new Map(frameList.map((frame) => [frame.id, frame]));
  const years = drawing.years
    .map((item) => {
      const layer = stack.layers.find(
        (value) => (value.id ?? value.year) === item.layerId,
      );
      const signature =
        frameMap
          .get(layer?.frameId)
          ?.scene.developerProfile?.signature?.replace(
            /^Strongest evidence:\s*/,
            "",
          ) || "";
      return `<g data-layer-id="${escape(item.layerId)}" data-layer-label=""${item.year ? ` data-temporal-year="${item.year}"` : ""} transform="translate(${item.x} ${item.y})" role="group" aria-label="${escape(item.label)}: ${escape(item.evidence)}${signature ? `. Developer evidence: ${escape(signature)}` : ""}"><text class="temporal-year" text-anchor="end">${escape(item.label)}</text><text class="temporal-evidence" text-anchor="end" y="18">${item.evidence}</text>${signature ? `<text class="temporal-evidence" text-anchor="end" y="34">${escape(signature)}</text>` : ""}</g>`;
    })
    .join("");
  const metadata = {
    geometry: stack.geometry,
    layers: stack.layers,
    settings: stack.settings,
  };
  const [x, y, width, height] = drawing.viewBox;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${(900 * height) / width}" viewBox="${drawing.viewBox.join(" ")}" role="img" aria-labelledby="temporal-title temporal-description" data-temporal-form="${drawing.profile.shape}"${selected ? ' data-interactive-selection=""' : ""}><title id="temporal-title">${escape(options.title || scene.metadata.account)} · ${stack.axis === "year" ? "Temporal" : "Universe · " + stack.axis} ${drawing.profile.shape}</title><desc id="temporal-description">${stack.axis === "year" ? "Years" : "Current " + stack.axis + " memberships"} are cross-sections of a 3D ${drawing.profile.shape}. Nodes retain identity-ring positions across layers. Ring and mesh guides are geometry, not project relationships. ${stack.axis === "year" ? "Filaments show project continuity. Halos mark first visibility in this window. Retrospective layers use current metadata, not historical metrics." : "Filaments connect repeated identities across layers. These are current memberships, not historical observations."}${stack.reduced ? (stack.axis === "year" ? " Small format: latest three selected years." : " Bounded selection of dimension layers.") : ""}</desc><metadata id="temporal-geometry-data">${escape(JSON.stringify(metadata))}</metadata><defs>${shapeDefinitions}<filter id="glow"><feGaussianBlur stdDeviation="2"/></filter></defs><style>
svg{${Object.entries(palette)
    .map(([key, value]) => `--sky-${key}:${value}`)
    .join(
      ";",
    )};background:transparent;color:var(--sky-foreground);font-family:system-ui,sans-serif}.temporal-ring,.temporal-mesh{fill:none;stroke:var(--sky-accent);stroke-width:1;pointer-events:none}.temporal-ring[data-rear]{stroke-dasharray:2 5;stroke-width:.7}.temporal-mesh{stroke-width:.7}.temporal-surface{fill:var(--sky-accent);stroke:none;pointer-events:none}.star{fill:currentColor}.temporal-birth{fill:none;stroke:currentColor;stroke-width:1.5;opacity:.7}.repo-label{fill:var(--sky-foreground);font-size:11px;text-anchor:middle;pointer-events:none}.temporal-year{fill:var(--sky-foreground);font-size:24px;font-weight:700}.temporal-evidence{fill:var(--sky-accent);font-size:11px}.shared-language,.temporal-bridge{fill:none;stroke:var(--sky-line);stroke-width:1}.temporal-bridge{stroke:var(--sky-accent)}.temporal-bridge[data-related]{stroke:var(--sky-star);stroke-width:3;opacity:1!important}.repository[data-related] .star{stroke:var(--sky-foreground);stroke-width:2}[data-filtered]{display:none}.repository:focus{outline:2px solid var(--sky-accent)}[data-interactive-selection] .repository:not([data-related]){opacity:.25!important}
${activityCSS}${options.animate !== false && options.starlightAnimate !== false ? ".star{animation:temporal-starlight 6s ease-in-out infinite}@keyframes temporal-starlight{0%,100%{opacity:.45}50%{opacity:1}}@media(prefers-reduced-motion:reduce){.star{animation:none}}" : ""}${layers.css}${options.theme === "auto" && !options.visualTheme ? "@media(prefers-color-scheme:dark){svg{--sky-background:#080e20;--sky-foreground:#e6edff;--sky-accent:#9ab9ff;--sky-line:#596f98;--sky-star:#f6d99b}}" : ""}${escape(options.visualStyle ? visualCSS(options.visualStyle) : "")}${escape(options.css || "")}${escape(options.customCSS || "")}</style>${layers.backdrop}${layers.underlay}<text x="${x + 32}" y="${y + 35}" fill="var(--sky-foreground)" font-size="22">${escape(options.title || scene.metadata.account)} · ${stack.axis === "year" ? "Temporal" : "Universe · " + stack.axis} ${drawing.profile.shape}</text>${stack.reduced ? `<text x="${x + 32}" y="${y + 57}" fill="var(--sky-accent)" font-size="12">${stack.axis === "year" ? "Small format · latest three selected years" : "Bounded selection of dimension layers"}</text>` : ""}<g data-temporal-world="">${drawing.items
    .filter((item) => !item.afterLabels)
    .map(markup)
    .join("")}</g><g data-temporal-labels="">${labels}</g>${drawing.items
    .filter((item) => item.afterLabels)
    .map(markup)
    .join(
      "",
    )}${years}${scene.layers.find((layer) => layer.id === "annotations")?.visible === false ? "" : (scene.annotations || []).map((note) => `<text x="${note.x}" y="${note.y}" fill="var(--sky-foreground)">${escape(note.text)}</text>`).join("")}${layers.credit}</svg>`;
  const accessibleSVG =
    stack.settings.innerArrangement === "profile"
      ? svg.replace(
          "Nodes retain identity-ring positions across layers.",
          "Developer Topology positions each layer from the evidence available in that layer.",
        )
      : svg;
  return interactive ? accessibleSVG : animateTemporalSVG(accessibleSVG, scene);
}
