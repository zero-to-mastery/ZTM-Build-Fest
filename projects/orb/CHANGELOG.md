# Changelog

All notable changes to orb are written here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and orb follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-16

The first release.

### Added

#### Sessions and worktrees

- Sessions across all your projects, each in the project's checkout or its own git worktree under `~/.orb/worktrees/`, made from a freshly fetched base branch.
- A new worktree's `orb/<hex>` branch is renamed after the agent's title once its first turn ends.
- The projects screen (`<C-g> P`) adds and removes projects; the workspace and branch pickers (`<C-g> w`, `<C-g> b`) move a session.
- Settling a session (`s`) stops its panes and moves it to the Settled shelf. `⏎` brings back its tabs and splits and resumes each agent with `claude --resume` or `pi --session-id`.
- Worktrees nothing uses, or whose sessions were all settled at least 3 days ago, are pruned at start and every hour. The worktree picker (`<C-g> W`) shows each worktree's size, changes and users, and deletes one.
- Incognito sessions (`<C-g> i`) in `/tmp/orb-incognito/` for a quick question outside any project.

#### Panes, tabs and layouts

- Tabs of split panes. Every pane runs under zmx, so quitting or updating orb leaves its programs running, and orb reattaches them at start.
- Alt keys move between panes and tabs, add and close panes, grow and shrink them, and switch the tab's layout (vertical, horizontal, stacked, half-stacked).
- `<C-g> p` splits, stacks, zooms and renames panes; `<C-g> t` manages tabs.
- Resize mode (`<C-g> r`) and move mode (`<C-g> m`).
- Floating panes per session (`Alt f`), with staggered, enlarged and spread layouts.
- 10 000 lines of history per pane, and dragging over text copies it to the clipboard.
- The mouse: click to focus panes, pick rows and switch tabs, and scroll history with the wheel.
- Images that a pane's program draws with kitty's graphics protocol show inside orb when orb runs in kitty.

#### Agents

- Claude Code and pi agents started in any pane show in the sidebar with their status: working, needs approval, needs input, idle or done.
- `orb integration install` sets up the Claude Code hook, the pi extension and the `orb` skill.
- A desktop notification when an agent finishes or needs you while orb isn't focused, on macOS and Linux.
- Sounds when an agent needs you and when one finishes.

#### Sidebar

- One card per session with a row per agent, each with its status, title and a mark for its tool (`✳` Claude Code, `π` pi).
- Pin, rename, delete, fold and search (`/`) sessions; show one project's sessions (`<C-g> f`); hide the sidebar (`<C-g> e`) or resize it.
- A jump list (`<C-[>`, `<C-]>`) that keeps the newest 20 places across restarts.

#### Pickers and search

- A session picker (`<C-g> Space`) with a preview of each chat and filters for blocked, working, idle and settled agents.
- Transcript search (`<C-g> /`) over every prompt and reply from Claude Code and pi, newest first; `⏎` jumps to the session.
- A which-key popup that lists the keys after `<C-g>`.

#### Control API and colonies

- `orb session`, `orb tab`, `orb pane` and `orb agent` commands let an agent list, create, split, focus, prompt, wait on and read panes and agents, with JSON replies.
- Worlds and colonies: `<C-g> c` starts a colony, a session for an orchestrator agent. Sessions it makes with `orb session create` become its colonists and fold under it in the sidebar.
- Built-in Research and Learn worlds, where each colony gets its own folder copied from a kit.

#### Look

- A LazyVim look in tokyonight-moon: an explorer-style sidebar, a lualine-style mode line, which-key and select pickers, a start screen, and a message box for errors and notices.

#### Install and packaging

- A one-command installer that puts orb and zmx in `~/.local/bin` after checking their checksums, sets up the integrations, and offers to install kitty and add orb's Cmd keys to kitty.conf.
- Prebuilt binaries for macOS and Linux, on aarch64 and x86_64, on every release.
- `orb --version`.
- orb backs up its saved data before upgrading it, and won't open data from a newer orb.
- A log in `~/.orb/orb.log`. A crash restores the terminal and leaves the panes running.

[0.1.0]: https://github.com/zqccer/orb/releases/tag/v0.1.0
