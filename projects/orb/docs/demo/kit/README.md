# Demo kit

Records the README demo (`docs/demo/demo.gif`) with [VHS](https://github.com/charmbracelet/vhs) against a throwaway home at `/private/tmp/orbdemo/home`. Nothing outside that folder is touched.

You need `vhs`, `ttyd`, `ffmpeg`, `zmx`, `python3`, JetBrainsMono Nerd Font and a release build (`cargo build --release`).

```sh
bash docs/demo/kit/rec.sh demo.tape    # reset the home, record, screenshot each scene into shots/
bash docs/demo/kit/sheets.sh           # tile shots/ into 2x2 review sheets
cp docs/demo/kit/demo.gif docs/demo/
```

The tape (about 45 s) shows the sidebar's agents working, waiting and done; a new colony in the Research world whose chief starts three colonists with `orb session create`; the colonists' statuses in the sidebar; approving one colonist's tool call; a floating shell; the `<C-g>` popup; and `<C-g> q`, with every pane still there when orb starts again.

- `setup.py` builds the home: three git repos, a worktree, a Research colony, `orb integration install`, transcripts, and orb's store seeded with live and settled sessions whose panes come back on start.
- `fakeagent.py` (as `fakebin/claude` and `fakebin/pi`) plays scripted sessions. The fake Claude runs orb's hook and answers `claude agents --json --all`; the fake pi writes its pane file and session file. Replies to new prompts are matched by a word in the prompt (`~/.fakeagent/replies.json`). The chief's reply runs the real `orb` CLI against the demo's orb, so its colonists are real sessions.
- `keys.py` sits between VHS and orb. VHS can't send Cmd or kitty keys, so the tape types markers that `keys.py` rewrites: `⌘x` is Alt+x (what Cmd+x sends through kitty's Cmd→Alt maps), `⌃H`/`⌃L` are `<C-g> h`/`<C-g> l`, `⌃[`/`⌃]` are Ctrl+[/], and `🖱x,y;` clicks column x, row y.
- `kill.sh` stops the demo's zmx sessions and fake agents. The zmx sessions live under the demo home, apart from the ones your own orb runs.
