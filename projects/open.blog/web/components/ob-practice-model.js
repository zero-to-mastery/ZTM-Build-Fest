// The scripted lessons and checking rules behind <ob-practice-lab>. Pure functions with no DOM:
// `start` makes a session, `submit` takes what the reader typed and returns the terminal lines
// to print. Every command that genuinely does a step's job is accepted, so there is never only one
// right answer.
//
// A step has: `ok`, the accepted commands (each `{ re, out?, why?, keep?, skip?, needs?, unmet? }`,
// `re` being regular-expression source); `side`, valid commands that print something without
// finishing the step (`set` records a flag a later `ok` entry can `need`); `out` and `why`, the
// Git output and the one-line reason; `hint`; `ex`, one accepted command; `alts`, more accepted
// commands that the tests type; `near`/`nearMsg`, a targeted message for a common near-miss; and
// `keep`, which records the quoted commit message for `{log}`. In `out` and `why`, `{m}` is the last
// value the reader typed (a name, message or URL) and `{log}`, `{logfull}`, `{loggraph}` list their commits;
// `{manual}` is a short manual page.
//
// Output flagged `pager: true` that is longer than one screen opens a simulated `less` (as Git does for
// long logs and manual pages): `pagerOpen`, `pagerKey` and `pagerView` model it with the keys readers know.

