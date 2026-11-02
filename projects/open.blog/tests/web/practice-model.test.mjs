import test from "node:test";
import assert from "node:assert/strict";
import { LESSONS, PAGER_HEIGHT, start, submit, isDone, currentStep, pagerOpen, pagerKey, pagerView, recallNew, recallPush, recallKey } from "../../web/components/ob-practice-model.js";

test("Up and Down walk earlier commands and put the half-typed line back", () => {
  let recall = recallNew();
  for (const line of ["git status", "git log", "git branch"]) recall = recallPush(recall, line);
  let r = recallKey(recall, "ArrowUp", "git co");
  assert.equal(r.value, "git branch", "first Up shows the newest command");
  r = recallKey(r.recall, "ArrowUp", r.value);
  assert.equal(r.value, "git log");
  r = recallKey(r.recall, "ArrowUp", r.value);
  r = recallKey(r.recall, "ArrowUp", r.value);
  assert.equal(r.value, "git status", "Up stops at the oldest command");
  r = recallKey(r.recall, "ArrowDown", r.value);
  assert.equal(r.value, "git log");
  r = recallKey(r.recall, "ArrowDown", r.value);
  r = recallKey(r.recall, "ArrowDown", r.value);
  assert.equal(r.value, "git co", "Down past the newest command restores the draft");
  assert.equal(recallKey(r.recall, "ArrowDown", "git co").value, "git co", "Down with nothing recalled leaves the line alone");
});

test("Ctrl+P and Ctrl+N recall like Up and Down, and plain letters are not recall keys", () => {
  const recall = recallPush(recallPush(recallNew(), "pwd"), "ls");
  const up = recallKey(recall, "p", "", true);
  assert.equal(up.value, "ls");
  assert.equal(recallKey(up.recall, "n", up.value, true).value, "");
  assert.equal(recallKey(recall, "p", "x", false).handled, false, "p without Ctrl is just a letter");
  assert.equal(recallKey(recall, "ArrowUp", "x", true).handled, false, "Ctrl+Up is not Up");
});

test("recall ignores blank lines and an immediate repeat, and an empty history does nothing", () => {
  let recall = recallNew();
  assert.equal(recallKey(recall, "ArrowUp", "abc").value, "abc");
  for (const line of ["  ", "git log", "git log", "  git status  "]) recall = recallPush(recall, line);
  assert.deepEqual(recall.items, ["git log", "git status"]);
  recall = recallPush(recall, "git log");
  assert.deepEqual(recall.items, ["git log", "git status", "git log"], "a repeat that is not immediate is kept");
});

function type(session, commands) {
  let result = { session, lines: [], advanced: false };
  for (const command of commands) result = submit(result.session, command);
  return result;
}

// Finish a lesson from wherever a session is, by typing each remaining step's example.
function finish(session) {
  while (!isDone(session)) {
    const step = currentStep(session);
    const result = submit(session, step.ex);
    assert.ok(result.advanced, `"${step.ex}" was not accepted for "${step.goal}"`);
    session = result.session;
  }
  return session;
}

test("every lesson can be finished by typing its example commands", () => {
  for (const id of Object.keys(LESSONS)) assert.ok(isDone(finish(start(id))), id);
});

test("every listed alternative is accepted at its step, and the lesson still finishes", () => {
  let checked = 0;
  for (const [id, lesson] of Object.entries(LESSONS)) {
    lesson.steps.forEach((step, index) => {
      for (const alt of step.alts ?? []) {
        let session = start(id);
        for (const earlier of lesson.steps.slice(0, index)) session = submit(session, earlier.ex).session;
        assert.equal(session.index, index, `${id} step ${index}: setup drifted`);
        const chain = [].concat(alt);
        const result = type(session, chain);
        assert.ok(result.advanced, `${id} step ${index + 1}: "${chain.join(" ; ")}" should be accepted for "${step.goal}"`);
        assert.ok(isDone(finish(result.session)), `${id}: finishing after "${chain.join(" ; ")}"`);
        checked += 1;
      }
    });
  }
  assert.ok(checked > 40, `only ${checked} alternatives were checked`);
});

test("a wrong command does not advance, and hints escalate", () => {
  const session = start("first-workflow");
  const first = submit(session, "git frobnicate");
  assert.equal(first.advanced, false);
  assert.equal(first.session.index, 0);
  assert.match(first.lines.at(-1).text, /hint/i);
  const second = submit(first.session, "git frobnicate");
  assert.match(second.lines.at(-1).text, /^Hint: /);
  const fourth = submit(submit(second.session, "git x").session, "git x");
  assert.match(fourth.lines.at(-1).text, /^One way to do it: git init$/);
});

test("non-git input says command not found, and near-misses get their own message", () => {
  assert.match(submit(start("first-workflow"), "hello").lines[1].text, /command not found/);
  const session = type(start("first-workflow"), ["git init", 'echo "# x" > README.md', "git status", "git add README.md", 'git commit -m "one"']).session;
  assert.match(submit(session, 'echo "more" > README.md').lines[1].text, />>/);
});

