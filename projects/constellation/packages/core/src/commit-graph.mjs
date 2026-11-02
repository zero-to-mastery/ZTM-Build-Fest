const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const palette = ['#67e8f9', '#c4b5fd', '#fda4af', '#86efac', '#fcd34d', '#93c5fd', '#fdba74', '#f0abfc'];
export const authorKey = commit => commit.login ? `github:${commit.login.toLowerCase()}` : `unlinked:${commit.author}`;

export function commitGraph(snapshot) {
  const commits = snapshot.commits, bySha = new Map(commits.map(commit => [commit.sha, commit]));
  const children = new Map(commits.map(commit => [commit.sha, 0]));
  for (const commit of commits) for (const parent of commit.parents) if (children.has(parent)) children.set(parent, children.get(parent) + 1);
  // Children precede parents even when commit clocks are out of order.
  const ordered = [], remaining = new Set(bySha.keys());
  while (remaining.size) {
    const next = commits.find(commit => remaining.has(commit.sha) && children.get(commit.sha) === 0);
    if (!next) throw Error('Invalid cyclic commit history.');
    ordered.push(next); remaining.delete(next.sha);
    for (const parent of next.parents) if (children.has(parent)) children.set(parent, children.get(parent) - 1);
  }
  const lanes = [], nodes = [], contributors = new Map();
  for (const [row, commit] of ordered.entries()) {
    let lane = lanes.indexOf(commit.sha);
    if (lane < 0) { lane = lanes.indexOf(null); if (lane < 0) lane = lanes.length; }
    lanes[lane] = null;
    const key = authorKey(commit);
    if (!contributors.has(key)) contributors.set(key, { key, name: commit.author, login: commit.login, count: 0, color: palette[contributors.size % palette.length], index: contributors.size });
    const contributor = contributors.get(key); contributor.count++;
    nodes.push({ ...commit, row, lane, key, color: contributor.color, authorIndex: contributor.index, x: 32 + lane * 28, y: 100 + row * 48 });
    for (const parent of commit.parents.filter(sha => bySha.has(sha))) {
      if (lanes.includes(parent)) continue;
      let slot = lanes.indexOf(null); if (slot < 0) slot = lanes.length;
      lanes[slot] = parent;
    }
  }
  const positioned = new Map(nodes.map(node => [node.sha, node]));
  const edges = nodes.flatMap(node => node.parents.filter(sha => positioned.has(sha)).map(sha => ({ from: node, to: positioned.get(sha) })));
  return { nodes, edges, contributors: [...contributors.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), boundary: nodes.reduce((n, node) => n + node.parents.filter(sha => !positioned.has(sha)).length, 0), graphWidth: Math.max(120, 65 + Math.max(0, ...nodes.map(node => node.lane)) * 28) };
}

export function renderCommitGraph(snapshot, selectedAuthor = '') {
  const graph = commitGraph(snapshot), width = Math.max(960, graph.graphWidth + 800), height = Math.max(230, graph.nodes.length * 48 + 140);
  const contributor = graph.contributors.find(person => person.key === selectedAuthor);
  const title = `${snapshot.repository} · ${snapshot.branch}`;
  const summary = `${graph.nodes.length} commits · ${graph.contributors.length} authors in loaded history${snapshot.partial ? ' · partial history' : ''}`;
  const edgeMarkup = graph.edges.map(({ from, to }) => `<path d="M${from.x} ${from.y} C${from.x} ${from.y + 24} ${to.x} ${to.y - 24} ${to.x} ${to.y}" stroke="${from.color}" opacity="${selectedAuthor && from.key !== selectedAuthor ? '.1' : '.5'}"/>`).join('');
  const nodes = graph.nodes.map(node => {
    const opacity = selectedAuthor && node.key !== selectedAuthor ? '.22' : '1';
    const missing = node.parents.filter(sha => !graph.nodes.some(other => other.sha === sha)).length;
    return `<g class="commit-node" data-author-index="${node.authorIndex}" opacity="${opacity}"><a href="https://github.com/${escape(snapshot.repository)}/commit/${node.sha}" target="_blank" rel="noopener noreferrer"><title>${escape(`${node.author}${node.login ? '' : ' (unlinked author)'} · ${node.date || 'Date unknown'} · ${node.subject}`)}</title><circle cx="${node.x}" cy="${node.y}" r="${node.parents.length > 1 ? 7 : 5}" fill="${node.color}" stroke="#0b1020" stroke-width="2"/>${node.parents.length > 1 ? `<circle cx="${node.x}" cy="${node.y}" r="2" fill="#0b1020"/>` : ''}<text x="${graph.graphWidth}" y="${node.y - 4}" fill="#edf2ff" font-size="12">${escape(node.subject.length > 80 ? node.subject.slice(0, 79) + '…' : node.subject)}</text><text x="${graph.graphWidth}" y="${node.y + 13}" fill="${node.color}" font-size="10">${escape(`${node.sha.slice(0, 7)} · ${node.login ? '@' : ''}${node.author} · ${node.date?.slice(0, 10) || 'date unknown'}${missing ? ' · earlier history outside view' : ''}`)}</text></a></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="commit-title commit-description"><title id="commit-title">${escape(title)}</title><desc id="commit-description">Commit ancestry graph. ${escape(summary)}. Colors identify authors; double-ring nodes are merges. ${graph.boundary} parent connections continue outside this view.</desc><style>text{font-family:system-ui,sans-serif}a:focus circle{stroke:#fff;stroke-width:3}</style><rect width="100%" height="100%" rx="12" fill="#0b1020"/><text x="24" y="30" fill="#edf2ff" font-size="18">${escape(title)}</text><text x="24" y="52" fill="#9caec9" font-size="11">${escape(summary)}${contributor ? ` · highlighting ${escape(contributor.name)}` : ''}</text><g fill="none" stroke-width="2">${edgeMarkup}</g>${nodes}${!graph.nodes.length ? '<text x="24" y="110" fill="#9caec9">This repository has no commits yet.</text>' : ''}<text x="24" y="${height - 22}" fill="#9caec9" font-size="11">${graph.boundary ? 'Earlier parent commits are outside the loaded history. ' : ''}Authors and counts describe this view, not all repository contributors.</text></svg>`;
}
