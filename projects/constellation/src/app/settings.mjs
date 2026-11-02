// Every user-facing option, defined once. Panels show the essential ones,
// Fine-tune generates a form for the rest, and tests walk the whole list.
// Labels are plain language; engine vocabulary stays in `key` and docs.

import { visualThemes, themePalettes } from '../themes.mjs';
import { defaultVisualStyle, visualCSS } from '../visual-style.mjs';
import { defaultStarfield } from '../starfield.mjs';
import { applyMotion, motionLevel } from './motion.mjs';

export const GROUPS = [
  { id: 'look', label: 'Look', blurb: 'Colours, background and stars.' },
  { id: 'layout', label: 'Layout', blurb: 'How your projects are arranged and connected.' },
  { id: 'projects', label: 'Projects', blurb: 'Which projects appear.' },
  { id: 'details', label: 'Details', blurb: 'Sizes, names and motion.' },
  { id: 'output', label: 'Size and format', blurb: 'The shape of the exported image.' },
  { id: 'data', label: 'Data', blurb: 'Extra GitHub data. Some needs sign-in.' },
];

const get = (object, path) => path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);
function set(object, path, value) {
  const copy = structuredClone(object);
  const keys = path.split('.');
  let target = copy;
  for (const key of keys.slice(0, -1)) {
    target[key] = target[key] && typeof target[key] === 'object' ? { ...target[key] } : {};
    target = target[key];
  }
  if (value === undefined) delete target[keys.at(-1)];
  else target[keys.at(-1)] = value;
  return copy;
}

// A style block (lines, glow, labels) also carries a full light/dark palette,
// and the renderer draws it after the theme. So it must always hold the
// theme's own colours plus the visitor's, never the defaults.
function themedPalettes(options) {
  const theme = visualThemes[options.visualTheme];
  const base = theme ? themePalettes(theme) : defaultVisualStyle();
  const colors = options.colors || {};
  return { light: { ...base.light, ...colors }, dark: { ...base.dark, ...colors } };
}
const withVisualStyle = (options) => {
  const theme = visualThemes[options.visualTheme];
  const style = options.visualStyle || { ...defaultVisualStyle(), ...(theme ? { glow: theme.glow ?? 2, secondaryOpacity: theme.opacity ?? 0.13 } : {}) };
  return { ...options, visualStyle: { ...style, ...themedPalettes(options) } };
};
// After a theme or colour change, an existing style block follows the palette.
const refreshPalettes = (options) => (options.visualStyle ? withVisualStyle(options) : options);

/**
 * The CSS a configuration renders with: the style block, then the visitor's
 * own CSS. Kept in `css` too, so the CLI and the Action draw the same picture.
 */
export function composeCSS(options) {
  return [options.visualStyle ? visualCSS(options.visualStyle) : '', options.customCSS || ''].filter(Boolean).join('\n');
}
const withDerivedCSS = (options) => (options.visualStyle || options.customCSS !== undefined ? { ...options, css: composeCSS(options) } : options);