test("a one-step shortcut that does two jobs skips the step it covers", () => {
  const session = type(start("first-workflow"), ["git init", "touch README.md", "git status", "git add .", 'git commit -m "one"', 'echo "y" >> README.md', "git diff"]).session;
  const shortcut = submit(session, 'git commit -am "Both at once"');
  assert.ok(shortcut.advanced);
  assert.equal(currentStep(shortcut.session).goal.startsWith("Show the history"), true);
  assert.match(submit(shortcut.session, "git log --oneline").lines[1].text, /Both at once\n.*one$/);
});

test("a command that needs an earlier command is refused until it has run", () => {
  const session = start("branch-and-merge");
  const early = submit(session, "git switch feature/login");
  assert.equal(early.advanced, false);
  assert.match(early.lines[1].text, /did not match/);
  const created = submit(session, "git branch feature/login");
  assert.equal(created.advanced, false, "creating the label alone does not finish the step");
  assert.ok(submit(created.session, "git switch feature/login").advanced);
});

test("quoted or bare values are echoed back, and the log lists their commits", () => {
  assert.match(submit(start("first-time-setup"), "git config user.name Ada").lines.at(-1).text, /`Ada`/);
  const inputs = ["git init", 'echo "# x" > README.md', "git status", "git add .", 'git commit -m "Mine one"', 'echo "y" >> README.md', "git diff", "git add .", 'git commit -m "Mine two"'];
  const session = type(start("first-workflow"), inputs).session;
  assert.equal(submit(session, "git log --oneline").lines[1].text, "9d8e7f6 (HEAD -> main) Mine two\n4f2a9c1 Mine one");
  const long = submit(session, "git log");
  assert.ok(long.advanced && long.pager, "a two-commit log is longer than one screen, so it opens in the pager");
  assert.match(long.pager.text, /^commit 9d8e7f6\w{33} \(HEAD -> main\)\nAuthor: .*\nDate: .*\n\n {4}Mine two\n\ncommit 4f2a9c1/);
  assert.match(long.pager.after[0].text, /Both of your commits/);
});

test("long output opens a pager that answers to the keys less does", () => {
  const log = submit(start("log-and-branches"), "git log");
  assert.equal(log.advanced, false, "the plain log is a side command: the step still wants --oneline");
  assert.equal(log.session.index, 0);
  assert.match(log.pager.after[0].text, /--oneline/);
  let pager = pagerOpen(log.pager.text);
  assert.equal(pager.lines.length, 17);
  assert.equal(pagerView(pager).prompt, ":");
  assert.equal(pagerView(pager).atStart, true);
  const press = (key) => { const r = pagerKey(pager, key); pager = r.pager; return r; };
  press(" ");
  assert.equal(pager.top, PAGER_HEIGHT);
  press("PageDown");
  assert.equal(pagerView(pager).prompt, "(END)", "the last page ends with (END)");
  press(" ");
  assert.equal(pager.top, pager.lines.length - PAGER_HEIGHT, "paging past the end stays on the last page");
  press("b");
  assert.equal(pager.top, pager.lines.length - PAGER_HEIGHT - PAGER_HEIGHT);
  press("g");
  assert.equal(pager.top, 0);
  press("j");
  press("Enter");
  press("ArrowDown");
  assert.equal(pager.top, 3);
  press("k");
  press("ArrowUp");
  assert.equal(pager.top, 1);
  press("G");
  assert.equal(pagerView(pager).atEnd, true);
  press("Home");
  assert.equal(pager.top, 0);
  assert.equal(pagerKey(pager, "x").handled, false, "unknown keys are ignored, as in less");
  assert.deepEqual([pagerKey(pager, "q").quit, pagerKey(pager, "Q").quit], [true, true]);
});

test("a manual page opens in the pager and finishes the step when the reader quits", () => {
  const session = type(start("first-time-setup"), ["git config user.name Ada", "git config user.email a@b.co", "git config core.editor vim"]).session;
  const result = submit(session, "git commit --help");
  assert.ok(result.advanced);
  assert.match(result.pager.text, /^GIT-COMMIT\(1\)/);
  assert.ok(pagerOpen(result.pager.text).lines.length > PAGER_HEIGHT);
  assert.match(result.pager.after[0].text, /q quits/);
});

test("short output prints inline instead of opening a pager", () => {
  const session = type(start("first-workflow"), ["git init", "touch README.md", "git status", "git add .", 'git commit -m "only"', 'echo "y" >> README.md', "git diff", "git add .", 'git commit -m "two"']).session;
  const oneLine = submit(session, "git log --oneline");
  assert.equal(oneLine.pager, undefined);
  assert.match(oneLine.lines[1].text, /two\n.*only/);
});

