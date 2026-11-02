import { temporalSceneLayers } from "./temporal-scene-layers.mjs";
import { projectTemporalPlane } from "./temporal-stack-model.mjs";
import { visualCSS } from "./visual-style.mjs";
import { shapeDefinitions } from "./visual-mapping.mjs";
import { renderNodeIcon } from "./theme-packs.mjs";
import { renderTemporalGeometrySVG } from "./temporal-geometry-svg.mjs";

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
export function renderTemporalStackSVG(scene, renderOptions) {
  if (scene.temporalStack.geometry)
    return renderTemporalGeometrySVG(scene, renderOptions);
  const stack = scene.temporalStack,
    frames = new Map(
      (stack.frames || scene.timeline.frames).map((frame) => [frame.id, frame]),
    );
  const settings = stack.settings,
    options = scene.presentation.options;
  const layers = temporalSceneLayers(scene);
  const selected = options.selection?.start;
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
  const layerStyle = (id) => {
    const layer = scene.layers.find((layer) => layer.id === id);
    return `opacity:${layer?.visible === false ? 0 : (layer?.opacity ?? 1)}`;
  };
  const first = new Map();
  for (const layer of [...stack.layers].reverse())
    for (const node of frames.get(layer.frameId).scene.nodes)
      if (!first.has(node.id)) first.set(node.id, layer.year);
  const projected = new Map();
  for (const layer of stack.layers) {
    const [a, b, c, d, e, f] = projectTemporalPlane(layer.depth, settings);
    for (const node of frames.get(layer.frameId).scene.nodes)
      projected.set(`${layer.year}::${node.id}`, {
        x: a * node.geometry.x + c * node.geometry.y + e,
        y: b * node.geometry.x + d * node.geometry.y + f,
        hidden: node.interaction.hidden,
      });
  }
  const bridges = stack.bridges
    .map((bridge) => {
      const from = projected.get(`${bridge.fromYear}::${bridge.nodeId}`),
        to = projected.get(`${bridge.toYear}::${bridge.nodeId}`);
      if (from.hidden || to.hidden) return "";
      return `<path class="temporal-bridge"${bridge.nodeId === selected ? ' data-related=""' : ""} data-node-id="${escape(bridge.nodeId)}" data-from-year="${bridge.fromYear}" data-to-year="${bridge.toYear}" d="M${from.x} ${from.y}L${to.x} ${to.y}"><title>${escape(bridge.nodeId)} · continuity ${bridge.fromYear}–${bridge.toYear}</title></path>`;
    })
    .join("");
  const planes = [...stack.layers]
    .reverse()
    .map((layer) => {
      const frame = frames.get(layer.frameId),
        local = frame.scene,
        matrix = projectTemporalPlane(layer.depth, settings);
      const visible = new Map(
        local.nodes
          .filter((node) => !node.interaction.hidden)
          .map((node) => [node.id, node]),
      );
      const evidence =
        frame.evidence === "current-metadata"
          ? "Current-metadata retrospective view"
          : frame.evidence === "snapshot"
            ? `Snapshot · ${frame.date.slice(0, 10)}`
            : "Current";
      const edges = local.edges
        .filter((edge) => visible.has(edge.from) && visible.has(edge.to))
        .map((edge) => {
          const from = visible.get(edge.from).geometry,
            to = visible.get(edge.to).geometry;
          return `<path class="shared-language" data-from="${escape(edge.from)}" data-to="${escape(edge.to)}" d="M${from.x} ${from.y}L${to.x} ${to.y}"/>`;
        })
        .join("");
      const [ma, mb, mc, md] = matrix,
        det = ma * md - mb * mc;
      const points = [...visible.values()]
        .map((node) => {
          const { x, y, radius } = node.geometry,
            birth = stack.axis === "year" && first.get(node.id) === layer.year;
          return `<g class="repository"${node.id === selected ? ' data-related=""' : ""} id="temporal-${escape(encodeURIComponent(`${layer.year}::${node.id}`))}" transform="translate(${x} ${y}) matrix(${(ma * md) / det} ${(-ma * mb) / det} ${(-ma * mc) / det} ${(ma * ma) / det} 0 0) translate(${-x} ${-y})" data-year="${layer.year}" data-node-id="${escape(node.id)}" style="color:${node.style.color || "var(--sky-star)"};opacity:${node.style.opacity ?? 1}"><title>${escape(node.metadata.name)} · ${layer.year} · ${evidence}${birth ? " · First visible layer (not necessarily creation year)" : ""}</title>${birth ? `<circle class="temporal-birth" cx="${x}" cy="${y}" r="${radius + 5}"/>` : ""}<circle class="star" style="${node.style.shape !== "circle" ? `clip-path:url(#shape-${node.style.shape});` : ""}${node.icon ? "fill:transparent" : ""}" data-label="${escape(node.metadata.name)}" data-kind="${escape(node.metadata.nodeKind || "repository")}" data-repo="${escape(node.id)}" cx="${x}" cy="${y}" r="${radius}"/>${renderNodeIcon(node.icon, { x, y, radius }) || ""}</g>`;
        })
        .join("");
      const [a, b, c, d] = matrix,
        determinant = a * d - b * c;
      const textTransform = (x, y) =>
        `translate(${x} ${y}) matrix(${d / determinant} ${-b / determinant} ${-c / determinant} ${a / determinant} 0 0) translate(${-x} ${-y})`;
      const labels = local.labels
        .filter((label) => !label.hidden && visible.has(label.id))
        .map(
          (label) =>
            `<text class="repo-label" transform="${textTransform(label.x, label.y)}" data-repo="${escape(label.id)}" x="${label.x}" y="${label.y}">${escape(label.text)}</text>`,
        )
        .join("");
      const emphasis = Math.max(0.55, 1 + layer.depth * 0.045);
      const signature =
        local.developerProfile?.signature?.replace(
          /^Strongest evidence:\s*/,
          "",
        ) || "";
      const layerLabel =
        stack.axis === "year" ? String(layer.year) : layer.label;
      return `<g data-layer-id="${escape(layer.id || "")}" data-temporal-year="${layer.year ?? ""}" data-depth="${layer.depth}" opacity="${emphasis}" transform="matrix(${matrix.join(" ")})" role="group" aria-label="${escape(layerLabel)}: ${evidence}${signature ? `. Developer evidence: ${escape(signature)}` : ""}"><ellipse class="temporal-plane" cx="450" cy="270" rx="405" ry="228"/><text class="temporal-year" transform="${textTransform(40, 5)}" x="40" y="5">${escape(layerLabel)}</text><text class="temporal-evidence" transform="${textTransform(120, 5)}" x="120" y="5">${evidence}</text>${signature ? `<text class="temporal-evidence" transform="${textTransform(120, 5)}" x="120" y="26">${escape(signature)}</text>` : ""}<g style="${layerStyle("connections")}">${edges}</g><g style="${layerStyle("nodes")}">${points}</g><g style="${layerStyle("labels")}">${labels}</g></g>`;
    })
    .join("");
  return `<svg${selected ? ' data-interactive-selection=""' : ""} xmlns="http://www.w3.org/2000/svg" width="${scene.viewport.width}" height="${scene.viewport.height}" viewBox="${scene.viewport.viewBox.join(" ")}" role="img" aria-labelledby="temporal-title temporal-description"><title id="temporal-title">${escape(options.title || scene.metadata.account)} · Temporal Stack</title><desc id="temporal-description">${stack.layers.length} yearly constellations. Newest nearest, older years descend into depth. Filaments connect the same project in adjacent displayed years. Halos mark first visibility within this window, not a proven birth date. Retrospective layers use current metadata, not historical metrics.${stack.reduced ? " Small format: only the latest three selected years are shown." : ""}</desc><defs>${shapeDefinitions}</defs><style>
svg{${Object.entries(palette)
    .map(([key, value]) => `--sky-${key}:${value}`)
    .join(
      ";",
    )};background:transparent;color:var(--sky-foreground);font-family:system-ui,sans-serif}.temporal-plane{fill:var(--sky-accent);fill-opacity:.035;stroke:var(--sky-accent);stroke-opacity:.25;stroke-dasharray:3 7}.temporal-year{fill:var(--sky-foreground);font-size:23px;font-weight:700}.temporal-evidence{fill:var(--sky-accent);font-size:12px}.star{fill:currentColor}.temporal-birth{fill:none;stroke:currentColor;stroke-width:1.5;opacity:.7}.repo-label{fill:var(--sky-foreground);font-size:11px;text-anchor:middle;pointer-events:none}.shared-language{fill:none;stroke:var(--sky-line);stroke-width:1;opacity:.5}.temporal-bridge{fill:none;stroke:var(--sky-accent);stroke-width:1;opacity:.16}.temporal-bridge[data-related]{stroke:var(--sky-star);stroke-width:3;opacity:1}.repository[data-related] .temporal-birth,.repository[data-related] .star{stroke:var(--sky-foreground);stroke-width:2}[data-filtered]{display:none}.repository:focus{outline:2px solid var(--sky-accent)}[data-interactive-selection] .repository:not([data-related]){opacity:.25!important}
${layers.css}${options.theme === "auto" && !options.visualTheme ? "@media(prefers-color-scheme:dark){svg{--sky-background:#080e20;--sky-foreground:#e6edff;--sky-accent:#9ab9ff;--sky-line:#596f98;--sky-star:#f6d99b}}" : ""}${escape(options.visualStyle ? visualCSS(options.visualStyle) : "")}${escape(options.css || "")}${escape(options.customCSS || "")}</style>${layers.backdrop}<text x="35" y="32" fill="var(--sky-foreground)" font-size="21">${escape(options.title || scene.metadata.account)} · Project history</text>${stack.reduced ? '<text x="35" y="55" fill="var(--sky-accent)" font-size="13">Small format · latest three selected years</text>' : ""}${layers.world}<g style="${layerStyle("connections")}">${bridges}</g>${planes}<g style="${layerStyle("annotations")}">${(scene.annotations || []).map((note) => `<text x="${note.x}" y="${note.y}" fill="var(--sky-foreground)">${escape(note.text)}</text>`).join("")}</g>${layers.credit}</svg>`;
}