export const LESSONS = {
  "log-and-branches": {
    "title": "log and branches",
    "steps": [
      {
        "goal": "See the history, one line per commit.",
        "ok": [
          {
            "re": "^git log (?:--oneline|--pretty=oneline|--format=oneline)(?: --graph| --decorate| --all| -\\d+)*$"
          }
        ],
        "ex": "git log --oneline",
        "out": "a1b2c3d (HEAD -> main) Add contact form\n7e8f9a0 Add navigation\n3c4d5e6 Initial commit",
        "why": "`--oneline` squeezes each commit to a short hash plus its message. If Git ever opens a pager, press q to leave.",
        "hint": "Type git log and add the flag that makes it one line per commit.",
        "side": [
          {
            "re": "^git log(?: -\\d+)?$",
            "pager": true,
            "out": "commit a1b2c3d000000000000000000000000000000000 (HEAD -> main)\nAuthor: You <you@example.com>\nDate:   Mon Oct 26 10:03:00 2026 -0400\n\n    Add contact form\n\ncommit 7e8f9a0000000000000000000000000000000000\nAuthor: You <you@example.com>\nDate:   Mon Oct 26 10:02:00 2026 -0400\n\n    Add navigation\n\ncommit 3c4d5e6000000000000000000000000000000000\nAuthor: You <you@example.com>\nDate:   Mon Oct 26 10:01:00 2026 -0400\n\n    Initial commit",
            "after": "That was the long form, shown in a pager. This step wants one line per commit: add --oneline."
          }
        ],
        "alts": [
          "git log --pretty=oneline",
          "git log --oneline --graph"
        ],
        "also": "`git log --oneline --graph` and `--pretty=oneline` work too."
      },
      {
        "goal": "List the branches in this repository.",
        "ok": [
          {
            "re": "^git branch(?: -a| --all| -l| --list| -v| -vv| --verbose)?$"
          }
        ],
        "ex": "git branch",
        "out": "* main",
        "why": "The asterisk marks the branch you are on.",
        "hint": "Just two words: git branch.",
        "alts": [
          "git branch --list",
          "git branch -a"
        ],
        "also": "`git branch --list`, `-a` and `-v` list them too."
      },
      {
        "goal": "Create a branch named testing. Creating it and switching to it in one go is fine too.",
        "ok": [
          {
            "re": "^git branch testing$"
          },
          {
            "re": "^git (?:switch -c|switch --create|checkout -b) testing$",
            "out": "Switched to a new branch 'testing'",
            "why": "That created the branch and moved you onto it in one command. Plain `git branch testing` would have left you on main."
          }
        ],
        "ex": "git branch testing",
        "out": "",
        "why": "A branch is a new label on the current commit. Plain `git branch` leaves you on main.",
        "hint": "git branch followed by the new name, or git switch -c with the name.",
        "alts": [
          "git switch -c testing",
          "git checkout -b testing"
        ],
        "also": "`git switch -c testing` or `git checkout -b testing` create it and move onto it."
      },
      {
        "goal": "Rename testing to testing2.",
        "ok": [
          {
            "re": "^git branch (?:-m|-M|--move) (?:testing )?testing2$"
          }
        ],
        "ex": "git branch -m testing testing2",
        "out": "",
        "why": "`-m` means move (rename): old name first, then the new one. If you are already standing on testing, the old name can be left out.",
        "hint": "git branch -m, then the old name, then the new name.",
        "alts": [
          "git branch --move testing testing2"
        ],
        "also": "From the testing branch, `git branch -m testing2` works too."
      },
      {
        "goal": "Delete the testing2 branch. (Git will not delete the branch you are standing on.)",
        "ok": [
          {
            "re": "^git branch (?:-d|-D|--delete) testing2$"
          }
        ],
        "ex": "git branch -d testing2",
        "out": "Deleted branch testing2 (was a1b2c3d).",
        "why": "`-d` is the safe delete: it refuses if the branch holds work that is not merged anywhere. `-D` forces it.",
        "hint": "git branch -d and the branch name. If you are standing on testing2, run git switch main first.",
        "alts": [
          "git branch -D testing2",
          "git branch --delete testing2"
        ],
        "side": [
          {
            "re": "^git (?:switch|checkout) (?:main|-)$",
            "out": "Switched to branch 'main'"
          }
        ],
        "also": "`-D` and `--delete` work too."
      }
    ]
  },
  "first-time-setup": {
    "title": "first-time setup",
    "steps": [
      {
        "goal": "Set your name. Use any name.",
        "ok": [
          {
            "re": "^git config (?:--global )?user\\.name (?:[\"'](.+)[\"']|(\\S+))$"
          }
        ],
        "ex": "git config --global user.name \"Your Name\"",
        "out": "",
        "why": "Git now stamps `{m}` on every commit you make.",
        "hint": "git config --global user.name \"Your Name\"",
        "alts": [
          "git config user.name Ada",
          "git config --global user.name \"Ada Lovelace\""
        ],
        "also": "Without `--global` it applies to this repository only."
      },
      {
        "goal": "Set your email.",
        "ok": [
          {
            "re": "^git config (?:--global )?user\\.email (?:[\"'](.+@.+)[\"']|(\\S+@\\S+))$"
          }
        ],
        "ex": "git config --global user.email \"you@example.com\"",
        "out": "",
        "why": "Use the same email as your GitHub account so your commits link to you.",
        "hint": "git config --global user.email \"you@example.com\"",
        "near": "user\\.email",
        "nearMsg": "Almost. An email address needs an @ in it.",
        "alts": [
          "git config user.email you@example.com"
        ]
      },
      {
        "goal": "Choose an editor for commit messages (any editor; VS Code is `code --wait`).",
        "ok": [
          {
            "re": "^git config (?:--global )?core\\.editor (?:[\"'](.+)[\"']|(\\S+))$"
          }
        ],
        "ex": "git config --global core.editor \"code --wait\"",
        "out": "",
        "why": "Git will now open `{m}` when it needs a commit message. VS Code needs `--wait` so Git pauses until you close the tab.",
        "hint": "git config --global core.editor \"code --wait\"",
        "alts": [
          "git config --global core.editor vim",
          "git config core.editor \"nano\""
        ],
        "also": "Any editor command is accepted: `vim`, `nano`, `code --wait`."
      },
      {
        "goal": "Open the manual page for git commit.",
        "ok": [
          {
            "re": "^(?:git commit (?:--help|-h)|git help commit|man git-commit)$"
          }
        ],
        "ex": "git commit --help",
        "out": "{manual}",
        "why": "Every Git command has built-in help. You just used a pager: space moves down a page, b back, j and k one line, and q quits.",
        "hint": "git commit followed by --help.",
        "pager": true,
        "alts": [
          "git help commit",
          "man git-commit"
        ],
        "also": "`git help commit` works too."
      }
    ]
  },
  "first-workflow": {
    "title": "your first workflow",
    "steps": [
      {
        "goal": "Turn this folder into a Git repository.",
        "ok": [
          {
            "re": "^git init(?: -b main| --initial-branch[= ]main| \\.)?$"
          }
        ],
        "ex": "git init",
        "out": "Initialized empty Git repository in /home/you/my-project/.git/",
        "why": "`git init` creates the hidden .git folder where all history lives.",
        "hint": "Two words: git init.",
        "alts": [
          "git init -b main",
          "git init ."
        ],
        "also": "`git init -b main` names the first branch as it creates it."
      },
      {
        "goal": "Create README.md containing a title. (echo, printf or touch all work.)",
        "ok": [
          {
            "re": "^echo [\"'].*[\"'] > README\\.md$"
          },
          {
            "re": "^printf [\"'].*[\"'] > README\\.md$"
          },
          {
            "re": "^touch README\\.md$"
          },
          {
            "re": "^echo [\"'].*[\"'] \\| tee README\\.md$"
          }
        ],
        "ex": "echo \"# My Awesome Project\" > README.md",
        "out": "",
        "why": "`>` writes the text into a new file. `touch` would make it empty.",
        "hint": "echo \"# My Awesome Project\" > README.md",
        "alts": [
          "printf \"# My Project\" > README.md",
          "touch README.md"
        ],
        "also": "`touch README.md` creates it empty."
      },
      {
        "goal": "Ask Git what it sees.",
        "ok": [
          {
            "re": "^git status$"
          },
          {
            "re": "^git status (?:-s|--short)$",
            "out": "?? README.md",
            "why": "Short format: ?? means untracked."
          },
          {
            "re": "^git status (?:-sb|-s -b|--short --branch)$",
            "out": "## No commits yet on main\n?? README.md",
            "why": "Short format with the branch line: ?? means untracked."
          }
        ],
        "ex": "git status",
        "out": "On branch main\n\nNo commits yet\n\nUntracked files:\n  (use \"git add <file>...\" to include in what will be committed)\n\tREADME.md\n\nnothing added to commit but untracked files present",
        "why": "Untracked means Git sees the file but is not recording it yet.",
        "hint": "git status.",
        "alts": [
          "git status -s",
          "git status --short --branch"
        ],
        "also": "`git status -s` gives the short form."
      },
      {
        "goal": "Stage README.md.",
        "ok": [
          {
            "re": "^git add (?:\\.\\/)?README\\.md$|^git add (?:\\.|-A|--all|\\*)$"
          }
        ],
        "ex": "git add README.md",
        "out": "",
        "why": "Staging chooses what goes into the next snapshot. Nothing is saved yet.",
        "hint": "git add and the file name (or git add . for everything).",
        "alts": [
          "git add .",
          "git add -A"
        ],
        "also": "`git add .` stages everything in the folder."
      },
      {
        "goal": "Commit with a message in quotes.",
        "ok": [
          {
            "re": "^git commit (?:-m|--message[= ]) ?[\"'](.+)[\"']$"
          }
        ],
        "ex": "git commit -m \"Initial commit with README\"",
        "out": "[main (root-commit) 4f2a9c1] {m}\n 1 file changed, 1 insertion(+)\n create mode 100644 README.md",
        "why": "That is your first snapshot, with a hash that names it.",
        "hint": "git commit -m \"your message\"",
        "keep": true,
        "alts": [
          "git commit --message \"Initial commit\""
        ],
        "also": "`--message` is the long form of `-m`."
      },
      {
        "goal": "Add a second line to README.md (append with >>).",
        "ok": [
          {
            "re": "^echo [\"'].+[\"'] >> README\\.md$"
          },
          {
            "re": "^printf [\"'].+[\"'] >> README\\.md$"
          },
          {
            "re": "^echo [\"'].+[\"'] \\| tee -a README\\.md$"
          }
        ],
        "ex": "echo \"This project demonstrates Git.\" >> README.md",
        "out": "",
        "why": "`>>` appends. A single `>` would have replaced the file.",
        "hint": "echo \"More text\" >> README.md",
        "near": "echo .* > README",
        "nearMsg": "A single > overwrites the file. Use >> to append.",
        "alts": [
          "printf \"more\" >> README.md"
        ]
      },
      {
        "goal": "Review the change before staging it.",
        "ok": [
          {
            "re": "^git diff(?: HEAD)?(?: README\\.md)?$"
          },
          {
            "re": "^git diff --stat$",
            "out": " README.md | 1 +\n 1 file changed, 1 insertion(+)",
            "why": "`--stat` summarises instead of showing every line."
          }
        ],
        "ex": "git diff",
        "out": "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # My Awesome Project\n+This project demonstrates Git.",
        "why": "Lines starting with + were added; lines with - were removed.",
        "hint": "git diff.",
        "alts": [
          "git diff README.md",
          "git diff --stat"
        ],
        "also": "`git diff README.md` limits it to one file."
      },
      {
        "goal": "Stage the change. (Or skip ahead: `git commit -am` stages and commits in one go.)",
        "ok": [
          {
            "re": "^git add (?:\\.\\/)?README\\.md$|^git add (?:\\.|-A|--all|-u|\\*)$"
          },
          {
            "re": "^git commit (?:-m|-am|-a -m|--message[= ]|-a --message[= ]) ?[\"'](.+)[\"']$",
            "skip": 1,
            "keep": true,
            "out": "[main 9d8e7f6] {m}\n 1 file changed, 1 insertion(+)",
            "why": "`-a` stages every already-tracked file for you, so that one command did both the add and the commit."
          }
        ],
        "ex": "git add README.md",
        "out": "",
        "why": "The edit moves from the working directory into the staging area.",
        "hint": "git add README.md, then commit (or git commit -am \"message\" for both at once).",
        "alts": [
          "git add .",
          "git commit -am \"Update README\""
        ],
        "also": "`git commit -am \"message\"` stages tracked files and commits in one go."
      },
      {
        "goal": "Commit it with a message in quotes.",
        "ok": [
          {
            "re": "^git commit (?:-m|-am|-a -m|--message[= ]|-a --message[= ]) ?[\"'](.+)[\"']$"
          }
        ],
        "ex": "git commit -m \"Update README with description\"",
        "out": "[main 9d8e7f6] {m}\n 1 file changed, 1 insertion(+)",
        "why": "Second snapshot saved.",
        "hint": "git commit -m \"your message\"",
        "keep": true,
        "alts": [
          "git commit --message=\"Update README\""
        ]
      },
      {
        "goal": "Show the history. Any of the log formats counts.",
        "ok": [
          {
            "re": "^git log (?:--oneline|--pretty=oneline|--format=oneline)(?: --decorate| --all| -\\d+)*$"
          },
          {
            "re": "^git log --oneline --graph(?: --all| --decorate)*$",
            "out": "{loggraph}"
          },
          {
            "re": "^git log(?: -\\d+| --stat)?$",
            "out": "{logfull}",
            "pager": true
          }
        ],
        "ex": "git log --oneline",
        "out": "{log}",
        "why": "Newest on top. Both of your commits are there. (A long log opens in a pager: q quits it.)",
        "hint": "git log, or git log --oneline for a compact view.",
        "alts": [
          "git log",
          "git log --oneline --graph",
          "git log -2"
        ],
        "also": "Plain `git log` shows the long form with author and date."
      }
    ]
  },
  "branch-and-merge": {
    "title": "branch, merge, clean up",
    "steps": [
      {
        "goal": "Create a branch called feature/login and switch to it. One command, or `git branch` then `git switch`.",
        "ok": [
          {
            "re": "^git (?:switch -c|switch --create|checkout -b) feature\\/login$"
          },
          {
            "re": "^git (?:switch|checkout) feature\\/login$",
            "needs": "created",
            "out": "Switched to branch 'feature/login'",
            "unmet": "error: pathspec 'feature/login' did not match any file(s) known to git. Create the branch first.",
            "why": "Two commands this time: `git branch` made the label, `switch` moved you onto it."
          }
        ],
        "ex": "git switch -c feature/login",
        "out": "Switched to a new branch 'feature/login'",
        "why": "`-c` means create. Without it, switch only moves to a branch that already exists.",
        "hint": "git switch -c and the branch name.",
        "side": [
          {
            "re": "^git branch feature\\/login$",
            "set": "created"
          }
        ],
        "alts": [
          "git checkout -b feature/login",
          [
            "git branch feature/login",
            "git switch feature/login"
          ],
          [
            "git branch feature/login",
            "git checkout feature/login"
          ]
        ],
        "also": "`git checkout -b feature/login`, or `git branch feature/login` followed by `git switch feature/login`."
      },
      {
        "goal": "Commit your work with a message in quotes. (This practice repository already has a staged change.)",
        "ok": [
          {
            "re": "^git commit (?:-m|-am|-a -m|--message[= ]|-a --message[= ]) ?[\"'](.+)[\"']$"
          }
        ],
        "ex": "git commit -m \"Add login form\"",
        "out": "[feature/login 5a6b7c8] {m}\n 1 file changed, 12 insertions(+)",
        "why": "The commit landed on feature/login. main has not moved.",
        "hint": "git commit -m \"Add login form\"",
        "alts": [
          "git commit -am \"Add login\""
        ]
      },
      {
        "goal": "Go back to main.",
        "ok": [
          {
            "re": "^git (?:switch|checkout) (?:main|-)$"
          }
        ],
        "ex": "git switch main",
        "out": "Switched to branch 'main'",
        "why": "Your files now match main again, without the login form.",
        "hint": "git switch main",
        "alts": [
          "git checkout main",
          "git switch -"
        ],
        "also": "`git checkout main` and `git switch -` (previous branch) work too."
      },
      {
        "goal": "Merge feature/login into main.",
        "ok": [
          {
            "re": "^git merge (?:--ff )?feature\\/login$|^git merge --ff-only feature\\/login$"
          },
          {
            "re": "^git merge --no-ff feature\\/login$",
            "out": "Merge made by the 'ort' strategy.\n login.html | 12 ++++++++++++\n 1 file changed, 12 insertions(+)",
            "why": "`--no-ff` forces a merge commit even though a fast-forward was possible, which keeps the branch visible in history."
          }
        ],
        "ex": "git merge feature/login",
        "out": "Updating 1f2e3d4..5a6b7c8\nFast-forward\n login.html | 12 ++++++++++++\n 1 file changed, 12 insertions(+)",
        "why": "Always merge while standing on the branch that should receive the work. main had not moved, so Git slid the label forward: a fast-forward.",
        "hint": "git merge and the branch name, while on main.",
        "alts": [
          "git merge --no-ff feature/login",
          "git merge --ff-only feature/login"
        ],
        "also": "`--no-ff` makes a merge commit anyway."
      },
      {
        "goal": "Delete the finished branch.",
        "ok": [
          {
            "re": "^git branch (?:-d|-D|--delete) feature\\/login$"
          }
        ],
        "ex": "git branch -d feature/login",
        "out": "Deleted branch feature/login (was 5a6b7c8).",
        "why": "The work is safe on main. The label was all that you deleted.",
        "hint": "git branch -d feature/login",
        "alts": [
          "git branch -D feature/login",
          "git branch --delete feature/login"
        ]
      }
    ]
  },
  "remote-roundtrip": {
    "title": "connect, push, fetch, pull",
    "steps": [
      {
        "goal": "Add a remote named origin pointing at a repository URL (for example https://github.com/you/demo.git).",
        "ok": [
          {
            "re": "^git remote add origin (\\S+)$"
          }
        ],
        "ex": "git remote add origin https://github.com/you/demo.git",
        "out": "",
        "why": "origin is the conventional nickname for the main remote.",
        "hint": "git remote add origin followed by the URL.",
        "alts": [
          "git remote add origin git@github.com:you/demo.git"
        ]
      },
      {
        "goal": "List your remotes with their URLs.",
        "ok": [
          {
            "re": "^git remote (?:-v|--verbose)$"
          },
          {
            "re": "^git remote show origin$",
            "out": "* remote origin\n  Fetch URL: {m}\n  Push  URL: {m}\n  HEAD branch: main",
            "why": "`show` gives the long report for one remote."
          }
        ],
        "ex": "git remote -v",
        "out": "origin\t{m} (fetch)\norigin\t{m} (push)",
        "why": "Two lines per remote: one URL for downloading, one for uploading.",
        "hint": "git remote -v",
        "near": "^git remote$",
        "nearMsg": "That lists only the names. Add -v to see the URLs too.",
        "alts": [
          "git remote --verbose",
          "git remote show origin"
        ]
      },
      {
        "goal": "Push main to origin. Remember it as the upstream if you can.",
        "ok": [
          {
            "re": "^git push (?:-u|--set-upstream) origin (?:main|HEAD)$"
          },
          {
            "re": "^git push origin main$",
            "out": "To {m}\n * [new branch]      main -> main",
            "why": "It worked, but Git did not remember the link. Next time use `-u` so a plain `git push` and `git pull` know where to go."
          }
        ],
        "ex": "git push -u origin main",
        "out": "To {m}\n * [new branch]      main -> main\nbranch 'main' set up to track 'origin/main'.",
        "why": "`-u` links local main to origin/main, so a plain git push works next time.",
        "hint": "git push -u origin main",
        "alts": [
          "git push --set-upstream origin main",
          "git push origin main",
          "git push -u origin HEAD"
        ]
      },
      {
        "goal": "A teammate pushed. Download their work without changing your files.",
        "ok": [
          {
            "re": "^git fetch(?: origin(?: main)?| --all)?$"
          }
        ],
        "ex": "git fetch origin",
        "out": "From {m}\n   a1b2c3d..e4f5a6b  main       -> origin/main",
        "why": "Your branch has not changed. Git only updated its picture of the remote.",
        "hint": "git fetch origin",
        "alts": [
          "git fetch",
          "git fetch --all",
          "git fetch origin main"
        ]
      },
      {
        "goal": "Now bring those commits into your branch.",
        "ok": [
          {
            "re": "^git pull(?: origin main| --ff-only| --rebase(?: origin main)?)?$"
          },
          {
            "re": "^git merge origin\\/main$",
            "out": "Updating a1b2c3d..e4f5a6b\nFast-forward\n README.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
            "why": "That is exactly what `git pull` does after its fetch: merge origin/main into your branch."
          }
        ],
        "ex": "git pull",
        "out": "Updating a1b2c3d..e4f5a6b\nFast-forward\n README.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
        "why": "`git pull` is `git fetch` followed by a merge (or a rebase with `--rebase`).",
        "hint": "git pull, or git merge origin/main since you already fetched.",
        "alts": [
          "git pull --rebase",
          "git pull origin main",
          "git merge origin/main"
        ]
      }
    ]
  },
  "stash": {
    "title": "stash",
    "steps": [
      {
        "goal": "Park your uncommitted changes.",
        "ok": [
          {
            "re": "^git stash(?: push| -u| --include-untracked| push -u)?$"
          },
          {
            "re": "^git stash push -m [\"'](.+)[\"']$",
            "out": "Saved working directory and index state On main: {m}",
            "why": "A message makes the stash easy to recognise in the list later."
          }
        ],
        "ex": "git stash",
        "out": "Saved working directory and index state WIP on main: 3f4e5d6 Add header",
        "why": "The directory now matches your last commit again.",
        "hint": "git stash",
        "alts": [
          "git stash push",
          "git stash push -m \"half-done header\"",
          "git stash -u"
        ],
        "also": "`git stash push -m \"message\"` labels it."
      },
      {
        "goal": "List what you have stashed.",
        "ok": [
          {
            "re": "^git stash list$"
          }
        ],
        "ex": "git stash list",
        "out": "stash@{0}: WIP on main: 3f4e5d6 Add header",
        "why": "Newest first. stash@{0} is the most recent.",
        "hint": "git stash list",
        "side": [
          {
            "re": "^git stash show(?: -p)?$",
            "out": " header.css | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)"
          }
        ]
      },
      {
        "goal": "Bring the work back. Pop (restore and drop) or apply (restore and keep) both count.",
        "ok": [
          {
            "re": "^git stash pop(?: stash@\\{0\\})?$"
          },
          {
            "re": "^git stash apply(?: stash@\\{0\\})?$",
            "out": "On branch main\nChanges not staged for commit:\n\tmodified:   header.css",
            "why": "`apply` restored the work and left a copy in the stash list. Use `git stash drop` when you no longer need it."
          }
        ],
        "ex": "git stash pop",
        "out": "On branch main\nChanges not staged for commit:\n\tmodified:   header.css\n\nDropped refs/stash@{0} (b7c8d9e)",
        "why": "`pop` applies and removes. `apply` would keep a copy in the list.",
        "hint": "git stash pop",
        "alts": [
          "git stash apply",
          "git stash pop stash@{0}"
        ]
      }
    ]
  },
  "amend-and-cherry-pick": {
    "title": "amend and cherry-pick",
    "steps": [
      {
        "goal": "You forgot notes.md. Stage it.",
        "ok": [
          {
            "re": "^git add (?:notes\\.md|\\.|-A|--all|\\*)$"
          }
        ],
        "ex": "git add notes.md",
        "out": "",
        "why": "It is staged, but it is not in the last commit yet.",
        "hint": "git add notes.md",
        "alts": [
          "git add .",
          "git add -A"
        ]
      },
      {
        "goal": "Fold it into the last commit. Keeping the message or writing a new one both count.",
        "ok": [
          {
            "re": "^git commit (?:-a )?--amend (?:--no-edit|-C HEAD)$|^git commit --no-edit --amend$"
          },
          {
            "re": "^git commit --amend -m [\"'](.+)[\"']$",
            "out": "[main 8c9d0e1] {m}\n Date: Mon Oct 26 10:00:00 2026 -0400\n 2 files changed, 8 insertions(+)",
            "why": "The new message replaced the old one, and the file joined the commit. The hash changed because it is a new commit object."
          }
        ],
        "ex": "git commit --amend --no-edit",
        "out": "[main 8c9d0e1] Add header\n Date: Mon Oct 26 10:00:00 2026 -0400\n 2 files changed, 8 insertions(+)",
        "why": "The hash changed (8c9d0e1) because the commit is a new object.",
        "hint": "git commit --amend --no-edit to keep the message, or --amend -m \"new message\".",
        "near": "--amend",
        "nearMsg": "Close. A bare --amend opens an editor. Add --no-edit to keep the message, or -m to give a new one.",
        "alts": [
          "git commit --amend -C HEAD",
          "git commit --amend -m \"Add header and notes\""
        ],
        "also": "`git commit --amend -m \"new message\"` rewrites the message too."
      },
      {
        "goal": "Copy commit a1b2c3d from another branch onto this one.",
        "ok": [
          {
            "re": "^git cherry-pick (?:-x )?a1b2c3d[0-9a-f]*$"
          }
        ],
        "ex": "git cherry-pick a1b2c3d",
        "out": "[main 7d8e9f0] Fix header typo\n 1 file changed, 1 insertion(+), 1 deletion(-)",
        "why": "Cherry-pick makes a new commit with the same change and a new hash.",
        "hint": "git cherry-pick followed by the hash.",
        "alts": [
          "git cherry-pick -x a1b2c3d"
        ]
      }
    ]
  },
  "conventional-release": {
    "title": "conventional commits and a release tag",
    "steps": [
      {
        "goal": "Commit a new feature. Start the message with the type feat, then a colon. A scope in brackets is optional.",
        "ok": [
          {
            "re": "^git commit (?:-m|-am|-a -m|--message[= ]) ?[\"']feat(?:\\([\\w./-]+\\))?!?: .+[\"']$"
          }
        ],
        "ex": "git commit -m \"feat(auth): add login form\"",
        "out": "[main 2b3c4d5] {m}\n 1 file changed, 40 insertions(+)",
        "why": "feat tells tools this adds a feature, so it can bump the minor version.",
        "hint": "git commit -m \"feat(auth): add login form\" or git commit -m \"feat: add login form\"",
        "near": "^git commit",
        "nearMsg": "Format it as type: summary, or type(scope): summary, with the type feat. For example feat(auth): add login form.",
        "alts": [
          "git commit -m \"feat: add search\"",
          "git commit -m \"feat(ui)!: redesign nav\"",
          "git commit --message=\"feat(api): add endpoint\""
        ]
      },
      {
        "goal": "Commit a bug fix. Use the type fix, with or without a scope.",
        "ok": [
          {
            "re": "^git commit (?:-m|-am|-a -m|--message[= ]) ?[\"']fix(?:\\([\\w./-]+\\))?!?: .+[\"']$"
          }
        ],
        "ex": "git commit -m \"fix(cart): stop negative quantities\"",
        "out": "[main 6e7f8a9] {m}\n 1 file changed, 3 insertions(+), 1 deletion(-)",
        "why": "fix marks a patch-level change.",
        "hint": "git commit -m \"fix(cart): stop negative quantities\"",
        "near": "^git commit",
        "nearMsg": "Format it as type: summary, or type(scope): summary, with the type fix.",
        "alts": [
          "git commit -m \"fix: handle empty cart\""
        ]
      },
      {
        "goal": "Tag this release v1.1.0. A feature plus a fix is a minor bump from 1.0.0. An annotated tag (-a with a message) is best, but a plain tag works.",
        "ok": [
          {
            "re": "^git tag (?:-a|--annotate) v1\\.1\\.0 -m [\"'].+[\"']$|^git tag -a -m [\"'].+[\"'] v1\\.1\\.0$|^git tag -am [\"'].+[\"'] v1\\.1\\.0$"
          },
          {
            "re": "^git tag v1\\.1\\.0$",
            "why": "That made a lightweight tag: just a name pointing at the commit. An annotated tag (`-a` with `-m`) also records who tagged it, when and why."
          }
        ],
        "ex": "git tag -a v1.1.0 -m \"Release 1.1.0\"",
        "out": "",
        "why": "An annotated tag stores who tagged it, when, and why.",
        "hint": "git tag -a v1.1.0 -m \"Release 1.1.0\"",
        "near": "^git tag",
        "nearMsg": "A feature plus a fix is a minor bump from 1.0.0, so the tag is v1.1.0.",
        "alts": [
          "git tag v1.1.0",
          "git tag -am \"Release\" v1.1.0",
          "git tag --annotate v1.1.0 -m \"Release\""
        ]
      },
      {
        "goal": "Push that tag to origin.",
        "ok": [
          {
            "re": "^git push origin (?:tag )?v1\\.1\\.0$"
          },
          {
            "re": "^git push (?:origin )?--tags$",
            "out": "To https://github.com/you/demo.git\n * [new tag]         v1.1.0 -> v1.1.0",
            "why": "`--tags` pushes every local tag at once. Fine here; naming the tag is safer when you have draft tags lying around."
          }
        ],
        "ex": "git push origin v1.1.0",
        "out": "To https://github.com/you/demo.git\n * [new tag]         v1.1.0 -> v1.1.0",
        "why": "Tags are not pushed with branches by default. You send them by name, or all at once with --tags.",
        "hint": "git push origin v1.1.0",
        "alts": [
          "git push origin tag v1.1.0",
          "git push --tags",
          "git push origin --tags"
        ]
      },
      {
        "goal": "List all tags.",
        "ok": [
          {
            "re": "^git tag(?: -l| --list| -n)?$"
          }
        ],
        "ex": "git tag",
        "out": "v1.0.0\nv1.1.0",
        "why": "Your new tag sits beside the existing v1.0.0, listed alphabetically.",
        "hint": "git tag",
        "alts": [
          "git tag -l",
          "git tag --list"
        ]
      }
    ]
  },
  "undo-and-rescue": {
    "title": "undo and rescue",
    "steps": [
      {
        "goal": "You broke app.js with uncommitted edits. Throw the edits away.",
        "ok": [
          {
            "re": "^git (?:restore (?:app\\.js|\\.)|checkout (?:-- )?(?:app\\.js|\\.))$"
          }
        ],
        "ex": "git restore app.js",
        "out": "",
        "why": "The file is back to its last committed state. Uncommitted work cannot be recovered after this.",
        "hint": "git restore app.js",
        "alts": [
          "git checkout -- app.js",
          "git checkout app.js",
          "git restore ."
        ],
        "also": "`git checkout -- app.js` is the older spelling."
      },
      {
        "goal": "The latest commit introduced a bug but is already pushed. Undo it by adding a new commit.",
        "ok": [
          {
            "re": "^git revert (?:--no-edit )?HEAD(?: --no-edit)?$"
          }
        ],
        "ex": "git revert HEAD",
        "out": "[main 2b3c4d5] Revert \"Break checkout\"\n 1 file changed, 4 deletions(-)",
        "why": "Revert never rewrites history, which is why it is safe on shared branches.",
        "hint": "git revert HEAD",
        "alts": [
          "git revert --no-edit HEAD",
          "git revert HEAD --no-edit"
        ]
      },
      {
        "goal": "Different day: you ran git reset --hard and lost a commit. Look at where HEAD has been.",
        "ok": [
          {
            "re": "^git (?:reflog(?: show)?(?: -n ?\\d+| --all)?|log (?:-g|--walk-reflogs)(?: --oneline)?)$"
          }
        ],
        "ex": "git reflog",
        "out": "2b3c4d5 HEAD@{0}: revert: Revert \"Break checkout\"\n9f8e7d6 HEAD@{1}: reset: moving to HEAD~1\n7c3d9e2 HEAD@{2}: commit: Add payment retry",
        "why": "The lost commit, 7c3d9e2, is still there.",
        "hint": "git reflog",
        "alts": [
          "git reflog show",
          "git log -g --oneline"
        ],
        "also": "`git log -g` reads the same diary."
      },
      {
        "goal": "Get the lost commit 7c3d9e2 back. A new branch pointing at it (call it rescue) is the safest way; reset or cherry-pick also work.",
        "ok": [
          {
            "re": "^git branch (?!-)\\S+ 7c3d9e2$",
            "out": ""
          },
          {
            "re": "^git (?:switch -c|switch --create|checkout -b) (?!-)(\\S+) 7c3d9e2$",
            "out": "Switched to a new branch '{m}'"
          },
          {
            "re": "^git reset --hard 7c3d9e2$",
            "out": "HEAD is now at 7c3d9e2 Add payment retry",
            "why": "`reset --hard` moved your current branch back onto the lost commit. It works, but it also throws away uncommitted changes, so a new branch is the gentler choice."
          },
          {
            "re": "^git cherry-pick 7c3d9e2$",
            "out": "[main 4d5e6f7] Add payment retry\n 1 file changed, 9 insertions(+)",
            "why": "Cherry-pick copied the lost commit onto your branch as a new commit with a new hash."
          }
        ],
        "ex": "git branch rescue 7c3d9e2",
        "out": "",
        "why": "A branch pointing at the commit keeps it reachable, so garbage collection will not remove it.",
        "hint": "git branch rescue 7c3d9e2",
        "alts": [
          "git switch -c rescue 7c3d9e2",
          "git checkout -b rescue 7c3d9e2",
          "git branch saved 7c3d9e2",
          "git reset --hard 7c3d9e2",
          "git cherry-pick 7c3d9e2"
        ]
      }
    ]
  },
  "worktree": {
    "title": "a second folder for a hotfix",
    "steps": [
      {
        "goal": "Create a second folder, ../hotfix, with a new branch called hotfix started from main.",
        "ok": [
          {
            "re": "^git worktree add (?:-b hotfix \\.\\./hotfix|\\.\\./hotfix -b hotfix)(?: main)?$"
          },
          {
            "re": "^git worktree add \\.\\./hotfix hotfix$",
            "needs": "branched",
            "unmet": "There is no branch called hotfix yet. Create it first with git branch hotfix, or let worktree add create it with -b.",
            "out": "Preparing worktree (checking out 'hotfix')\nHEAD is now at 0e55d86 Add checkout",
            "why": "The branch already existed, so Git checked it out into the new folder instead of creating it."
          }
        ],
        "side": [
          {
            "re": "^git branch hotfix(?: main)?$",
            "set": "branched",
            "out": "",
            "after": "The branch exists, but nothing is checked out for it yet. Now add the folder: git worktree add ../hotfix hotfix."
          }
        ],
        "ex": "git worktree add ../hotfix -b hotfix main",
        "out": "Preparing worktree (new branch 'hotfix')\nHEAD is now at 0e55d86 Add checkout",
        "why": "A worktree is a second folder with a branch checked out into it. -b creates the branch at the same time, and your unfinished changes in this folder were not touched.",
        "hint": "git worktree add, then the path ../hotfix, then -b hotfix and the starting branch main.",
        "near": "^git worktree add",
        "nearMsg": "Not that one. Plain 'git worktree add ../hotfix main' fails with: fatal: 'main' is already used by worktree. Create a new branch with -b hotfix instead.",
        "alts": [
          "git worktree add -b hotfix ../hotfix main",
          "git worktree add -b hotfix ../hotfix",
          "git worktree add ../hotfix -b hotfix",
          [
            "git branch hotfix",
            "git worktree add ../hotfix hotfix"
          ]
        ],
        "also": "`git worktree add -b hotfix ../hotfix main`, or `git branch hotfix` and then `git worktree add ../hotfix hotfix`, work too."
      },
      {
        "goal": "List the worktrees.",
        "ok": [
          {
            "re": "^git worktree list$"
          }
        ],
        "ex": "git worktree list",
        "out": "C:/code/shop    0e55d86 [main]\nC:/code/hotfix  0e55d86 [hotfix]",
        "why": "Two folders, two branches, one repository. The first line is the main worktree.",
        "hint": "git worktree list, nothing after it."
      },
      {
        "goal": "Back in this folder, try to switch to the hotfix branch.",
        "ok": [
          {
            "re": "^git (?:switch|checkout) hotfix$"
          }
        ],
        "ex": "git switch hotfix",
        "out": "fatal: 'hotfix' is already used by worktree at 'C:/code/hotfix'",
        "why": "Git refuses on purpose: a branch can be checked out in only one worktree at a time. A commit in one folder would move the branch under the other.",
        "hint": "git switch hotfix.",
        "alts": [
          "git checkout hotfix"
        ]
      },
      {
        "goal": "The fix has been committed in hotfix. From this folder, bring it into main.",
        "ok": [
          {
            "re": "^git merge (?:--ff-only |--ff )?hotfix$"
          }
        ],
        "ex": "git merge hotfix",
        "out": "Updating 0e55d86..0b7d3d7\nFast-forward\n fix.txt | 1 +\n 1 file changed, 1 insertion(+)\n create mode 100644 fix.txt",
        "why": "main had no commits of its own since hotfix started, so it just moves forward. Your unfinished edits are still there.",
        "hint": "git merge and the branch name.",
        "alts": [
          "git merge --ff-only hotfix",
          "git merge --ff hotfix"
        ]
      },
      {
        "goal": "Remove the second folder.",
        "ok": [
          {
            "re": "^git worktree remove (?:--force |-f )?(?:\\.\\./hotfix|C:/code/hotfix)$"
          }
        ],
        "ex": "git worktree remove ../hotfix",
        "out": "",
        "why": "Git deleted the folder and its bookkeeping together. With uncommitted or untracked changes in it, Git refuses unless you add --force.",
        "hint": "git worktree remove and the path of the folder.",
        "near": "^(?:rm|git rm)\\b",
        "nearMsg": "Deleting the folder yourself leaves Git's record behind (git worktree prune cleans it up). Use git worktree remove so both go together.",
        "alts": [
          "git worktree remove --force ../hotfix",
          "git worktree remove C:/code/hotfix"
        ]
      },
      {
        "goal": "Delete the merged hotfix branch.",
        "ok": [
          {
            "re": "^git branch (?:-d|-D|--delete) hotfix$"
          }
        ],
        "ex": "git branch -d hotfix",
        "out": "Deleted branch hotfix (was 0b7d3d7).",
        "why": "-d is the safe delete: it works here because hotfix is merged into main.",
        "hint": "git branch -d and the branch name.",
        "alts": [
          "git branch -D hotfix",
          "git branch --delete hotfix"
        ]
      }
    ]
  },
  "submodule": {
    "title": "a library inside a project",
    "steps": [
      {
        "goal": "Add ../lib.git, a repository next to this one, as a submodule at vendor/lib. A local path is refused for submodules by default, so allow the file transport for this one command.",
        "ok": [
          {
            "re": "^git -c protocol\\.file\\.allow=always submodule add \\.\\./lib\\.git vendor/lib$"
          },
          {
            "re": "^git submodule add \\.\\./lib\\.git vendor/lib$",
            "needs": "allowed",
            "unmet": "fatal: transport 'file' not allowed\nfatal: clone of 'C:/code/lib.git' into submodule path 'C:/code/app/vendor/lib' failed\nGit blocks local-path clones for submodules by default. Allow them for one command with -c protocol.file.allow=always."
          }
        ],
        "side": [
          {
            "re": "^git config --global protocol\\.file\\.allow always$",
            "set": "allowed",
            "out": "",
            "after": "That allows file clones in every repository you use. A -c on a single command is safer. Now add the submodule."
          }
        ],
        "ex": "git -c protocol.file.allow=always submodule add ../lib.git vendor/lib",
        "out": "Cloning into 'C:/code/app/vendor/lib'...\ndone.",
        "why": "The project now has a submodule. With a GitHub URL you would not need the -c part.",
        "hint": "git -c protocol.file.allow=always, then submodule add, the URL ../lib.git and the path vendor/lib.",
        "near": "^git (?:-c \\S+ )?submodule",
        "nearMsg": "Add it with: git submodule add <url> <path>, where the URL is ../lib.git and the path is vendor/lib.",
        "alts": [
          [
            "git config --global protocol.file.allow always",
            "git submodule add ../lib.git vendor/lib"
          ]
        ],
        "also": "`git config --global protocol.file.allow always` and then a plain `git submodule add ../lib.git vendor/lib` works too, but switches the protection off everywhere."
      },
      {
        "goal": "See what Git staged.",
        "ok": [
          {
            "re": "^git status$"
          },
          {
            "re": "^git status (?:-s|--short)$",
            "out": "A  .gitmodules\nA  vendor/lib",
            "why": "Two new entries: .gitmodules, which records where the library comes from, and vendor/lib, which is one pointer to a commit and not a folder of files."
          }
        ],
        "ex": "git status",
        "out": "On branch main\nYour branch is up to date with 'origin/main'.\n\nChanges to be committed:\n  (use \"git restore --staged <file>...\" to unstage)\n\tnew file:   .gitmodules\n\tnew file:   vendor/lib",
        "why": "Two new entries: .gitmodules, which records where the library comes from, and vendor/lib, which is one pointer to a commit and not a folder of files.",
        "hint": "git status, with nothing after it.",
        "alts": [
          "git status -s",
          "git status --short"
        ]
      },
      {
        "goal": "Commit it with a message.",
        "ok": [
          {
            "re": "^git commit (?:-m|-am|-a -m|--message[= ]) ?[\"'](.+)[\"']$"
          }
        ],
        "ex": "git commit -m \"Add lib as a submodule\"",
        "out": "[main 88efc5b] {m}\n 2 files changed, 4 insertions(+)\n create mode 100644 .gitmodules\n create mode 160000 vendor/lib",
        "why": "Mode 160000 is how Git marks an entry that is a commit in another repository. The project stores that commit id, not the library's files.",
        "hint": "git commit -m followed by your message in quotes.",
        "near": "^git commit",
        "nearMsg": "Give the commit a message in quotes: git commit -m \"your message\".",
        "alts": [
          "git commit -am \"Add library\"",
          "git commit --message=\"Add library\""
        ]
      },
      {
        "goal": "Clone the project as a teammate would, into a folder called bob, so that vendor/lib is filled in by the same command. (The file transport still needs allowing.)",
        "ok": [
          {
            "re": "^git -c protocol\\.file\\.allow=always clone (?:--recurse-submodules|--recursive) app\\.git bob$"
          },
          {
            "re": "^git clone (?:--recurse-submodules|--recursive) app\\.git bob$",
            "needs": "allowed",
            "unmet": "fatal: transport 'file' not allowed\nFailed to clone 'vendor/lib' a second time, aborting\nThe project cloned, but not the library. Allow the file transport for this command: git -c protocol.file.allow=always clone ..."
          },
          {
            "re": "^git -c protocol\\.file\\.allow=always submodule update --init(?: --recursive)?$",
            "out": "Submodule 'vendor/lib' (C:/code/lib.git) registered for path 'vendor/lib'\nCloning into 'C:/code/bob/vendor/lib'...\ndone.\nSubmodule path 'vendor/lib': checked out '94078779f2d654668e7bfe8eb59828a532c3b160'",
            "why": "Same result in two commands: the plain clone left vendor/lib empty, and submodule update --init filled it in."
          }
        ],
        "side": [
          {
            "re": "^git clone app\\.git bob$",
            "out": "Cloning into 'bob'...\ndone.",
            "after": "That worked, but bob/vendor/lib is an empty folder. Fill it in with git submodule update --init, or clone again with --recurse-submodules."
          },
          {
            "re": "^git config --global protocol\\.file\\.allow always$",
            "set": "allowed",
            "out": "",
            "after": "That allows file clones in every repository you use. A -c on a single command is safer. Now clone."
          }
        ],
        "ex": "git -c protocol.file.allow=always clone --recurse-submodules app.git bob",
        "out": "Cloning into 'bob'...\ndone.\nSubmodule 'vendor/lib' (C:/code/lib.git) registered for path 'vendor/lib'\nCloning into 'C:/code/bob/vendor/lib'...\ndone.\nSubmodule path 'vendor/lib': checked out '94078779f2d654668e7bfe8eb59828a532c3b160'",
        "why": "--recurse-submodules cloned the project and then the library, at the commit the project recorded.",
        "hint": "git -c protocol.file.allow=always clone --recurse-submodules, then app.git and bob.",
        "near": "^git (?:-c \\S+ )?clone",
        "nearMsg": "Clone app.git into bob with --recurse-submodules so the submodule is filled in as well.",
        "alts": [
          "git -c protocol.file.allow=always clone --recursive app.git bob",
          [
            "git clone app.git bob",
            "git -c protocol.file.allow=always submodule update --init"
          ],
          [
            "git config --global protocol.file.allow always",
            "git clone --recurse-submodules app.git bob"
          ]
        ],
        "also": "A plain `git clone app.git bob` followed by `git -c protocol.file.allow=always submodule update --init` ends in the same place."
      },
      {
        "goal": "List the submodules and the commits they are on.",
        "ok": [
          {
            "re": "^git submodule(?: status)?(?: --recursive)?$"
          }
        ],
        "ex": "git submodule status",
        "out": " 94078779f2d654668e7bfe8eb59828a532c3b160 vendor/lib (heads/main)",
        "why": "A leading space means vendor/lib is checked out at the commit the project records. A minus would mean it has not been filled in, and a plus would mean it has moved to a different commit.",
        "hint": "git submodule status.",
        "alts": [
          "git submodule",
          "git submodule status --recursive"
        ]
      },
      {
        "goal": "You committed in vendor/lib and then in the project, but you have not pushed vendor/lib. Push the project so that Git pushes the library first.",
        "ok": [
          {
            "re": "^git push (?:origin main )?--recurse-submodules=on-demand(?: origin main)?$"
          }
        ],
        "side": [
          {
            "re": "^git push --recurse-submodules=check(?: origin main)?$",
            "out": "The following submodule paths contain changes that can\nnot be found on any remote:\n  vendor/lib\n\nPlease try\n\n\tgit push --recurse-submodules=on-demand\n\nor cd to the path and use\n\n\tgit push\n\nto push them to a remote.\n\nfatal: Aborting.\nfatal: the remote end hung up unexpectedly",
            "after": "check refuses rather than pushes. To have Git push the library first, use on-demand."
          },
          {
            "re": "^git push(?: origin main)?$",
            "out": "To C:/code/app.git\n   88efc5b..775a232  main -> main",
            "after": "The project went up, but the library's new commit did not. A teammate who pulls cannot fetch it. Push with --recurse-submodules=on-demand instead."
          }
        ],
        "ex": "git push --recurse-submodules=on-demand origin main",
        "out": "Pushing submodule 'vendor/lib'\nTo C:/code/lib.git\n   27cf084..abe9e26  main -> main\nTo C:/code/app.git\n   88efc5b..775a232  main -> main",
        "why": "The library went up first, then the project, so the commit the project points at exists on the remote.",
        "hint": "git push with --recurse-submodules=on-demand.",
        "alts": [
          "git push --recurse-submodules=on-demand",
          "git push origin main --recurse-submodules=on-demand"
        ]
      }
    ]
  },
  "big-repos": {
    "title": "take less of a big repository",
    "steps": [
      {
        "goal": "Clone only the latest commit of https://github.com/you/big.git.",
        "ok": [
          {
            "re": "^git clone (?:--depth[= ]1 https://github\\.com/you/big\\.git|https://github\\.com/you/big\\.git --depth[= ]1)$"
          }
        ],
        "side": [
          {
            "re": "^git clone https://github\\.com/you/big\\.git$",
            "out": "Cloning into 'big'...",
            "after": "That downloads every commit. Ask for only the latest with --depth 1."
          }
        ],
        "ex": "git clone --depth 1 https://github.com/you/big.git",
        "out": "Cloning into 'big'...",
        "why": "A shallow clone has the latest commit and none of the history behind it, so it is small and fast.",
        "hint": "git clone, the flag --depth 1, then the URL.",
        "alts": [
          "git clone --depth=1 https://github.com/you/big.git",
          "git clone https://github.com/you/big.git --depth 1"
        ]
      },
      {
        "goal": "Ask Git whether this repository is shallow.",
        "ok": [
          {
            "re": "^git rev-parse --is-shallow-repository$"
          },
          {
            "re": "^cat \\.git/shallow$",
            "out": "d03174d7cf1aa3f6373f99e142d7b409a66e9bc5",
            "why": "Git keeps the id of the commit whose parents were cut off in .git/shallow. The file exists only in a shallow repository."
          }
        ],
        "ex": "git rev-parse --is-shallow-repository",
        "out": "true",
        "why": "true means the history was cut. git log would show one commit, and blame and bisect have nothing behind it to use.",
        "hint": "git rev-parse --is-shallow-repository.",
        "alts": [
          "cat .git/shallow"
        ]
      },
      {
        "goal": "Get the rest of the history back.",
        "ok": [
          {
            "re": "^git (?:fetch|pull) --unshallow(?: origin)?$"
          }
        ],
        "ex": "git fetch --unshallow",
        "out": "",
        "why": "--unshallow fetches every older commit and turns the repository back into a normal one. git fetch --depth=5 would only have grown it to five commits.",
        "hint": "git fetch with the flag --unshallow.",
        "alts": [
          "git fetch --unshallow origin",
          "git pull --unshallow"
        ]
      },
      {
        "goal": "Clone again into a folder called lean: skip file contents until they are needed, and check out only the top-level files.",
        "ok": [
          {
            "re": "^git clone (?:--filter=blob:none --sparse|--sparse --filter=blob:none) https://github\\.com/you/big\\.git lean$"
          }
        ],
        "ex": "git clone --filter=blob:none --sparse https://github.com/you/big.git lean",
        "out": "Cloning into 'lean'...",
        "why": "All the commits came down, but not the file contents (--filter=blob:none), and the folders were left off the disk (--sparse). Git fetches a file when something needs it.",
        "hint": "git clone with --filter=blob:none and --sparse, then the URL and the folder name lean.",
        "near": "^git clone",
        "nearMsg": "This step wants two flags, --filter=blob:none and --sparse, and the folder name lean after the URL.",
        "alts": [
          "git clone --sparse --filter=blob:none https://github.com/you/big.git lean"
        ]
      },
      {
        "goal": "Inside lean, check out only the docs folder.",
        "ok": [
          {
            "re": "^git sparse-checkout set(?: --cone)? docs$"
          }
        ],
        "ex": "git sparse-checkout set docs",
        "out": "",
        "why": "Git fetched the files in docs and put that folder on your disk. The other folders stay out. set replaces the list; add extends it.",
        "hint": "git sparse-checkout set and the folder name.",
        "alts": [
          "git sparse-checkout set --cone docs"
        ]
      },
      {
        "goal": "List the folders that are checked out.",
        "ok": [
          {
            "re": "^git sparse-checkout list$"
          }
        ],
        "ex": "git sparse-checkout list",
        "out": "docs",
        "why": "Only docs is on disk, plus the files at the top level.",
        "hint": "git sparse-checkout list."
      },
      {
        "goal": "Go back to the whole tree.",
        "ok": [
          {
            "re": "^git sparse-checkout disable$"
          }
        ],
        "side": [
          {
            "re": "^git sparse-checkout add src$",
            "out": "",
            "after": "Added. docs and src are both on disk now. To get everything, disable sparse checkout."
          }
        ],
        "ex": "git sparse-checkout disable",
        "out": "",
        "why": "Git fetched the files it had skipped and put every folder on disk. The history was never cut, so nothing else needed fetching.",
        "hint": "git sparse-checkout disable."
      }
    ]
  },
  "hooks": {
    "title": "share a hook with the team",
    "steps": [
      {
        "goal": "The repository tracks its hooks in a folder called .githooks. Tell Git to run hooks from there.",
        "ok": [
          {
            "re": "^git config (?:--local )?core\\.hooksPath (?:\\./)?\\.githooks$"
          }
        ],
        "ex": "git config core.hooksPath .githooks",
        "out": "",
        "why": "The setting is stored in .git/config, which is not part of a clone. Every clone has to run this once.",
        "hint": "git config core.hooksPath and the folder name .githooks.",
        "alts": [
          "git config --local core.hooksPath .githooks",
          "git config core.hooksPath ./.githooks"
        ]
      },
      {
        "goal": "Check that the setting is there.",
        "ok": [
          {
            "re": "^git config (?:--get |--local |--local --get )?core\\.hooksPath$"
          }
        ],
        "ex": "git config core.hooksPath",
        "out": ".githooks",
        "why": "Git will now look for hooks in .githooks instead of .git/hooks.",
        "hint": "git config core.hooksPath, with nothing after it.",
        "alts": [
          "git config --get core.hooksPath",
          "git config --local core.hooksPath"
        ]
      },
      {
        "goal": "A .env file is staged. Commit it with a message and watch the pre-commit hook.",
        "ok": [
          {
            "re": "^git commit (?:-m|-am|-a -m|--message[= ]) ?[\"'](.+)[\"']$"
          }
        ],
        "ex": "git commit -m \"Add env\"",
        "out": "pre-commit: refusing to commit a .env file.",
        "why": "The hook exited with an error, so Git created no commit.",
        "hint": "git commit -m and a message in quotes.",
        "near": "^git commit (?:-n|--no-verify)",
        "nearMsg": "That skips the hook, and it is the next step. First run a normal commit with -m and watch the hook refuse.",
        "alts": [
          "git commit -am \"Add env\"",
          "git commit --message=\"Add env\""
        ]
      },
      {
        "goal": "You have decided the file is fine. Commit it, skipping the hooks for this one commit.",
        "ok": [
          {
            "re": "^git commit (?:--no-verify|-n) (?:-m|--message[= ]) ?[\"'](.+)[\"']$"
          },
          {
            "re": "^git commit (?:-m|--message[= ]) ?[\"'](.+)[\"'] (?:--no-verify|-n)$"
          }
        ],
        "ex": "git commit --no-verify -m \"Add env anyway\"",
        "out": "[main bf37352] {m}\n 1 file changed, 1 insertion(+)\n create mode 100644 .env",
        "why": "--no-verify skips pre-commit and commit-msg for that commit. Git does not ask why. That is what a hook cannot prevent.",
        "hint": "git commit with --no-verify, then -m and the message.",
        "near": "^git commit",
        "nearMsg": "A normal commit runs the hook again. Add --no-verify (or -n) to skip it this once.",
        "alts": [
          "git commit -n -m \"Add env anyway\"",
          "git commit -m \"Add env anyway\" --no-verify"
        ]
      },
      {
        "goal": "Record .githooks/pre-commit as executable in Git, so a teammate on Linux or macOS can run it.",
        "ok": [
          {
            "re": "^git (?:update-index|add) --chmod=\\+x \\.githooks/pre-commit$"
          }
        ],
        "ex": "git update-index --chmod=+x .githooks/pre-commit",
        "out": "",
        "why": "Windows keeps no executable bit on files, but Git records one in its index. Without it, Linux and macOS skip the hook.",
        "hint": "git update-index --chmod=+x and the path of the hook.",
        "alts": [
          "git add --chmod=+x .githooks/pre-commit"
        ]
      },
      {
        "goal": "Confirm the mode Git recorded for that file.",
        "ok": [
          {
            "re": "^git ls-files (?:-s|--stage) \\.githooks/pre-commit$"
          }
        ],
        "ex": "git ls-files -s .githooks/pre-commit",
        "out": "100755 d9a4c991b07dbd9b526df46c0956c7b5ac972df2 0\t.githooks/pre-commit",
        "why": "100755 is an executable file. 100644 would mean it is not.",
        "hint": "git ls-files -s and the path.",
        "alts": [
          "git ls-files --stage .githooks/pre-commit"
        ]
      }
    ]
  },
  "remove-a-secret": {
    "title": "remove a leaked secret from history",
    "steps": [
      {
        "goal": "You have already rotated the leaked key. Now find every commit that ever held the text FAKE-not-a-real-key. Search the history with -S and keep each commit to one line.",
        "ok": [
          {
            "re": "^(?=.*--oneline)git log(?: --all| --oneline)* -S ?[\"']?FAKE-not-a-real-key[\"']?(?: --all| --oneline)*$"
          }
        ],
        "ex": "git log --oneline -S\"FAKE-not-a-real-key\"",
        "out": "fbe993a Stop tracking .env\n65bf43d Add settings",
        "why": "-S lists the commits that changed how many times the text appears. Add settings put it in, and Stop tracking .env took the file out. The secret is still in the older commit.",
        "hint": "git log, --oneline, then -S and the text in quotes.",
        "near": "^git log",
        "nearMsg": "Use -S with the text in quotes, and add --oneline so each commit takes one line.",
        "alts": [
          "git log -S\"FAKE-not-a-real-key\" --oneline",
          "git log --all --oneline -S'FAKE-not-a-real-key'",
          "git log --oneline -S FAKE-not-a-real-key"
        ]
      },
      {
        "goal": "Measure the repository before you change it. Print the object counts in human-readable sizes.",
        "ok": [
          {
            "re": "^git count-objects (?:-vH|-Hv|-v -H|-H -v)$"
          }
        ],
        "ex": "git count-objects -vH",
        "out": "count: 13\nsize: 2.86 MiB\nin-pack: 0\npacks: 0\nsize-pack: 0 bytes\nprune-packable: 0\ngarbage: 0\nsize-garbage: 0 bytes",
        "why": "13 objects and 2.86 MiB. Most of that is the 3 MB database dump that was committed next to the key. Remember these numbers.",
        "hint": "git count-objects with -v for verbose and -H for human-readable.",
        "near": "^git count-objects",
        "nearMsg": "Add -v for the full list of counters and -H for sizes like MiB.",
        "alts": [
          "git count-objects -Hv",
          "git count-objects -v -H"
        ]
      },
      {
        "goal": "In a fresh clone, rewrite history without .env and db-backup.dump. Use git filter-repo with --sensitive-data-removal, --invert-paths, and one --path for each file.",
        "ok": [
          {
            "re": "^(?=.* (?:--sensitive-data-removal|--sdr)(?: |$))(?=.* --invert-paths(?: |$))(?=.* --path \\.env(?: |$))(?=.* --path db-backup\\.dump(?: |$))git[ -]filter-repo(?: (?:--sensitive-data-removal|--sdr|--invert-paths|--path \\.env|--path db-backup\\.dump)){4}$"
          }
        ],
        "ex": "git filter-repo --sensitive-data-removal --invert-paths --path .env --path db-backup.dump",
        "out": "NOTICE: Fetching all refs from origin to make sure we rewrite\n        all history that may reference the sensitive data.\nParsed 4 commits\nHEAD is now at 35cccfa Stop tracking .env\n\nNew history written in 1.42 seconds; now repacking/cleaning...\nYou rewrote 4 (of 4) commits.\n\nNOTE: First Changed Commit(s) is/are:\n  25b989967cec4c5eb38a6818ae42853374f55c8a\n\nCompletely finished after 2.70 seconds.\n\nNEXT STEPS FOR YOUR SENSITIVE DATA REMOVAL:\n  [...]",
        "why": "Every commit got a new hash, because a commit's hash covers its parent. The Add settings commit had nothing left, so it vanished.",
        "hint": "git filter-repo, then --sensitive-data-removal, --invert-paths, --path .env and --path db-backup.dump.",
        "near": "^git[ -]filter-repo",
        "nearMsg": "Four options: --sensitive-data-removal, --invert-paths, and --path .env and --path db-backup.dump. Without --invert-paths, --path keeps only those files and drops everything else.",
        "alts": [
          "git filter-repo --sdr --invert-paths --path .env --path db-backup.dump",
          "git filter-repo --path db-backup.dump --path .env --invert-paths --sensitive-data-removal",
          "git-filter-repo --sensitive-data-removal --invert-paths --path .env --path db-backup.dump"
        ]
      },
      {
        "goal": "Run the same search as before and check that it now finds nothing.",
        "ok": [
          {
            "re": "^git log(?: --all| --oneline)* -S ?[\"']?FAKE-not-a-real-key[\"']?(?: --all| --oneline)*$"
          }
        ],
        "ex": "git log --oneline -S\"FAKE-not-a-real-key\"",
        "out": "",
        "why": "No output means no commit changes that text, and the text exists in no commit. Add --all to cover every branch and tag.",
        "hint": "The same git log -S command as the first step.",
        "alts": [
          "git log --all --oneline -S\"FAKE-not-a-real-key\""
        ]
      },
      {
        "goal": "Measure again.",
        "ok": [
          {
            "re": "^git count-objects (?:-vH|-Hv|-v -H|-H -v)$"
          }
        ],
        "ex": "git count-objects -vH",
        "out": "count: 0\nsize: 0 bytes\nin-pack: 9\npacks: 1\nsize-pack: 1.98 KiB\nprune-packable: 0\ngarbage: 0\nsize-garbage: 0 bytes",
        "why": "Nine objects in one pack, 1.98 KiB. The dump is gone from this clone, and filter-repo repacked it. The server still has to be told.",
        "hint": "The same git count-objects command as before.",
        "alts": [
          "git count-objects -v -H"
        ]
      },
      {
        "goal": "Send the rewritten history to the server. Every branch and tag must be replaced, so force it and mirror it to origin.",
        "ok": [
          {
            "re": "^git push (?:(?:--force|-f) --mirror|--mirror (?:--force|-f)) origin$"
          }
        ],
        "ex": "git push --force --mirror origin",
        "out": "To https://github.com/you/app.git\n + fbe993a...35cccfa main -> main (forced update)",
        "why": "--force replaces main with the new history. --mirror makes the server match this clone for every ref. Tell your teammates to re-clone, and ask the host about cached copies and forks.",
        "hint": "git push with --force, --mirror, and origin.",
        "near": "^git push",
        "nearMsg": "A normal push is rejected, because the new history shares no commit with the old one. A force push alone replaces one branch and leaves the old tags and branches holding the secret. You need --force and --mirror, then origin.",
        "alts": [
          "git push --mirror --force origin",
          "git push -f --mirror origin"
        ]
      }
    ]
  },
  "git3-check": {
    "title": "check a repository against the Git 3.0 list",
    "steps": [
      {
        "goal": "Print the version of Git you have.",
        "ok": [
          {
            "re": "^git (?:--version|version)$"
          }
        ],
        "ex": "git --version",
        "out": "git version 2.45.2",
        "why": "Git 3.0 does not exist yet, so any version you see is a 2.x release. Compare it with the newest release on git-scm.com.",
        "hint": "git --version.",
        "alts": [
          "git version"
        ]
      },
      {
        "goal": "Find out whether init.defaultBranch is set, and which file set it. Ask for the origin of the setting too.",
        "ok": [
          {
            "re": "^git config --show-origin (?:--get )?init\\.defaultBranch$"
          },
          {
            "re": "^git config (?:--get )?init\\.defaultBranch$",
            "out": "main",
            "why": "The name is main. To see which file sets it, add --show-origin. Git 3.0 plans to default new repositories to main, so you are already there."
          }
        ],
        "ex": "git config --show-origin --get init.defaultBranch",
        "out": "file:/home/you/.gitconfig\tmain",
        "why": "A global file names main as the first branch of every new repository. Git 3.0 plans to make main the default for new repositories. Existing repositories keep their branch names.",
        "hint": "git config, --show-origin, then init.defaultBranch.",
        "alts": [
          "git config --get init.defaultBranch",
          "git config init.defaultBranch",
          "git config --show-origin init.defaultBranch"
        ]
      },
      {
        "goal": "Print the object format of this repository: the hash function it uses for commit ids.",
        "ok": [
          {
            "re": "^git rev-parse --show-object-format$"
          }
        ],
        "ex": "git rev-parse --show-object-format",
        "out": "sha1",
        "why": "This repository uses SHA-1, like nearly all repositories today. The official list plans to make sha256 the default for new repositories, and there is no plan to remove sha1.",
        "hint": "git rev-parse --show-object-format."
      },
      {
        "goal": "Print the format this repository uses to store its references (branches and tags).",
        "ok": [
          {
            "re": "^git rev-parse --show-ref-format$"
          }
        ],
        "ex": "git rev-parse --show-ref-format",
        "out": "files",
        "why": "files means one small file per reference. The official list plans to make reftable the default for new repositories.",
        "hint": "git rev-parse --show-ref-format."
      },
      {
        "goal": "Check whether safe.bareRepository is set.",
        "ok": [
          {
            "re": "^git config (?:--show-origin )?(?:--get )?safe\\.bareRepository$"
          }
        ],
        "ex": "git config --get safe.bareRepository",
        "out": "",
        "why": "It prints nothing, so the setting is not set and Git uses its default, all. The official list plans to change that default to explicit.",
        "hint": "git config --get safe.bareRepository.",
        "alts": [
          "git config safe.bareRepository",
          "git config --show-origin --get safe.bareRepository"
        ]
      },
      {
        "goal": "Create a trial repository called trial that uses the sha256 object format.",
        "ok": [
          {
            "re": "^git init (?:-b main )?--object-format=sha256 trial$"
          },
          {
            "re": "^git init trial --object-format=sha256$"
          }
        ],
        "ex": "git init --object-format=sha256 trial",
        "out": "Initialized empty Git repository in /home/you/trial/.git/",
        "why": "A new repository can choose its hash function today. It is not a default yet, and a SHA-256 repository cannot be pushed to a server that only understands SHA-1.",
        "hint": "git init, --object-format=sha256, and the folder name trial.",
        "alts": [
          "git init trial --object-format=sha256",
          "git init -b main --object-format=sha256 trial"
        ]
      },
      {
        "goal": "Ask the trial repository for its object format without leaving this folder. Point Git at it with -C.",
        "ok": [
          {
            "re": "^git -C trial rev-parse --show-object-format$"
          }
        ],
        "ex": "git -C trial rev-parse --show-object-format",
        "out": "sha256",
        "why": "-C runs the command as if you had changed into the trial folder first. The trial repository reports sha256.",
        "hint": "git -C trial, then the same rev-parse command."
      }
    ]
  },
  "case-rename": {
    "title": "two names that differ only in case",
    "steps": [
      {
        "goal": "List the file names Git is tracking.",
        "ok": [
          {
            "re": "^git ls-files(?: -c| --cached)?$|^git ls-tree -r (?:--name-only HEAD|HEAD --name-only)$"
          }
        ],
        "ex": "git ls-files",
        "out": "This.component.test.jsx\nheader.jsx\nthis.component.test.jsx",
        "why": "Git tracks two names here, This.component.test.jsx and this.component.test.jsx. On a Windows or macOS disk they are the same file name, so only one of them can exist in your folder.",
        "hint": "git ls-files, with nothing after it.",
        "side": [
          {
            "re": "^git status$",
            "out": "On branch main\nYour branch is up to date with 'origin/main'.\n\nChanges not staged for commit:\n  (use \"git add <file>...\" to update what will be committed)\n  (use \"git restore <file>...\" to discard changes in working directory)\n\tmodified:   This.component.test.jsx\n\nno changes added to commit (use \"git add\" and/or \"git commit -a\")",
            "after": "You never edited that file. That is the symptom. To see why, list the names Git is tracking."
          }
        ],
        "alts": [
          "git ls-files --cached",
          "git ls-files -c",
          "git ls-tree -r --name-only HEAD"
        ],
        "also": "`git ls-tree -r --name-only HEAD` lists the same names from the last commit."
      },
      {
        "goal": "Ask Git whether it has been told to ignore case in file names.",
        "ok": [
          {
            "re": "^git config (?:--get |--local |--local --get |--get --local )?core\\.[iI]gnore[cC]ase$"
          },
          {
            "re": "^git config --show-origin (?:--get )?core\\.[iI]gnore[cC]ase$",
            "out": "file:.git/config\ttrue",
            "why": "`--show-origin` adds where the setting came from: this repository's own .git/config. The value is true."
          }
        ],
        "ex": "git config core.ignorecase",
        "out": "true",
        "why": "true means Git is working around a file system that does not tell `Name` and `name` apart. The setting does not stop two such names from being tracked.",
        "hint": "git config followed by the setting name, core.ignorecase.",
        "alts": [
          "git config --get core.ignorecase",
          "git config core.ignoreCase",
          "git config --local core.ignorecase",
          "git config --show-origin core.ignorecase"
        ]
      },
      {
        "goal": "The team keeps the lowercase name. Stop tracking This.component.test.jsx, but leave the files in your folder alone.",
        "ok": [
          {
            "re": "^git rm (?:--cached|-r --cached|--cached -r) (?:-- )?This\\.component\\.test\\.jsx$"
          },
          {
            "re": "^git update-index --force-remove (?:-- )?This\\.component\\.test\\.jsx$",
            "out": "",
            "why": "`update-index --force-remove` takes the name out of the index without touching your folder. It is the plumbing command behind `git rm --cached`."
          }
        ],
        "ex": "git rm --cached This.component.test.jsx",
        "out": "rm 'This.component.test.jsx'",
        "why": "`--cached` changes only what Git tracks. Plain `git rm` would also delete the file in your folder, and here that one file answers to both names.",
        "hint": "git rm --cached and the capital-T name.",
        "near": "^git rm",
        "nearMsg": "Close. Plain git rm refuses here, and with -f it would delete the one file in your folder, which is also the other name. Add --cached to change only what Git tracks.",
        "alts": [
          "git rm --cached -- This.component.test.jsx",
          "git rm -r --cached This.component.test.jsx",
          "git update-index --force-remove This.component.test.jsx"
        ]
      },
      {
        "goal": "Component files are PascalCase from now on. Rename header.jsx to Header.jsx. Going through a temporary name in two moves counts too.",
        "ok": [
          {
            "re": "^git mv header\\.jsx Header\\.jsx$"
          },
          {
            "re": "^git mv (?:-f|--force) header\\.jsx Header\\.jsx$",
            "why": "`-f` told Git to go ahead even though, on a case-insensitive disk, the destination looks like it already exists."
          },
          {
            "re": "^git mv (?!-)(?!header\\.jsx )\\S+ Header\\.jsx$",
            "needs": "moved",
            "why": "Two moves, so no step ever asked Git for a name that differs only by case.",
            "unmet": "That name does not exist yet. First move header.jsx to a temporary name."
          }
        ],
        "side": [
          {
            "re": "^git mv header\\.jsx (?!Header\\.jsx$)(?!-)\\S+$",
            "set": "moved",
            "out": "",
            "after": "Half done: the file has a name that differs by more than case. Now move it to Header.jsx."
          }
        ],
        "ex": "git mv header.jsx Header.jsx",
        "out": "",
        "why": "Git recorded the rename. If Git ever answers 'destination exists', add -f or go through a temporary name.",
        "hint": "git mv, the old name, then the new name. Or move to any temporary name first, then to Header.jsx.",
        "near": "^mv\\b",
        "nearMsg": "That renames the file in your folder, but Git would go on tracking header.jsx. Use git mv so Git records the rename.",
        "alts": [
          "git mv -f header.jsx Header.jsx",
          "git mv --force header.jsx Header.jsx",
          [
            "git mv header.jsx header-tmp.jsx",
            "git mv header-tmp.jsx Header.jsx"
          ]
        ],
        "also": "Plain `mv header.jsx Header.jsx` renames the file but Git still tracks the old spelling."
      },
      {
        "goal": "Commit the cleanup with a message.",
        "ok": [
          {
            "re": "^git commit (?:-m|-am|-a -m|--message[= ]) ?[\"'](.+)[\"']$"
          }
        ],
        "ex": "git commit -m \"Keep one name, PascalCase the header\"",
        "out": "[main 44d9f80] {m}\n 2 files changed, 1 deletion(-)\n rename header.jsx => Header.jsx (100%)\n delete mode 100644 This.component.test.jsx",
        "why": "One commit holds both fixes: the twin name is gone and the rename is recorded.",
        "hint": "git commit -m followed by your message in quotes.",
        "near": "^git commit",
        "nearMsg": "Give the commit a message in quotes: git commit -m \"your message\".",
        "alts": [
          "git commit -am \"Clean up names\"",
          "git commit --message=\"Clean up names\""
        ]
      },
      {
        "goal": "Run the check: list tracked names and show any that differ only by case. Nothing printed means none do.",
        "ok": [
          {
            "re": "^git ls-files \\| sort (?:-f|--ignore-case) \\| uniq (?:-di|-id|-d -i|-i -d|-Di|-iD|-D -i|-i -D|--repeated --ignore-case|--ignore-case --repeated)$"
          },
          {
            "re": "^git ls-files \\| tr ['\"]?A-Z['\"]? ['\"]?a-z['\"]? \\| sort \\| uniq -d$",
            "why": "This version lowercases every name first, so a clash shows up as a duplicate. Clean: nothing printed."
          }
        ],
        "ex": "git ls-files | sort -f | uniq -di",
        "out": "",
        "why": "Nothing printed, which is the good answer: no two tracked names differ only by case. `sort -f` ignores case, so a clash lines up side by side, and `uniq -di` prints names that repeat.",
        "hint": "Pipe git ls-files into sort -f, then into uniq -di.",
        "near": "^git ls-files",
        "nearMsg": "Pipe it: git ls-files | sort -f | uniq -di sorts the names without regard to case, then prints any that repeat.",
        "alts": [
          "git ls-files | sort --ignore-case | uniq -Di",
          "git ls-files | sort -f | uniq -d -i",
          "git ls-files | tr A-Z a-z | sort | uniq -d"
        ]
      }
    ]
  },
  "interactive-rebase": {
    "title": "tidy a branch with rebase",
    "steps": [
      {
        "goal": "List the commits on your branch that are not on main, one line each.",
        "ok": [
          {
            "re": "^git log (?:--oneline|--pretty=oneline|--format=oneline) main\\.\\.(?:HEAD)?$|^git log main\\.\\.(?:HEAD)? (?:--oneline|--pretty=oneline)$"
          }
        ],
        "ex": "git log --oneline main..",
        "out": "96eed00 Debug output\nda9c2a6 wip\n872747b Fix typo in search box\n736ca7c Add search results\n038a3d4 wip\nb4b3152 Add search box",
        "why": "`main..` means commits reachable from your branch but not from main. Six commits, two of them called wip, and a typo fix that belongs in the first one.",
        "hint": "git log --oneline, then main.. (two dots, nothing after them).",
        "near": "^git log",
        "nearMsg": "Close. Add --oneline and the range main.. so the list shows only your branch's commits, one per line.",
        "alts": [
          "git log --oneline main..HEAD",
          "git log main.. --oneline"
        ],
        "also": "`git log --oneline main..HEAD` means the same thing."
      },
      {
        "goal": "You have staged the typo fix. Record it as a fixup for the first commit, b4b3152 (Add search box).",
        "ok": [
          {
            "re": "^git commit (?:-a )?--fixup[= ](?:b4b3152|HEAD~5|:/Add search box)$"
          }
        ],
        "ex": "git commit --fixup b4b3152",
        "out": "[feature/search 9c64964] fixup! Add search box\n 1 file changed, 1 insertion(+), 1 deletion(-)",
        "why": "Git named the commit `fixup! Add search box`. That prefix is how a later rebase knows where it belongs.",
        "hint": "git commit --fixup and the hash b4b3152.",
        "near": "^git commit",
        "nearMsg": "Use --fixup with the hash of the commit the change belongs to, here b4b3152. Git writes the message for you.",
        "alts": [
          "git commit --fixup=b4b3152",
          "git commit -a --fixup b4b3152",
          "git commit --fixup HEAD~5",
          "git commit --fixup :/Add search box"
        ]
      },
      {
        "goal": "Replay the branch on main with the fixup folded into the commit it belongs to.",
        "ok": [
          {
            "re": "^git rebase (?:-i|--interactive) --autosquash main$|^git rebase --autosquash (?:-i|--interactive) main$|^git rebase --autosquash main$"
          }
        ],
        "side": [
          {
            "re": "^git rebase (?:-i|--interactive) main$",
            "out": "pick b4b3152 Add search box\npick 038a3d4 wip\npick 736ca7c Add search results\npick 872747b Fix typo in search box\npick da9c2a6 wip\npick 96eed00 Debug output\npick 9c64964 fixup! Add search box",
            "after": "That is the todo list your editor would show. The fixup is still at the bottom. Add --autosquash and Git moves it under the commit it belongs to."
          }
        ],
        "ex": "git rebase -i --autosquash main",
        "out": "pick b4b3152 Add search box\nfixup 9c64964 fixup! Add search box\npick 038a3d4 wip\npick 736ca7c Add search results\npick 872747b Fix typo in search box\npick da9c2a6 wip\npick 96eed00 Debug output\n\nSuccessfully rebased and updated refs/heads/feature/search.",
        "why": "The first lines are the todo Git wrote for you: the fixup now sits right under its commit. You saved it as it was, and the fix is inside Add search box.",
        "hint": "git rebase -i, then --autosquash, then main.",
        "near": "^git rebase",
        "nearMsg": "Close. Rebase onto main, interactively, and add --autosquash so the fixup commit moves under the commit it belongs to.",
        "alts": [
          "git rebase --autosquash -i main",
          "git rebase --interactive --autosquash main",
          "git rebase --autosquash main"
        ]
      },
      {
        "goal": "main has moved. The branch search-history is stacked on top of search. Rebase search-history onto main and take the search branch along.",
        "ok": [
          {
            "re": "^git rebase (?:(?:-i|--interactive) )?--update-refs main$|^git rebase main --update-refs$"
          }
        ],
        "side": [
          {
            "re": "^git rebase main$",
            "out": "Successfully rebased and updated refs/heads/search-history.",
            "after": "That moved search-history only. The branch search stayed on the old commits. Run it again with the flag that moves the branches in between."
          }
        ],
        "ex": "git rebase --update-refs main",
        "out": "Successfully rebased and updated refs/heads/search-history.\nUpdated the following refs with --update-refs:\n\trefs/heads/search",
        "why": "Both branch names followed their commits. Needs Git 2.38 or newer, and `git config rebase.updateRefs true` makes it the default.",
        "hint": "git rebase --update-refs main.",
        "near": "^git rebase",
        "nearMsg": "Add --update-refs, so branches that point into the commits being replayed move with them.",
        "alts": [
          "git rebase -i --update-refs main",
          "git rebase main --update-refs"
        ]
      },
      {
        "goal": "A rebase stopped with CONFLICT in results.html and you would rather start over. Cancel it and get back to how the branch was.",
        "ok": [
          {
            "re": "^git rebase --abort$"
          }
        ],
        "side": [
          {
            "re": "^git status$",
            "out": "interactive rebase in progress; onto 1c31025\nLast command done (1 command done):\n   pick 96eed00 Debug output\nNext commands to do (5 remaining commands):\n   pick b4b3152 Add search box\n   pick 038a3d4 wip\n  (use \"git rebase --edit-todo\" to view and edit)\nYou are currently rebasing branch 'feature/search' on '1c31025'.\n  (fix conflicts and then run \"git rebase --continue\")\n  (use \"git rebase --skip\" to skip this patch)\n  (use \"git rebase --abort\" to check out the original branch)\n\nUnmerged paths:\n  (use \"git restore --staged <file>...\" to unstage)\n  (use \"git add/rm <file>...\" as appropriate to mark resolution)\n\tdeleted by us:   results.html",
            "after": "Git lists three ways out: --continue after you fix the file, --skip to drop the commit, --abort to cancel the whole rebase. This step wants the last one."
          }
        ],
        "ex": "git rebase --abort",
        "out": "",
        "why": "The branch is exactly as it was before you typed git rebase. Nothing was lost.",
        "hint": "git rebase --abort.",
        "near": "^git rebase",
        "nearMsg": "--continue and --skip both carry on with the rebase. To cancel it and go back to the start, use --abort."
      },
      {
        "goal": "A different rebase finished, and then you noticed it dropped a commit you needed. Put the branch back where it was before that rebase.",
        "ok": [
          {
            "re": "^git reset --hard ORIG_HEAD$"
          },
          {
            "re": "^git reset --hard 96eed00$",
            "why": "That works too, because 96eed00 is where the branch pointed. ORIG_HEAD saves you from having to look the hash up."
          }
        ],
        "side": [
          {
            "re": "^git reflog(?: -n ?3)?$",
            "out": "984035f HEAD@{0}: rebase (finish): returning to refs/heads/feature/search\n984035f HEAD@{1}: rebase (pick): Add search results\n556586e HEAD@{2}: rebase (fixup): Style the search box",
            "after": "That is the top of the reflog, which goes on and remembers every earlier position of HEAD. Right after a rebase, though, the shorter way is the name Git saved for you: ORIG_HEAD."
          }
        ],
        "ex": "git reset --hard ORIG_HEAD",
        "out": "HEAD is now at 96eed00 Debug output",
        "why": "ORIG_HEAD is where the branch pointed before the rebase started. All six original commits are back.",
        "hint": "git reset --hard ORIG_HEAD.",
        "near": "^git reset",
        "nearMsg": "The target is ORIG_HEAD, the place Git saved before the rebase. Use --hard so your files go back too.",
        "alts": [
          "git reset --hard 96eed00"
        ]
      }
    ]
  },
  "config-and-aliases": {
    "title": "config and aliases",
    "steps": [
      {
        "goal": "List every setting Git knows, together with the file each one comes from.",
        "ok": [
          {
            "re": "^(?=.*--show-origin)git config (?:--show-(?:origin|scope) )*(?:--list|-l)(?: --show-(?:origin|scope))*$"
          }
        ],
        "ex": "git config --list --show-origin",
        "out": "file:C:/Users/you/.gitconfig\tuser.name=Ada Example\nfile:C:/Users/you/.gitconfig\tuser.email=ada@home.example\nfile:.git/config\tuser.email=ada@work.example",
        "why": "The left column names the file. user.email appears twice, and the narrower file, .git/config, is the one that counts.",
        "hint": "git config --list, plus the flag that adds the file name: --show-origin.",
        "near": "^git config (?:--list|-l)$",
        "nearMsg": "That lists the settings but not where each one comes from. Add --show-origin.",
        "side": [
          {
            "re": "^git config user\\.email$",
            "out": "ada@work.example",
            "after": "That is the value in effect, but not the file it came from. List everything with --show-origin."
          }
        ],
        "alts": [
          "git config --show-origin --list",
          "git config -l --show-origin",
          "git config --list --show-scope --show-origin"
        ],
        "also": "`git config --show-scope --show-origin --list` adds the scope name too."
      },
      {
        "goal": "Find out which file the user.email in effect comes from.",
        "ok": [
          {
            "re": "^git config(?: --get)? --show-origin(?: --get)? user\\.email$"
          },
          {
            "re": "^git config(?: --get)?(?: --show-scope --show-origin| --show-origin --show-scope)(?: --get)? user\\.email$",
            "out": "local\tfile:.git/config\tada@work.example",
            "why": "`--show-scope` adds the scope name: local means the repository's own .git/config, which beats the global file."
          }
        ],
        "ex": "git config --show-origin user.email",
        "out": "file:.git/config\tada@work.example",
        "why": "The value comes from .git/config, the local file. When a setting appears in several files, the narrower scope wins.",
        "hint": "git config, then --show-origin, then the setting name user.email.",
        "near": "^git config(?: --get)? user\\.email$",
        "nearMsg": "That prints the value, ada@work.example, but not where it came from. Add --show-origin.",
        "alts": [
          "git config --get --show-origin user.email",
          "git config --show-origin --get user.email",
          "git config --show-scope --show-origin user.email"
        ]
      },
      {
        "goal": "Make the first push of a new branch set its upstream automatically, in every repository.",
        "ok": [
          {
            "re": "^git config --global push\\.[aA]uto[sS]etup[rR]emote (?:true|yes|on|1)$"
          }
        ],
        "ex": "git config --global push.autoSetupRemote true",
        "out": "",
        "why": "From now on the first plain `git push` of a new branch also sets the upstream, so `--set-upstream` is no longer needed. It needs Git 2.37 or newer.",
        "hint": "git config --global push.autoSetupRemote true",
        "near": "^git config (?:--global )?push\\.",
        "nearMsg": "Close. Use --global so it applies to every repository, and set the value to true.",
        "alts": [
          "git config --global push.autosetupremote true",
          "git config --global push.autoSetupRemote yes"
        ]
      },
      {
        "goal": "Make every fetch remove remote-tracking branches that were deleted on the remote.",
        "ok": [
          {
            "re": "^git config --global fetch\\.prune (?:true|yes|on|1)$"
          }
        ],
        "ex": "git config --global fetch.prune true",
        "out": "",
        "why": "Every `git fetch` now behaves as if you had typed `--prune`. Only the origin/... pointers go; a local branch of the same name stays.",
        "hint": "git config --global fetch.prune true",
        "near": "^git config (?:--global )?fetch\\.",
        "nearMsg": "Close. Use --global so it applies to every repository, and set the value to true.",
        "alts": [
          "git config --global fetch.prune yes"
        ]
      },
      {
        "goal": "Choose a default for a divergent pull, so Git stops asking. Any of the three answers in Git's hint works.",
        "ok": [
          {
            "re": "^git config --global pull\\.ff only$",
            "why": "A pull now succeeds only as a straight line and stops otherwise. You choose whether to merge or rebase."
          },
          {
            "re": "^git config --global pull\\.rebase true$",
            "why": "A pull now replays your local commits on top of what arrived."
          },
          {
            "re": "^git config --global pull\\.rebase false$",
            "why": "A pull now merges, which was the behaviour before Git started asking."
          }
        ],
        "ex": "git config --global pull.ff only",
        "out": "",
        "why": "Git no longer stops with \"Need to specify how to reconcile divergent branches\".",
        "hint": "Git's own hint lists them: pull.ff only, pull.rebase true, or pull.rebase false. Add --global.",
        "near": "^git config (?:--global )?pull\\.",
        "nearMsg": "Close. Use --global, and one of the values from Git's hint: ff only, rebase true or rebase false.",
        "alts": [
          "git config --global pull.rebase true",
          "git config --global pull.rebase false"
        ]
      },
      {
        "goal": "Add an alias named lg for log --oneline --graph --decorate, for every repository.",
        "ok": [
          {
            "re": "^git config --global alias\\.lg [\"']log (?=[^\"']*--oneline)(?=[^\"']*--graph)(?=[^\"']*--decorate)[^\"']*[\"']$"
          }
        ],
        "ex": "git config --global alias.lg \"log --oneline --graph --decorate\"",
        "out": "",
        "why": "`git lg` now runs `git log --oneline --graph --decorate`. Git does not let an alias replace a command it already has, so a new name is always safe to try.",
        "hint": "git config --global alias.lg, then the command in quotes.",
        "near": "^git config (?:--global )?alias\\.lg",
        "nearMsg": "Close. Use --global, and put log --oneline --graph --decorate in quotes as one value.",
        "alts": [
          "git config --global alias.lg 'log --oneline --graph --decorate'",
          "git config --global alias.lg \"log --graph --decorate --oneline\""
        ]
      },
      {
        "goal": "Remove the lg alias again.",
        "ok": [
          {
            "re": "^git config (?:--global --unset(?:-all)?|--unset(?:-all)? --global) alias\\.lg$"
          }
        ],
        "ex": "git config --global --unset alias.lg",
        "out": "",
        "why": "`--unset` deletes one setting from the file you name. Nothing else in the file changes.",
        "hint": "git config --global --unset, then alias.lg.",
        "near": "^git config .*alias\\.lg",
        "nearMsg": "To remove a setting, use --unset with --global and the name alias.lg.",
        "alts": [
          "git config --global --unset-all alias.lg",
          "git config --unset --global alias.lg"
        ]
      }
    ]
  },
  "rerere": {
    "title": "resolve a conflict once",
    "steps": [
      {
        "goal": "Turn on rerere in this repository.",
        "ok": [
          {
            "re": "^git config (?:--local )?rerere\\.enabled (?:true|yes|on|1)$"
          },
          {
            "re": "^git config --global rerere\\.enabled (?:true|yes|on|1)$",
            "why": "Set globally, rerere is on in every repository. Git will now record how you resolve each conflict."
          }
        ],
        "ex": "git config rerere.enabled true",
        "out": "",
        "why": "Git will now record how you resolve each conflict in this repository.",
        "hint": "git config rerere.enabled true",
        "near": "^git config (?:--\\w+ )?rerere",
        "nearMsg": "Close. The setting is rerere.enabled and the value is true.",
        "alts": [
          "git config --global rerere.enabled true",
          "git config --local rerere.enabled true"
        ],
        "also": "`git config --global rerere.enabled true` turns it on for every repository."
      },
      {
        "goal": "Merge the feature branch into main. It changes the same lines as main did.",
        "ok": [
          {
            "re": "^git merge feature$"
          }
        ],
        "ex": "git merge feature",
        "out": "Auto-merging theme.txt\nCONFLICT (content): Merge conflict in theme.txt\nAutomatic merge failed; fix conflicts and then commit the result.\nRecorded preimage for 'theme.txt'",
        "why": "Git stopped on the conflict, as it always does. The new line is rerere saving the conflicted file, the preimage.",
        "hint": "git merge and the branch name, feature.",
        "side": [
          {
            "re": "^git status --short$",
            "out": "",
            "after": "Nothing is conflicted yet. Merge the feature branch first."
          }
        ]
      },
      {
        "goal": "You fixed theme.txt in your editor (color: teal, size: 14). Mark the file as resolved.",
        "ok": [
          {
            "re": "^git add (?:theme\\.txt|\\.|-A|--all)$"
          }
        ],
        "ex": "git add theme.txt",
        "out": "",
        "why": "Staging a conflicted file is how you tell Git it is resolved.",
        "hint": "git add theme.txt",
        "side": [
          {
            "re": "^git status --short$",
            "out": "UU theme.txt",
            "after": "UU means unmerged on both sides. Stage the file once you have fixed it."
          }
        ],
        "alts": [
          "git add .",
          "git add -A"
        ]
      },
      {
        "goal": "Finish the merge with a message.",
        "ok": [
          {
            "re": "^git commit -m ?[\"'](.+)[\"']$",
            "out": "Recorded resolution for 'theme.txt'.\n[main f1d2f67] {m}"
          },
          {
            "re": "^git commit(?: --no-edit)?$",
            "out": "Recorded resolution for 'theme.txt'.\n[main f1d2f67] Merge branch 'feature'",
            "why": "Without -m, Git used its default message for a merge. The editor would have opened for a plain git commit unless you passed --no-edit."
          }
        ],
        "ex": "git commit -m \"Merge feature\"",
        "out": "Recorded resolution for 'theme.txt'.\n[main f1d2f67] {m}",
        "why": "The new first line is rerere saving the resolved file, the postimage. Git now knows how you answered this conflict.",
        "hint": "git commit -m and a message in quotes.",
        "near": "^git commit",
        "nearMsg": "Give the commit a message in quotes: git commit -m \"your message\".",
        "alts": [
          "git commit",
          "git commit --no-edit"
        ]
      },
      {
        "goal": "Undo that merge commit, so the branches are separate again.",
        "ok": [
          {
            "re": "^git reset --hard (?:HEAD~1|HEAD~|HEAD\\^|ORIG_HEAD)$"
          }
        ],
        "ex": "git reset --hard HEAD~1",
        "out": "HEAD is now at 8d52897 Teal",
        "why": "main is back on its own commit, Teal. The recorded resolution stays in .git/rr-cache.",
        "hint": "git reset --hard HEAD~1",
        "near": "^git reset",
        "nearMsg": "Move the branch back one commit and discard the merge: git reset --hard HEAD~1.",
        "alts": [
          "git reset --hard HEAD^",
          "git reset --hard ORIG_HEAD"
        ]
      },
      {
        "goal": "Merge the feature branch again.",
        "ok": [
          {
            "re": "^git merge feature$"
          }
        ],
        "ex": "git merge feature",
        "out": "Auto-merging theme.txt\nCONFLICT (content): Merge conflict in theme.txt\nAutomatic merge failed; fix conflicts and then commit the result.\nResolved 'theme.txt' using previous resolution.",
        "why": "The same conflict, and this time the last line is the one we wanted: Git replayed our earlier answer into the file.",
        "hint": "The same command as before: git merge feature.",
        "side": [
          {
            "re": "^git status --short$",
            "out": "",
            "after": "Nothing is conflicted yet. Merge the feature branch again."
          }
        ]
      },
      {
        "goal": "See what rerere wrote into theme.txt. The file is rewritten but not staged, so the diff is a combined one.",
        "ok": [
          {
            "re": "^git diff$"
          }
        ],
        "ex": "git diff",
        "out": "diff --cc theme.txt\nindex f087244,e919003..0000000\n--- a/theme.txt\n+++ b/theme.txt\n@@@ -1,4 -1,4 +1,4 @@@\n  title: Notes\n -color: green\n +color: teal\n- size: 12\n+ size: 14\n  footer: yes",
        "why": "Two columns, one per side. The result keeps teal (already on main) and 14 (already on feature), which is the answer we gave last time. Stage the file and commit to finish.",
        "hint": "git diff, with nothing after it.",
        "side": [
          {
            "re": "^git status --short$",
            "out": "UU theme.txt",
            "after": "Still unmerged: rerere rewrote the file but did not stage it. git diff shows what it wrote."
          }
        ]
      }
    ]
  },
  "bisect": {
    "title": "hunt a bad commit",
    "steps": [
      {
        "goal": "check.sh fails on your branch but passed at the v1.0 tag. Start a bisect session.",
        "ok": [
          {
            "re": "^git bisect start$"
          },
          {
            "re": "^git bisect start (?:HEAD|aa1dcd3) (?:v1\\.0|f81a834)(?: --)?$",
            "skip": 2,
            "out": "Bisecting: 6 revisions left to test after this (roughly 3 steps)\n[189fe51b563dc16a0f96744518ba87072c7a5e36] Comment the formula",
            "why": "Both ends in one command: HEAD is bad and v1.0 is good. Git went straight to the middle, so the next two steps are already done."
          }
        ],
        "ex": "git bisect start",
        "out": "status: waiting for both good and bad commits",
        "why": "Git is waiting to be told one bad commit and one good commit.",
        "hint": "git bisect start, nothing after it.",
        "near": "^git bisect",
        "nearMsg": "Not yet. Begin with git bisect start.",
        "alts": [
          "git bisect start HEAD v1.0",
          "git bisect start aa1dcd3 f81a834 --"
        ],
        "also": "`git bisect start HEAD v1.0` names both ends at once and skips ahead to step 4."
      },
      {
        "goal": "Mark the commit you are standing on as bad.",
        "ok": [
          {
            "re": "^git bisect bad(?: HEAD| aa1dcd3)?$"
          }
        ],
        "ex": "git bisect bad",
        "out": "status: waiting for good commit(s), bad commit known",
        "why": "Git now knows the bad end. It needs a commit that was good.",
        "hint": "git bisect bad.",
        "alts": [
          "git bisect bad HEAD",
          "git bisect bad aa1dcd3"
        ]
      },
      {
        "goal": "The check passed at the v1.0 tag. Mark that tag as good.",
        "ok": [
          {
            "re": "^git bisect good (?:v1\\.0|f81a834)$"
          }
        ],
        "ex": "git bisect good v1.0",
        "out": "Bisecting: 6 revisions left to test after this (roughly 3 steps)\n[189fe51b563dc16a0f96744518ba87072c7a5e36] Comment the formula",
        "why": "Git checked out the commit in the middle, 189fe51. Run the check there, and answer for that commit.",
        "hint": "git bisect good, then the tag v1.0.",
        "near": "^git bisect good",
        "nearMsg": "Say which commit was good: git bisect good v1.0.",
        "alts": [
          "git bisect good f81a834"
        ]
      },
      {
        "goal": "At 189fe51, `sh check.sh; echo $?` prints 0, so the check passed. Tell Git.",
        "ok": [
          {
            "re": "^git bisect good(?: HEAD| 189fe51)?$"
          }
        ],
        "side": [
          {
            "re": "^sh check\\.sh(?:; echo \\$\\?)?$",
            "out": "0",
            "after": "Exit code 0 means the check passed. Tell Git that this commit is good."
          }
        ],
        "ex": "git bisect good",
        "out": "Bisecting: 3 revisions left to test after this (roughly 2 steps)\n[977c5b326b651d1920eaeb0f82eaec1458d313c1] Add cherries",
        "why": "Everything up to 189fe51 is good now. Git moved to the middle of what is left.",
        "hint": "The check exited with 0, so: git bisect good.",
        "near": "^git bisect",
        "nearMsg": "The check printed 0 here. Exit code 0 means it passed, so this commit is good.",
        "alts": [
          "git bisect good HEAD"
        ]
      },
      {
        "goal": "At 977c5b3, check.sh prints 1, so the check failed. Tell Git.",
        "ok": [
          {
            "re": "^git bisect bad(?: HEAD| 977c5b3)?$"
          }
        ],
        "side": [
          {
            "re": "^sh check\\.sh(?:; echo \\$\\?)?$",
            "out": "1",
            "after": "Any exit code from 1 to 127 (except 125) means bad. Tell Git."
          }
        ],
        "ex": "git bisect bad",
        "out": "Bisecting: 0 revisions left to test after this (roughly 1 step)\n[e2b28b48490fa9fca263b1139911de5315b6778c] Add loyalty discount",
        "why": "The culprit is at 977c5b3 or earlier, and after 189fe51. Git picked Add loyalty discount.",
        "hint": "The check exited with 1, so: git bisect bad.",
        "near": "^git bisect",
        "nearMsg": "The check printed 1 here. A non-zero exit code means it failed, so this commit is bad.",
        "alts": [
          "git bisect bad HEAD"
        ]
      },
      {
        "goal": "At e2b28b4 (Add loyalty discount), check.sh prints 1 again. Tell Git.",
        "ok": [
          {
            "re": "^git bisect bad(?: HEAD| e2b28b4)?$"
          }
        ],
        "side": [
          {
            "re": "^sh check\\.sh(?:; echo \\$\\?)?$",
            "out": "1",
            "after": "The check failed. Tell Git."
          }
        ],
        "ex": "git bisect bad",
        "out": "Bisecting: 0 revisions left to test after this (roughly 0 steps)\n[78bad623c1471205a79ced65f082805a7e706ddd] Mention check.sh",
        "why": "One commit is left to rule out: the one just before Add loyalty discount.",
        "hint": "The check exited with 1, so: git bisect bad.",
        "near": "^git bisect",
        "nearMsg": "The check printed 1 here. A non-zero exit code means it failed, so this commit is bad.",
        "alts": [
          "git bisect bad HEAD"
        ]
      },
      {
        "goal": "At 78bad62 (Mention check.sh), check.sh prints 0. Tell Git.",
        "ok": [
          {
            "re": "^git bisect good(?: HEAD| 78bad62)?$"
          }
        ],
        "side": [
          {
            "re": "^sh check\\.sh(?:; echo \\$\\?)?$",
            "out": "0",
            "after": "The check passed. Tell Git."
          }
        ],
        "ex": "git bisect good",
        "out": "e2b28b48490fa9fca263b1139911de5315b6778c is the first bad commit\ncommit e2b28b48490fa9fca263b1139911de5315b6778c\nAuthor: Test User <test@example.com>\nDate:   Mon Sep 30 19:23:19 2024 -0400\n\n    Add loyalty discount\n\n bill.sh | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)",
        "why": "Four checks instead of thirteen. The first bad commit is Add loyalty discount.",
        "hint": "The check exited with 0, so: git bisect good.",
        "near": "^git bisect",
        "nearMsg": "The check printed 0 here. Exit code 0 means it passed, so this commit is good.",
        "alts": [
          "git bisect good HEAD"
        ]
      },
      {
        "goal": "Found it. Leave the bisect session and go back to your branch.",
        "ok": [
          {
            "re": "^git bisect reset$"
          }
        ],
        "ex": "git bisect reset",
        "out": "Previous HEAD position was 78bad62 Mention check.sh\nSwitched to branch 'main'",
        "why": "Reset ends the search and returns you to the branch you started from. It changes no commits.",
        "hint": "git bisect reset.",
        "side": [
          {
            "re": "^git status$",
            "out": "HEAD detached at 78bad62\nYou are currently bisecting, started from branch 'main'.\n  (use \"git bisect reset\" to get back to the original branch)",
            "after": "You are still inside the session. Leave it with git bisect reset."
          }
        ]
      },
      {
        "goal": "Now let a script answer. Start a session with HEAD as the bad end and v1.0 as the good end, in one command.",
        "ok": [
          {
            "re": "^git bisect start (?:HEAD|aa1dcd3) (?:v1\\.0|f81a834)(?: --)?$"
          }
        ],
        "ex": "git bisect start HEAD v1.0",
        "out": "Bisecting: 6 revisions left to test after this (roughly 3 steps)\n[189fe51b563dc16a0f96744518ba87072c7a5e36] Comment the formula",
        "why": "Bad first, then good. Git is already at the first commit to test.",
        "hint": "git bisect start, then the bad commit HEAD, then the good tag v1.0.",
        "near": "^git bisect",
        "nearMsg": "Give both ends: git bisect start HEAD v1.0, with the bad one first.",
        "alts": [
          "git bisect start aa1dcd3 v1.0",
          "git bisect start HEAD v1.0 --"
        ]
      },
      {
        "goal": "Run check.sh at every step automatically, using sh to run it.",
        "ok": [
          {
            "re": "^git bisect run (?:sh check\\.sh|sh \\./check\\.sh|\\./check\\.sh)$"
          }
        ],
        "ex": "git bisect run sh check.sh",
        "out": "running 'sh' 'check.sh'\nBisecting: 3 revisions left to test after this (roughly 2 steps)\n[977c5b326b651d1920eaeb0f82eaec1458d313c1] Add cherries\nrunning 'sh' 'check.sh'\nBisecting: 0 revisions left to test after this (roughly 1 step)\n[e2b28b48490fa9fca263b1139911de5315b6778c] Add loyalty discount\nrunning 'sh' 'check.sh'\nBisecting: 0 revisions left to test after this (roughly 0 steps)\n[78bad623c1471205a79ced65f082805a7e706ddd] Mention check.sh\nrunning 'sh' 'check.sh'\ne2b28b48490fa9fca263b1139911de5315b6778c is the first bad commit\ncommit e2b28b48490fa9fca263b1139911de5315b6778c\nAuthor: Test User <test@example.com>\nDate:   Mon Sep 30 19:23:19 2024 -0400\n\n    Add loyalty discount\n\n bill.sh | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)\nbisect found first bad commit",
        "why": "The script ran four times, and its exit code was the answer each time: 0 good, 1 to 127 bad, 125 skip. Same commit as by hand. Finish with git bisect reset.",
        "hint": "git bisect run, then the command Git should run: sh check.sh.",
        "near": "^git bisect",
        "nearMsg": "Use run, followed by the command that tests a commit: git bisect run sh check.sh.",
        "alts": [
          "git bisect run ./check.sh",
          "git bisect run sh ./check.sh"
        ]
      }
    ]
  },
  "signing": {
    "title": "sign and verify",
    "steps": [
      {
        "goal": "Tell Git to sign with SSH instead of GPG.",
        "ok": [
          {
            "re": "^git config --global gpg\\.format ssh$"
          }
        ],
        "ex": "git config --global gpg.format ssh",
        "out": "",
        "why": "Git will now use ssh-keygen to sign. This needs Git 2.34 or newer.",
        "hint": "git config --global gpg.format ssh",
        "near": "^git config (?:--global )?gpg\\.",
        "nearMsg": "Close. The setting is gpg.format, the value is ssh, and --global applies it everywhere."
      },
      {
        "goal": "Say which public key to sign with. The key is ~/.ssh/id_ed25519.pub.",
        "ok": [
          {
            "re": "^git config --global user\\.[sS]igning[kK]ey [\"']?(?:~|C:)/\\S*\\.pub[\"']?$"
          }
        ],
        "ex": "git config --global user.signingkey ~/.ssh/id_ed25519.pub",
        "out": "",
        "why": "Git signs with the private key that belongs to this public key. Git expands the ~ before it stores the path.",
        "hint": "git config --global user.signingkey, then the path to the .pub file.",
        "near": "^git config (?:--global )?user\\.",
        "nearMsg": "Close. The setting is user.signingkey, and its value is the path to the public key, ending in .pub.",
        "alts": [
          "git config --global user.signingkey \"~/.ssh/id_ed25519.pub\""
        ]
      },
      {
        "goal": "Say whose signatures to trust: the allowed signers file is ~/.ssh/allowed_signers.",
        "ok": [
          {
            "re": "^git config --global gpg\\.ssh\\.[aA]llowed[sS]ignersFile [\"']?(?:~|C:)/\\S*[\"']?$"
          }
        ],
        "ex": "git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers",
        "out": "",
        "why": "Each line of that file is a name and a public key. Without it Git can sign, but it cannot check, and shows No signature.",
        "hint": "git config --global gpg.ssh.allowedSignersFile, then the file path.",
        "near": "^git config (?:--global )?gpg\\.ssh",
        "nearMsg": "Close. The setting is gpg.ssh.allowedSignersFile and the value is the path to the file."
      },
      {
        "goal": "Commit the staged change with a signature.",
        "ok": [
          {
            "re": "^git commit (?:-S|--gpg-sign) -m ?[\"'](.+)[\"']$|^git commit -m ?[\"'](.+)[\"'] (?:-S|--gpg-sign)$"
          }
        ],
        "ex": "git commit -S -m \"Signed commit\"",
        "out": "[main 3782c0e] {m}\n 1 file changed, 1 insertion(+)",
        "why": "The capital -S added a signature to the commit. Nothing looks different yet: the signature is stored in the commit itself.",
        "hint": "git commit -S -m and a message in quotes.",
        "near": "^git commit",
        "nearMsg": "That makes a commit, but an unsigned one. Add -S, with a message: git commit -S -m \"your message\".",
        "alts": [
          "git commit --gpg-sign -m \"Signed commit\"",
          "git commit -m \"Signed commit\" -S"
        ]
      },
      {
        "goal": "Check the signature on the last commit.",
        "ok": [
          {
            "re": "^git log (?:-1 --show-signature|--show-signature(?: -1)?)$",
            "out": "commit 3782c0ef853dff0304a7869b928ddab435099720\nGood \"git\" signature for ada@example.com with ED25519 key SHA256:m80CKmGqDv/3ImdGY+NwcMUfQtVWVOcsK4GYEXQbQrM\nAuthor: Ada Example <ada@example.com>\nDate:   Mon Oct 26 19:19:34 2026 -0400\n\n    {m}"
          },
          {
            "re": "^git verify-commit HEAD$",
            "out": "Good \"git\" signature for ada@example.com with ED25519 key SHA256:m80CKmGqDv/3ImdGY+NwcMUfQtVWVOcsK4GYEXQbQrM",
            "why": "`verify-commit` prints only the verdict and exits with status 0 when the signature is good, which suits a script."
          }
        ],
        "ex": "git log --show-signature -1",
        "out": "",
        "why": "Good means the signature matches a key in the allowed signers file, and Git names the signer. It proves which key signed, not that the Author line is true.",
        "hint": "git log --show-signature -1, or git verify-commit HEAD.",
        "near": "^git log",
        "nearMsg": "Add --show-signature, and -1 to show only the last commit.",
        "alts": [
          "git log -1 --show-signature",
          "git log --show-signature",
          "git verify-commit HEAD"
        ]
      },
      {
        "goal": "Sign every commit from now on, so you cannot forget -S.",
        "ok": [
          {
            "re": "^git config --global commit\\.gpg[sS]ign (?:true|yes|on|1)$"
          }
        ],
        "ex": "git config --global commit.gpgsign true",
        "out": "",
        "why": "Every commit is now signed, and so are the commits a rebase or an amend rewrites. Add tag.gpgsign true for annotated tags.",
        "hint": "git config --global commit.gpgsign true",
        "near": "^git config (?:--global )?commit\\.",
        "nearMsg": "Close. The setting is commit.gpgsign, the value is true, and --global applies it everywhere.",
        "alts": [
          "git config --global commit.gpgSign true"
        ]
      }
    ]
  },
  "archaeology": {
    "title": "dig through history",
    "steps": [
      {
        "goal": "Find out who wrote lines 7 to 9 of checkout.js (the send function).",
        "ok": [
          {
            "re": "^git blame -L ?7,(?:9|\\+3) checkout\\.js$"
          }
        ],
        "ex": "git blame -L 7,9 checkout.js",
        "out": "83b088e7 (Ravi 2024-02-19 10:00:00 -0500 7) function send(order) {\nab0f597e (Ravi 2024-04-22 10:00:00 -0400 8)   return post(order, TIMEOUT_MS);\n83b088e7 (Ravi 2024-02-19 10:00:00 -0500 9) }",
        "why": "Line 8 is blamed on ab0f597, Reformat with 2-space indent. Blame shows the last commit that touched a line, and a re-indent touches every line it moves.",
        "hint": "git blame -L, then the range 7,9, then the file name.",
        "near": "^git blame",
        "nearMsg": "Limit blame to lines 7 to 9 with -L 7,9, then name the file: checkout.js.",
        "alts": [
          "git blame -L7,9 checkout.js",
          "git blame -L 7,+3 checkout.js"
        ]
      },
      {
        "goal": "Blame the same lines again, but look past the reformat commit, ab0f597.",
        "ok": [
          {
            "re": "^git blame (?:--ignore-rev[ =]ab0f597 -L ?7,9|-L ?7,9 --ignore-rev[ =]ab0f597|-w -L ?7,9|-L ?7,9 -w) checkout\\.js$"
          }
        ],
        "ex": "git blame --ignore-rev ab0f597 -L 7,9 checkout.js",
        "out": "83b088e7 (Ravi 2024-02-19 10:00:00 -0500 7) function send(order) {\nb226a4fd (Ada  2024-04-08 10:00:00 -0400 8)   return post(order, TIMEOUT_MS);\n83b088e7 (Ravi 2024-02-19 10:00:00 -0500 9) }",
        "why": "Line 8 belongs to Ada, in b226a4f (Stop retrying orders). `-w` gets there too, because the reformat only changed whitespace. For a bigger rewrite, list the commit's full hash in .git-blame-ignore-revs.",
        "hint": "The same command, plus --ignore-rev ab0f597. -w also works for a whitespace-only commit.",
        "near": "^git blame",
        "nearMsg": "That is the same answer as before. Tell blame to skip the reformat: add --ignore-rev ab0f597 (or -w, since it only changed whitespace).",
        "alts": [
          "git blame --ignore-rev=ab0f597 -L 7,9 checkout.js",
          "git blame -L 7,9 --ignore-rev ab0f597 checkout.js",
          "git blame -w -L 7,9 checkout.js",
          "git blame -L 7,9 -w checkout.js"
        ]
      },
      {
        "goal": "RETRY_LIMIT is gone from the code. List the commits that added or removed it, one line each.",
        "ok": [
          {
            "re": "^git log (?:-S ?[\"']?RETRY_LIMIT[\"']? --oneline|--oneline -S ?[\"']?RETRY_LIMIT[\"']?)$"
          }
        ],
        "ex": "git log -S RETRY_LIMIT --oneline",
        "out": "b226a4f Stop retrying orders\n83b088e Retry failed orders",
        "why": "-S lists commits that change how many times the text appears: one that added it, one that removed it.",
        "hint": "git log -S and the word RETRY_LIMIT, with --oneline.",
        "near": "^git log",
        "nearMsg": "Search the changes for the word with -S RETRY_LIMIT, and add --oneline.",
        "alts": [
          "git log --oneline -S RETRY_LIMIT",
          "git log -S\"RETRY_LIMIT\" --oneline",
          "git log -SRETRY_LIMIT --oneline"
        ]
      },
      {
        "goal": "Find the commit that changed the value of TIMEOUT_MS from 30000 to 60000. Search the changed lines with a regular expression: a line like TIMEOUT_MS = and a number.",
        "ok": [
          {
            "re": "^git log (?:-G ?[\"']TIMEOUT_MS = \\[0-9\\]\\+[\"'] --oneline|--oneline -G ?[\"']TIMEOUT_MS = \\[0-9\\]\\+[\"'])$"
          }
        ],
        "side": [
          {
            "re": "^git log (?:-S ?[\"']?TIMEOUT_MS[\"']? --oneline|--oneline -S ?[\"']?TIMEOUT_MS[\"']?)$",
            "out": "83b088e Retry failed orders\n8ea9a14 Add checkout total",
            "after": "The change to 60000 is missing. TIMEOUT_MS appears the same number of times before and after it, so -S does not count it. -G reads the changed lines instead."
          }
        ],
        "ex": "git log -G \"TIMEOUT_MS = [0-9]+\" --oneline",
        "out": "03b44d0 Give slow carriers more time\n8ea9a14 Add checkout total",
        "why": "03b44d0 is the change from 30000 to 60000. -G matches lines in the diff, so it finds a changed value that -S cannot.",
        "hint": "git log -G with the pattern in quotes, TIMEOUT_MS = [0-9]+, and --oneline.",
        "near": "^git log",
        "nearMsg": "Use -G with the pattern in quotes: -G \"TIMEOUT_MS = [0-9]+\", and add --oneline.",
        "alts": [
          "git log --oneline -G \"TIMEOUT_MS = [0-9]+\"",
          "git log -G'TIMEOUT_MS = [0-9]+' --oneline",
          "git log -G 'TIMEOUT_MS = [0-9]+' --oneline"
        ]
      },
      {
        "goal": "Follow the addTax function of checkout.js through history.",
        "ok": [
          {
            "re": "^git log -L ?:addTax:checkout\\.js$"
          }
        ],
        "pager": true,
        "ex": "git log -L :addTax:checkout.js",
        "out": "commit 0963c24c64bc87700452467c6015687f8d10df24\nAuthor: Ada <ada@example.com>\nDate:   Mon May 6 10:00:00 2024 -0400\n\n    Round tax\n\ndiff --git a/checkout.js b/checkout.js\n--- a/checkout.js\n+++ b/checkout.js\n@@ -11,3 +11,3 @@\n function addTax(amount) {\n-  return amount * 1.2;\n+  return Math.round(amount * 1.2);\n }\n\ncommit ab0f597e5e9e32f98e6e79732f6a79a6ab2ffa85\nAuthor: Ravi <ravi@example.com>\nDate:   Mon Apr 22 10:00:00 2024 -0400\n\n    Reformat with 2-space indent\n\ndiff --git a/checkout.js b/checkout.js\n--- a/checkout.js\n+++ b/checkout.js\n@@ -11,3 +11,3 @@\n function addTax(amount) {\n-    return amount * 1.2;\n+  return amount * 1.2;\n }\n\ncommit e3592b05291cc26f5a70810cb7c55b3a6aeff852\nAuthor: Ada <ada@example.com>\nDate:   Mon Mar 4 10:00:00 2024 -0500\n\n    Add tax\n\ndiff --git a/checkout.js b/checkout.js\n--- a/checkout.js\n+++ b/checkout.js\n@@ -14,0 +15,3 @@\n+function addTax(amount) {\n+    return amount * 1.2;\n+}",
        "why": "Three commits touched addTax: the one that added it, the reformat, and the rounding. Press q to leave the pager.",
        "hint": "git log -L, then :addTax:checkout.js (function name between colons, then the file).",
        "near": "^git log",
        "nearMsg": "Use -L with the function name between colons and the file after it: -L :addTax:checkout.js."
      },
      {
        "goal": "Print every commit as its short hash, author name, short date and subject. Use --format with %h %an %ad %s, and --date=short.",
        "ok": [
          {
            "re": "^git log (?:--format|--pretty)=(?:format:)?[\"']%h %an %ad %s[\"'] --date=short$|^git log --date=short (?:--format|--pretty)=(?:format:)?[\"']%h %an %ad %s[\"']$"
          }
        ],
        "ex": "git log --format=\"%h %an %ad %s\" --date=short",
        "out": "0963c24 Ada 2024-05-06 Round tax\nab0f597 Ravi 2024-04-22 Reformat with 2-space indent\nb226a4f Ada 2024-04-08 Stop retrying orders\n03b44d0 Ravi 2024-03-18 Give slow carriers more time\ne3592b0 Ada 2024-03-04 Add tax\n83b088e Ravi 2024-02-19 Retry failed orders\n8ea9a14 Ada 2024-02-05 Add checkout total",
        "why": "%h is the short hash, %an the author name, %ad the author date in the style --date sets, and %s the subject.",
        "hint": "git log --format=\"%h %an %ad %s\" --date=short",
        "near": "^git log",
        "nearMsg": "Put the placeholders in quotes after --format=, and add --date=short so the date is one short word.",
        "alts": [
          "git log --pretty=format:\"%h %an %ad %s\" --date=short",
          "git log --date=short --format=\"%h %an %ad %s\""
        ]
      }
    ]
  },
  "partial-staging": {
    "title": "commit one hunk of two",
    "steps": [
      {
        "goal": "greet.js has two edits far apart. See them as Git does.",
        "ok": [
          {
            "re": "^git diff(?: greet\\.js)?$"
          }
        ],
        "side": [
          {
            "re": "^git status(?: -s| --short)?$",
            "out": " M greet.js",
            "after": "One modified file, and nothing says there are two edits in it. git diff shows them."
          }
        ],
        "ex": "git diff",
        "out": "diff --git a/greet.js b/greet.js\nindex adf0b53..7c88535 100644\n--- a/greet.js\n+++ b/greet.js\n@@ -1,7 +1,7 @@\n // Greetings for the app.\n \n function greet(name) {\n-  return \"Hello, \" + name;\n+  return `Hello, ${name}`;\n }\n \n function farewell(name) {\n@@ -10,7 +10,7 @@ function farewell(name) {\n \n function shout(text) {\n   const loud = text.toUpperCase();\n-  return loud;\n+  return loud + \"!\";\n }\n \n module.exports = { greet, farewell, shout };",
        "why": "Two lines start with @@, so there are two hunks: the template string in greet and the exclamation mark in shout.",
        "hint": "git diff, with nothing after it.",
        "alts": [
          "git diff greet.js"
        ]
      },
      {
        "goal": "Start choosing hunks one at a time.",
        "ok": [
          {
            "re": "^git add (?:-p|--patch)(?: greet\\.js)?$"
          }
        ],
        "ex": "git add -p",
        "out": "diff --git a/greet.js b/greet.js\nindex adf0b53..7c88535 100644\n--- a/greet.js\n+++ b/greet.js\n@@ -1,7 +1,7 @@\n // Greetings for the app.\n \n function greet(name) {\n-  return \"Hello, \" + name;\n+  return `Hello, ${name}`;\n }\n \n function farewell(name) {\n(1/2) Stage this hunk [y,n,q,a,d,j,J,g,/,e,p,?]?",
        "why": "Git shows the first hunk and waits. The letters in the brackets are the answers it accepts: y stages the hunk, n leaves it out.",
        "hint": "git add with -p, which is short for --patch.",
        "near": "^git add",
        "nearMsg": "A plain git add stages the whole file. Add -p so Git asks about one hunk at a time: git add -p.",
        "alts": [
          "git add --patch",
          "git add -p greet.js"
        ]
      },
      {
        "goal": "Answer the prompt: stage this first hunk, the template string. Type the one letter.",
        "ok": [
          {
            "re": "^y$"
          }
        ],
        "ex": "y",
        "out": "@@ -10,7 +10,7 @@ function farewell(name) {\n \n function shout(text) {\n   const loud = text.toUpperCase();\n-  return loud;\n+  return loud + \"!\";\n }\n \n module.exports = { greet, farewell, shout };\n(2/2) Stage this hunk [y,n,q,a,d,K,g,/,e,p,?]?",
        "why": "The template string is staged, and Git moves on to the second hunk.",
        "hint": "Type the single letter y and press Enter.",
        "near": "^[nqdasepjJgK?]$",
        "nearMsg": "That letter does something else here. This step stages the hunk, so type y."
      },
      {
        "goal": "Answer the second prompt: leave the exclamation mark out. Type the one letter.",
        "ok": [
          {
            "re": "^[nqd]$"
          }
        ],
        "ex": "n",
        "out": "",
        "why": "Only the first hunk is staged. q or d would have stopped here too, since this is the last hunk.",
        "hint": "Type n for no.",
        "near": "^[yasepjJgK?]$",
        "nearMsg": "y would stage the exclamation mark too. This step leaves it out, so type n.",
        "alts": [
          "q",
          "d"
        ]
      },
      {
        "goal": "Check what the next commit will contain.",
        "ok": [
          {
            "re": "^git diff (?:--staged|--cached)(?: greet\\.js)?$"
          }
        ],
        "side": [
          {
            "re": "^git diff$",
            "out": "diff --git a/greet.js b/greet.js\nindex 618ce63..7c88535 100644\n--- a/greet.js\n+++ b/greet.js\n@@ -10,7 +10,7 @@ function farewell(name) {\n \n function shout(text) {\n   const loud = text.toUpperCase();\n-  return loud;\n+  return loud + \"!\";\n }\n \n module.exports = { greet, farewell, shout };",
            "after": "That is what is still waiting, the exclamation mark. To see what the commit will hold, add --staged."
          }
        ],
        "ex": "git diff --staged",
        "out": "diff --git a/greet.js b/greet.js\nindex adf0b53..618ce63 100644\n--- a/greet.js\n+++ b/greet.js\n@@ -1,7 +1,7 @@\n // Greetings for the app.\n \n function greet(name) {\n-  return \"Hello, \" + name;\n+  return `Hello, ${name}`;\n }\n \n function farewell(name) {",
        "why": "Only the template string is staged. git status -s would print MM for this file: one M for the staged side and one for the working tree.",
        "hint": "git diff with --staged.",
        "alts": [
          "git diff --cached",
          "git diff --staged greet.js"
        ]
      },
      {
        "goal": "Commit it with a message.",
        "ok": [
          {
            "re": "^git commit (?:-m|--message[= ]) ?[\"'](.+)[\"']$"
          }
        ],
        "ex": "git commit -m \"Greet with a template string\"",
        "out": "[main fa6a9c7] {m}\n 1 file changed, 1 insertion(+), 1 deletion(-)",
        "why": "One commit with one change. The exclamation mark is still an ordinary edit in the file.",
        "hint": "git commit -m followed by your message in quotes.",
        "near": "^git commit",
        "nearMsg": "Give the commit a message in quotes: git commit -m \"your message\".",
        "alts": [
          "git commit --message=\"Use a template string\""
        ]
      },
      {
        "goal": "Throw the second edit away, one hunk at a time.",
        "ok": [
          {
            "re": "^git restore (?:-p|--patch)(?: greet\\.js)?$"
          }
        ],
        "ex": "git restore -p",
        "out": "diff --git a/greet.js b/greet.js\nindex 618ce63..7c88535 100644\n--- a/greet.js\n+++ b/greet.js\n@@ -10,7 +10,7 @@ function farewell(name) {\n \n function shout(text) {\n   const loud = text.toUpperCase();\n-  return loud;\n+  return loud + \"!\";\n }\n \n module.exports = { greet, farewell, shout };\n(1/1) Discard this hunk from worktree [y,n,q,a,d,e,p,?]?",
        "why": "The prompt says Discard this hunk from worktree. Git has no other copy of those lines, so read it before you answer.",
        "hint": "git restore with -p, short for --patch.",
        "near": "^git (?:restore|checkout)",
        "nearMsg": "Add -p: git restore -p. A plain git restore greet.js would discard every unstaged change in the file without asking.",
        "alts": [
          "git restore --patch",
          "git restore -p greet.js"
        ]
      },
      {
        "goal": "Answer y to discard it.",
        "ok": [
          {
            "re": "^y$"
          }
        ],
        "ex": "y",
        "out": "",
        "why": "The edit is gone from greet.js and Git kept no copy. git status -s now prints nothing, because the file matches the last commit.",
        "hint": "Type the single letter y.",
        "near": "^[nqdaep?]$",
        "nearMsg": "That letter would keep the edit or do something else. This step throws it away, so type y."
      }
    ]
  },
  "compare-branches": {
    "title": "compare two branches",
    "steps": [
      {
        "goal": "main and feature have split. List the commits feature has that main does not, one line each.",
        "ok": [
          {
            "re": "^git log (?:--oneline main\\.\\.feature|main\\.\\.feature --oneline)$"
          }
        ],
        "ex": "git log --oneline main..feature",
        "out": "57c102b Style the search box\nf218e7f Add search results\nfcd832d Add search box",
        "why": "A..B means the commits reachable from B that are not reachable from A. Swap the names and you get main's own commits instead.",
        "hint": "git log --oneline and then main..feature, with two dots.",
        "near": "^git log",
        "nearMsg": "Use two dots between the names, main..feature, and add --oneline. Two dots in git log mean: on feature, not on main.",
        "alts": [
          "git log main..feature --oneline"
        ]
      },
      {
        "goal": "List the commits on either side but not both, marked with < for main and > for feature.",
        "ok": [
          {
            "re": "^git log (?:--oneline --left-right|--left-right --oneline) main\\.\\.\\.feature$"
          }
        ],
        "ex": "git log --oneline --left-right main...feature",
        "out": "< ebc6840 Link to the footer page\n< 14548a7 Add footer\n> 57c102b Style the search box\n> f218e7f Add search results\n> fcd832d Add search box",
        "why": "A...B means on A or on B, not on both. --left-right marks which side each commit is on: < for the first name, > for the second.",
        "hint": "git log with --oneline, --left-right and main...feature, with three dots.",
        "near": "^git log",
        "nearMsg": "Use three dots, main...feature, and add --left-right so each commit is marked < or >.",
        "alts": [
          "git log --left-right --oneline main...feature"
        ]
      },
      {
        "goal": "Show, as a short summary, only what feature changed since it left main.",
        "ok": [
          {
            "re": "^git diff (?:--stat main\\.\\.\\.feature|main\\.\\.\\.feature --stat)$"
          },
          {
            "re": "^git diff --name-only main\\.\\.\\.feature$",
            "out": "results.html\nsearch.html\nstyle.css"
          }
        ],
        "side": [
          {
            "re": "^git diff (?:--stat main(?:\\.\\.| )feature|main(?:\\.\\.| )feature --stat)$",
            "out": " footer.html  | 1 -\n index.html   | 1 -\n results.html | 1 +\n search.html  | 1 +\n style.css    | 9 +++++++++\n 5 files changed, 11 insertions(+), 2 deletions(-)",
            "after": "Five files. footer.html and index.html are main's own new work, and from feature's side they look deleted. Three dots start at the merge base and leave them out."
          }
        ],
        "ex": "git diff --stat main...feature",
        "out": " results.html | 1 +\n search.html  | 1 +\n style.css    | 9 +++++++++\n 3 files changed, 11 insertions(+)",
        "why": "In git diff, A...B compares the merge base of A and B with B, so only feature's own work appears.",
        "hint": "git diff --stat and then main...feature, with three dots.",
        "near": "^git diff",
        "nearMsg": "Use three dots, main...feature, with --stat. Two dots would compare the two tips and show main's work reversed.",
        "alts": [
          "git diff main...feature --stat",
          "git diff --name-only main...feature"
        ]
      },
      {
        "goal": "You rebased feature onto main and kept the old tip as a branch called feature-v1. Compare the old commits with the new ones.",
        "ok": [
          {
            "re": "^git range-diff (?:main feature-v1 feature|main ORIG_HEAD feature|main\\.\\.feature-v1 main\\.\\.feature)$"
          },
          {
            "re": "^git range-diff -s main feature-v1 feature$",
            "out": "1:  fcd832d = 1:  1b335a6 Add search box\n2:  f218e7f = 2:  d54a1f6 Add search results\n3:  57c102b = 3:  bbd49c6 Style the search box"
          }
        ],
        "side": [
          {
            "re": "^git range-diff feature-v1\\.\\.\\.feature$",
            "out": "-:  ------- > 1:  14548a7 Add footer\n-:  ------- > 2:  ebc6840 Link to the footer page\n1:  fcd832d = 3:  1b335a6 Add search box\n2:  f218e7f = 4:  d54a1f6 Add search results\n3:  57c102b = 5:  bbd49c6 Style the search box",
            "after": "Three dots start at the old merge base, so main's two new commits show up as added. After a rebase, name the base: git range-diff main feature-v1 feature."
          }
        ],
        "ex": "git range-diff main feature-v1 feature",
        "out": "1:  fcd832d = 1:  1b335a6 Add search box\n2:  f218e7f = 2:  d54a1f6 Add search results\n3:  57c102b = 3:  bbd49c6 Style the search box",
        "why": "Each line pairs an old commit with a new one. The = means the changes are the same: new hashes, same patches.",
        "hint": "git range-diff, then the base main, the old tip feature-v1 and the new tip feature.",
        "near": "^git range-diff",
        "nearMsg": "Give git range-diff three names: the base, the old tip and the new tip. Here that is main, feature-v1 and feature.",
        "alts": [
          "git range-diff main..feature-v1 main..feature",
          "git range-diff main ORIG_HEAD feature",
          "git range-diff -s main feature-v1 feature"
        ]
      },
      {
        "goal": "You then amended the last commit on feature, to make the search box wider. Run the same comparison to see which commit changed.",
        "ok": [
          {
            "re": "^git range-diff (?:main feature-v1 feature|main\\.\\.feature-v1 main\\.\\.feature)$"
          },
          {
            "re": "^git range-diff -s main feature-v1 feature$",
            "out": "1:  fcd832d = 1:  1b335a6 Add search box\n2:  f218e7f = 2:  d54a1f6 Add search results\n3:  57c102b ! 3:  5cfb18e Style the search box"
          }
        ],
        "ex": "git range-diff main feature-v1 feature",
        "out": "1:  fcd832d = 1:  1b335a6 Add search box\n2:  f218e7f = 2:  d54a1f6 Add search results\n3:  57c102b ! 3:  5cfb18e Style the search box\n    @@ style.css\n     @@\n      body { margin: 0; }\n     +.search {\n    -+  width: 20em;\n    ++  width: 24em;\n     +  padding: 4px;\n     +  border: 1px solid gray;\n     +  border-radius: 4px;",
        "why": "The ! means the commit is in both ranges but its changes differ. The lines after it are a diff of the two patches: the old one added 20em, the new one adds 24em.",
        "hint": "The same command as before: git range-diff main feature-v1 feature.",
        "near": "^git range-diff",
        "nearMsg": "Same three names as before: the base main, the old tip feature-v1 and the new tip feature.",
        "alts": [
          "git range-diff main..feature-v1 main..feature",
          "git range-diff -s main feature-v1 feature"
        ]
      }
    ]
  },
  "subtree": {
    "title": "a library copied into a project",
    "steps": [
      {
        "goal": "Copy the library at ../lib.git (branch main) into vendor/lib as a subtree, with its history squashed into one commit.",
        "ok": [
          {
            "re": "^git subtree add (?:(?:--prefix[= ]vendor/lib|-P vendor/lib) \\.\\./lib\\.git main --squash|--squash (?:--prefix[= ]vendor/lib|-P vendor/lib) \\.\\./lib\\.git main|(?:--prefix[= ]vendor/lib|-P vendor/lib) --squash \\.\\./lib\\.git main)$"
          }
        ],
        "ex": "git subtree add --prefix=vendor/lib ../lib.git main --squash",
        "out": "git fetch ../lib.git main\nFrom ../lib\n * branch            main       -> FETCH_HEAD\nAdded dir 'vendor/lib'",
        "why": "The library's files are now in vendor/lib as ordinary files. A submodule would have needed a protocol.file.allow flag for a local path; this did not.",
        "hint": "git subtree add with --prefix=vendor/lib, then the repository ../lib.git, the branch main and --squash.",
        "near": "^git subtree add",
        "nearMsg": "Name the folder with --prefix=vendor/lib, then the repository ../lib.git and the branch main, and end with --squash. Without it every library commit comes into the project, and later pulls must match.",
        "alts": [
          "git subtree add --prefix vendor/lib ../lib.git main --squash",
          "git subtree add --squash --prefix=vendor/lib ../lib.git main",
          "git subtree add -P vendor/lib ../lib.git main --squash"
        ]
      },
      {
        "goal": "See the two commits Git made, one line each.",
        "ok": [
          {
            "re": "^git log --oneline(?: -\\d+)?$"
          }
        ],
        "ex": "git log --oneline",
        "out": "bf936af Merge commit 'e4ee97e4d46e7845965e899d6be24d8aa15529e9' as 'vendor/lib'\ne4ee97e Squashed 'vendor/lib/' content from commit 9f8901b\n034d11b Add README",
        "why": "The squash commit holds the library's files, and its message records the folder and the library commit. The merge commit puts them under vendor/lib.",
        "hint": "git log --oneline.",
        "alts": [
          "git log --oneline -3"
        ]
      },
      {
        "goal": "The library got a new commit. Bring it into vendor/lib, squashed the same way.",
        "ok": [
          {
            "re": "^git subtree pull (?:(?:--prefix[= ]vendor/lib|-P vendor/lib) \\.\\./lib\\.git main --squash|--squash (?:--prefix[= ]vendor/lib|-P vendor/lib) \\.\\./lib\\.git main)$"
          }
        ],
        "side": [
          {
            "re": "^git subtree pull (?:--prefix[= ]vendor/lib|-P vendor/lib) \\.\\./lib\\.git main$",
            "out": "From ../lib\n * branch            main       -> FETCH_HEAD\nfatal: refusing to merge unrelated histories",
            "after": "The project holds one squash commit, not the library's real history, so Git cannot connect the two. Add --squash, as in the first step."
          }
        ],
        "ex": "git subtree pull --prefix=vendor/lib ../lib.git main --squash",
        "out": "From ../lib\n * branch            main       -> FETCH_HEAD\nMerge made by the 'ort' strategy.\n vendor/lib/greet.txt | 1 +\n 1 file changed, 1 insertion(+)",
        "why": "Git added another squash commit and merged it in. Run it again and it says the subtree is already at the library's latest commit.",
        "hint": "The same shape as the add: git subtree pull, --prefix=vendor/lib, ../lib.git main and --squash.",
        "near": "^git subtree pull",
        "nearMsg": "Pull with the same folder, repository and branch as the add, and end with --squash.",
        "alts": [
          "git subtree pull --prefix vendor/lib ../lib.git main --squash",
          "git subtree pull --squash --prefix=vendor/lib ../lib.git main"
        ]
      },
      {
        "goal": "You edited a file in vendor/lib and committed it. Send that change to the library as a new branch called spanish.",
        "ok": [
          {
            "re": "^git subtree push (?:--prefix[= ]vendor/lib|-P vendor/lib) \\.\\./lib\\.git spanish$"
          }
        ],
        "ex": "git subtree push --prefix=vendor/lib ../lib.git spanish",
        "out": "6/6 (3) [0]\nTo ../lib.git\n * [new branch]      6187ace4985f69dc38940ee526c2f7fb145cf283 -> spanish",
        "why": "Git rebuilt the project's commits that touched vendor/lib as commits of the library and pushed them as a branch, so the library's owner can review them.",
        "hint": "git subtree push, --prefix=vendor/lib, the repository ../lib.git and the branch name spanish.",
        "near": "^git subtree push",
        "nearMsg": "Push to a new branch called spanish, so the library's owner can review it: git subtree push --prefix=vendor/lib ../lib.git spanish.",
        "alts": [
          "git subtree push --prefix vendor/lib ../lib.git spanish",
          "git subtree push -P vendor/lib ../lib.git spanish"
        ]
      },
      {
        "goal": "Clone the project into a folder called bob, as a teammate would.",
        "ok": [
          {
            "re": "^git clone app\\.git bob$"
          }
        ],
        "ex": "git clone app.git bob",
        "out": "Cloning into 'bob'...\ndone.",
        "why": "A plain clone, with no flags. Nothing else is needed for a subtree.",
        "hint": "git clone app.git bob.",
        "near": "^git clone",
        "nearMsg": "Clone app.git into a folder called bob: git clone app.git bob."
      },
      {
        "goal": "List the files inside the library folder of the clone.",
        "ok": [
          {
            "re": "^ls (?:-A |-a |-1 )?bob/vendor/lib/?$"
          }
        ],
        "ex": "ls bob/vendor/lib",
        "out": "greet.txt",
        "why": "The files are already there. With a submodule, a plain clone would have left this folder empty.",
        "hint": "ls bob/vendor/lib.",
        "alts": [
          "ls bob/vendor/lib/",
          "ls -A bob/vendor/lib"
        ]
      }
    ]
  }
};