// The same self-contained rule the configuration schema enforces.
const UNSAFE_CSS = /(?:@import|url\s*\(|expression\s*\(|\\)/i;
const withStarfield = (options) => ({ ...options, starfield: { ...defaultStarfield, mode: 'classic', ...(options.starfield || {}) } });

/** Build a setting stored at `path` (dot notation). */
function field(id, path, spec) {
  const prepare = path.startsWith('visualStyle.') ? withVisualStyle : path.startsWith('starfield.') ? withStarfield : (o) => o;
  return {
    id,
    key: path,
    tier: 'more',
    read: (options) => {
      const value = get(options, path);
      if (value !== undefined) return value;
      if (path.startsWith('visualStyle.')) return get({ visualStyle: defaultVisualStyle() }, path);
      if (path.startsWith('starfield.')) return get({ starfield: { ...defaultStarfield, mode: 'classic' } }, path);
      return spec.fallback;
    },
    write: (options, value) => set(prepare(options), path, value),
    ...spec,
  };
}

const choice = (value, label, hint) => ({ value, label, ...(hint ? { hint } : {}) });

// A colour you haven't set shows the theme's own colour, not a made-up one.
const PALETTE_KEYS = ['background', 'foreground', 'accent', 'line', 'star'];
function colorField(id, key, spec) {
  const base = field(id, `colors.${key}`, { group: 'look', control: { type: 'color' }, ...spec });
  return {
    ...base,
    read: (options) => options.colors?.[key] ?? visualThemes[options.visualTheme]?.palette?.[PALETTE_KEYS.indexOf(key)],
    write: (options, value) => refreshPalettes(base.write(options, value)),
  };
}

const THEME_HINTS = {
  'deep-space': 'Violet glow on deep navy',
  'github-dark': 'Feels like GitHub at night',
  constellation: 'The original. Follows light or dark mode',
  mnix: 'See-through. Follows light or dark mode',
  terminal: 'Green on black, square stars',
  solarized: 'Calm, warm and low contrast',
  dracula: 'A purple night with pink accents',
  synthwave: 'Neon on violet',
  monochrome: 'Black and white, stars too',
  contribution: 'GitHub contribution greens',
  rustacean: 'Rust orange, hexagon stars',
  javascript: 'JavaScript yellow',
  chingu: 'Emerald, see-through',
  'code-the-dream': 'Navy and coral, see-through',
};
// Names that mean something to a newcomer.
const THEME_NAMES = { mnix: 'Adaptive' };
// Some themes only make sense with their own star colour.
const THEME_EXTRAS = { monochrome: { nodeColorMode: 'custom' } };
export const DEFAULT_THEME = 'deep-space';
// The default first; the hidden easter-egg theme stays out of the gallery.
export const THEME_CHOICES = Object.entries(visualThemes)
  .filter(([id]) => id !== 'sudo')
  .sort(([a], [b]) => Number(b === DEFAULT_THEME) - Number(a === DEFAULT_THEME))
  .map(([id, theme]) => choice(id, THEME_NAMES[id] || theme.label.replace(/\s*\(.*\)$/, ''), THEME_HINTS[id]));

export const LAYOUT_CHOICES = [
  choice('galaxy', 'Galaxy', 'Clusters by language'),
  choice('rings', 'Rings', 'Projects on your own orbit rings'),
  choice('solar-system', 'Solar system', 'Biggest projects become planets'),
  choice('orbital', 'Orbits', 'Projects circle the centre'),
  choice('force', 'Web', 'Related projects pull together'),
  choice('field', 'Scatter', 'An open, even spread'),
  choice('profile', 'Skills', 'Sorted by what kind of work it is'),
  choice('era-rings', 'Eras', 'Older projects further out'),
  choice('temporal-stack', 'Through time', 'One layer per year'),
];

export const SETTINGS = [
  // ---------------------------------------------------------------- Look
  {
    id: 'look.theme', key: 'visualTheme', group: 'look', tier: 'essential', label: 'Theme',
    help: 'A coordinated set of colours. Your own colour changes are cleared when you switch.',
    control: { type: 'gallery', choices: THEME_CHOICES },
    read: (o) => o.visualTheme || 'custom',
    write: (o, value) => {
      const next = { ...o, visualTheme: value, colors: {} };
      const theme = visualThemes[value];
      // A theme supplies its own shape and colour mapping unless you chose otherwise later.
      for (const key of ['nodeShape', 'nodeColorMode', 'effect']) {
        if (theme && key in theme) next[key] = theme[key]; else if (key === 'effect') next.effect = 'none';
      }
      Object.assign(next, THEME_EXTRAS[value]);
      if (next.visualStyle && theme) next.visualStyle = { ...next.visualStyle, glow: theme.glow ?? next.visualStyle.glow, secondaryOpacity: theme.opacity ?? next.visualStyle.secondaryOpacity };
      return refreshPalettes(next);
    },
  },
  field('look.background', 'starfield.mode', {
    group: 'look', tier: 'essential', label: 'Background',
    control: { type: 'segmented', choices: [choice('off', 'Plain'), choice('classic', 'Stars'), choice('space', 'Deep space'), choice('milky-way', 'Milky Way')] },
  }),
  field('look.shape', 'nodeShape', {
    group: 'look', tier: 'essential', label: 'Star shape', fallback: 'circle',
    control: { type: 'segmented', choices: [choice('circle', 'Dot'), choice('star', 'Star'), choice('diamond', 'Diamond'), choice('hexagon', 'Hexagon'), choice('square', 'Square'), choice('mixed', 'Mixed')] },
  }),
  field('look.glow', 'visualStyle.glow', {
    group: 'look', tier: 'essential', label: 'Glow', control: { type: 'range', min: 0, max: 5, step: 0.5 },
  }),
  colorField('look.colors.background', 'background', { label: 'Sky colour' }),
  colorField('look.colors.star', 'star', { label: 'Star colour', help: 'Used when stars are coloured by theme.' }),
  colorField('look.colors.line', 'line', { label: 'Line colour' }),
  colorField('look.colors.accent', 'accent', { label: 'Highlight colour' }),
  colorField('look.colors.foreground', 'foreground', { label: 'Text colour' }),
  field('look.effect', 'effect', {
    group: 'look', label: 'Overlay', fallback: 'none',
    control: { type: 'select', choices: [choice('none', 'None'), choice('grid', 'Grid'), choice('scanlines', 'Scanlines'), choice('coordinates', 'Coordinates')] },
  }),
  field('look.starDensity', 'starfield.density', { group: 'look', label: 'Background star amount', control: { type: 'range', min: 0, max: 100, step: 5 } }),
  field('look.starBrightness', 'starfield.brightness', { group: 'look', label: 'Background star brightness', control: { type: 'range', min: 0, max: 1, step: 0.05 } }),
  field('look.lineWidth', 'visualStyle.lineWidth', { group: 'look', label: 'Line thickness', control: { type: 'range', min: 0.5, max: 3, step: 0.1 } }),
  field('look.lineOpacity', 'visualStyle.lineOpacity', { group: 'look', label: 'Line strength', control: { type: 'range', min: 0, max: 1, step: 0.05 } }),
  field('look.faintLines', 'visualStyle.secondaryOpacity', { group: 'look', label: 'Faint line strength', control: { type: 'range', min: 0, max: 1, step: 0.05 } }),
  field('look.dust', 'visualStyle.dustOpacity', { group: 'look', label: 'Stardust', control: { type: 'range', min: 0, max: 1, step: 0.05 } }),
  field('look.glowMode', 'nodeGlowMode', {
    group: 'look', label: 'Which stars glow', fallback: 'uniform',
    control: { type: 'select', choices: [choice('uniform', 'All the same'), choice('stars', 'Most-starred glow most'), choice('activity', 'Most active glow most'), choice('seeded', 'Varied')] },
  }),
  field('look.centre', 'accountSun', {
    group: 'look', label: 'Centre of the map', fallback: 'off',
    control: { type: 'select', choices: [choice('off', 'Nothing'), choice('sun', 'Your name'), choice('avatar', 'Your avatar'), choice('profile', 'Your profile summary')] },
  }),
  field('look.css', 'customCSS', {
    group: 'look', label: 'Custom CSS', help: 'Added after every other style. Imports, URLs and scripts are not allowed.',
    control: { type: 'textarea', rows: 6, maxLength: 20000 }, fallback: '',
    write: (options, value) => {
      if (UNSAFE_CSS.test(value.replace(/\/\*[\s\S]*?\*\//g, ''))) {
        throw new Error('Custom CSS must be self-contained: no url(), @import, escapes or expressions.');
      }
      return { ...options, customCSS: value };
    },
  }),

  // ---------------------------------------------------------------- Layout
  {
    id: 'layout.arrangement', key: 'arrangement', group: 'layout', tier: 'essential', label: 'Layout',
    control: { type: 'gallery', choices: LAYOUT_CHOICES },
    read: (o) => (o.temporalStack?.enabled ? 'temporal-stack' : o.arrangement || 'rings'),
    write: (o, value) => {
      const next = { ...o, arrangement: value, starPositions: {}, labelPositions: {}, labelOffsets: {} };
      next.temporalStack = value === 'temporal-stack'
        ? { ...(o.temporalStack || {}), enabled: true, axis: o.temporalStack?.axis || 'year' }
        : { ...(o.temporalStack || {}), enabled: false };
      return next;
    },
    available: ({ repositories = [] }) => ({
      'temporal-stack': new Set(repositories.map((r) => String(r.created_at || '').slice(0, 4)).filter(Boolean)).size >= 3
        || 'Needs projects from at least three different years.',
      'era-rings': repositories.some((r) => r.created_at) || 'Needs project creation dates.',
    }),
  },
  field('layout.connect', 'connectionBasis', {
    group: 'layout', tier: 'essential', label: 'Connect projects that share', fallback: 'languages',
    control: { type: 'segmented', choices: [choice('languages', 'Languages'), choice('topics', 'Topics'), choice('both', 'Both')] },
  }),
  field('layout.density', 'connectionDensity', {
    group: 'layout', tier: 'essential', label: 'Lines', fallback: 'balanced',
    control: { type: 'segmented', choices: [choice('balanced', 'Strongest'), choice('all', 'All')] },
  }),
  field('layout.orbits', 'orbitShape', {
    group: 'layout', tier: 'essential', label: 'Orbit shape', fallback: 'wide',
    help: 'Wide stretches the orbits to fill a wide README banner.',
    control: { type: 'segmented', choices: [choice('round', 'Round'), choice('wide', 'Wide')] },
  }),
  field('layout.rings', 'identityRing', {
    group: 'layout', tier: 'essential', label: 'Orbit rings', fallback: true, control: { type: 'toggle' },
  }),
  field('layout.lineWeight', 'connectionWeight', {
    group: 'layout', label: 'Line thickness shows', fallback: 'uniform',
    control: { type: 'select', choices: [choice('uniform', 'Nothing (all equal)'), choice('languages', 'Shared languages'), choice('topics', 'Shared topics'), choice('overlap', 'Total overlap')] },
  }),
  field('layout.colorLines', 'colorConnections', { group: 'layout', label: 'Colour lines like their stars', fallback: false, control: { type: 'toggle' } }),
  field('layout.bridges', 'bridges', { group: 'layout', label: 'Dotted links between clusters', help: 'Decorative only. They don’t mean the projects depend on each other.', fallback: false, control: { type: 'toggle' } }),
  field('layout.snap', 'snapToRings', { group: 'layout', label: 'Line stars up on the rings', fallback: false, control: { type: 'toggle' } }),
  field('layout.rotate', 'ringRotation', { group: 'layout', label: 'Turn the rings', fallback: 0, control: { type: 'range', min: 0, max: 360, step: 5, unit: '°' } }),
  field('layout.tidy', 'layoutRefinement.enabled', { group: 'layout', label: 'Tidy overlapping stars', fallback: false, control: { type: 'toggle' } }),
  field('layout.tidyStrength', 'layoutRefinement.intensity', { group: 'layout', label: 'Tidy strength', fallback: 5, control: { type: 'range', min: 0, max: 10, step: 1 } }),
  field('layout.ringMeaning', 'ringMeaning', {
    group: 'layout', label: 'Distance from the centre shows', fallback: 'identity',
    control: { type: 'select', choices: [choice('identity', 'Nothing in particular'), choice('capability', 'Kind of work'), choice('showcase', 'Featured first'), choice('activity', 'Recently updated first'), choice('era', 'Newest first')] },
  }),
  field('layout.focus', 'profileEmphasis', {
    group: 'layout', label: 'Skills layout focus', help: 'Used by the Skills arrangement.', fallback: 'automatic',
    control: { type: 'select', choices: [choice('automatic', 'Automatic'), choice('interface', 'Interfaces'), choice('services', 'Services'), choice('data', 'Data'), choice('systems', 'Systems'), choice('tooling', 'Tooling'), choice('automation', 'Automation')] },
  }),
  field('layout.planetsBy', 'majorMetric', {
    group: 'layout', label: 'Solar system planets are', fallback: 'stars',
    control: { type: 'segmented', choices: [choice('stars', 'Most starred'), choice('updated', 'Most recent')] },
  }),
  field('layout.timeAxis', 'temporalStack.axis', {
    group: 'layout', label: 'Through time: one layer per', fallback: 'year',
    control: { type: 'select', choices: [choice('year', 'Year'), choice('language', 'Language'), choice('repository', 'Project'), choice('topic', 'Topic')] },
  }),
  field('layout.tilt', 'perspective.enabled', { group: 'layout', label: 'Tilt the map', fallback: false, control: { type: 'toggle' } }),
  field('layout.tiltAngle', 'perspective.vertical', { group: 'layout', label: 'Tilt amount', fallback: 35, control: { type: 'range', min: 0, max: 65, step: 1, unit: '°' } }),
  field('layout.turnAngle', 'perspective.horizontal', { group: 'layout', label: 'Turn amount', fallback: 0, control: { type: 'range', min: -55, max: 55, step: 1, unit: '°' } }),
  field('layout.seed', 'seed', {
    group: 'layout', label: 'Layout code', help: 'Any word. The same word always places the stars the same way.',
    control: { type: 'text', maxLength: 120 }, fallback: '',
    write: (o, value) => ({ ...o, seed: value, seedMode: value ? 'custom' : 'account' }),
  }),

  // ---------------------------------------------------------------- Projects
  field('projects.max', 'maxRepos', { group: 'projects', tier: 'essential', label: 'Most projects to show', fallback: 45, control: { type: 'range', min: 1, max: 100, step: 1 } }),
  field('projects.sort', 'sortBy', {
    group: 'projects', tier: 'essential', label: 'When there are too many, keep', fallback: 'stars',
    control: { type: 'segmented', choices: [choice('stars', 'Most starred'), choice('updated', 'Most recent'), choice('name', 'A to Z')] },
  }),
  field('projects.forks', 'includeForks', { group: 'projects', tier: 'essential', label: 'Include forks', fallback: false, control: { type: 'toggle' } }),
  field('projects.archived', 'includeArchived', { group: 'projects', tier: 'essential', label: 'Include archived projects', fallback: true, control: { type: 'toggle' } }),
  field('projects.minStars', 'minStars', { group: 'projects', label: 'Only projects with at least this many stars', fallback: 0, control: { type: 'number', min: 0, max: 1000000, step: 1 } }),
  field('projects.recent', 'updatedWithin', {
    group: 'projects', label: 'Only projects updated in the last', fallback: 0,
    control: { type: 'select', choices: [choice(0, 'Any time'), choice(1, 'Year'), choice(2, '2 years'), choice(5, '5 years')] },
  }),
  field('projects.query', 'repoQuery', { group: 'projects', label: 'Only projects whose name contains', fallback: '', control: { type: 'text', maxLength: 200 } }),
  field('projects.other', 'showOther', { group: 'projects', label: 'Include projects with no detected language', fallback: true, control: { type: 'toggle' } }),
  field('projects.nodes', 'nodeMode', {
    group: 'projects', label: 'Each star is a', fallback: 'repositories',
    control: { type: 'select', choices: [choice('repositories', 'Project'), choice('languages', 'Language'), choice('topics', 'Topic'), choice('combined', 'Project, language and topic')] },
  }),
  field('projects.featured', 'featuredTreatment', {
    group: 'projects', label: 'Featured projects stand out with', fallback: 'label',
    control: { type: 'select', choices: [choice('label', 'A bold name'), choice('star', 'A bigger star'), choice('spotlight', 'A spotlight')] },
  }),

  // ---------------------------------------------------------------- Details
  field('details.size', 'nodeSize', {
    group: 'details', tier: 'essential', label: 'Star size shows', fallback: 'stars',
    control: { type: 'segmented', choices: [choice('stars', 'GitHub stars'), choice('activity', 'Recent work'), choice('age', 'Age'), choice('uniform', 'Nothing')] },
  }),
  field('details.color', 'nodeColorMode', {
    group: 'details', tier: 'essential', label: 'Star colour shows', fallback: 'language',
    control: { type: 'segmented', choices: [choice('language', 'Language'), choice('custom', 'Theme colour'), choice('seeded', 'Rainbow')] },
  }),
  field('details.labels', 'visualStyle.labels', { group: 'details', tier: 'essential', label: 'Project names', control: { type: 'toggle' } }),
  field('details.labelSize', 'visualStyle.labelSize', { group: 'details', tier: 'essential', label: 'Name size', control: { type: 'range', min: 9, max: 20, step: 1 } }),
  {
    id: 'details.motion', key: 'animate', group: 'details', tier: 'essential', label: 'Motion',
    help: 'Gentle twinkles and turns the rings; Lively also lets stars drift. Always still for anyone who prefers reduced motion.',
    control: { type: 'segmented', choices: [choice('still', 'Still'), choice('gentle', 'Gentle'), choice('lively', 'Lively')] },
    read: motionLevel,
    write: applyMotion,
  },
  field('details.legend', 'legend', { group: 'details', tier: 'essential', label: 'Show a key', fallback: false, control: { type: 'toggle' } }),
  field('details.title', 'title', { group: 'details', tier: 'essential', label: 'Title', help: 'Not drawn on the map. Screen readers read it out, and it names your image. Up to 60 characters.', fallback: '', control: { type: 'text', maxLength: 60, placeholder: 'My GitHub constellation' } }),
  field('details.twinkle', 'starlightAnimate', { group: 'details', label: 'Twinkling stars', fallback: true, control: { type: 'toggle' } }),
  field('details.spin', 'ringAnimation.enabled', { group: 'details', label: 'Spinning rings', fallback: false, control: { type: 'toggle' } }),
  field('details.float', 'floatingAnimation.enabled', { group: 'details', label: 'Floating stars', fallback: false, control: { type: 'toggle' } }),
  field('details.floatStyle', 'floatingAnimation.mode', {
    group: 'details', label: 'Floating style', fallback: 'drift',
    control: { type: 'segmented', choices: [choice('drift', 'Drift'), choice('bob', 'Bob'), choice('orbit', 'Orbit')] },
  }),
  field('details.groups', 'semanticZoom.mode', {
    group: 'details', label: 'Group related projects', fallback: 'auto',
    control: { type: 'segmented', choices: [choice('auto', 'Automatic'), choice('groups', 'Grouped'), choice('projects', 'Every project')] },
  }),

  // ---------------------------------------------------------------- Output
  field('output.shape', 'exportProfile', {
    group: 'output', label: 'Image shape', fallback: 'custom',
    control: { type: 'select', choices: [choice('custom', 'Automatic'), choice('hero', 'Large (900 × 560)'), choice('wide', 'Wide banner (900 × 320)'), choice('square', 'Square'), choice('compact', 'Compact'), choice('readme', 'Profile README'), choice('transparent', 'See-through background')] },
  }),
  field('output.height', 'layout', {
    group: 'output', label: 'Canvas', fallback: 'atlas',
    control: { type: 'segmented', choices: [choice('atlas', 'Tall'), choice('compact', 'Short')] },
  }),

  // ---------------------------------------------------------------- Data (sign-in)
  field('data.activity', 'activityEffect', {
    group: 'data', label: 'Highlight recent activity', fallback: 'off', needsSignIn: true,
    control: { type: 'select', choices: [choice('off', 'Off'), choice('glow', 'Glow'), choice('pulse', 'Pulse'), choice('comet', 'Comet'), choice('ripple', 'Ripple')] },
  }),
  field('data.activityWindow', 'activityWindow', {
    group: 'data', label: 'Recent means the last', fallback: '7d', needsSignIn: true,
    control: { type: 'segmented', choices: [choice('1d', 'Day'), choice('7d', 'Week'), choice('30d', 'Month')] },
  }),
  field('data.rhythm', 'codingRhythm', { group: 'data', label: 'Show when you usually code', fallback: false, needsSignIn: true, control: { type: 'toggle' } }),
  field('data.source', 'repoSource', {
    group: 'data', label: 'Start from', fallback: 'all', needsSignIn: true,
    control: { type: 'segmented', choices: [choice('all', 'All public projects'), choice('pinned', 'Pinned projects')] },
  }),
];

export const settingsById = new Map(SETTINGS.map((setting) => [setting.id, setting]));

export function settingsFor(group, tier) {
  return SETTINGS.filter((setting) => setting.group === group && (!tier || setting.tier === tier));
}

/** Case-insensitive search across labels, help and choice labels. */
// Everyday and American words for what the labels call something else.
const SYNONYMS = { color: 'colour', colors: 'colours', gray: 'grey', center: 'centre', font: 'name', label: 'name', labels: 'names', text: 'name' };

export function searchSettings(query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).map((word) => SYNONYMS[word] || word);
  if (!words.length) return SETTINGS;
  return SETTINGS.filter((setting) => {
    const text = [setting.label, setting.help, ...(setting.control.choices || []).map((c) => c.label)].join(' ').toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * Apply one setting. Returns the new options; never mutates.
 * The value is coerced to the control type and range so a stale or hostile
 * input can't produce an out-of-range configuration.
 */
export function applySetting(options, id, raw) {
  const setting = settingsById.get(id);
  if (!setting) throw new Error(`Unknown setting: ${id}`);
  const { control } = setting;
  let value = raw;
  if (control.type === 'toggle') value = Boolean(raw);
  else if (control.type === 'range' || control.type === 'number') {
    value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${setting.label} must be a number.`);
    value = Math.min(control.max, Math.max(control.min, value));
  } else if (control.choices) {
    const match = control.choices.find((c) => String(c.value) === String(raw));
    if (!match) throw new Error(`${setting.label}: choose one of the listed options.`);
    value = match.value;
  } else if (control.type === 'color') {
    if (!/^#[0-9a-f]{6}$/i.test(String(raw))) throw new Error(`${setting.label} must be a colour like #1a2b3c.`);
  } else if (['text', 'textarea'].includes(control.type)) {
    value = String(raw ?? '');
    if (control.maxLength && value.length > control.maxLength) value = value.slice(0, control.maxLength);
  }
  return withDerivedCSS(setting.write(options, value));
}
