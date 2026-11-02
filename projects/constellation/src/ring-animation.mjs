export function ringAnimationOptions(value = {}) {
  const { enabled = false, linked = false, speeds = [1, 1, 1, 1], directions = ['clockwise', 'clockwise', 'clockwise', 'clockwise'] } = value;
  if (typeof enabled !== 'boolean' || typeof linked !== 'boolean' || !Array.isArray(speeds) || speeds.length !== 4 || speeds.some(speed => !Number.isFinite(speed) || speed < 0 || speed > 6) || !Array.isArray(directions) || directions.length !== 4 || directions.some(direction => !['clockwise', 'counterclockwise'].includes(direction))) throw new Error('Invalid ringAnimation settings. Use four speeds (0–6 RPM) and four clockwise/counterclockwise directions.');
  const { modes = ['spin', 'spin', 'spin', 'spin'], amplitudes = [30, 30, 30, 30], easing = ['linear', 'linear', 'linear', 'linear'] } = value;
  if (!Array.isArray(modes) || modes.length !== 4 || modes.some(mode => !['spin', 'sway'].includes(mode)) || !Array.isArray(amplitudes) || amplitudes.length !== 4 || amplitudes.some(angle => !Number.isFinite(angle) || angle < 0 || angle > 180) || !Array.isArray(easing) || easing.length !== 4 || easing.some(ease => !['linear', 'smooth'].includes(ease))) throw new Error('Invalid ring animation motion settings.');
  return { enabled, linked, modes: modes.map((mode, i) => linked ? modes[0] : mode), amplitudes: amplitudes.map((angle, i) => linked ? amplitudes[0] : angle), easing: easing.map((ease, i) => linked ? easing[0] : ease), speeds: speeds.map((speed, i) => linked ? speeds[0] : speed), directions: directions.map((direction, i) => linked ? directions[0] : direction) };
}

export function floatingAnimationOptions(value = {}) {
  const { enabled = false, mode = 'drift', amplitude = 10, duration = 12 } = value;
  if (typeof enabled !== 'boolean' || !['drift', 'bob', 'orbit'].includes(mode) || !Number.isFinite(amplitude) || amplitude < 0 || amplitude > 24 || !Number.isFinite(duration) || duration < 2 || duration > 60) throw new Error('Invalid floatingAnimation settings.');
  return { enabled, mode, amplitude, duration };
}