test("a wrong version tag and a non-conventional message get specific messages", () => {
  let session = start("conventional-release");
  assert.match(submit(session, 'git commit -m "added login"').lines[1].text, /type: summary/);
  session = type(session, ['git commit -m "feat: login"', 'git commit -m "fix(cart): bug"']).session;
  assert.match(submit(session, 'git tag -a v2.0.0 -m "x"').lines[1].text, /v1\.1\.0/);
});

test("case-rename: the twin names are listed, only the index entry is removed, and a rename may go through a temporary name", () => {
  let session = start("case-rename");
  const status = submit(session, "git status");
  assert.equal(status.advanced, false);
  assert.match(status.lines.at(-1).text, /never edited that file/);
  const listed = submit(session, "git ls-files");
  assert.ok(listed.advanced);
  assert.match(listed.lines[1].text, /^This\.component\.test\.jsx\nheader\.jsx\nthis\.component\.test\.jsx$/);
  session = listed.session;
  assert.equal(submit(session, "git config core.ignorecase").lines[1].text, "true");
  session = submit(session, "git config core.ignorecase").session;

  const plainRm = submit(session, "git rm This.component.test.jsx");
  assert.equal(plainRm.advanced, false, "plain git rm refuses on the twin, so it must not advance");
  assert.match(plainRm.lines[1].text, /--cached/);
  assert.equal(submit(session, "git rm --cached header.jsx").advanced, false, "removing an unrelated file is not the goal");
  session = submit(session, "git rm --cached This.component.test.jsx").session;

  const plainMv = submit(session, "mv header.jsx Header.jsx");
  assert.equal(plainMv.advanced, false);
  assert.match(plainMv.lines[1].text, /git mv/);
  const early = submit(session, "git mv header-tmp.jsx Header.jsx");
  assert.equal(early.advanced, false, "the second half of a two-step rename needs the first half");
  const half = submit(session, "git mv header.jsx header-tmp.jsx");
  assert.equal(half.advanced, false);
  assert.match(half.lines.at(-1).text, /Half done/);
  session = submit(half.session, "git mv header-tmp.jsx Header.jsx").session;

  assert.equal(submit(session, "git commit -m").advanced, false);
  const committed = submit(session, 'git commit -m "Tidy names"');
  assert.match(committed.lines[1].text, /^\[main 44d9f80\] Tidy names\n 2 files changed, 1 deletion\(-\)\n rename header\.jsx => Header\.jsx \(100%\)\n delete mode 100644 This\.component\.test\.jsx$/);
  const check = submit(committed.session, "git ls-files | sort -f | uniq -di");
  assert.ok(check.advanced && isDone(check.session));
  assert.match(check.lines.at(-1).text, /no two tracked names differ only by case/);
});

test("case-rename: the check step rejects a pipe that does not fold case", () => {
  const session = type(start("case-rename"), ["git ls-files", "git config core.ignorecase", "git rm --cached This.component.test.jsx", "git mv header.jsx Header.jsx", 'git commit -m "x"']).session;
  assert.equal(submit(session, "git ls-files | sort | uniq -d").advanced, false);
  assert.match(submit(session, "git ls-files").lines.at(-2).text, /Pipe it/);
});

test("interactive-rebase: the fixup needs --autosquash, update-refs moves the stacked branch, and the ways out differ", () => {
  let session = start("interactive-rebase");
  assert.equal(submit(session, "git log --oneline").advanced, false, "without the main.. range it lists everything");
  session = submit(session, "git log --oneline main..").session;

  assert.equal(submit(session, "git commit --fixup 872747b").advanced, false, "a fixup of the wrong commit is not the goal");
  session = submit(session, "git commit --fixup b4b3152").session;

  const plain = submit(session, "git rebase -i main");
  assert.equal(plain.advanced, false, "without --autosquash the fixup stays at the bottom");
  assert.match(plain.lines.at(-2).text, /pick 9c64964 fixup! Add search box$/);
  assert.match(plain.lines.at(-1).text, /--autosquash/);
  const squashed = submit(session, "git rebase -i --autosquash main");
  assert.ok(squashed.advanced);
  assert.match(squashed.lines[1].text, /^pick b4b3152 Add search box\nfixup 9c64964 fixup! Add search box\n/);
  session = squashed.session;

  const bare = submit(session, "git rebase main");
  assert.equal(bare.advanced, false, "a plain rebase leaves the branch below behind");
  assert.match(bare.lines.at(-1).text, /search stayed/);
  session = submit(session, "git rebase --update-refs main").session;

  for (const wrong of ["git rebase --continue", "git rebase --skip"]) {
    const result = submit(session, wrong);
    assert.equal(result.advanced, false, wrong);
    assert.match(result.lines.at(-3).text + result.lines.at(-2).text, /--abort/);
  }
  assert.match(submit(session, "git status").lines.at(-1).text, /three ways out/);
  session = submit(session, "git rebase --abort").session;

  assert.equal(submit(session, "git reset --hard HEAD~1").advanced, false);
  assert.match(submit(session, "git reflog").lines.at(-1).text, /ORIG_HEAD/);
  const done = submit(session, "git reset --hard ORIG_HEAD");
  assert.ok(done.advanced && isDone(done.session));
  assert.equal(done.lines[1].text, "HEAD is now at 96eed00 Debug output");
});

