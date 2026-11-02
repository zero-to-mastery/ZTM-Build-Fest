// Motion levels for the Studio. Each writes the engine's existing animation
// options; Fine-tune still exposes every one of them individually. Anyone who
// prefers reduced motion sees a still map whatever the level.

const DIRECTIONS = ['clockwise', 'counterclockwise', 'clockwise', 'counterclockwise'];
const rings = (speeds) => ({
  enabled: true, linked: false, speeds, directions: DIRECTIONS,
  modes: ['spin', 'spin', 'spin', 'spin'], amplitudes: [30, 30, 30, 30], easing: ['linear', 'linear', 'linear', 'linear'],
});

export const MOTION_LEVELS = {
  still: { animate: false, starlightAnimate: false, twinkle: false, ringAnimation: null, floatingAnimation: null },
  // Twinkling stars and slowly turning orbit rings.
  gentle: { animate: true, starlightAnimate: true, twinkle: true, ringAnimation: rings([0.25, 0.5, 0.35, 0.75]), floatingAnimation: null },
  // Faster rings, and every star drifts a little.
  lively: { animate: true, starlightAnimate: true, twinkle: true, ringAnimation: rings([1, 1.5, 1, 2]), floatingAnimation: { enabled: true, mode: 'drift', amplitude: 6, duration: 10 } },
};

export function applyMotion(options, level) {
  const motion = MOTION_LEVELS[level];
  if (!motion) throw new Error('Motion must be still, gentle or lively.');
  return {
    ...options,
    animate: motion.animate,
    starlightAnimate: motion.starlightAnimate,
    starfield: { ...(options.starfield || {}), twinkle: motion.twinkle },
    ringAnimation: motion.ringAnimation ? structuredClone(motion.ringAnimation) : { ...(options.ringAnimation || {}), enabled: false },
    floatingAnimation: motion.floatingAnimation ? { ...motion.floatingAnimation } : { ...(options.floatingAnimation || {}), enabled: false },
    perspective: { ...(options.perspective || {}), animate: level !== 'still' && Boolean(options.perspective?.animate) },
  };
}

/** The level that best describes the current options (Fine-tune can mix them freely). */
export function motionLevel(options) {
  if (options.animate === false) return 'still';
  if (options.floatingAnimation?.enabled) return 'lively';
  if (options.ringAnimation?.enabled || options.starlightAnimate !== false) return 'gentle';
  return 'still';
}

/**
 * True when stars themselves move, so they can't be dragged: floating stars,
 * or spinning rings that stars are attached to. Rings spinning behind a Galaxy
 * or Scatter layout are only decoration.
 */
export function starsMove(options) {
  if (options.animate === false) return false;
  const attached = options.arrangement === 'rings' || options.snapToRings === true;
  return Boolean(options.floatingAnimation?.enabled || (options.ringAnimation?.enabled && attached));
}