const HASHES =["4f2a9c1", "9d8e7f6", "c0ffee1"];
const KNOWN = /^(git|ls|cd|pwd|mkdir|echo|printf|touch|man)\b/;

export function start(id) {
  const lesson = LESSONS[id];
  return lesson ? { lesson, index: 0, misses: 0, last: "", history: [], flags: {} } : null;
}

export function normalise(raw) {
  return raw.trim().replace(/\s+/g, " ").replace(/[\u201c\u201d]/g, '"');
}

export function currentStep(session) {
  return session.lesson.steps[session.index] ?? null;
}

export function isDone(session) {
  return session.index >= session.lesson.steps.length;
}

function fill(text, last, history) {
  const hash = (k) => HASHES[history.length - 1 - k];
  const full = (k) => hash(k).padEnd(40, "0");
  const oneline = history.map((message, k) => `${hash(k)}${k ? " " : " (HEAD -> main) "}${message}`).join("\n");
  const graph = history.map((message, k) => `* ${hash(k)}${k ? " " : " (HEAD -> main) "}${message}`).join("\n");
  const long = history
    .map((message, k) => `commit ${full(k)}${k ? "" : " (HEAD -> main)"}\nAuthor: You <you@example.com>\nDate:   Mon Oct 26 10:0${history.length - k}:00 2026 -0400\n\n    ${message}`)
    .join("\n\n");
  return text.replace(/\{manual\}/g, MANUAL).replace(/\{m\}/g, last).replace(/\{logfull\}/g, long).replace(/\{loggraph\}/g, graph).replace(/\{log\}/g, oneline);
}