test("config-and-aliases: origin is required, scope is named, and every divergent-pull answer is accepted", () => {
  let session = start("config-and-aliases");
  assert.equal(submit(session, "git config --list").advanced, false);
  assert.match(submit(session, "git config --list").lines[1].text, /--show-origin/);
  const side = submit(session, "git config user.email");
  assert.equal(side.advanced, false);
  assert.equal(side.lines[1].text, "ada@work.example");
  const listed = submit(session, "git config --list --show-origin");
  assert.ok(listed.advanced);
  assert.match(listed.lines[1].text, /file:\.git\/config\tuser\.email=ada@work\.example$/);
  session = listed.session;

  assert.match(submit(session, "git config user.email").lines[1].text, /Add --show-origin/);
  const scoped = submit(session, "git config --show-scope --show-origin user.email");
  assert.ok(scoped.advanced);
  assert.match(scoped.lines[1].text, /^local\tfile:\.git\/config\tada@work\.example$/);
  session = submit(session, "git config --show-origin user.email").session;

  assert.equal(submit(session, "git config push.autoSetupRemote true").advanced, false, "without --global it is not every repository");
  assert.match(submit(session, "git config push.autoSetupRemote true").lines[1].text, /--global/);
  session = submit(session, "git config --global push.autoSetupRemote true").session;
  session = submit(session, "git config --global fetch.prune true").session;

  for (const answer of ["git config --global pull.ff only", "git config --global pull.rebase true", "git config --global pull.rebase false"]) {
    assert.ok(submit(session, answer).advanced, answer);
  }
  assert.equal(submit(session, "git config --global pull.ff false").advanced, false);
  session = submit(session, "git config --global pull.rebase true").session;

  assert.equal(submit(session, "git config --global alias.lg log --oneline --graph --decorate").advanced, false, "unquoted value is not one argument");
  assert.equal(submit(session, 'git config --global alias.lg "log --oneline"').advanced, false);
  assert.equal(submit(session, 'git config alias.lg "log --oneline --graph --decorate"').advanced, false, "local alias is not every repository");
  session = submit(session, "git config --global alias.lg 'log --decorate --oneline --graph'").session;
  const done = submit(session, "git config --global --unset alias.lg");
  assert.ok(done.advanced && isDone(done.session));
});

test("rerere: the preimage and resolution lines appear, the replay is unstaged, and a plain commit is accepted", () => {
  let session = start("rerere");
  assert.equal(submit(session, "git config rerere.enabled false").advanced, false);
  assert.match(submit(session, "git config rerere.enable true").lines[1].text, /rerere\.enabled/);
  session = submit(session, "git config --global rerere.enabled true").session;
  const first = submit(session, "git merge feature");
  assert.ok(first.advanced);
  assert.match(first.lines[1].text, /Recorded preimage for 'theme\.txt'$/);
  session = first.session;
  assert.equal(submit(session, "git add other.txt").advanced, false);
  assert.match(submit(session, "git status --short").lines[1].text, /^UU theme\.txt$/);
  session = submit(session, "git add .").session;
  const commit = submit(session, 'git commit -m "Merge feature"');
  assert.match(commit.lines[1].text, /^Recorded resolution for 'theme\.txt'\.\n\[main f1d2f67\] Merge feature$/);
  assert.match(submit(session, "git commit --no-edit").lines[1].text, /Merge branch 'feature'$/);
  session = commit.session;
  assert.equal(submit(session, "git reset --hard HEAD~2").advanced, false);
  session = submit(session, "git reset --hard ORIG_HEAD").session;
  const again = submit(session, "git merge feature");
  assert.match(again.lines[1].text, /Resolved 'theme\.txt' using previous resolution\.$/);
  const diff = submit(again.session, "git diff");
  assert.ok(diff.advanced && isDone(diff.session));
  assert.match(diff.lines[1].text, /^diff --cc theme\.txt/);
});