// Native SVG animation also runs when the exported image is embedded in a README.
// spreadX: the orbits' horizontal reach (368 wide; equal to spread when round).
export function animateRingSVG(svg, settings, geometry, stars, center, spread, escape, floating = floatingAnimationOptions(), anchors = [], spreadX = 368) {
  if ((!settings.enabled && !floating.enabled && !svg.includes('data-perspective="true"')) || !geometry) return svg;
  const radii = [0, 1, 2, 3].map(i => geometry[2 + i * 22]);
  const ringAt = (x, y) => {
    const radius = Math.hypot(x, y);
    return radii.findIndex(r => Math.abs(r - radius) < .2);
  };
  const ringAngle = (ring, progress) => {
    const direction = settings.directions[ring] === 'clockwise' ? 1 : -1;
    const t = settings.easing[ring] === 'smooth' ? (1 - Math.cos(Math.PI * progress)) / 2 : progress;
    return direction * (settings.modes[ring] === 'sway' ? Math.sin(2 * Math.PI * t) * settings.amplitudes[ring] * Math.PI / 180 : t * 2 * Math.PI);
  };
  const labelBounds = [...svg.matchAll(/<text class="repo-label"[^>]* x="([\d.-]+)" y="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)];
  const limits = new Map(stars.map(star => {
    const label = labelBounds.find(match => match[0].includes(`data-repo="${escape(star.repo.full_name)}"`));
    const half = label ? label[3].length * 4 : 0;
    return [`${star.x.toFixed(1)}:${star.y.toFixed(1)}`, { x: Math.max(0, Math.min(star.x - 32, 868 - star.x, label ? +label[1] - half - 4 : 900, label ? 896 - +label[1] - half : 900)), y: Math.max(0, Math.min(star.y - 28, (spread === 88 ? 220 : 500) - star.y, label ? +label[2] - 20 : 560, label ? (spread === 88 ? 250 : 530) - +label[2] : 560)) }];
  }));
  const motion = (x, y, local = false) => {
    const dx = local ? x - 240 : (x - 450) * 172 / spreadX;
    const dy = local ? y - 240 : (y - center) * 172 / spread;
    const attached = local || anchors.some(point => Math.hypot(point.x - x, point.y - y) < .2);
    const ring = attached ? ringAt(dx, dy) : -1;
    if (ring < 0) {
      if (local || !floating.enabled || !floating.amplitude) return null;
      const room = limits.get(`${x.toFixed(1)}:${y.toFixed(1)}`) || { x: 0, y: 0 };
      const ax = Math.min(floating.amplitude, room.x / 2), ay = Math.min(floating.amplitude, room.y / 2);
      const phase = ((Math.round(x * 10) * 31 + Math.round(y * 10)) % 628) / 100;
      return { duration: floating.duration, values: Array.from({ length: 73 }, (_, i) => {
        const t = i * Math.PI * 2 / 72;
        const ox = floating.mode === 'bob' ? 0 : floating.mode === 'orbit' ? Math.cos(t + phase) - Math.cos(phase) : Math.sin(t + phase) - Math.sin(phase);
        const oy = Math.sin((floating.mode === 'drift' ? 2 : 1) * t + phase) - Math.sin(phase);
        return [x + ax * ox, y + ay * oy];
      }) };
    }
    if (!settings.enabled || !settings.speeds[ring]) return null;
    const values = Array.from({ length: 73 }, (_, i) => {
      const angle = ringAngle(ring, i / 72), cos = Math.cos(angle), sin = Math.sin(angle);
      return [local ? 240 + dx * cos - dy * sin : 450 + (dx * cos - dy * sin) * spreadX / 172,
        local ? 240 + dx * sin + dy * cos : center + (dx * sin + dy * cos) * spread / 172];
    });
    return { values, duration: 60 / settings.speeds[ring] };
  };
  const animation = (name, movement, axis, offset = 0) => movement ? `<animate attributeName="${name}" values="${movement.values.map(p => (p[axis] + offset).toFixed(2)).join(';')}" dur="${movement.duration}s" repeatCount="indefinite"/>` : '';
  const byId = new Map(stars.map(star => [escape(star.repo.full_name), { ...star, motion: motion(star.x, star.y) }]));
  const coordinate = (tag, name) => Number(tag.match(new RegExp(` ${name}="([^"]+)"`))?.[1]);
  // Showcase roles add class tokens; their nodes still follow the same anchors.
  let animated = svg.replace(/<g class="repository(?: [^"]*)?"[^>]*>[\s\S]*?<\/g>/g, group => {
    const id = group.match(/data-repo="([^"]+)"/)?.[1], node = byId.get(id);
    if (!node?.motion) return group;
    return group.replace(/<svg class="activity-asteroid-field"[^>]*>/g, field => field + animation('x', node.motion, 0) + animation('y', node.motion, 1))
      .replace(/<circle\b[^>]*\/>/g, circle => circle.slice(0, -2) + '>' + animation('cx', node.motion, 0) + animation('cy', node.motion, 1) + '</circle>')
      .replace(/<path class="activity-comet[^>]*\/>/g, path => path.slice(0, -2) + `><animateTransform attributeName="transform" type="translate" values="${node.motion.values.map(([x, y]) => `${(x - node.x).toFixed(2)} ${(y - node.y).toFixed(2)}`).join(';')}" dur="${node.motion.duration}s" repeatCount="indefinite"/></path>`);
  }).replace(/<text class="repo-label"[^>]*>[\s\S]*?<\/text>/g, label => {
    const id = label.match(/data-repo="([^"]+)"/)?.[1], node = byId.get(id);
    return !node?.motion ? label : label.replace('</text>', animation('x', node.motion, 0, coordinate(label, 'x') - node.x) + animation('y', node.motion, 1, coordinate(label, 'y') - node.y) + '</text>');
  }).replace(/<circle class="identity-point"[^>]*\/>/g, point => {
    const movement = motion(coordinate(point, 'cx'), coordinate(point, 'cy'), true);
    return point.slice(0, -2) + '>' + animation('cx', movement, 0) + animation('cy', movement, 1) + '</circle>';
  }).replace(/<circle class="identity-arc"[^>]*\/>/g, arc => {
    const ring = coordinate(arc, 'data-ring'), speed = settings.speeds[ring];
    if (!settings.enabled || !speed) return arc;
    const direction = settings.directions[ring] === 'clockwise' ? 360 : -360;
    const timing = settings.modes[ring] === 'spin' && settings.easing[ring] === 'linear' ? `from="0 240 240" to="${direction} 240 240"` : `values="${Array.from({ length: 73 }, (_, i) => `${(ringAngle(ring, i / 72) * 180 / Math.PI).toFixed(3)} 240 240`).join(';')}"`;
    return arc.slice(0, -2) + `><animateTransform attributeName="transform" type="rotate" ${timing} dur="${60 / speed}s" additive="sum" repeatCount="indefinite"/></circle>`;
  }).replace(/<path class="shared-language"[^>]*>[\s\S]*?<\/path>/g, path => {
    const from = byId.get(path.match(/data-from="([^"]+)"/)?.[1]), to = byId.get(path.match(/data-to="([^"]+)"/)?.[1]);
    if (!from || !to) return path;
    if (!from.motion && !to.motion) return path;
    const coordinates = path.match(/ d="M([\d.-]+) ([\d.-]+)Q([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)"/);
    if (!coordinates) return path;
    const [x1, y1, cx, cy, x2, y2] = coordinates.slice(1).map(Number);
    const dx = x2 - x1, dy = y2 - y1, lengthSquared = dx * dx + dy * dy;
    // Express the control point along and perpendicular to the chord. Each
    // endpoint contributes independently, preserving different ring periods.
    const along = lengthSquared ? ((cx - x1) * dx + (cy - y1) * dy) / lengthSquared : .5;
    const bend = lengthSquared ? ((cy - y1) * dx - (cx - x1) * dy) / lengthSquared : 0;
    const curveMotion = (node, start) => {
      if (!node.motion) return '';
      const values = node.motion.values.map(([x, y]) => {
        const ox = x - node.x, oy = y - node.y;
        const weight = start ? 1 - along : along, normal = start ? -bend : bend;
        const control = `${(weight * ox - normal * oy).toFixed(2)} ${(weight * oy + normal * ox).toFixed(2)}`;
        const endpoint = `${ox.toFixed(2)} ${oy.toFixed(2)}`;
        return `M${start ? endpoint : '0 0'}Q${control} ${start ? '0 0' : endpoint}`;
      });
      return `<animate attributeName="d" additive="sum" values="${values.join(';')}" dur="${node.motion.duration}s" repeatCount="indefinite"/>`;
    };
    return path.replace('</path>', curveMotion(from, true) + curveMotion(to, false) + '</path>');
  }).replace(/<g class="bridges">[\s\S]*?<\/g>/g, group => group.replace(/<path d="M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)">([\s\S]*?)<\/path>/g, (_, x1, y1, x2, y2, title) => {
    const from = motion(Number(x1), Number(y1)), to = motion(Number(x2), Number(y2));
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${title}${animation('x1', from, 0)}${animation('y1', from, 1)}${animation('x2', to, 0)}${animation('y2', to, 1)}</line>`;
  })).replace(/<linearGradient\b[^>]*>[\s\S]*?<\/linearGradient>/g, gradient => {
    const from = motion(coordinate(gradient, 'x1'), coordinate(gradient, 'y1')), to = motion(coordinate(gradient, 'x2'), coordinate(gradient, 'y2'));
    return gradient.replace('</linearGradient>', animation('x1', from, 0) + animation('y1', from, 1) + animation('x2', to, 0) + animation('y2', to, 1) + '</linearGradient>');
  });
  // The fallback is an image rather than duplicated graph nodes or SVG IDs.
  const opening = animated.slice(0, animated.indexOf('>') + 1);
  const content = animated.slice(opening.length, animated.lastIndexOf('</svg>'));
  // The picture keeps the same viewBox, so it must cover exactly the visible
  // area. A fitted view rarely starts at 0 0; pinning the picture to the
  // origin would show reduced-motion visitors a zoomed, cropped map.
  const view = opening.match(/ viewBox="([^"]+)"/)?.[1].trim().split(/[\s,]+/).map(Number);
  const [x, y, width, height] = view?.length === 4 && view.every(Number.isFinite) && view[2] > 0 && view[3] > 0
    ? view : [0, 0, 900, spread === 88 ? 280 : 560];
  const place = `${x ? ` x="${x}"` : ''}${y ? ` y="${y}"` : ''} width="${width}" height="${height}"`;
  return `${opening}<style>.ring-motion-still{display:none}@media(prefers-reduced-motion:reduce){.ring-motion-active{display:none}.ring-motion-still{display:inline}}</style><g class="ring-motion-active">${content}</g><image class="ring-motion-still"${place} href="data:image/svg+xml,${escape(encodeURIComponent(svg.replace(/<animateTransform data-perspective="true"[^>]*\/>/g, '')))}"/></svg>`;
}