const MANUAL = [
  "GIT-COMMIT(1)                      Git Manual                      GIT-COMMIT(1)",
  "",
  "NAME",
  "       git-commit - Record changes to the repository",
  "",
  "SYNOPSIS",
  "       git commit [-a] [-m <msg>] [--amend] [--no-edit] [--dry-run]",
  "",
  "DESCRIPTION",
  "       Creates a new commit containing the staged changes and a log message",
  "       that describes them. The new commit becomes the tip of the current",
  "       branch.",
  "",
  "OPTIONS",
  "       -a, --all",
  "           Stage every modified or deleted file that Git already tracks",
  "           before committing. New files are not included.",
  "",
  "       -m <msg>, --message=<msg>",
  "           Use <msg> as the commit message instead of opening an editor.",
  "",
  "       --amend",
  "           Replace the tip of the current branch with a new commit that",
  "           combines the staged changes and the previous commit.",
  "",
  "       --no-edit",
  "           Keep the existing message. Used with --amend.",
  "",
  "SEE ALSO",
  "       git-add(1), git-status(1), git-log(1)",
  "",
  "Git                                                              GIT-COMMIT(1)",
].join("\n");

// The pager is a simulated `less`: long output (a multi-page log, a manual page) opens in it, as
// Git does in a real terminal. Pure state in, state out; the element draws it.
export const PAGER_HEIGHT = 8;

