// Project structure is intentionally a separate, serializable Core model. It
// contains repository facts and bounded path relationships, never source text.
export const PROJECT_CONSTELLATION_VERSION = 1;
export const PROJECT_STRUCTURE_LIMITS = Object.freeze({
  files: 500, directories: 128, bytes: 2 * 1024 * 1024,
  manifests: 32, imports: 500, nodes: 100, edges: 1024, depth: 3,
  pathLength: 512, manifestBytes: 64 * 1024, sourceFileBytes: 128 * 1024,
});

const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
const pathHash = value => {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (const char of value) {
    const code = char.codePointAt(0);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
};
const normalizePath = value => {
  if (typeof value !== 'string' || value.length > PROJECT_STRUCTURE_LIMITS.pathLength || value.startsWith('/') || value.includes('\\')) return null;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
};
const stableId = (projectId, path) => `project:${pathHash(projectId)}:${pathHash(path)}`;
const boundedText = (value, max = 160) => [...String(value || '')].slice(0, max).join('');
const parseJSON = text => { try { return JSON.parse(text); } catch { return null; } };

function workspacePatterns(manifest) {
  if (Array.isArray(manifest?.workspaces)) return manifest.workspaces.filter(x => typeof x === 'string');
  if (Array.isArray(manifest?.workspaces?.packages)) return manifest.workspaces.packages.filter(x => typeof x === 'string');
  return [];
}
function packageEntryValues(manifest) {
  const entries=[manifest?.main,manifest?.module,manifest?.types,manifest?.typings,manifest?.source,...(typeof manifest?.bin==='string'?[manifest.bin]:Object.values(manifest?.bin||{}))];
  const pending=[manifest?.exports]; let remaining=32, visited=0;
  while(pending.length&&remaining>0&&visited<128){
    const value=pending.pop(); visited++;
    if(typeof value==='string'){entries.push(value);remaining--;}
    else if(Array.isArray(value))pending.push(...value.slice(0,32).reverse());
    else if(value&&typeof value==='object')for(const key of Object.keys(value).sort().slice(0,32).reverse())pending.push(value[key]);
  }
  return entries.filter(value=>typeof value==='string').slice(0,40);
}
function cargoWorkspacePatterns(text) {
  const section=(text.replace(/^\s*#.*$/gm,'').match(/(?:^|\n)\s*\[workspace\]\s*([\s\S]*?)(?=\n\s*\[|$)/)?.[1])||'';
  const members=section.match(/(?:^|\n)\s*members\s*=\s*\[([\s\S]*?)\]/)?.[1]||'';
  return [...members.matchAll(/["']([^"'\r\n]{1,256})["']/g)].map(match=>match[1]);
}
function matchesWorkspace(path, patterns) {
  return patterns.some(pattern => {
    const normalized = pattern.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized.endsWith('/*')) return path.startsWith(normalized.slice(0, -1)) && !path.slice(normalized.length - 1).includes('/');
    return path === normalized;
  });
}
function staticImportSpecifiers(source, limit) {
  const tokens = [];
  let index = 0, lineBreak = false;
  while (index < source.length && tokens.length < 100000) {
    const char = source[index], next = source[index + 1];
    if (char === '\n' || char === '\r') { lineBreak = true; index++; continue; }
    if (/\s/.test(char)) { index++; continue; }
    if (char === '/' && next === '/') { index += 2; while (index < source.length && source[index] !== '\n') index++; continue; }
    if (char === '/' && next === '*') { index += 2; while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) { if (source[index] === '\n') lineBreak = true; index++; } index = Math.min(source.length, index + 2); continue; }
    if (char === '/') {
      const previous=tokens.at(-1);let canStart=!previous||['=','(','[','{',',',':',';','!','?','>','return','throw','case','delete','void','typeof','instanceof','in','of','yield','await'].includes(previous.value);
      if(!canStart&&previous?.value===')'){let nesting=0;for(let i=tokens.length-1;i>=0;i--){if(tokens[i].value===')')nesting++;else if(tokens[i].value==='('&&!--nesting){canStart=['if','while','for','with','switch','catch'].includes(tokens[i-1]?.value);break;}}}
      if(canStart){let inClass=false;index++;while(index<source.length){const current=source[index];if(current==='\\'){index+=2;continue;}if(current==='[')inClass=true;else if(current===']')inClass=false;else if(current==='/'&&!inClass){index++;while(/[a-z]/i.test(source[index]||''))index++;break;}else if(current==='\n'||current==='\r')break;index++;}continue;}
    }
    if (char === '`') { index++; while (index < source.length) { if (source[index] === '\\') { index += 2; continue; } if (source[index++] === '`') break; } continue; }
    if (char === '"' || char === "'") {
      const quote = char; let value = '', valid = true; index++;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\n' || source[index] === '\r') { valid = false; break; }
        if (source[index] === '\\') { const escaped = source[index + 1]; if (escaped !== quote && escaped !== '\\' && escaped !== '/') valid = false; value += escaped; index += 2; }
        else value += source[index++];
      }
      if (source[index] === quote) index++;
      tokens.push({ type: valid ? 'string' : 'invalid', value, lineBreak }); lineBreak = false; continue;
    }
    if (/[A-Za-z_$]/.test(char)) { const start=index++; while (index<source.length && /[\w$]/.test(source[index])) index++; tokens.push({type:'word',value:source.slice(start,index),lineBreak}); lineBreak=false; continue; }
    tokens.push({ type: 'punct', value: char, lineBreak }); lineBreak = false; index++;
  }
  const found = [];
  for (let i=0; i<tokens.length && found.length<limit; i++) {
    const token=tokens[i];
    if (token.type==='word' && token.value==='require' && tokens[i+1]?.value==='(' && tokens[i+2]?.type==='string' && tokens[i+3]?.value===')') found.push(tokens[i+2].value);
    if (token.type!=='word' || !['import','export'].includes(token.value)) continue;
    if (token.value==='import' && tokens[i+1]?.value==='(') continue;
    if (token.value==='import' && tokens[i+1]?.type==='string') { found.push(tokens[i+1].value); continue; }
    for (let j=i+1; j<tokens.length && j<i+256; j++) {
      if (tokens[j].type==='word' && ['import','export'].includes(tokens[j].value)) break;
      if (tokens[j].value===';') break;
      if (tokens[j].type==='word' && tokens[j].value==='from' && tokens[j+1]?.type==='string') { found.push(tokens[j+1].value); break; }
    }
  }
  return found;
}

