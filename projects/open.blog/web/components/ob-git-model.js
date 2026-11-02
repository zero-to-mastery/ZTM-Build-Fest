// A tiny in-memory Git model for <ob-git-sandbox>. Pure functions: every command takes a
// state and returns { state, output, error }. Nothing here touches the DOM or the network.
//
// Simplifications, stated to the reader by the sandbox: each commit edits exactly one file
// (README.md unless `-f name` is given), and a file counts as changed on both sides of a merge
// when each side edited it after the merge base, which is how conflicts arise.

const DEFAULT_FILE = "README.md";
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function initialState() {
  const id = hash("root", 0);
  return {
    counter: 1,
    commits: { [id]: { id, parents: [], message: "Start project", tree: { [DEFAULT_FILE]: id } } },
    branches: { main: id },
    head: "main",
    merging: null,
  };
}

function hash(seed, counter) {
  let h = 2166136261;
  for (const ch of `${seed}:${counter}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 7);
}

export function tokenize(line) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(line))) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

export function headCommit(state) {
  return state.branches[state.head] ?? state.head;
}

function ancestors(state, id) {
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const next = stack.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...state.commits[next].parents);
  }
  return seen;
}

export function depths(state) {
  const memo = {};
  const depth = (id) => (memo[id] ??= state.commits[id].parents.length
    ? 1 + Math.max(...state.commits[id].parents.map(depth))
    : 0);
  Object.keys(state.commits).forEach(depth);
  return memo;
}

function mergeBase(state, a, b) {
  const common = [...ancestors(state, a)].filter((id) => ancestors(state, b).has(id));
  const level = depths(state);
  return common.sort((x, y) => level[y] - level[x])[0];
}

function reply(state, output = "") {
  return { state, output, error: false };
}

function fail(state, output) {
  return { state, output, error: true };
}

function commitOn(state, { message, file, parents, tree }) {
  const id = hash(message + parents.join(), state.counter);
  const commit = { id, parents, message, tree: { ...tree, ...(file ? { [file]: id } : {}) } };
  return { commit, state: { ...state, counter: state.counter + 1, commits: { ...state.commits, [id]: commit } } };
}

function advanceHead(state, id) {
  return state.head in state.branches
    ? { ...state, branches: { ...state.branches, [state.head]: id } }
    : { ...state, head: id };
}

function resolveRef(state, name) {
  if (name in state.branches) return state.branches[name];
  const matches = Object.keys(state.commits).filter((id) => id.startsWith(name));
  return name.length >= 4 && matches.length === 1 ? matches[0] : null;
}

function commit(state, args) {
  let message = null;
  let file = DEFAULT_FILE;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-m") message = args[++i];
    else if (args[i] === "-f") file = args[++i];
  }
  const tip = state.commits[headCommit(state)];
  if (state.merging) {
    if (state.merging.conflicts.length) {
      return fail(state, `error: Committing is not possible because you have unmerged files:\n  ${state.merging.conflicts.join("\n  ")}\nUse "resolve --ours <file>" or "resolve --theirs <file>", or "git merge --abort".`);
    }
    const theirs = state.commits[state.merging.theirs];
    const merged = commitOn(state, {
      message: message ?? `Merge branch '${state.merging.name}'`,
      parents: [tip.id, theirs.id], tree: state.merging.tree,
    });
    const next = advanceHead({ ...merged.state, merging: null }, merged.commit.id);
    return reply(next, `[${state.head} ${merged.commit.id}] ${merged.commit.message}`);
  }
  if (!file || file.startsWith("-")) return fail(state, "error: -f needs a file name.");
  const made = commitOn(state, { message: message ?? `Update ${file}`, file, parents: [tip.id], tree: tip.tree });
  return reply(advanceHead(made.state, made.commit.id), `[${state.head} ${made.commit.id}] ${made.commit.message}\n 1 file changed (${file})`);
}

function branch(state, args) {
  if (!args.length) {
    return reply(state, Object.keys(state.branches).map((n) => `${n === state.head ? "*" : " "} ${n}`).join("\n"));
  }
  const name = args[0];
  if (!BRANCH_NAME.test(name) || name.endsWith("/") || name.includes("..")) return fail(state, `fatal: '${name}' is not a valid branch name.`);
  if (name in state.branches) return fail(state, `fatal: a branch named '${name}' already exists.`);
  return reply({ ...state, branches: { ...state.branches, [name]: headCommit(state) } }, `Created branch ${name} at ${headCommit(state)}.`);
}

function switchTo(state, args) {
  if (state.merging) return fail(state, "error: you need to resolve your current merge first (commit it or run git merge --abort).");
  const create = args[0] === "-c" || args[0] === "-b";
  const name = create ? args[1] : args[0];
  if (!name) return fail(state, "fatal: missing branch name.");
  if (create) {
    const made = branch(state, [name]);
    if (made.error) return made;
    return reply({ ...made.state, head: name }, `Switched to a new branch '${name}'`);
  }
  if (name in state.branches) return reply({ ...state, head: name }, `Switched to branch '${name}'`);
  const id = resolveRef(state, name);
  if (!id) return fail(state, `fatal: invalid reference: ${name}`);
  return reply({ ...state, head: id }, `HEAD is now at ${id} (detached).\nCommits made here belong to no branch. Create one with "git switch -c <name>".`);
}

function merge(state, args) {
  if (args[0] === "--abort") {
    if (!state.merging) return fail(state, "fatal: There is no merge to abort.");
    return reply({ ...state, merging: null }, "Merge aborted. HEAD is back where it was.");
  }
  if (state.merging) return fail(state, "fatal: you have not concluded your merge. Finish with git commit or run git merge --abort.");
  const noFf = args.includes("--no-ff");
  const name = args.find((arg) => !arg.startsWith("-"));
  if (!name) return fail(state, "fatal: missing branch to merge.");
  const theirs = resolveRef(state, name);
  if (!theirs) return fail(state, `merge: ${name} - not something we can merge`);
  const ours = headCommit(state);
  if (ancestors(state, ours).has(theirs)) return reply(state, "Already up to date.");
  if (ancestors(state, theirs).has(ours) && !noFf) {
    return reply(advanceHead(state, theirs), `Fast-forward: ${state.head} moved from ${ours} to ${theirs}. No merge commit was needed.`);
  }
  const base = state.commits[mergeBase(state, ours, theirs)].tree;
  const mine = state.commits[ours].tree;
  const other = state.commits[theirs].tree;
  const tree = {};
  const conflicts = [];
  for (const file of new Set([...Object.keys(mine), ...Object.keys(other)])) {
    if (mine[file] === other[file] || other[file] === base[file]) tree[file] = mine[file];
    else if (mine[file] === base[file]) tree[file] = other[file];
    else {
      tree[file] = mine[file];
      conflicts.push(file);
    }
  }
  const clean = { ...state, merging: { name, theirs, tree, conflicts } };
  if (conflicts.length) {
    return fail(clean, `CONFLICT: both sides changed ${conflicts.join(", ")} since they diverged.\nAutomatic merge failed. Pick a side with "resolve --ours <file>" or "resolve --theirs <file>", then git commit. Or give up with git merge --abort.`);
  }
  return commit(clean, ["-m", `Merge branch '${name}'`]);
}

function resolve(state, args) {
  if (!state.merging) return fail(state, "resolve: there is no merge in progress.");
  const side = args[0];
  const file = args[1];
  if (!["--ours", "--theirs"].includes(side) || !file) return fail(state, "usage: resolve --ours|--theirs <file>");
  if (!state.merging.conflicts.includes(file)) return fail(state, `resolve: ${file} is not in conflict.`);
  const source = side === "--ours" ? headCommit(state) : state.merging.theirs;
  const merging = {
    ...state.merging,
    tree: { ...state.merging.tree, [file]: state.commits[source].tree[file] },
    conflicts: state.merging.conflicts.filter((name) => name !== file),
  };
  return reply({ ...state, merging }, `Resolved ${file} using ${side.slice(2)}. ${merging.conflicts.length ? `${merging.conflicts.length} left.` : "Now run git commit."}`);
}

function log(state) {
  const tips = new Map();
  for (const [name, id] of Object.entries(state.branches)) tips.set(id, [...(tips.get(id) ?? []), name]);
  const level = depths(state);
  const lines = Object.values(state.commits)
    .sort((a, b) => level[b.id] - level[a.id] || b.id.localeCompare(a.id))
    .map((c) => {
      const refs = (tips.get(c.id) ?? []).filter((n) => n !== state.head);
      if (c.id === headCommit(state)) refs.unshift(state.head in state.branches ? `HEAD -> ${state.head}` : "HEAD");
      const label = refs.length ? ` (${refs.join(", ")})` : "";
      return `${c.id}${label} ${c.message}`;
    });
  return reply(state, lines.join("\n"));
}

function status(state) {
  const where = state.head in state.branches ? `On branch ${state.head}` : `HEAD detached at ${state.head}`;
  if (!state.merging) return reply(state, `${where}\nnothing to commit, working tree clean`);
  return reply(state, `${where}\nYou are merging '${state.merging.name}'.\n${state.merging.conflicts.length ? `Unmerged paths:\n  ${state.merging.conflicts.join("\n  ")}` : "All conflicts fixed: run git commit."}`);
}

const HELP = [
  "git commit [-m \"message\"] [-f file]   record a snapshot (sandbox: each commit edits one file)",
  "git branch [name]                       list branches, or create one here",
  "git switch [-c] <branch|id>             move HEAD (-c creates the branch first)",
  "git merge [--no-ff] <branch>            bring another branch into this one",
  "git merge --abort                       cancel a conflicted merge",
  "resolve --ours|--theirs <file>          sandbox shortcut for fixing a conflict",
  "git log                                 list commits, newest first",
  "git status                              say where HEAD is and what is pending",
  "reset                                   start over",
].join("\n");

export function run(state, line) {
  const tokens = tokenize(line.trim());
  if (!tokens.length) return reply(state);
  if (tokens[0] === "reset") return reply(initialState(), "Sandbox reset.");
  if (tokens[0] === "resolve") return resolve(state, tokens.slice(1));
  if (tokens[0] === "help") return reply(state, HELP);
  if (tokens[0] !== "git") return fail(state, `${tokens[0]}: not a sandbox command. Type help.`);
  const [, command, ...args] = tokens;
  switch (command) {
    case "commit": return commit(state, args);
    case "branch": return branch(state, args);
    case "switch":
    case "checkout": return switchTo(state, args);
    case "merge": return merge(state, args);
    case "log": return log(state);
    case "status": return status(state);
    default: return fail(state, `git: '${command ?? ""}' is not available in this sandbox. Type help.`);
  }
}

// Positions for drawing: x by generation, y by branch lane (main on top).
export function layout(state) {
  const level = depths(state);
  const lanes = {};
  const order = ["main", ...Object.keys(state.branches).filter((n) => n !== "main")];
  order.forEach((name, lane) => {
    for (let id = state.branches[name]; id && !(id in lanes); id = state.commits[id].parents[0]) lanes[id] = lane;
  });
  for (const id of Object.keys(state.commits)) lanes[id] ??= 0;
  const nodes = Object.keys(state.commits).map((id) => ({ id, x: level[id], y: lanes[id] }));
  return { nodes, columns: Math.max(...nodes.map((n) => n.x)) + 1, rows: Math.max(...nodes.map((n) => n.y)) + 1 };
}
