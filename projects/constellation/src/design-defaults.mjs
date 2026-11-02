import { rhythmDefaults } from './coding-rhythm.mjs';

// Values a design falls back to when a recipe or config leaves an option unset.
export const designDefaults = { ringMeaning: 'identity', semanticLegend: false, accountSun: 'off', ...rhythmDefaults, starlightAnimate: true, activityAnimate: true, seedMode: 'account', seed: '', nodeSize: 'legacy', nodeColorMode: 'custom', nodeGlowMode: 'uniform', connectionWeight: 'uniform', majorMetric: 'stars', nodeShape: 'circle', effect: 'none', legend: false, minStars: 0, includeArchived: true, updatedWithin: 0, repoQuery: '', sortBy: 'stars', exportProfile: 'custom', readmePresentation: 'full-universe', ringOrganization: 'identity', featuredTreatment: 'label', activityEffect: 'off', activityWindow: '7d', activityDetail: 'simple', activityConnections: false };

// Replaying a full random recipe must not discard what the person chose to feature.
export function preserveShowcaseOptions(recipe, current = {}) {
  return { ...recipe, ...(current.projectRelationships ? { projectRelationships: structuredClone(current.projectRelationships) } : {}), ...(current.projectShowcase ? { projectShowcase: structuredClone(current.projectShowcase) } : {}), ...(current.readmePresentation ? { readmePresentation: current.readmePresentation } : {}), ...(current.ringOrganization ? { ringOrganization: current.ringOrganization } : {}), ...(current.featuredTreatment ? { featuredTreatment: current.featuredTreatment } : {}) };
}