/** Normalize a bounded GitHub/local tree snapshot. contents maps paths to text
 * and should contain manifest files and explicitly fetched source files only. */
export function createProjectConstellation(input, limits = {}) {
  limits=limits&&typeof limits==='object'?limits:{};
  const cap = { ...PROJECT_STRUCTURE_LIMITS };
  for (const key of Object.keys(cap)) if (Number.isSafeInteger(limits[key]) && limits[key] > 0) cap[key] = Math.min(cap[key], limits[key]);
  if (!input || !safeId(input.projectId) || !Array.isArray(input.tree) || input.tree.length > 100000) throw new Error('Project structure requires a projectId and a bounded tree.');
  const ref = input.ref || 'HEAD';
  if (typeof ref !== 'string' || !ref.length || ref.length > 256 || /[\x00-\x1f]/.test(ref)) throw new Error('Project ref must be non-empty text up to 256 characters.');
  const commit = input.commit == null ? null : typeof input.commit==='string' ? boundedText(input.commit, 64) : null;
  if(input.commit!=null&&commit===null)throw new Error('Project commit must be text.');
  if (commit && !/^[a-f\d]{7,64}$/i.test(commit)) throw new Error('Project commit must be a hexadecimal Git object ID.');
  if(input.scannedAt!==undefined&&(typeof input.scannedAt!=='string'||!Number.isFinite(Date.parse(input.scannedAt))||new Date(input.scannedAt).toISOString()!==input.scannedAt))throw new Error('Project scan time must be an ISO timestamp.');
  if(input.visibility!==undefined&&!['public','private'].includes(input.visibility))throw new Error('Project visibility must be public or private.');
  const byPath = new Map();
  for (const item of input.tree) {
    const path = normalizePath(item?.path);
    if (!path || !['blob', 'tree', 'file', 'directory'].includes(item.type)) continue;
    if (!byPath.has(path)) byPath.set(path, { path, type: item.type === 'tree' || item.type === 'directory' ? 'directory' : 'file', sha: typeof item.sha === 'string' ? item.sha.slice(0, 64) : null, size: Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : 0 });
  }
  const sorted = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const files = sorted.filter(x => x.type === 'file');
  const dirsFromTree = sorted.filter(x => x.type === 'directory');
  const isManifestPath = path => /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|go\.mod)$/.test(path);
  const isSourcePath = path => /\.[cm]?[jt]sx?$/.test(path);
  const manifestsAvailablePaths = files.filter(item => isManifestPath(item.path)).map(item => item.path);
  const sourceAvailablePaths = files.filter(item => isSourcePath(item.path)).map(item => item.path);
  const contents = input.contents && typeof input.contents === 'object' ? input.contents : {};

  // Parsed declarations identify high-signal entry files before we spend the
  // bounded inspection window. Only supplied content is parsed here.
  const knownEntryPaths = new Set();
  for (const manifestPath of manifestsAvailablePaths.slice(0, cap.manifests)) {
    if (!manifestPath.endsWith('package.json') || typeof contents[manifestPath] !== 'string' || contents[manifestPath].length > cap.manifestBytes) continue;
    const value = parseJSON(contents[manifestPath]);
    if (!value || typeof value !== 'object') continue;
    const base = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1) : '';
    for (const entry of packageEntryValues(value)) {
      if (typeof entry !== 'string') continue;
      const path = normalizePath(`${base}${entry.replace(/^\.\//, '')}`);
      if (path && byPath.get(path)?.type === 'file') knownEntryPaths.add(path);
    }
  }
  const rank = path => isManifestPath(path) ? 0 : knownEntryPaths.has(path) ? 1 : isSourcePath(path) ? 2 : 3;
  const filesByPriority = [...files].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
  const selectedFiles = filesByPriority.slice(0, cap.files);
  const selectedPaths = new Set(selectedFiles.map(x => x.path));
  const manifestPaths = selectedFiles.filter(item => isManifestPath(item.path)).map(item => item.path);
  const sourcePaths = selectedFiles.filter(item => isSourcePath(item.path)).map(item => item.path);
  const unsupportedFilesIgnored = selectedFiles.filter(item => !isManifestPath(item.path) && !isSourcePath(item.path)).length;
  let bytes = 0, manifestsRead = 0, sourceFilesRead = 0;
  const textByPath = new Map();
  const readOrder = [
    ...manifestPaths,
    ...selectedFiles.filter(item => knownEntryPaths.has(item.path) && !isManifestPath(item.path)).map(item => item.path),
    ...sourcePaths,
    ...selectedFiles.filter(item => !isManifestPath(item.path) && !isSourcePath(item.path)).map(item => item.path),
  ];
  for (const path of [...new Set(readOrder)]) {
    const text = contents[path];
    if (typeof text !== 'string') continue;
    const manifest = isManifestPath(path), source = isSourcePath(path);
    if (manifest && manifestsRead >= cap.manifests) continue;
    const individualLimit = manifest ? cap.manifestBytes : cap.sourceFileBytes;
    if (text.length > individualLimit) continue;
    const size = new TextEncoder().encode(text).length;
    if (size > individualLimit || bytes + size > cap.bytes) continue;
    bytes += size;
    if (manifest) manifestsRead++;
    if (source) sourceFilesRead++;
    textByPath.set(path, text);
  }

  const allDirPaths = new Set(dirsFromTree.map(x => x.path));
  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      allDirPaths.add(parts.slice(0, i).join('/'));
      if (allDirPaths.size > 100000) throw new Error('Repository tree contains too many distinct directory paths.');
    }
  }
  const directoryPaths = [...allDirPaths].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const shallowDirs = directoryPaths.filter(path => path.split('/').length < cap.depth).slice(0, cap.directories);

  const root = { id: stableId(input.projectId, ''), path: '', kind: 'project-root', label: input.projectId, parent: null, source: 'repository', metadata: {} };
  const nodes = [root], edges = [], nodeByPath = new Map([['', root]]);
  const addNode = (path, kind, source = 'repository', metadata = {}) => {
    if (!path || nodeByPath.has(path) || nodes.length >= cap.nodes) return null;
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parent = nodeByPath.get(parentPath) || [...nodeByPath.values()].filter(n => n.path && path.startsWith(`${n.path}/`)).sort((a,b)=>b.path.length-a.path.length)[0] || root;
    const node = { id: stableId(input.projectId, path), path, kind, label: path.split('/').at(-1), parent: parent.id, source, metadata };
    nodes.push(node); nodeByPath.set(path, node);
    if (edges.length < cap.edges) edges.push({ id: `contains:${node.id}`, from: parent.id, to: node.id, kind: 'contains', evidence: { source: 'repository-path', path } });
    return node;
  };
  const manifests = [...textByPath.keys()].filter(isManifestPath).sort();
  const parsed = new Map(manifests.map(path => [path, path.endsWith('package.json') ? parseJSON(textByPath.get(path)) : null]));
  const packageManifestByDirectory = new Map();
  const manifestPriority = path => path.endsWith('/package.json') || path === 'package.json' ? 0 : path.endsWith('/Cargo.toml') || path === 'Cargo.toml' ? 1 : path.endsWith('/pyproject.toml') || path === 'pyproject.toml' ? 2 : 3;
  for (const path of manifestPaths) {
    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (!directory) continue;
    const previous = packageManifestByDirectory.get(directory);
    if (!previous || manifestPriority(path) < manifestPriority(previous) || manifestPriority(path) === manifestPriority(previous) && path.localeCompare(previous) < 0) packageManifestByDirectory.set(directory, path);
  }
  const packagePaths = new Set(packageManifestByDirectory.keys());
  for (const path of shallowDirs) addNode(path, packagePaths.has(path) ? 'package' : 'directory', packagePaths.has(path) ? 'manifest' : 'repository', packagePaths.has(path) ? { manifest: packageManifestByDirectory.get(path) } : {});
  for (const path of [...packagePaths].filter(path => path && path.split('/').length <= cap.depth).sort((a,b)=>a.split('/').length-b.split('/').length || a.localeCompare(b))) {
    if (!nodeByPath.has(path)) addNode(path, 'package', 'manifest', { manifest: packageManifestByDirectory.get(path) });
  }
  for (const file of selectedFiles.filter(x => /\.[cm]?[jt]sx?$/.test(x.path)).sort((a,b)=>a.path.localeCompare(b.path))) {
    if (file.path.split('/').length > cap.depth + 1 || nodes.length >= cap.nodes) continue;
    addNode(file.path, 'module');
  }

  // Workspace edges require an explicit declaration and a real package manifest.
  const workspacePairs = new Set();
  for (const manifestPath of manifests) {
    const owner = manifestPath.includes('/') ? manifestPath.slice(0,manifestPath.lastIndexOf('/')) : '';
    const ownerNode = nodeByPath.get(owner) || root;
    const patterns=manifestPath.endsWith('package.json')?workspacePatterns(parsed.get(manifestPath)):manifestPath.endsWith('Cargo.toml')?cargoWorkspacePatterns(textByPath.get(manifestPath)||''):[];
    for (const pattern of patterns) {
      for (const packagePath of [...packagePaths].filter(Boolean).sort()) if (matchesWorkspace(packagePath, [pattern])) {
        const member = nodeByPath.get(packagePath);
        const pair=member?`${ownerNode.id}\n${member.id}`:null;
        if (member && !workspacePairs.has(pair) && edges.length < cap.edges) { workspacePairs.add(pair); edges.push({ id: `workspace:${ownerNode.id}:${member.id}`, from: ownerNode.id, to: member.id, kind: 'workspace-member', evidence: { source: 'manifest', path: manifestPath, declaration: pattern } }); }
      }
    }
  }

  const entryPaths = new Map();
  for (const manifestPath of manifests.filter(p => p.endsWith('package.json'))) {
    const value = parsed.get(manifestPath); if (!value || typeof value !== 'object') continue;
    const base = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1) : '';
    for (const entry of packageEntryValues(value)) {
      if (typeof entry !== 'string') continue;
      const path = normalizePath(`${base}${entry.replace(/^\.\//, '')}`);
      if (path && selectedPaths.has(path) && !entryPaths.has(path)) entryPaths.set(path, { manifestPath, declaration: entry });
    }
  }
  for (const [path, declaration] of [...entryPaths].sort(([a],[b])=>a.localeCompare(b))) {
    if (nodes.length >= cap.nodes) break;
    const entry = nodeByPath.get(path) || addNode(path, 'entry-point', 'manifest');
    if (entry) { entry.kind = 'entry-point'; entry.source = 'manifest'; }
    const parent = entry && nodeByPath.get(entry.parent === root.id ? '' : nodes.find(n => n.id === entry.parent)?.path || '');
    if (entry && parent && edges.length < cap.edges) edges.push({ id: `entry:${parent.id}:${entry.id}`, from: parent.id, to: entry.id, kind: 'entry-of', evidence: { source: 'manifest', path: declaration.manifestPath, declaration: declaration.declaration } });
  }

  // Recognize only literal JS/TS import/export/require specifiers. The original
  // source is discarded immediately; unresolved and external imports are omitted.
  let parsedImports = 0;
  const modulePaths = new Set(nodes.filter(node => node.kind === 'module' || node.kind === 'entry-point').map(node => node.path));
  const resolveLocal = (from, specifier) => {
    if (!specifier.startsWith('.')) return null;
    const base = from.split('/').slice(0, -1), parts = [...base, ...specifier.split('/')], out = [];
    for (const part of parts) { if (!part || part === '.') continue; if (part === '..') { if (!out.length) return null; out.pop(); } else out.push(part); }
    const stem = out.join('/');
    return [stem, ...['.js','.mjs','.cjs','.ts','.tsx','.jsx','.mts','.cts'].map(ext => stem + ext), ...['index.js','index.mjs','index.ts','index.tsx'].map(name => `${stem}/${name}`)].find(path => modulePaths.has(path)) || null;
  };
  const importPairs = new Set();
  for (const [path, text] of [...textByPath].sort(([a],[b])=>a.localeCompare(b))) {
    if (!modulePaths.has(path) || parsedImports >= cap.imports) continue;
    for (const specifier of staticImportSpecifiers(text, cap.imports - parsedImports)) {
      if (parsedImports >= cap.imports) break;
      parsedImports++;
      const targetPath = resolveLocal(path, specifier), from = nodeByPath.get(path), to = targetPath && nodeByPath.get(targetPath);
      if (!from || !to || from.id === to.id) continue;
      const key = `${from.id}\n${to.id}`;
      if (importPairs.has(key) || edges.length >= cap.edges) continue;
      importPairs.add(key); edges.push({ id: `import:${from.id}:${to.id}`, from: from.id, to: to.id, kind: 'imports', evidence: { source: 'static-import', path, specifier } });
    }
  }
  nodes.sort((a,b)=>a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  edges.sort((a,b)=>a.id.localeCompare(b.id));
  const omittedFiles = Math.max(0, files.length - selectedFiles.length);
  const directoryPathSet = new Set(directoryPaths);
  const directoriesIncluded = new Set(nodes.filter(node => directoryPathSet.has(node.path)).map(node => node.path)).size;
  const omittedDirectories = Math.max(0, directoryPaths.length - directoriesIncluded);
  const manifestsOmitted = Math.max(0, manifestsAvailablePaths.length - manifestsRead);
  const sourceFilesOmitted = Math.max(0, sourceAvailablePaths.length - sourceFilesRead);
  const truncated = omittedFiles > 0 || omittedDirectories > 0 || bytes >= cap.bytes || manifestsRead < manifestsAvailablePaths.length || sourceFilesRead < sourceAvailablePaths.length || nodes.length >= cap.nodes || edges.length >= cap.edges || parsedImports >= cap.imports;
  const limitation = `Repository structure is bounded: ${selectedFiles.length} of ${files.length} files entered inspection; ${manifestsAvailablePaths.length} manifests exist, ${manifestPaths.length} were selected and ${manifestsRead} read; ${sourceAvailablePaths.length} supported source files exist, ${sourcePaths.length} were selected and ${sourceFilesRead} read; ${directoriesIncluded} of ${directoryPaths.length} directories were represented.`;
  return {
    version: PROJECT_CONSTELLATION_VERSION, projectId: input.projectId,
    manifestPaths: [...manifestPaths].sort(),
    provenance: { ref, ...(commit ? { commit } : {}), ...(input.scannedAt ? { scannedAt: input.scannedAt } : {}), ...(input.visibility ? { visibility: input.visibility } : {}) }, nodes, edges,
    statistics: { filesAvailable: files.length, filesInspected: selectedFiles.length, filesOmitted: omittedFiles, unsupportedFilesIgnored, directoriesAvailable: directoryPaths.length, directoriesIncluded, directoriesOmitted: omittedDirectories, manifestsAvailable: manifestsAvailablePaths.length, manifestsSelected: manifestPaths.length, manifestsRead, manifestsOmitted, sourceFilesAvailable: sourceAvailablePaths.length, sourceFilesSelected: sourcePaths.length, sourceFilesRead, sourceFilesOmitted, bytesRead: bytes, importsParsed: parsedImports, nodeCount: nodes.length, edgeCount: edges.length, truncated, ...(truncated ? { limitation } : {}) },
  };
}

