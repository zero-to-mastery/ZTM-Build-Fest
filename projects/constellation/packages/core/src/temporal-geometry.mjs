// Pure composition of Rust-generated identity coordinates. This factory is also
// embedded in offline HTML, so static rendering, camera moves and inverse picking
// use exactly the same world/camera math without invoking layout.
export function createTemporalGeometryMath() {
  const shapes = ['stack', 'cylinder', 'cone', 'sphere', 'dome', 'hourglass', 'helix'];
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const vector = (value, max) => object(value) && Object.keys(value).length === 3 && ['x', 'y', 'z'].every(key => Number.isFinite(value[key]) && Math.abs(value[key]) <= max);
  function options(value = {}) {
    if (!object(value)) throw new Error('temporalGeometry must be an object.');
    const radius = value.radius ?? 320;
    const defaults = { shape: 'stack', radius, depth: radius * (value.shape === 'dome' ? 1 : 2), startRadius: radius, endRadius: radius * .3, waist: .28, twist: 0, surface: 'wireframe', orientation: { x: 0, y: 0, z: 0 }, lean: { x: 0, y: 0, z: 0 }, planeTilt: { x: 0, y: 0, z: 0 } };
    if (Object.keys(value).some(key => !Object.hasOwn(defaults, key))) throw new Error('Unknown temporalGeometry field.');
    const result = { ...defaults, ...value };
    if (!shapes.includes(result.shape) || !['off', 'wireframe', 'translucent'].includes(result.surface)) throw new Error('Invalid temporal form or surface.');
    for (const [key, min, max] of [['radius', 80, 600], ['depth', 80, 1600], ['startRadius', 40, 600], ['endRadius', 40, 600], ['waist', .1, 1], ['twist', -720, 720]]) if (!Number.isFinite(result[key]) || result[key] < min || result[key] > max) throw new Error(`Invalid temporalGeometry.${key}.`);
    if (!vector(result.orientation, 180) || !vector(result.lean, 600) || !vector(result.planeTilt, 60)) throw new Error('Invalid temporal orientation, lean or plane tilt.');
    return JSON.parse(JSON.stringify(result));
  }
  const rotate = (p, angles, inverse = false) => {
    let { x, y, z } = p;
    for (const axis of inverse ? ['z', 'y', 'x'] : ['x', 'y', 'z']) {
      const angle = angles[axis] * Math.PI / 180 * (inverse ? -1 : 1), c = Math.cos(angle), s = Math.sin(angle);
      if (axis === 'x') [y, z] = [y * c - z * s, y * s + z * c];
      if (axis === 'y') [x, z] = [x * c + z * s, -x * s + z * c];
      if (axis === 'z') [x, y] = [x * c - y * s, x * s + y * c];
    }
    return { x, y, z };
  };
  function section(profile, t, separation = 1) {
    const u = 1 - 2 * t;
    let radius = profile.radius;
    if (profile.shape === 'cone') radius = profile.startRadius + (profile.endRadius - profile.startRadius) * t;
    if (profile.shape === 'sphere') radius *= Math.sqrt(Math.max(0, 1 - u * u));
    if (profile.shape === 'dome') radius *= Math.sqrt(Math.max(0, 1 - t * t));
    if (profile.shape === 'hourglass') radius *= profile.waist + (1 - profile.waist) * Math.abs(u);
    return { radius, center: { x: profile.lean.x * (t - .5), y: profile.lean.y * (t - .5), z: (u * profile.depth / 2 + profile.lean.z * (t - .5)) * separation }, rotation: { x: profile.planeTilt.x * t, y: profile.planeTilt.y * t, z: profile.planeTilt.z * t + profile.twist * t }, t };
  }
  function plane(profile, index, count, separation = 1) {
    // Sample curved forms at band centers: projects never collapse at a pole.
    const t = ['sphere', 'dome'].includes(profile.shape) ? (index + .5) / count : count === 1 ? .5 : index / (count - 1);
    return section(profile, t, separation);
  }
  function world(local, plane, profile, outerRadius) {
    const p = rotate({ x: (local.x - 450) * 172 / 368 / outerRadius * plane.radius, y: (local.y - 270) * 172 / 192 / outerRadius * plane.radius, z: 0 }, plane.rotation);
    return rotate({ x: p.x + plane.center.x, y: p.y + plane.center.y, z: p.z + plane.center.z }, profile.orientation);
  }
  function camera(profile, settings, view = {}) {
    const angles = { x: Math.acos(view.tilt ?? settings.tilt) * 180 / Math.PI, y: -12 + (view.rotation ?? 0) * 42, z: 0 };
    // Fixed conservative framing avoids resize/fit feedback during dragging.
    const extent = Math.max(profile.radius, profile.startRadius, profile.endRadius) + profile.depth + Math.hypot(...Object.values(profile.lean)) + 100;
    return { angles, distance: extent * 3, strength: .35 + settings.perspective * .65, centerX: 600, centerY: 510 };
  }
  function project(point, camera) {
    const p = rotate(point, camera.angles), scale = camera.distance / (camera.distance - p.z * camera.strength);
    return { x: camera.centerX + p.x * scale, y: camera.centerY + p.y * scale, depth: p.z, scale };
  }
  function projector(plane, profile, outerRadius, camera) {
    const origin = rotate(world({ x: 450, y: 270 }, plane, profile, outerRadius), camera.angles);
    const px = rotate(world({ x: 451, y: 270 }, plane, profile, outerRadius), camera.angles), py = rotate(world({ x: 450, y: 271 }, plane, profile, outerRadius), camera.angles);
    const ax = { x: px.x - origin.x, y: px.y - origin.y, z: px.z - origin.z }, ay = { x: py.x - origin.x, y: py.y - origin.y, z: py.z - origin.z };
    return local => {
      const x = local.x - 450, y = local.y - 270;
      const cx = origin.x + ax.x * x + ay.x * y, cy = origin.y + ax.y * x + ay.y * y, depth = origin.z + ax.z * x + ay.z * y;
      const scale = camera.distance / (camera.distance - depth * camera.strength);
      return { x: camera.centerX + cx * scale, y: camera.centerY + cy * scale, depth, scale };
    };
  }
  function unproject(screen, plane, profile, outerRadius, camera) {
    const originWorld = world({ x: 450, y: 270 }, plane, profile, outerRadius);
    const xWorld = world({ x: 451, y: 270 }, plane, profile, outerRadius), yWorld = world({ x: 450, y: 271 }, plane, profile, outerRadius);
    const o = rotate(originWorld, camera.angles), px = rotate(xWorld, camera.angles), py = rotate(yWorld, camera.angles);
    const ax = { x: px.x - o.x, y: px.y - o.y, z: px.z - o.z }, ay = { x: py.x - o.x, y: py.y - o.y, z: py.z - o.z };
    const sx = screen.x - camera.centerX, sy = screen.y - camera.centerY, k = camera.strength / camera.distance;
    const a = ax.x + sx * k * ax.z, b = ay.x + sx * k * ay.z, c = ax.y + sy * k * ax.z, d = ay.y + sy * k * ay.z;
    const ex = sx * (1 - k * o.z) - o.x, ey = sy * (1 - k * o.z) - o.y, det = a * d - b * c;
    if (Math.abs(det) < 1e-8) return null; // Edge-on cross-sections cannot be picked reliably.
    return { x: 450 + (ex * d - b * ey) / det, y: 270 + (a * ey - ex * c) / det };
  }
  return { shapes, options, section, plane, world, camera, project, projector, unproject };
}
export const temporalGeometryMath = createTemporalGeometryMath();

export function validateRingPlacements(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 2048) throw new Error('Invalid ringPlacements.');
  for (const [id, placement] of Object.entries(value)) if (!id || !placement || Object.keys(placement).some(key => !['ring', 'point'].includes(key)) || !Number.isInteger(placement.ring) || placement.ring < 0 || placement.ring > 3 || !Number.isInteger(placement.point) || placement.point < 0 || placement.point > 511) throw new Error('Ring placements require ring 0–3 and point 0–511.');
  return value;
}
