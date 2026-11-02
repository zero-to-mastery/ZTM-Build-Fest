import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { visualThemes } from '../src/themes.mjs';
const themes = new URL('../packages/themes/', import.meta.url);
const source = new URL('../packages/source-json/', import.meta.url);
await mkdir(themes, { recursive: true }); await mkdir(source, { recursive: true });
async function packageVersion(directory) {
  try { return JSON.parse(await readFile(new URL('package.json', directory), 'utf8')).version; }
  catch (error) { if (error.code === 'ENOENT') return '1.0.0'; throw error; }
}
const packs = Object.entries(visualThemes).map(([id, preset]) => ({ id, version: '1.0.0', preset }));
await writeFile(new URL('index.mjs', themes), `// Versioned independently of the core.\nexport const themePacks = ${JSON.stringify(packs, null, 2)};\nexport const themePacksV2 = themePacks.map(pack => ({ ...pack, apiVersion: 2 }));\n`);
await writeFile(new URL('package.json', themes), JSON.stringify({ name: '@constellation/themes', version: await packageVersion(themes), type: 'module', exports: './index.mjs', files: ['index.mjs'], license: 'UNLICENSED' }, null, 2) + '\n');
await copyFile(new URL('../src/json-feed-source.mjs', import.meta.url), new URL('index.mjs', source));
await writeFile(new URL('package.json', source), JSON.stringify({ name: '@constellation/source-json', version: await packageVersion(source), type: 'module', exports: './index.mjs', files: ['index.mjs'], license: 'UNLICENSED' }, null, 2) + '\n');

await import('./build-web-component.mjs');