export function pagerOpen(text) {
  return { lines: text.split("\n"), top: 0 };
}

export function needsPager(text) {
  return text.split("\n").length > PAGER_HEIGHT;
}

const lastTop = (pager) => Math.max(0, pager.lines.length - PAGER_HEIGHT);

// `key` is a KeyboardEvent.key. Returns { pager, quit, handled }.
export function pagerKey(pager, key) {
  const move = (top) => ({ pager: { ...pager, top: Math.min(lastTop(pager), Math.max(0, top)) }, quit: false, handled: true });
  if (key === "q" || key === "Q") return { pager, quit: true, handled: true };
  if ([" ", "f", "z", "PageDown"].includes(key)) return move(pager.top + PAGER_HEIGHT);
  if (["b", "w", "PageUp"].includes(key)) return move(pager.top - PAGER_HEIGHT);
  if (["j", "e", "Enter", "ArrowDown"].includes(key)) return move(pager.top + 1);
  if (["k", "y", "ArrowUp"].includes(key)) return move(pager.top - 1);
  if (key === "g" || key === "Home") return move(0);
  if (key === "G" || key === "End") return move(lastTop(pager));
  return { pager, quit: false, handled: false };
}

export function pagerView(pager) {
  const shown = pager.lines.slice(pager.top, pager.top + PAGER_HEIGHT);
  const atEnd = pager.top >= lastTop(pager);
  const pages = Math.ceil(pager.lines.length / PAGER_HEIGHT);
  const page = Math.min(pages, Math.floor(pager.top / PAGER_HEIGHT) + 1);
  return {
    text: shown.join("\n"),
    prompt: atEnd ? "(END)" : ":",
    atStart: pager.top === 0,
    atEnd,
    summary: `Lines ${pager.top + 1}-${pager.top + shown.length} of ${pager.lines.length}${atEnd ? " (end)" : ""}. Page ${page} of ${pages}.`,
  };
}

