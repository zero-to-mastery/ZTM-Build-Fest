export const ringMeanings = {
  identity: 'Identity geometry is account-seeded decoration; distance does not represent importance.',
  capability: 'Sectors show strongest capability evidence. Inner bands show stronger evidence; ties use interface, services, data, systems, tooling, automation order. The outer band marks no evidence.',
  showcase: 'Inner to outer: Featured, Supporting, Experimental, Historical, Unassigned. Roles are authored presentation choices, not GitHub facts.',
  activity: 'Inner to outer: updated within 30, 180, 365 days, older, then unavailable or future dates. This is repository update recency, not GitHub contribution activity.',
  era: 'Inner to outer: creation eras (five-year units, merged to at most five dated bands), oldest first; missing dates are outermost. Uses current repository metadata, not historical snapshots.',
};
export function validateSemanticOptions(options) {
  if (options.ringMeaning !== undefined && !Object.hasOwn(ringMeanings, options.ringMeaning)) throw Error('Unknown ringMeaning.');
  if (options.semanticLegend !== undefined && typeof options.semanticLegend !== 'boolean') throw Error('semanticLegend must be boolean.');
}
export function semanticActive(options) {
  return !!options.ringMeaning && options.ringMeaning !== 'identity' && (options.arrangement || 'rings') === 'rings' && (options.nodeMode || 'repositories') === 'repositories' && !options.layoutEngine && !options.temporalStack?.enabled;
}
export function explainGraphic(options = {}) {
  if (options.readmePresentation === 'recruiter') return ['The center shows identity, primary languages and recurring repository topics when available. Up to seven selected projects use curated roles, order and push recency.', 'Size: developer-curated importance, not quality. Featured is largest, Supporting medium, Experimental/Historical small, and unassigned conservative.', 'Distance: last repository push or observed work event. NOW: under 30 days; RECENT: under six months; EARLIER: older or unknown. This is not necessarily personal activity; missing dates are identified in accessible titles.', 'Color: primary language. Counts cover displayed repositories, not skill. Only Featured labels show other loaded contributors; missing scans never establish solo work.', 'Quiet lines: explicit project relationships. History evidence and ownership caveats remain in accessible metadata; they do not change size or fill.', 'Only a restrained recent Featured outline animates; reduced motion and static export preserve all essential information.'];
  const active = semanticActive(options), mode = options.nodeMode || 'repositories';
  const lines = [options.accountSun === 'profile'
    ? 'The center identifies the account. Six labelled rays show Developer Profile evidence for interface, services, data, systems, tooling and automation. Ray length reflects bounded evidence scores, not skill ratings; absent rays mean no evidence in the selected repositories.'
    : options.accountSun && options.accountSun !== 'off' ? 'The center identifies the GitHub account.' : 'The account sun is hidden.'];
  lines.push(`Nodes represent ${mode === 'combined' ? 'repositories, languages and topics' : mode}.`);
  lines.push(active ? ringMeanings[options.ringMeaning] : options.arrangement === 'profile' ? 'Developer Topology positions nodes by language and topic evidence; manual emphasis changes presentation, not scores.' : options.arrangement === 'temporal-stack' ? 'Temporal layers use the configured axis; retrospective layers use current metadata unless recorded snapshots are supplied.' : 'Layout positions compose the graphic; distance alone is not a measure of importance. ' + ringMeanings.identity);
  if (!active && options.arrangement === 'galaxy') lines.push('Galaxy clusters group primary languages (or node kinds). Within each cluster, the selected major-repository metric orders projects.');
  if (!active && options.arrangement === 'solar-system') lines.push(`Solar systems center up to four projects ranked by ${options.majorMetric === 'updated' ? 'repository updates' : 'GitHub stars'}; satellites group by shared language, topics or membership. Orbital distance is decorative.`);
  if (!active && options.arrangement === 'era-rings') lines.push('Era rings group repository creation metadata; they do not reconstruct past stars, topics or contributions.');
  if (!active && options.ringMeaning && options.ringMeaning !== 'identity') lines.push('The selected semantic rings apply only to repository nodes in the built-in Rings arrangement.');
  if (options.ringMeaning === 'activity' && active) lines.push(options.referenceDate ? `Recency reference: ${options.referenceDate}.` : 'Recency uses the scene reference date; save the configuration to retain that date.');
  lines.push(`Node color: ${{custom:'authored decorative colors',seeded:'a decorative seeded palette',language:'primary language (category nodes use their name)',category:'first topic, falling back to language or Other',contribution:'repository update recency in contribution-style colors, not contribution counts'}[options.nodeColorMode || 'custom']}.`);
  lines.push(`Node size: ${{uniform:'uniform; no data meaning',stars:'GitHub stars',legacy:'classic sizing: stars for projects, membership for categories',activity:'repository update recency',age:'repository age',languages:'language count',topics:'topic count',membership:'repository membership count'}[options.nodeSize || options.sizingMode || 'legacy'] || options.nodeSize}.`);
  if (mode !== 'repositories') lines.push('Category nodes use repository membership for non-uniform sizing; repository metrics apply to repository nodes.');
  lines.push(`Connections show ${mode === 'combined' ? 'repository membership in languages and topics' : mode === 'repositories' ? `shared ${options.connectionBasis || 'languages'}` : 'shared repository membership'}. Line weight: ${options.connectionWeight && options.connectionWeight !== 'uniform' ? options.connectionWeight + ' overlap' : 'uniform; brightness can emphasize geometric proximity'}. Dotted bridges, if visible, are decorative, not dependencies.`);
  if (mode === 'commits') lines[lines.length-1] = 'Commit nodes and lines show the loaded commit sample and actual parent relationships, not language overlap. Missing history outside the loaded sample is not inferred.';
  lines.push(`Glow: ${['stars','activity'].includes(options.nodeGlowMode) ? options.nodeGlowMode === 'stars' ? 'GitHub stars' : 'repository update recency' : 'decorative'}. Ring motion, twinkle, floating and camera movement are decorative, not activity; reduced motion keeps the data readable.`);
  if (options.activityEffect && options.activityEffect !== 'off') lines.push('Activity effects require loaded activity evidence; no extra data is fetched by Explain.');
  if (Object.keys(options.nodeColors || {}).length) lines.push('Individual authored colors override the color mapping.');
  if (Object.keys(options.starPositions || {}).length || (options.layoutRefinement?.enabled && options.layoutRefinement.intensity > 0)) lines.push('Manual positions and refinement can override default placement; semantic bands suspend refinement.');
  for (const [channel,mapping] of Object.entries(options.mappings || {})) lines.push(`Custom ${channel} mapping overrides the default: ${typeof mapping === 'string' ? mapping : mapping.field || 'an authored expression'}. Missing values use ${typeof mapping === 'object' && mapping.fallback !== undefined ? `the configured fallback (${mapping.fallback})` : 'the default encoding'}.`);
  return lines;
}
