import { renderSceneSVG } from './renderer-svg.mjs';

export function renderProfileStorySVG(candidate, targetWidth = 900) {
  if (![480, 900].includes(targetWidth)) throw Error('Choose a 480px or 900px Profile Story export.');
  const source = candidate?.scene;
  const projects = source?.nodes.filter(node => node.metadata?.nodeKind === 'repository'
    || (node.metadata?.full_name && !node.metadata?.nodeKind));
  if (!candidate?.bounded || !projects?.length || projects.length > 12)
    throw Error('A Profile Story must include 1–12 evidence-backed projects.');
  return renderSceneSVG({
    ...source,
    presentation: {
      ...source.presentation,
      options: { ...source.presentation.options, exportProfile: 'readme' },
    },
  }, { targetWidth });
}