const asEntry = (entry) => (typeof entry === "string" ? { re: entry } : entry);

// Returns { session, lines: [{ kind, text }], advanced, pager? }. kinds: cmd, out, why, err, tip.
// When flagged output is longer than one screen, `pager` is { text, after } instead of an out
// line: the element opens it in a pager, then prints the `after` lines when the reader quits.
export function submit(session, raw) {
  const input = normalise(raw);
  const step = currentStep(session);
  if (!input || !step) return { session, lines: [], advanced: false };
  const lines = [{ kind: "cmd", text: `$ ${input}` }];
  if (input === "hint") {
    return { session, lines: [...lines, { kind: "tip", text: `Hint: ${step.hint}` }], advanced: false };
  }
  for (const side of (step.side ?? []).map(asEntry)) {
    if (!new RegExp(side.re).test(input)) continue;
    const flags = side.set ? { ...session.flags, [side.set]: true } : session.flags;
    const after = side.after ? [{ kind: "tip", text: side.after }] : [];
    if (side.pager && side.out && needsPager(side.out)) {
      return { session: { ...session, flags }, lines, advanced: false, pager: { text: side.out, after } };
    }
    if (side.out) lines.push({ kind: "out", text: side.out });
    lines.push(...after);
    return { session: { ...session, flags }, lines, advanced: false };
  }
  let unmet = "";
  for (const entry of step.ok.map(asEntry)) {
    const match = input.match(new RegExp(entry.re));
    if (!match) continue;
    if (entry.needs && !session.flags[entry.needs]) {
      unmet = entry.unmet || "";
      continue;
    }
    const captured = match.slice(1).find(Boolean);
    const last = captured || session.last;
    const keep = entry.keep ?? step.keep;
    const history = keep ? [captured, ...session.history] : session.history;
    const output = fill(entry.out ?? step.out, last, history);
    const why = { kind: "why", text: fill(entry.why ?? step.why, last, history) };
    const index = session.index + 1 + (entry.skip ?? 0);
    const next = { ...session, index, misses: 0, last, history };
    if ((entry.pager ?? step.pager) && output && needsPager(output)) {
      return { session: next, lines, advanced: true, pager: { text: output, after: [why] } };
    }
    if (output) lines.push({ kind: "out", text: output });
    lines.push(why);
    return { session: next, lines, advanced: true };
  }
  const misses = session.misses + 1;
  if (unmet) lines.push({ kind: "err", text: unmet });
  else if (step.near && new RegExp(step.near).test(input)) lines.push({ kind: "err", text: step.nearMsg });
  else if (!KNOWN.test(input)) lines.push({ kind: "err", text: `${input.split(" ")[0]}: command not found` });
  else lines.push({ kind: "err", text: `Not quite. This step asks you to: ${step.goal.charAt(0).toLowerCase()}${step.goal.slice(1)}` });
  if (misses >= 4) lines.push({ kind: "tip", text: `One way to do it: ${step.ex}` });
  else if (misses >= 2) lines.push({ kind: "tip", text: `Hint: ${step.hint}` });
  else lines.push({ kind: "tip", text: 'Type "hint" if you are stuck.' });
  return { session: { ...session, misses }, lines, advanced: false };
}

