import { renderSceneSVG } from './renderer-svg.mjs';
import { renderSceneHTML } from './renderer-html.mjs';
import { assertScene } from './scene.mjs';

export const RENDERER_API_VERSION = 1;
export const svgRenderer = Object.freeze({ id: 'svg', apiVersion: RENDERER_API_VERSION, mimeType: 'image/svg+xml', extension: 'svg', render: renderSceneSVG });
export const htmlRenderer = Object.freeze({ id: 'html', apiVersion: RENDERER_API_VERSION, mimeType: 'text/html', extension: 'html', render: renderSceneHTML });
export function renderScene(scene, { renderer = svgRenderer, ...options } = {}) {
  if (!renderer || renderer.apiVersion !== RENDERER_API_VERSION || typeof renderer.render !== 'function' || typeof renderer.mimeType !== 'string') throw new Error('A renderer must implement Renderer API v1.');
  assertScene(scene);
  const output = renderer.render(structuredClone(scene), structuredClone(options));
  if (typeof output !== 'string') throw new Error('Renderer API v1 must return a string artifact.');
  return output;
}
