export function scalingOptions(options = {}) {
  const { nodeCap = 256, simplifyAbove = 256 } = options;
  if (!Number.isInteger(nodeCap) || nodeCap < 1 || nodeCap > 2048) throw new Error('nodeCap must be an integer from 1 through 2048.');
  if (!Number.isInteger(simplifyAbove) || simplifyAbove < 16 || simplifyAbove > 2048) throw new Error('simplifyAbove must be an integer from 16 through 2048.');
  return { nodeCap, simplifyAbove };
}

export function ringOccupancy(stars) {
  const cells = new Map();
  stars.forEach((star, index) => {
    const key = `${Math.floor(star.x)}:${Math.floor(star.y)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(index);
  });
  return (x, y) => {
    const candidates = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) candidates.push(...(cells.get(`${Math.floor(x) + dx}:${Math.floor(y) + dy}`) || []));
    return candidates.sort((a, b) => a - b).filter(i => Math.hypot(stars[i].x - x, stars[i].y - y) < 1).map(i => stars[i].repo.full_name);
  };
}

// A sparse overview retains actual relationships with bounded SVG edge counts.
export function overviewEdges(repos, basis) {
  const groups = new Map(), edges = new Map();
  const add = (key, i) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(i); };
  repos.forEach((repo, i) => {
    if (repo.hidden) return;
    if (basis === 'membership') {
      if (repo.kind === 'repository') add(`m:${repo.name}`, i);
      else for (const member of repo.members) add(`m:${member}`, i);
    } else if (basis === 'repositories') for (const member of repo.members) add(`m:${member}`, i);
    else {
      if (basis !== 'topics') for (const language of repo.languages) add(`l:${language}`, i);
      if (basis !== 'languages') for (const topic of repo.topics) add(`t:${topic}`, i);
    }
  });
  for (const [group, members] of groups) {
    const sorted = [...new Set(members)].sort((a, b) => repos[a].name.localeCompare(repos[b].name));
    for (let i = 1; i < sorted.length; i++) {
      const from = sorted[i - 1], to = sorted[i];
      if (basis === 'membership' && repos[from].kind !== 'repository' && repos[to].kind !== 'repository') continue;
      const key = `${Math.min(from, to)}:${Math.max(from, to)}`;
      if (!edges.has(key)) edges.set(key, { from, to, languages: [], topics: [], members: [], primary: false });
      edges.get(key)[group.startsWith('l:') ? 'languages' : group.startsWith('t:') ? 'topics' : 'members'].push(group.slice(2));
    }
  }
  return [...edges.values()].slice(0, repos.length * 4);
}
