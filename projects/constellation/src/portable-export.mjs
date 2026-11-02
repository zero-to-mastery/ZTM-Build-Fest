import { renderSceneSVG } from './renderer-svg.mjs';
import { renderSceneHTML } from './renderer-html.mjs';
import { parseSemanticGraph, projectSemanticGraphToScene, semanticGraphExportInfo, semanticGraphFingerprint, serializeSemanticGraph, SEMANTIC_GRAPH_VERSION } from './semantic-graph.mjs';
import { renderSemanticMarkdown, SEMANTIC_MARKDOWN_VERSION } from './semantic-markdown.mjs';

export const EXPORT_MANIFEST_VERSION = 1;

// Build a deterministic set of portable artifacts from one validated graph and
// one projected Scene. Filesystem and archive operations belong to the caller.
export function createPortableExport(input, { constellationVersion = '3.14.3' } = {}) {
  const graph = parseSemanticGraph(typeof input === 'string' ? input : serializeSemanticGraph(input));
  const info = semanticGraphExportInfo(graph);
  const fingerprint = semanticGraphFingerprint(graph);
  const scene = projectSemanticGraphToScene(graph, { referenceDate: '2000-01-01T00:00:00Z' });
  const graphJSON = serializeSemanticGraph(graph);
  const markdown = renderSemanticMarkdown(graph, { detail: 'standard' });
  const svg = renderSceneSVG(scene);
  const html = renderSceneHTML(scene, {
    title: `${graph.subject.id} constellation`,
    semanticMetadata: {
      subjectLabel: `${graph.subject.kind === 'developer' ? 'Developer' : 'Project'}: ${graph.subject.id}`,
      version: SEMANTIC_GRAPH_VERSION,
      fingerprint,
      truncated: graph.statistics.truncated,
      privateSource: graph.project?.provenance?.visibility === 'private',
    },
  });
  const filenames = {
    graph: info.filename,
    markdown: 'constellation.md',
    svg: 'constellation.svg',
    html: 'constellation.html',
  };
  const manifest = {
    version: EXPORT_MANIFEST_VERSION,
    constellationVersion,
    semanticGraphVersion: SEMANTIC_GRAPH_VERSION,
    semanticMarkdownVersion: SEMANTIC_MARKDOWN_VERSION,
    fingerprint,
    subject: { ...graph.subject },
    sourceVisibility: graph.project?.provenance?.visibility === 'private' ? 'private' : 'public-or-unspecified',
    truncated: graph.statistics.truncated,
    artifacts: filenames,
  };
  const manifestJSON = `${JSON.stringify(manifest, null, 2)}\n`;
  return Object.freeze({
    graph, scene, fingerprint, manifest,
    files: Object.freeze({
      [filenames.graph]: graphJSON,
      [filenames.markdown]: markdown,
      [filenames.svg]: svg,
      [filenames.html]: html,
      'manifest.json': manifestJSON,
    }),
  });
}
