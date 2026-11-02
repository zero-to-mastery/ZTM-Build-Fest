import { parseConfig, configFields } from './config-schema.mjs';

export function validateConfig(value) {
  try {
    const input = typeof value === 'string' ? JSON.parse(value) : value;
    const options = input?.version !== undefined && input?.options ? input.options : input;
    const errors = [];
    if (options && typeof options === 'object') {
      if (options.nodeColors && typeof options.nodeColors === 'object' && !Array.isArray(options.nodeColors)) {
        for (const id of Object.keys(options.nodeColors)) {
          if (!/^(?:[^\s/:]+\/[^\s/]+|[a-z][a-z\d-]*:[^\x00-\x1f]+)$/i.test(id)) errors.push({ path: `nodeColors.${id}`, message: 'Use a repository ID (owner/name) or a namespaced node ID (for example language:Rust).' });
        }
      }
      if ('ringRotations' in options && (!Array.isArray(options.ringRotations) || options.ringRotations.length !== 4 || Array.from(options.ringRotations).some(angle => !Number.isFinite(angle) || angle < 0 || angle > 360))) errors.push({ path: 'ringRotations', message: 'Provide exactly four finite angles between 0 and 360 degrees.' });
      if (options.layoutRefinement && typeof options.layoutRefinement === 'object' && 'intensity' in options.layoutRefinement && (!Number.isInteger(options.layoutRefinement.intensity) || options.layoutRefinement.intensity < 0 || options.layoutRefinement.intensity > 10)) errors.push({ path: 'layoutRefinement.intensity', message: 'Use an integer from 0 through 10.' });
    }
    if (errors.length) return { valid: false, errors };
    if (options && typeof options === 'object' && !Array.isArray(options)) {
      const unknown = Object.keys(options).filter(key => !configFields.includes(key) && !['version', 'account', 'cssFile'].includes(key));
      if (unknown.length) return { valid: false, errors: unknown.map(path => ({ path, message: `Unknown setting "${path}". Check the configuration field name.` })) };
    }
    // Legacy CLI/workflow configs permit trusted CSS. Keep that contract;
    // versioned studio imports retain their existing stricter CSS validation.
    const legacyCSS = input?.version === undefined && options && typeof options === 'object'
      ? Object.fromEntries(['css', 'customCSS'].filter(key => typeof options[key] === 'string').map(key => [key, options[key]])) : {};
    const config = parseConfig(Object.keys(legacyCSS).length ? { ...input, ...Object.fromEntries(Object.keys(legacyCSS).map(key => [key, ''])) } : input);
    Object.assign(config.options, legacyCSS);
    return { valid: true, errors: [], config };
  } catch (error) {
    return { valid: false, errors: [{ path: '$', message: error.message }] };
  }
}
