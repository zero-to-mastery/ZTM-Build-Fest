import {
  temporalGeometryMath,
  validateRingPlacements,
} from "./temporal-geometry.mjs";
export const TEMPORAL_STACK_VERSION = 2;
export const MAX_TEMPORAL_LAYERS = 20;
export const MAX_TEMPORAL_NODES = 4096;
export function temporalStackOptions(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("temporalStack must be an object.");
  const defaults = {
    enabled: false,
    axis: "year",
    yearStep: 1,
    depthGap: 120,
    perspective: 0.8,
    tilt: 0.35,
    scaleFalloff: 0.035,
    connections: "same-node",
    innerArrangement: "solar-system",
  };
  if (
    Object.keys(value).some(
      (key) =>
        ![
          ...Object.keys(defaults),
          "yearStart",
          "yearEnd",
          "layerValues",
        ].includes(key),
    )
  )
    throw new Error("Unknown temporalStack field.");
  const result = { ...defaults, ...value };
  if (!["year", "language", "repository", "topic"].includes(result.axis))
    throw Error("Invalid temporalStack.axis.");
  if (
    result.layerValues !== undefined &&
    (!Array.isArray(result.layerValues) ||
      !result.layerValues.length ||
      result.layerValues.length > 20 ||
      new Set(result.layerValues).size !== result.layerValues.length ||
      result.layerValues.some(
        (value) =>
          typeof value !== "string" || !value.length || value.length > 200,
      ))
  )
    throw Error("Invalid temporalStack.layerValues.");
  if (
    typeof result.enabled !== "boolean" ||
    !["same-node", "none"].includes(result.connections) ||
    !["solar-system", "galaxy", "rings", "profile"].includes(
      result.innerArrangement,
    )
  )
    throw new Error("Invalid temporalStack settings.");
  for (const [key, min, max, integer] of [
    ["yearStart", 1970, 9998, true],
    ["yearEnd", 1970, 9998, true],
    ["yearStep", 1, 100, true],
    ["depthGap", 20, 240],
    ["perspective", 0, 1],
    ["tilt", 0.15, 0.85],
    ["scaleFalloff", 0, 0.08],
  ]) {
    if (
      result[key] !== undefined &&
      (!Number.isFinite(result[key]) ||
        result[key] < min ||
        result[key] > max ||
        (integer && !Number.isInteger(result[key])))
    )
      throw new Error(`Invalid temporalStack.${key}.`);
  }
  if (result.yearStart > result.yearEnd)
    throw new Error("temporalStack yearStart must not exceed yearEnd.");
  return result;
}