test("bisect: each answer must match the exit code at that commit, and one command can name both ends", () => {
  let session = start("bisect");
  assert.equal(submit(session, "git bisect bad").advanced, false, "start comes first");
  session = submit(session, "git bisect start").session;
  session = submit(session, "git bisect bad").session;
  const early = submit(session, "git bisect good");
  assert.equal(early.advanced, false, "the good end must name a commit");
  assert.match(early.lines.at(-2).text, /git bisect good v1\.0/);
  session = submit(session, "git bisect good v1.0").session;

  const wrong = submit(session, "git bisect bad");
  assert.equal(wrong.advanced, false, "check.sh printed 0 at 189fe51, so bad is the wrong answer");
  assert.match(wrong.lines.at(-2).text, /printed 0/);
  assert.equal(submit(session, "sh check.sh; echo $?").lines.at(-2).text, "0");
  session = submit(session, "git bisect good").session;
  assert.equal(submit(session, "git bisect good").advanced, false, "check.sh printed 1 at 977c5b3");
  assert.equal(submit(session, "sh check.sh").lines.at(-2).text, "1");
  session = type(session, ["git bisect bad", "git bisect bad"]).session;
  const found = submit(session, "git bisect good");
  assert.ok(found.advanced);
  assert.match(found.lines[1].text, /^e2b28b48490fa9fca263b1139911de5315b6778c is the first bad commit\n/);
  session = found.session;

  assert.match(submit(session, "git status").lines.at(-1).text, /git bisect reset/);
  session = submit(session, "git bisect reset").session;
  session = submit(session, "git bisect start HEAD v1.0").session;
  assert.equal(submit(session, "git bisect run check.sh").advanced, false, "run needs a command that sh can start");
  const run = submit(session, "git bisect run sh check.sh");
  assert.ok(run.advanced && isDone(run.session));
  assert.equal(run.lines[1].text.match(/^running 'sh' 'check.sh'$/gm).length, 4);
});

test("bisect: naming both ends at the start skips the two marking steps", () => {
  const result = submit(start("bisect"), "git bisect start HEAD v1.0");
  assert.ok(result.advanced);
  assert.equal(result.session.index, 3);
  assert.match(result.lines[1].text, /roughly 3 steps\)\n\[189fe51/);
});

test("signing: a commit without -S is refused, and the check names the signer and echoes the message", () => {
  let session = start("signing");
  session = type(session, ["git config --global gpg.format ssh", "git config --global user.signingkey ~/.ssh/id_ed25519.pub"]).session;
  assert.equal(submit(session, "git config --global user.signingkey id_ed25519").advanced, false, "a key name without a path to the .pub file");
  session = submit(session, "git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers").session;
  const unsigned = submit(session, 'git commit -m "Plain"');
  assert.equal(unsigned.advanced, false);
  assert.match(unsigned.lines[1].text, /Add -S/);
  const signed = submit(session, 'git commit -S -m "Signed commit"');
  assert.match(signed.lines[1].text, /^\[main 3782c0e\] Signed commit\n 1 file changed/);
  assert.ok(submit(signed.session, "git log --show-signature").advanced, "the lesson has one commit, so the plain form checks it too");
  assert.equal(submit(signed.session, "git log --oneline").advanced, false);
  const verdict = submit(signed.session, "git log --show-signature -1");
  assert.match(verdict.lines[1].text, /\nGood "git" signature for ada@example\.com with ED25519 key SHA256:.*\n.*\n.*\n\n {4}Signed commit$/);
  assert.match(submit(signed.session, "git verify-commit HEAD").lines[1].text, /^Good "git" signature for ada@example\.com/);
  const finished = submit(verdict.session, "git config --global commit.gpgsign true");
  assert.ok(finished.advanced && isDone(finished.session));
});

