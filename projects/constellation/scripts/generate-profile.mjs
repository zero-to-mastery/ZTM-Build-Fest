import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fetchRepositories, fetchRepositoryLanguages, selectRepositoryPool, renderConstellation } from '../src/constellation.mjs';
import { defaultVisualStyle, visualCSS } from '../src/visual-style.mjs';
import { rustAvailable, engineError } from '../src/engine.mjs';

// Both variants use the same repository snapshot and layout configuration.
const options = JSON.parse(await readFile(new URL('../profiles/mnichols08.json', import.meta.url), 'utf8'));
const palettes = {
  dark: { background: '#111111', foreground: '#eeeeee', accent: '#E3DE13', line: '#77743b', star: '#E3DE13' },
  light: { background: '#F5F4E6', foreground: '#111111', accent: '#747122', line: '#aaa66d', star: '#747122' },
};
try {
  if (!rustAvailable) throw new Error(`Could not load the Rust engine: ${engineError?.message}`);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.gh_token;
  const listed = await fetchRepositories('mnichols08', { token, repoSource: options.repoSource });
  const repos = await fetchRepositoryLanguages(selectRepositoryPool(listed, options), { token });
  const missing = options.includeRepos.filter(name => !repos.some(repo => repo.name === name && !repo.private && (options.includeForks || !repo.fork)));
  if (missing.length) console.warn(`Selected repositories unavailable: ${missing.join(', ')}`);
  const generatedAt = new Date().toISOString();
  const outputs = Object.entries(palettes).map(([variant, colors]) => ({
    file: new URL(`../dist/mnichols08-${variant}.svg`, import.meta.url),
    svg: renderConstellation('mnichols08', repos, { ...options, theme: variant === 'dark' ? 'midnight' : 'light', colors, generatedAt }),
  }));
  const adaptiveStyle = { ...defaultVisualStyle(), ...palettes };
  outputs.push({ file: new URL('../dist/mnichols08.svg', import.meta.url), svg: renderConstellation('mnichols08', repos, { ...options, theme: 'auto', css: visualCSS(adaptiveStyle), generatedAt }) });
  await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
  for (const { file, svg } of outputs) await writeFile(file, svg);
  console.log('Generated adaptive dist/mnichols08.svg plus fixed dark and light variants.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
