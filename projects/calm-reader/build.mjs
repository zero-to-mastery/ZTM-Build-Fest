import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/fonts', { recursive: true });

// Static files: manifest, HTML, CSS, icons.
cpSync('static', 'dist', { recursive: true });

// Atkinson Hyperlegible (SIL OFL 1.1), latin subset, regular and bold.
const fontDir = 'node_modules/@fontsource/atkinson-hyperlegible/files';
for (const w of ['400', '700']) {
  cpSync(`${fontDir}/atkinson-hyperlegible-latin-${w}-normal.woff2`, `dist/fonts/atkinson-hyperlegible-latin-${w}-normal.woff2`);
}
cpSync('node_modules/@fontsource/atkinson-hyperlegible/LICENSE', 'dist/fonts/LICENSE.txt');

const options = {
  entryPoints: {
    content: 'src/content.ts',
    background: 'src/background.ts',
    popup: 'src/popup.ts',
    options: 'src/options.ts',
  },
  bundle: true,
  outdir: 'dist',
  target: 'chrome110',
  format: 'iife',
  minify: !watch,
  sourcemap: watch,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