// Command recall, as in a shell: Up and Down (or Ctrl+P and Ctrl+N) walk the lines typed so far.
// Walking up keeps what was being typed as a draft, and walking back down past the newest line
// restores it. Blank lines and an immediate repeat of the previous line are not stored.
export function recallNew() {
  return { items: [], at: null, draft: "" };
}

export function recallPush(recall, raw) {
  const line = raw.trim();
  const items = line && recall.items[recall.items.length - 1] !== line ? [...recall.items, line] : recall.items;
  return { items, at: null, draft: "" };
}

export function recallKey(recall, key, current, ctrl = false) {
  const up = ctrl ? key === "p" || key === "P" : key === "ArrowUp";
  const down = ctrl ? key === "n" || key === "N" : key === "ArrowDown";
  if (up) {
    if (!recall.items.length) return { handled: true, recall, value: current };
    const at = recall.at === null ? recall.items.length - 1 : Math.max(0, recall.at - 1);
    const draft = recall.at === null ? current : recall.draft;
    return { handled: true, recall: { ...recall, at, draft }, value: recall.items[at] };
  }
  if (down) {
    if (recall.at === null) return { handled: true, recall, value: current };
    if (recall.at >= recall.items.length - 1) return { handled: true, recall: { ...recall, at: null }, value: recall.draft };
    const at = recall.at + 1;
    return { handled: true, recall: { ...recall, at }, value: recall.items[at] };
  }
  return { handled: false, recall, value: current };
}
