export const SEMANTIC_ZOOM_MODES = Object.freeze(['auto', 'groups', 'projects']);

// Scale is base viewBox width divided by current viewBox width. At 1, the
// complete original scene fits the initial camera. Enter and exit thresholds
// are deliberately separated by at least one ordinary 1.25x zoom step.
export const SEMANTIC_ZOOM_POLICY = Object.freeze({
  overviewToGroups: 0.82,
  groupsToOverview: 0.68,
  groupsToProjects: 1.8,
  projectsToGroups: 1.45,
});

export function resolveSemanticZoomMode(value, fallback = 'auto') {
  if (value === undefined || value === null) return fallback;
  if (SEMANTIC_ZOOM_MODES.includes(value.mode)) return value.mode;
  // Config v7 compatibility: the old disabled form always rendered projects;
  // the old enabled form rendered its requested grouped/project level.
  if (typeof value.enabled === 'boolean' && ['overview', 'groups', 'projects'].includes(value.level)) {
    return value.enabled && value.level !== 'projects' ? 'groups' : 'projects';
  }
  return fallback;
}

export function createSemanticZoomState(initial = 'groups', policy = SEMANTIC_ZOOM_POLICY) {
  if (!['overview', 'groups', 'projects'].includes(initial)) throw new Error('Invalid initial semantic level.');
  let level = initial;
  return {
    get level() { return level; },
    update(scale, { allowProjects = true } = {}) {
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('Semantic zoom scale must be a finite positive number.');
      const previous = level, transitions = [];
      for (let step = 0; step < 3; step++) {
        const next = level === 'overview' && scale >= policy.overviewToGroups
          ? 'groups'
          : level === 'groups' && scale <= policy.groupsToOverview
            ? 'overview'
            : level === 'groups' && allowProjects && scale >= policy.groupsToProjects
              ? 'projects'
              : level === 'projects' && scale <= policy.projectsToGroups
                ? 'groups'
                : level;
        if (next === level) break;
        transitions.push({ previous: level, current: next });
        level = next;
      }
      return { previous, current: level, changed: previous !== level, transitions };
    },
    set(value) {
      if (!['overview', 'groups', 'projects'].includes(value)) throw new Error('Invalid semantic level.');
      const previous = level; level = value;
      return { previous, current: level, changed: previous !== level, transitions: previous === level ? [] : [{ previous, current: level }] };
    },
  };
}