test("archaeology: the reformat hides the author until it is ignored, and -S misses a changed value that -G finds", () => {
  let session = start("archaeology");
  const first = submit(session, "git blame -L 7,9 checkout.js");
  assert.ok(first.advanced);
  assert.match(first.lines[1].text, /^83b088e7 .*\nab0f597e \(Ravi/);
  session = first.session;

  const again = submit(session, "git blame -L 7,9 checkout.js");
  assert.equal(again.advanced, false, "the same blame gives the same wrong answer");
  assert.match(again.lines.at(-2).text, /--ignore-rev ab0f597/);
  const ignored = submit(session, "git blame --ignore-rev ab0f597 -L 7,9 checkout.js");
  assert.match(ignored.lines[1].text, /b226a4fd \(Ada /);
  session = ignored.session;

  assert.equal(submit(session, "git log -S RETRY_LIMIT").advanced, false, "needs --oneline");
  session = submit(session, "git log -S RETRY_LIMIT --oneline").session;

  const s = submit(session, "git log -S TIMEOUT_MS --oneline");
  assert.equal(s.advanced, false, "-S does not count a changed value");
  assert.match(s.lines.at(-1).text, /-G reads the changed lines/);
  assert.doesNotMatch(s.lines[1].text, /03b44d0/);
  const g = submit(session, 'git log -G "TIMEOUT_MS = [0-9]+" --oneline');
  assert.match(g.lines[1].text, /^03b44d0 Give slow carriers more time/);
  session = g.session;

  const history = submit(session, "git log -L :addTax:checkout.js");
  assert.ok(history.advanced && history.pager, "the function history is longer than a screen");
  assert.match(history.pager.text, /Round tax[\s\S]*Reformat with 2-space indent[\s\S]*Add tax/);
  session = history.session;

  const last = submit(session, 'git log --format="%h %an %ad %s" --date=short');
  assert.ok(last.advanced && isDone(last.session));
  assert.match(last.lines[1].text, /^0963c24 Ada 2024-05-06 Round tax\n/);
});

test("worktree: the new branch needs -b or an existing branch, and a branch cannot be checked out twice", () => {
  const session = start("worktree");
  const early = submit(session, "git worktree add ../hotfix hotfix");
  assert.equal(early.advanced, false, "the branch does not exist yet");
  assert.match(early.lines[1].text, /no branch called hotfix/);
  const reused = submit(session, "git worktree add ../hotfix main");
  assert.equal(reused.advanced, false);
  assert.match(reused.lines[1].text, /already used by worktree/);
  const created = submit(session, "git branch hotfix");
  assert.equal(created.advanced, false, "creating the branch alone does not make the folder");
  assert.ok(submit(created.session, "git worktree add ../hotfix hotfix").advanced);
  const after = type(session, ["git worktree add ../hotfix -b hotfix main", "git worktree list"]).session;
  const refused = submit(after, "git switch hotfix");
  assert.ok(refused.advanced);
  assert.match(refused.lines[1].text, /^fatal: 'hotfix' is already used by worktree at /);
  const merged = type(after, ["git switch hotfix", "git merge hotfix"]).session;
  assert.equal(submit(merged, "rm -rf ../hotfix").advanced, false);
  assert.match(submit(merged, "rm -rf ../hotfix").lines.at(-2).text, /worktree prune/);
});

test("submodule: a local path is refused until the file transport is allowed, and a plain clone leaves the folder empty", () => {
  const session = start("submodule");
  const plain = submit(session, "git submodule add ../lib.git vendor/lib");
  assert.equal(plain.advanced, false);
  assert.match(plain.lines[1].text, /transport 'file' not allowed/);
  const allowed = submit(session, "git config --global protocol.file.allow always");
  assert.equal(allowed.advanced, false);
  assert.ok(submit(allowed.session, "git submodule add ../lib.git vendor/lib").advanced);
  const ready = type(session, [
    "git -c protocol.file.allow=always submodule add ../lib.git vendor/lib",
    "git status",
    'git commit -m "Add lib as a submodule"',
  ]).session;
  const empty = submit(ready, "git clone app.git bob");
  assert.equal(empty.advanced, false);
  assert.match(empty.lines.at(-1).text, /empty folder/);
  const refused = submit(ready, "git clone --recurse-submodules app.git bob");
  assert.equal(refused.advanced, false, "the recursive clone fails on a local path without the allow setting");
  assert.match(refused.lines[1].text, /transport 'file' not allowed/);
  const cloned = submit(ready, "git -c protocol.file.allow=always clone --recurse-submodules app.git bob");
  assert.ok(cloned.advanced);
  assert.match(cloned.lines[1].text, /checked out '94078779f2d654668e7bfe8eb59828a532c3b160'/);
});

test("submodule: push check refuses and plain push leaves the library behind, only on-demand finishes", () => {
  const steps = ["git -c protocol.file.allow=always submodule add ../lib.git vendor/lib", "git status", 'git commit -m "Add lib"', "git -c protocol.file.allow=always clone --recurse-submodules app.git bob", "git submodule status"];
  const session = type(start("submodule"), steps).session;
  const check = submit(session, "git push --recurse-submodules=check origin main");
  assert.equal(check.advanced, false);
  assert.match(check.lines[1].text, /can\nnot be found on any remote/);
  const plain = submit(session, "git push origin main");
  assert.equal(plain.advanced, false);
  assert.match(plain.lines.at(-1).text, /on-demand/);
  const done = submit(session, "git push --recurse-submodules=on-demand origin main");
  assert.ok(done.advanced && isDone(done.session));
  assert.match(done.lines[1].text, /^Pushing submodule 'vendor\/lib'/);
});

test("big-repos: a plain clone is not shallow, --unshallow ends it, and sparse-checkout add does not finish the step", () => {
  const session = start("big-repos");
  const plain = submit(session, "git clone https://github.com/you/big.git");
  assert.equal(plain.advanced, false);
  assert.match(plain.lines.at(-1).text, /--depth 1/);
  const shallow = type(session, ["git clone --depth 1 https://github.com/you/big.git", "git rev-parse --is-shallow-repository"]);
  assert.equal(shallow.lines[1].text, "true");
  const lean = type(shallow.session, ["git fetch --unshallow"]).session;
  assert.equal(submit(lean, "git clone --filter=blob:none https://github.com/you/big.git lean").advanced, false, "both flags are needed");
  const sparse = type(lean, ["git clone --filter=blob:none --sparse https://github.com/you/big.git lean", "git sparse-checkout set docs", "git sparse-checkout list"]);
  assert.equal(sparse.lines[1].text, "docs");
  const added = submit(sparse.session, "git sparse-checkout add src");
  assert.equal(added.advanced, false);
  assert.match(added.lines.at(-1).text, /docs and src/);
  assert.ok(isDone(submit(sparse.session, "git sparse-checkout disable").session));
});

test("hooks: the hook refuses a normal commit, --no-verify gets past it, and the order of the flags does not matter", () => {
  const ready = type(start("hooks"), ["git config core.hooksPath .githooks", "git config core.hooksPath"]).session;
  const skipEarly = submit(ready, "git commit --no-verify -m \"Add env\"");
  assert.equal(skipEarly.advanced, false, "step three wants the refused commit first");
  assert.match(skipEarly.lines.at(-2).text, /skips the hook/);
  const refused = submit(ready, 'git commit -m "Add env"');
  assert.ok(refused.advanced);
  assert.equal(refused.lines[1].text, "pre-commit: refusing to commit a .env file.");
  const skip = refused.session;
  assert.equal(submit(skip, 'git commit -m "Again"').advanced, false, "a normal commit runs the hook again");
  assert.match(submit(skip, 'git commit -m "Add env anyway" --no-verify').lines[1].text, /^\[main bf37352\] Add env anyway\n/);
  const mode = type(skip, ['git commit -n -m "x"', "git update-index --chmod=+x .githooks/pre-commit"]).session;
  assert.match(submit(mode, "git ls-files -s .githooks/pre-commit").lines[1].text, /^100755 /);
});

test("remove-a-secret: keeping only the two paths is refused, the push needs --force and --mirror, and the counters change", () => {
  const search = 'git log --oneline -S"FAKE-not-a-real-key"';
  const first = submit(start("remove-a-secret"), search);
  assert.match(first.lines[1].text, /^fbe993a Stop tracking \.env\n65bf43d Add settings$/);
  assert.match(submit(start("remove-a-secret"), 'git log -S"FAKE-not-a-real-key"').lines.at(-2).text, /--oneline/);
  const counted = type(first.session, ["git count-objects -vH"]);
  assert.match(counted.lines[1].text, /size: 2\.86 MiB/);
  const keepOnly = submit(counted.session, "git filter-repo --path .env --path db-backup.dump");
  assert.equal(keepOnly.advanced, false);
  assert.match(keepOnly.lines.at(-2).text, /keeps only those files/);
  assert.equal(submit(counted.session, "git filter-repo --invert-paths --path .env").advanced, false, "both files must be named");
  assert.equal(submit(counted.session, "git filter-repo --sdr --invert-paths --path .env --path db-backup.dump --path extra").advanced, false);
  const rewritten = type(counted.session, ["git filter-repo --sdr --invert-paths --path db-backup.dump --path .env"]);
  assert.ok(rewritten.advanced);
  const empty = submit(rewritten.session, "git log --all --oneline -S FAKE-not-a-real-key");
  assert.ok(empty.advanced);
  assert.equal(empty.lines.length, 2, "no output line: the search finds nothing");
  const after = type(empty.session, ["git count-objects -vH"]);
  assert.match(after.lines[1].text, /size-pack: 1\.98 KiB/);
  const plain = submit(after.session, "git push origin main");
  assert.equal(plain.advanced, false);
  assert.match(plain.lines.at(-2).text, /--force and --mirror/);
  assert.equal(submit(after.session, "git push --force origin").advanced, false, "a force push alone leaves old tags behind");
  assert.ok(isDone(submit(after.session, "git push --mirror -f origin").session));
});

test("git3-check: a plain config read names the value, and a SHA-256 trial repository reports its format", () => {
  const session = type(start("git3-check"), ["git --version"]).session;
  const plain = submit(session, "git config init.defaultBranch");
  assert.ok(plain.advanced);
  assert.equal(plain.lines[1].text, "main");
  const origin = submit(session, "git config --show-origin --get init.defaultBranch");
  assert.match(origin.lines[1].text, /^file:\/home\/you\/\.gitconfig\tmain$/);
  const ready = type(origin.session, ["git rev-parse --show-object-format", "git rev-parse --show-ref-format", "git config --get safe.bareRepository"]).session;
  assert.equal(submit(ready, "git -C trial rev-parse --show-object-format").advanced, false, "the trial repository does not exist yet");
  const trial = type(ready, ["git init --object-format=sha256 trial"]);
  assert.match(trial.lines[1].text, /Initialized empty Git repository/);
  assert.equal(submit(trial.session, "git -C trial rev-parse --show-object-format").lines[1].text, "sha256");
});

test("partial-staging: y and n answer the prompt, a plain git add does not start it, and restore -p asks before discarding", () => {
  const session = start("partial-staging");
  const status = submit(session, "git status -s");
  assert.equal(status.advanced, false);
  assert.match(status.lines[1].text, /^ M greet\.js$/);
  const shown = type(session, ["git diff"]);
  assert.equal((shown.lines[1].text.match(/^@@/gm) ?? []).length, 2, "two hunks");
  const whole = submit(shown.session, "git add greet.js");
  assert.equal(whole.advanced, false);
  assert.match(whole.lines.at(-2).text, /Add -p/);
  const prompt = submit(shown.session, "git add -p");
  assert.match(prompt.lines[1].text, /\(1\/2\) Stage this hunk/);
  assert.equal(submit(prompt.session, "n").advanced, false, "n would leave the template string out");
  assert.match(submit(prompt.session, "n").lines.at(-2).text, /type y/);
  const second = submit(prompt.session, "y");
  assert.match(second.lines[1].text, /\(2\/2\) Stage this hunk/);
  assert.equal(submit(second.session, "y").advanced, false, "y would stage the exclamation mark too");
  const answered = submit(second.session, "n");
  assert.ok(answered.advanced);
  const unstaged = submit(answered.session, "git diff");
  assert.equal(unstaged.advanced, false, "plain git diff shows what is still waiting");
  assert.match(unstaged.lines.at(-1).text, /--staged/);
  const staged = submit(answered.session, "git diff --staged");
  assert.doesNotMatch(staged.lines[1].text, /loud \+/, "the exclamation mark is not staged");
  const committed = type(staged.session, ['git commit -m "Greet with a template string"']);
  assert.match(committed.lines[1].text, /^\[main fa6a9c7\] Greet with a template string/);
  const plainRestore = submit(committed.session, "git restore greet.js");
  assert.equal(plainRestore.advanced, false);
  assert.match(plainRestore.lines.at(-2).text, /without asking/);
  const asked = submit(committed.session, "git restore -p");
  assert.match(asked.lines[1].text, /Discard this hunk from worktree/);
  assert.equal(submit(asked.session, "n").advanced, false, "n would keep the edit");
  assert.ok(isDone(submit(asked.session, "y").session));
});

test("compare-branches: two dots in git diff show main's work reversed, and three dots after a rebase name the wrong base", () => {
  const session = start("compare-branches");
  const swapped = submit(type(session, ["git log --oneline main..feature", "git log --oneline --left-right main...feature"]).session, "git diff --stat main feature");
  assert.equal(swapped.advanced, false);
  assert.match(swapped.lines[1].text, /footer\.html  \| 1 -/);
  assert.match(swapped.lines.at(-1).text, /Three dots start at the merge base/);
  const names = submit(type(session, ["git log --oneline main..feature", "git log --oneline --left-right main...feature"]).session, "git diff --name-only main...feature");
  assert.ok(names.advanced);
  assert.equal(names.lines[1].text, "results.html\nsearch.html\nstyle.css");
  const rebased = type(session, ["git log --oneline main..feature", "git log --oneline --left-right main...feature", "git diff --stat main...feature"]).session;
  const wrongBase = submit(rebased, "git range-diff feature-v1...feature");
  assert.equal(wrongBase.advanced, false);
  assert.match(wrongBase.lines[1].text, /^-:  ------- > 1:  14548a7 Add footer/);
  const same = submit(rebased, "git range-diff main feature-v1 feature");
  assert.ok(same.advanced);
  assert.equal((same.lines[1].text.match(/ = /g) ?? []).length, 3, "a plain rebase pairs every commit with =");
  const amended = submit(same.session, "git range-diff main feature-v1 feature");
  assert.ok(amended.advanced);
  assert.match(amended.lines[1].text, /57c102b ! 3:  5cfb18e Style the search box/);
  assert.match(amended.lines[1].text, /-\+  width: 20em;\n\s+\+\+  width: 24em;/);
  assert.ok(isDone(amended.session));
});

test("subtree: a pull without --squash is refused after a squashed add, and the clone already holds the files", () => {
  const session = start("subtree");
  const noSquash = submit(session, "git subtree add --prefix=vendor/lib ../lib.git main");
  assert.equal(noSquash.advanced, false);
  assert.match(noSquash.lines.at(-2).text, /end with --squash/);
  const added = type(session, ["git subtree add --prefix=vendor/lib ../lib.git main --squash", "git log --oneline"]).session;
  const refused = submit(added, "git subtree pull --prefix=vendor/lib ../lib.git main");
  assert.equal(refused.advanced, false);
  assert.match(refused.lines[1].text, /fatal: refusing to merge unrelated histories/);
  const pulled = submit(added, "git subtree pull --prefix=vendor/lib ../lib.git main --squash");
  assert.ok(pulled.advanced);
  assert.match(pulled.lines[1].text, /Merge made by the 'ort' strategy/);
  const toMain = submit(pulled.session, "git subtree push --prefix=vendor/lib ../lib.git main");
  assert.equal(toMain.advanced, false, "the step wants a review branch");
  const pushed = submit(pulled.session, "git subtree push --prefix=vendor/lib ../lib.git spanish");
  assert.match(pushed.lines[1].text, /\[new branch\]/);
  const cloned = type(pushed.session, ["git clone app.git bob"]);
  assert.ok(isDone(submit(cloned.session, "ls bob/vendor/lib").session));
});

test("an unknown lesson id yields no session", () => {
  assert.equal(start("nope"), null);
});