// Affine projection of each local XY plane into temporal depth. Shared verbatim
// by static SVG and the offline camera; no layout or relationship work here.
export function projectTemporalPlane(depth, settings, view = {}) {
  const separation = view.depth ?? 1,
    yaw = view.rotation ?? 0,
    tilt = view.tilt ?? settings.tilt;
  const d = -depth,
    scale = 1 / (1 + d * settings.scaleFalloff * settings.perspective);
  const a = scale,
    b = yaw * 0.18 * scale,
    c = (0.18 + yaw * 0.25) * scale,
    e = tilt * scale;
  const x = 450 + d * (18 + yaw * 35) * settings.perspective;
  const y =
    100 + 270 * tilt + 80 * Math.abs(yaw) + d * settings.depthGap * separation;
  return [a, b, c, e, x - a * 450 - c * 270, y - b * 450 - e * 270];
}
export function temporalBridges(layers, frames, connections) {
  if (connections === "none") return [];
  const result = [],
    previous = new Map();
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    for (const node of frames.get(layer.frameId).nodes) {
      const newer = previous.get(node.id);
      if (newer && (layer.axis || newer.index === i - 1))
        result.push(
          layer.axis
            ? {
                type: "dimensional",
                nodeId: node.id,
                fromLayer: layer.id,
                toLayer: newer.layer.id,
              }
            : {
                type: "temporal",
                nodeId: node.id,
                fromYear: layer.year,
                toYear: newer.layer.year,
              },
        );
      previous.set(node.id, { layer, index: i });
    }
  }
  return result;
}
export function validateTemporalStack(scene, validateFrame) {
  const stack = scene.temporalStack;
  const fail = () => {
    throw new Error("Scene: invalid temporalStack attachment.");
  };
  if (
    !stack ||
    ![1, 2].includes(stack.version) ||
    !["year", "language", "repository", "topic"].includes(stack.axis) ||
    (stack.axis === "year"
      ? !scene.timeline || stack.version !== 1 || stack.frames !== undefined
      : stack.version !== 2 ||
        !Array.isArray(stack.frames) ||
        stack.frames.length !== stack.layers?.length ||
        !stack.geometry ||
        scene.timeline !== undefined) ||
    !Array.isArray(stack.layers) ||
    !stack.layers.length ||
    stack.layers.length > MAX_TEMPORAL_LAYERS ||
    !Array.isArray(stack.bridges)
  )
    fail();
  const settings = temporalStackOptions(stack.settings);
  if (
    Object.keys(settings).some((key) =>
      key === "axis" && stack.version === 1 && stack.settings.axis === undefined
        ? false
        : stack.settings[key] !== settings[key],
    ) ||
    settings.axis !== stack.axis ||
    typeof stack.reduced !== "boolean"
  )
    fail();
  const frameList = stack.frames || scene.timeline.frames;
  if (stack.frames)
    for (const frame of stack.frames) {
      if (
        !frame ||
        typeof frame.id !== "string" ||
        frame.evidence !== "current-membership" ||
        frame.date !== undefined ||
        !frame.scene ||
        frame.scene.temporalStack ||
        frame.scene.timeline ||
        frame.scene.story ||
        frame.scene.hierarchy
      )
        fail();
      validateFrame(frame.scene);
    }
  const frames = new Map(frameList.map((frame) => [frame.id, frame.scene]));
  if (frames.size !== frameList.length) fail();
  let previous = Infinity;
  const ids = new Set();
  const anchors = new Map();
  let total = 0;
  for (const [index, layer] of stack.layers.entries()) {
    if (!layer || layer.depth !== -index || !frames.has(layer.frameId)) fail();
    if (stack.axis !== "year") {
      if (
        layer.axis !== stack.axis ||
        typeof layer.value !== "string" ||
        !layer.value.length ||
        layer.value.length > 200 ||
        layer.label !== layer.value ||
        layer.id !== stack.axis + ":" + encodeURIComponent(layer.value) ||
        layer.frameId !== layer.id ||
        layer.evidence !== "current-membership" ||
        ids.has(layer.id) ||
        layer.year !== undefined
      )
        fail();
      ids.add(layer.id);
    } else if (
      !Number.isInteger(layer.year) ||
      layer.year >= previous ||
      layer.depth !== -index ||
      !frames.has(layer.frameId) ||
      new Date(layer.frameId).getUTCFullYear() !== layer.year
    )
      fail();
    previous = layer.year;
    total += frames.get(layer.frameId).nodes.length;
    for (const node of frames.get(layer.frameId).nodes) {
      const anchor = anchors.get(node.id);
      if (
        settings.innerArrangement !== "profile" &&
        anchor &&
        (anchor.x !== node.geometry.x || anchor.y !== node.geometry.y)
      )
        fail();
      anchors.set(node.id, node.geometry);
    }
  }
  if (anchors.size > 2048 || total > MAX_TEMPORAL_NODES) fail();
  if (stack.geometry !== undefined) {
    const g = stack.geometry;
    if (
      !g ||
      g.version !== 1 ||
      !Array.isArray(g.radii) ||
      g.radii.length !== 4 ||
      g.radii.some(
        (r, i) =>
          !Number.isFinite(r) ||
          r < 60 ||
          r > 180 ||
          (i > 0 && r <= g.radii[i - 1]),
      ) ||
      g.outerRadius !== g.radii[3] ||
      !Array.isArray(g.points) ||
      g.points.length < 24 ||
      g.points.length > 2048
    )
      fail();
    const profile = temporalGeometryMath.options(g.profile);
    if (
      Object.keys(profile).some((key) =>
        typeof profile[key] === "object"
          ? ["x", "y", "z"].some(
              (axis) => profile[key][axis] !== g.profile[key]?.[axis],
            )
          : profile[key] !== g.profile[key],
      )
    )
      fail();
    const points = new Map();
    for (const point of g.points) {
      if (
        !point ||
        !Number.isInteger(point.ring) ||
        point.ring < 0 ||
        point.ring > 3 ||
        !Number.isInteger(point.point) ||
        point.point < 0 ||
        point.point > 511 ||
        ![point.x, point.y, point.angle].every(Number.isFinite)
      )
        fail();
      const key = `${point.ring}:${point.point}`;
      if (
        points.has(key) ||
        Math.abs(
          Math.hypot(
            ((point.x - 450) * 172) / 368,
            ((point.y - 270) * 172) / 192,
          ) - g.radii[point.ring],
        ) > 0.01
      )
        fail();
      points.set(key, point);
    }
    validateRingPlacements(g.placements);
    const occupied = new Set();
    const allAnchors = new Map(
      frameList.flatMap((frame) =>
        frame.scene.nodes.map((node) => [node.id, node.geometry]),
      ),
    );
    for (const [id, p] of Object.entries(g.placements)) {
      const key = `${p.ring}:${p.point}`,
        point = points.get(key),
        anchor = allAnchors.get(id);
      if (
        !point ||
        !anchor ||
        occupied.has(key) ||
        point.x !== anchor.x ||
        point.y !== anchor.y
      )
        fail();
      occupied.add(key);
    }
  }
  const expected = temporalBridges(
    stack.layers,
    frames,
    stack.settings.connections,
  );
  if (
    expected.length !== stack.bridges.length ||
    expected.some(
      (edge, index) =>
        !stack.bridges[index] ||
        Object.keys(edge).some(
          (key) => edge[key] !== stack.bridges[index][key],
        ),
    )
  )
    fail();
}
