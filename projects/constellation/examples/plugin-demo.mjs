import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createPluginHost } from '../packages/core/src/core-api.mjs';
import { jsonFeedSource } from '../packages/source-json/index.mjs';
import { themePacks } from '../packages/themes/index.mjs';

const host = createPluginHost();
host.registerSource({ ...jsonFeedSource, id: 'portfolio-feed', renderNode: () => ({ path: 'M0 -1 L1 0 L0 1 L-1 0 Z' }) });
const theme = themePacks.find(pack => pack.id === 'deep-space');
host.registerThemePack(theme);
const options = {
  animate: false, themePack: { id: theme.id, version: theme.version },
  plugins: { sources: [
    { id: 'notes', source: 'portfolio-feed', options: { items: [{ id: 'one', name: 'Design notes', language: 'Writing' }] } },
    { id: 'projects', source: 'json-feed', options: { items: [{ id: 'one', name: 'A project', language: 'Rust' }] } },
  ] },
};
const nodes = await host.load(options, { account: 'octocat' });
const svg = host.render('octocat', nodes, options);
const output = process.argv[2] || '.dist/plugin-demo.svg';
await mkdir(dirname(output), { recursive: true });
await writeFile(output, svg);
console.log(`Generated ${output} from ${nodes.length} source nodes without network access.`);
