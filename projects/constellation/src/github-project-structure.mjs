import { createProjectConstellation, PROJECT_STRUCTURE_LIMITS } from './project-constellation.mjs';

const API = 'https://api.github.com';
const MAX_TREE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TREE_ITEMS = 100000;
const safeRepoPath = path => typeof path==='string' && path.length<=PROJECT_STRUCTURE_LIMITS.pathLength && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(part=>part&&part!=='.'&&part!=='..');

function declaredPackageEntries(manifest) {
  const entries=[manifest?.main,manifest?.module,manifest?.types,manifest?.typings,manifest?.source,...(typeof manifest?.bin==='string'?[manifest.bin]:Object.values(manifest?.bin||{}))].filter(value=>typeof value==='string');
  const pending=[manifest?.exports]; let visited=0, strings=0;
  while(pending.length&&visited<128&&strings<32){
    const value=pending.pop(); visited++;
    if(typeof value==='string'){entries.push(value);strings++;}
    else if(Array.isArray(value))pending.push(...value.slice(0,32).reverse());
    else if(value&&typeof value==='object')for(const key of Object.keys(value).sort().slice(0,32).reverse())pending.push(value[key]);
  }
  return entries.slice(0,40);
}

async function readBoundedJSON(response, maxBytes) {
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429
    ? 'GitHub rate limit reached while loading project structure.'
    : `GitHub could not load project structure (${response.status}).`);
  const length=Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length>maxBytes) throw new Error('GitHub project structure response exceeded the acquisition byte limit.');
  let text;
  if (response.body?.getReader) {
    const reader=response.body.getReader(), chunks=[]; let total=0;
    try {
      while (true) {
        const {done,value}=await reader.read(); if(done) break;
        total+=value.byteLength;
        if(total>maxBytes){ await reader.cancel(); throw new Error('GitHub project structure response exceeded the acquisition byte limit.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock?.(); }
    const bytes=new Uint8Array(total); let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    text=new TextDecoder().decode(bytes);
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).length > maxBytes) throw new Error('GitHub project structure response exceeded the acquisition byte limit.');
  }
  try { return JSON.parse(text); } catch { throw new Error('GitHub returned invalid project structure data.'); }
}

/** Explicit opt-in GitHub acquisition. fetchImpl should be the existing session
 * and request-cache fetch path so auth isolation, cooldowns, and cancellation
 * remain owned by the browser host. */
export async function fetchGitHubProjectConstellation({ projectId, ref = null, fetchImpl, signal, limits, authenticated = false } = {}) {
  if (typeof projectId !== 'string' || !/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(projectId)) throw new Error('Project ID must be owner/repository.');
  if (typeof fetchImpl !== 'function') throw new Error('Pass the existing GitHub session/request-cache fetch function.');
  const [owner, repo] = projectId.split('/');
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner) || repo==='.' || repo==='..' || !/^[\w.-]{1,100}$/.test(repo)) throw new Error('Project ID must contain a valid GitHub owner and repository.');
  const scannedAt=new Date().toISOString();
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const request = async endpoint => fetchImpl(`${API}${endpoint}`, { headers, signal, credentials: 'omit', redirect: 'error' });
  const repository = await readBoundedJSON(await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`), 128 * 1024);
  const resolvedRef = String(ref || repository.default_branch || 'HEAD');
  if (resolvedRef.length > 256 || /[\x00-\x20]/.test(resolvedRef)) throw new Error('Invalid Git ref.');
  const commit = await readBoundedJSON(await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(resolvedRef)}`), 256 * 1024);
  const commitSha = commit.sha;
  const treeSha = commit.commit?.tree?.sha;
  if (!/^[a-f\d]{40}$/i.test(commitSha || '') || !/^[a-f\d]{40}$/i.test(treeSha || '')) throw new Error('GitHub returned incomplete commit provenance.');
  const tree = await readBoundedJSON(await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${treeSha}?recursive=1`), MAX_TREE_RESPONSE_BYTES);
  if (!Array.isArray(tree.tree) || tree.tree.length > MAX_TREE_ITEMS) throw new Error('GitHub repository tree exceeded the acquisition item limit.');
  if (tree.truncated) throw new Error('GitHub truncated the repository tree; project structure cannot be represented as complete.');
  const items = tree.tree.filter(item => (item.type === 'blob' || item.type === 'tree') && safeRepoPath(item.path));
  const byteLimit=Number.isSafeInteger(limits?.bytes)&&limits.bytes>0?Math.min(limits.bytes,PROJECT_STRUCTURE_LIMITS.bytes):PROJECT_STRUCTURE_LIMITS.bytes;
  const manifestLimit=Number.isSafeInteger(limits?.manifests)&&limits.manifests>0?Math.min(limits.manifests,authenticated?24:8):authenticated?24:8;
  const availableFiles = items.filter(item => item.type === 'blob').sort((a, b) => a.path.localeCompare(b.path));
  const availablePaths = new Set(availableFiles.map(item => item.path));
  const manifestPaths = availableFiles.filter(item => /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|go\.mod)$/.test(item.path)).slice(0, manifestLimit);
  const contents = {};
  let totalBytes = 0, manifestCount = 0;
  const fetchContent = async (path, manifest, knownSize = null) => {
    signal?.throwIfAborted();
    const contentLimit = manifest ? PROJECT_STRUCTURE_LIMITS.manifestBytes : PROJECT_STRUCTURE_LIMITS.sourceFileBytes;
    if (totalBytes >= byteLimit || Number.isSafeInteger(knownSize) && (knownSize > contentLimit || knownSize > byteLimit - totalBytes)) return;
    const response = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(commitSha)}`);
    const responseLimit = Math.min(Math.ceil(contentLimit * 4 / 3) + 4096, Math.ceil((byteLimit - totalBytes) * 4 / 3) + 4096);
    const item = await readBoundedJSON(response, responseLimit);
    if (item.encoding !== 'base64' || typeof item.content !== 'string') return;
    const decoded = atob(item.content.replace(/\s/g, ''));
    const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
    if (bytes.byteLength > contentLimit || totalBytes + bytes.byteLength > byteLimit) return;
    totalBytes += bytes.byteLength;
    if (manifest) manifestCount++;
    contents[path] = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  };
  for (const item of manifestPaths) {
    if (manifestCount >= manifestLimit) break;
    await fetchContent(item.path, true, item.size);
  }
  if (authenticated) {
    const entryPaths = new Set();
    for (const [manifestPath, text] of Object.entries(contents)) {
      if (!manifestPath.endsWith('/package.json') && manifestPath !== 'package.json') continue;
      let manifest; try { manifest = JSON.parse(text); } catch { continue; }
      const base = manifestPath.includes('/') ? manifestPath.slice(0,manifestPath.lastIndexOf('/')+1) : '';
      for (const value of declaredPackageEntries(manifest)) entryPaths.add(`${base}${value.replace(/^\.\//,'')}`);
    }
    for (const path of [...entryPaths].filter(path=>safeRepoPath(path)&&availablePaths.has(path)).sort().slice(0,16)) {
      const item = availableFiles.find(file => file.path === path);
      await fetchContent(path, false, item?.size);
    }
  }
  return createProjectConstellation({ projectId, ref: resolvedRef, commit: commitSha, scannedAt, visibility: repository.private === true ? 'private' : 'public', tree: items, contents }, limits);
}
