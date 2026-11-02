// Pure, deterministic motion in local ring coordinates, before world projection.
// Embedded verbatim in offline HTML. No clock or executable config is stored.
export function temporalMotion(options, seconds = 0) {
  const enabled = options.animate !== false, rings = options.ringAnimation || {}, floating = options.floatingAnimation || {}, perspective = options.perspective || {};
  const angle = ring => {
    const i = rings.linked ? 0 : ring, speed = rings.speeds?.[i] ?? 1;
    if (!enabled || !rings.enabled || !speed) return 0;
    const progress = (seconds * speed / 60) % 1;
    const phase = rings.easing?.[i] === 'smooth' ? (1 - Math.cos(progress * Math.PI * 2)) / 2 : progress;
    const direction = rings.directions?.[i] === 'counterclockwise' ? -1 : 1;
    return direction * (rings.modes?.[i] === 'sway' ? Math.sin(phase * Math.PI * 2) * (rings.amplitudes?.[i] ?? 30) * Math.PI / 180 : phase * Math.PI * 2);
  };
  const local = (point, placement) => {
    if (!enabled || !seconds) return point;
    if (placement) {
      const a = angle(placement.ring), x = (point.x - 450) * 172 / 368, y = (point.y - 270) * 172 / 192;
      return { x: 450 + (x * Math.cos(a) - y * Math.sin(a)) * 368 / 172, y: 270 + (x * Math.sin(a) + y * Math.cos(a)) * 192 / 172 };
    }
    if (!floating.enabled) return point;
    const phase = ((Math.round(point.x * 10) * 31 + Math.round(point.y * 10)) % 628) / 100;
    const t = seconds * Math.PI * 2 / (floating.duration ?? 12), amplitude = floating.amplitude ?? 10;
    const x = floating.mode === 'bob' ? 0 : floating.mode === 'orbit' ? Math.cos(t + phase) - Math.cos(phase) : Math.sin(t + phase) - Math.sin(phase);
    const y = Math.sin((floating.mode === 'drift' ? 2 : 1) * t + phase) - Math.sin(phase);
    return { x: point.x + amplitude * x, y: point.y + amplitude * y };
  };
  const phase = seconds * Math.PI * 2 / (perspective.duration ?? 20);
  return { local, angle,
    camera: enabled && perspective.enabled && perspective.animate ? Math.sin(phase) * (perspective.range ?? 15) / 42 : 0,
    active: enabled && (rings.enabled && (rings.speeds || [1, 1, 1, 1]).some(speed => speed > 0) || floating.enabled && (floating.amplitude ?? 10) > 0 || perspective.enabled && perspective.animate && (perspective.range ?? 15) > 0 || options.history?.timeLapse?.enabled),
  };
}
