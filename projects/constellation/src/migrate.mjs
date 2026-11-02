import { parseConfig, serializeConfig } from './config-schema.mjs';
import { validateConfig } from './validate-config.mjs';
import { decodeShare } from './share-link.mjs';

export function migrateConfig(value, { account = 'your-universe' } = {}) {
  let config;
  if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) {
    config = decodeShare(value.trim());
    if (!config) throw new Error('The URL does not contain a constellation view.');
  } else if (typeof value === 'string' && /^v[1-6]:/i.test(value.trim())) config = parseConfig(value.trim(), account);
  else {
    const validation = validateConfig(value);
    if (!validation.valid) throw new Error(validation.errors.map(error => `${error.path}: ${error.message}`).join('; '));
    config = validation.config;
    const input = typeof value === 'string' ? JSON.parse(value) : value;
    if (!input.account) config.account = account;
  }
  return JSON.parse(serializeConfig(config.account, config.options));
}

export function migrateWorkflow(text, options = {}) {
  if (!/uses:\s*['"]?mnichols08\/constellation@v[123](?:\.\d+\.\d+)?(?=[\s'"]|$)/.test(text)) throw new Error('Expected a constellation@v1, @v2 or @v3 workflow. Migrate custom action references manually.');
  let output = text.replace(/(uses:\s*['"]?mnichols08\/constellation@)v[123](?:\.\d+\.\d+)?(?=[\s'"]|$)/g, '$1v3');
  const marker = /^([ \t]*)config-json:\s*\|[-+]?\s*\r?$/m.exec(output);
  if (marker) {
    const start = marker.index + marker[0].length;
    const lines = output.slice(start).replace(/^\r?\n/, '').split(/\r?\n/);
    let count = 0;
    while (count < lines.length && (!lines[count].trim() || /^\s/.test(lines[count]) && lines[count].search(/\S/) > marker[1].length)) count++;
    const original = lines.slice(0, count).join('\n').trim();
    const config = migrateConfig(original, options);
    // Workflow account remains the repository owner; config account is metadata.
    delete config.account;
    const indent = marker[1] + '  ';
    const block = JSON.stringify(config, null, 2).replace(/\$/g, '\\u0024').split('\n').map(line => indent + line).join('\n');
    output = output.slice(0, start) + '\n' + block + '\n' + lines.slice(count).join('\n');
  } else if (/config-json:/.test(output)) throw new Error('Inline/expression config-json must be migrated separately; use a literal JSON block or --config.');
  return output;
}