export function validateProjectConstellation(model) {
  const errors = [];
  if (!model || model.version !== PROJECT_CONSTELLATION_VERSION || !safeId(model.projectId) || !Array.isArray(model.nodes) || model.nodes.length > PROJECT_STRUCTURE_LIMITS.nodes || !Array.isArray(model.edges) || model.edges.length > PROJECT_STRUCTURE_LIMITS.edges || !Array.isArray(model.manifestPaths) || model.manifestPaths.length > PROJECT_STRUCTURE_LIMITS.files) return { valid: false, errors: ['Invalid project constellation or exceeded graph bounds.'] };
  const provenance = model.provenance;
  if (!provenance || typeof provenance !== 'object' || !safeId(provenance.ref) || provenance.ref.length > 256 || provenance.commit !== undefined && (typeof provenance.commit!=='string'||!/^[a-f\d]{7,64}$/i.test(provenance.commit)) || provenance.scannedAt !== undefined && (typeof provenance.scannedAt!=='string'||!Number.isFinite(Date.parse(provenance.scannedAt))||new Date(provenance.scannedAt).toISOString()!==provenance.scannedAt) || provenance.visibility !== undefined && !['public','private'].includes(provenance.visibility)) errors.push('Invalid repository ref provenance.');
  const ids = new Set(), paths = new Set(), nodeById = new Map();
  const manifestPathSet = new Set();
  for (const path of model.manifestPaths) {
    if (!normalizePath(path) || !/(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|go\.mod)$/.test(path) || manifestPathSet.has(path)) errors.push('Invalid selected manifest path inventory.');
    manifestPathSet.add(path);
  }
  for (const node of model.nodes) {
    if (!node || typeof node !== 'object') { errors.push('Invalid structural node.'); continue; }
    const nodeKeys = ['id','path','kind','label','parent','source','metadata'];
    if (Object.keys(node).length !== nodeKeys.length || nodeKeys.some(key=>!Object.hasOwn(node,key)) || !safeId(node.id) || ids.has(node.id) || !normalizePath(node.path) && node.path !== '' || paths.has(node.path) || node.id !== stableId(model.projectId, node.path) || !['project-root','package','directory','module','entry-point'].includes(node.kind) || !safeId(node.label) || !['repository','manifest'].includes(node.source) || !node.metadata || typeof node.metadata !== 'object' || Array.isArray(node.metadata) || Object.keys(node.metadata).some(key=>key!=='manifest') || Object.keys(node.metadata).length > 1 || Object.values(node.metadata).some(value=>!safeId(value))) errors.push('Invalid or duplicate structural node.');
    ids.add(node.id); paths.add(node.path); nodeById.set(node.id,node);
  }
  const roots = model.nodes.filter(x=>x?.kind==='project-root');
  if (roots.length !== 1 || roots[0]?.path !== '' || roots[0]?.parent !== null) errors.push('Exactly one valid project root is required.');
  for (const node of model.nodes) if (node?.kind !== 'project-root') {
    const parent = nodeById.get(node.parent);
    if (!parent || !node.path.startsWith(`${parent.path ? `${parent.path}/` : ''}`) || node.path === parent.path) errors.push('Structural node has an invalid parent.');
  }
  for (const node of model.nodes) {
    if (!node || node.kind !== 'package') continue;
    const manifest = node.metadata?.manifest;
    const validManifestName = typeof manifest === 'string' && /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|go\.mod)$/.test(manifest);
    const manifestDirectory = validManifestName && manifest.includes('/') ? manifest.slice(0, manifest.lastIndexOf('/')) : '';
    if (!validManifestName || manifestDirectory !== node.path || !manifestPathSet.has(manifest)) errors.push('Package node must reference an observed selected manifest in its own repository directory.');
  }
  const depths = new Map();
  const depthOf = (node, visiting = new Set()) => {
    if (!node || visiting.has(node.id)) return PROJECT_STRUCTURE_LIMITS.depth + 1;
    if (depths.has(node.id)) return depths.get(node.id);
    visiting.add(node.id);
    const depth = node.kind === 'project-root' ? 0 : depthOf(nodeById.get(node.parent), visiting) + 1;
    visiting.delete(node.id); depths.set(node.id,depth); return depth;
  };
  if (model.nodes.some(node=>node && depthOf(node)>PROJECT_STRUCTURE_LIMITS.depth)) errors.push('Project structure exceeds the depth limit.');
  const edgeIds = new Set();
  for (const edge of model.edges) {
    if (!edge || typeof edge !== 'object') { errors.push('Invalid structural edge.'); continue; }
    const edgeKeys = ['id','from','to','kind','evidence'];
    const evidence = edge?.evidence, target = nodeById.get(edge?.to);
    const expectedEvidence = edge.kind === 'contains' ? ['source','path'] : edge.kind === 'imports' ? ['source','path','specifier'] : ['source','path','declaration'];
    if (Object.keys(edge).length !== edgeKeys.length || edgeKeys.some(key=>!Object.hasOwn(edge,key)) || !safeId(edge.id) || edgeIds.has(edge.id) || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || !['contains','imports','entry-of','workspace-member'].includes(edge.kind) || !evidence || typeof evidence !== 'object' || Array.isArray(evidence) || Object.keys(evidence).length !== expectedEvidence.length || expectedEvidence.some(key=>!Object.hasOwn(evidence,key)) || !safeId(evidence.path) || evidence.path.length > PROJECT_STRUCTURE_LIMITS.pathLength) errors.push('Invalid structural edge or missing evidence.');
    else if (edge.kind === 'contains' ? evidence.source !== 'repository-path' || evidence.path !== target?.path || nodeById.get(edge.from)?.id !== target?.parent
      : edge.kind === 'imports' ? evidence.source !== 'static-import' || !safeId(evidence.specifier) || !evidence.specifier.startsWith('.') || nodeById.get(edge.from)?.path !== evidence.path
      : evidence.source !== 'manifest' || !safeId(evidence.declaration)) errors.push('Structural edge evidence does not match its relationship kind.');
    edgeIds.add(edge.id);
  }
  const stats = model.statistics;
  const statInt = value => Number.isSafeInteger(value) && value >= 0;
  const statsValid = stats && typeof stats === 'object'
    && stats.nodeCount === model.nodes.length && stats.edgeCount === model.edges.length
    && statInt(stats.filesAvailable) && stats.filesAvailable <= 100000
    && statInt(stats.filesInspected) && stats.filesInspected <= PROJECT_STRUCTURE_LIMITS.files && stats.filesInspected <= stats.filesAvailable
    && statInt(stats.filesOmitted) && stats.filesOmitted === stats.filesAvailable - stats.filesInspected
    && statInt(stats.unsupportedFilesIgnored) && stats.unsupportedFilesIgnored <= stats.filesInspected
    && statInt(stats.directoriesAvailable) && stats.directoriesAvailable <= 100000
    && statInt(stats.directoriesIncluded) && stats.directoriesIncluded <= PROJECT_STRUCTURE_LIMITS.directories && stats.directoriesIncluded <= stats.directoriesAvailable
    && statInt(stats.directoriesOmitted) && stats.directoriesOmitted === stats.directoriesAvailable - stats.directoriesIncluded
    && statInt(stats.manifestsAvailable) && stats.manifestsAvailable <= stats.filesAvailable
    && statInt(stats.manifestsSelected) && stats.manifestsSelected <= stats.filesInspected && stats.manifestsSelected <= stats.manifestsAvailable
    && stats.manifestsSelected === model.manifestPaths.length
    && statInt(stats.manifestsRead) && stats.manifestsRead <= PROJECT_STRUCTURE_LIMITS.manifests && stats.manifestsRead <= stats.manifestsSelected
    && statInt(stats.manifestsOmitted) && stats.manifestsOmitted === stats.manifestsAvailable - stats.manifestsRead
    && statInt(stats.sourceFilesAvailable) && stats.sourceFilesAvailable <= stats.filesAvailable
    && statInt(stats.sourceFilesSelected) && stats.sourceFilesSelected <= stats.filesInspected && stats.sourceFilesSelected <= stats.sourceFilesAvailable
    && stats.manifestsSelected + stats.sourceFilesSelected <= stats.filesInspected
    && statInt(stats.sourceFilesRead) && stats.sourceFilesRead <= stats.sourceFilesSelected
    && statInt(stats.sourceFilesOmitted) && stats.sourceFilesOmitted === stats.sourceFilesAvailable - stats.sourceFilesRead
    && statInt(stats.bytesRead) && stats.bytesRead <= PROJECT_STRUCTURE_LIMITS.bytes
    && statInt(stats.importsParsed) && stats.importsParsed <= PROJECT_STRUCTURE_LIMITS.imports
    && typeof stats.truncated === 'boolean'
    && (!stats.truncated || safeId(stats.limitation))
    && (stats.truncated || stats.limitation === undefined);
  const coverageIncomplete = statsValid && (
    stats.filesOmitted > 0 || stats.directoriesOmitted > 0
    || stats.manifestsRead < stats.manifestsAvailable
    || stats.sourceFilesRead < stats.sourceFilesAvailable
    || stats.bytesRead === PROJECT_STRUCTURE_LIMITS.bytes
    || stats.nodeCount === PROJECT_STRUCTURE_LIMITS.nodes
    || stats.edgeCount === PROJECT_STRUCTURE_LIMITS.edges
    || stats.importsParsed === PROJECT_STRUCTURE_LIMITS.imports
  );
  if (!statsValid || coverageIncomplete && !stats.truncated) errors.push('Invalid project structure statistics or truncation evidence.');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function explainProjectStructuralNode(model, nodeId) {
  if (!validateProjectConstellation(model).valid) return null;
  const node = model.nodes.find(item => item.id === nodeId);
  if (!node) return null;
  return { version: 1, nodeId, kind: node.kind, path: node.path, source: node.source, summary: node.path ? `${node.kind} at ${node.path}.` : `Repository root for ${model.projectId}.`, ...(node.metadata.manifest ? { manifest: node.metadata.manifest } : {}) };
}

export function explainProjectStructuralEdge(model, edgeId) {
  if (!validateProjectConstellation(model).valid) return null;
  const edge = model.edges.find(item => item.id === edgeId);
  if (!edge) return null;
  const from = model.nodes.find(item => item.id === edge.from), to = model.nodes.find(item => item.id === edge.to);
  const summary = edge.kind === 'contains' ? `${to.kind} is represented beneath ${from.kind} by repository path ancestry.`
    : edge.kind === 'workspace-member' ? `${to.path} is declared as a workspace member in ${edge.evidence.path}.`
    : edge.kind === 'entry-of' ? `${edge.evidence.declaration} is declared as a package entry in ${edge.evidence.path}.`
    : `${from.path} has a static relative import of ${to.path}.`;
  return { version: 1, edgeId, kind: edge.kind, from: edge.from, to: edge.to, summary, evidence: structuredClone(edge.evidence) };
}
