import type { ProfileId } from './shared';

// Text blocks only. Styling spans and divs breaks icon fonts and layouts.
const TEXT = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, td, th, summary';

const HIDDEN = `[data-cr-hidden] { display: none !important; }
html[data-cr-unlock], html[data-cr-unlock] body { overflow: auto !important; }`;

const ADS = `ins.adsbygoogle, [id^="google_ads"], [aria-label="Advertisement" i],
iframe[src*="doubleclick.net"], iframe[src*="googlesyndication.com"] { display: none !important; }`;

export function buildCss(profile: ProfileId, extensionBase: string): string {
  const font = (w: number) =>
    `@font-face { font-family: "Atkinson Hyperlegible"; font-weight: ${w}; font-display: swap;
  src: url("${extensionBase}fonts/atkinson-hyperlegible-latin-${w}-normal.woff2") format("woff2"); }`;

  switch (profile) {
    case 'dyslexia':
      return `${HIDDEN}
${font(400)}
${font(700)}
html body { background: #faf6ec !important; color: #222 !important; }
${TEXT} {
  font-family: "Atkinson Hyperlegible", sans-serif !important;
  letter-spacing: 0.05em !important;
  word-spacing: 0.15em !important;
  line-height: 1.75 !important;
  text-align: left !important;
}
p, li { max-width: 65ch !important; }`;

    case 'adhd':
      return `${HIDDEN}
${TEXT} { line-height: 1.7 !important; text-align: left !important; }
p, li { font-size: 1.125rem !important; max-width: 62ch !important; }
p:hover, li:hover { background: rgba(255, 226, 120, 0.35) !important; }`;

    case 'calm':
      return `${HIDDEN}
${ADS}
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  scroll-behavior: auto !important;
}
html body { background: #f3f0e8 !important; color: #2d2d2d !important; }
img, video, picture, canvas { filter: saturate(0.7) contrast(0.95); }`;
  }
}
