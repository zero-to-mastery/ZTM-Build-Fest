#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir "$work/bin" "$work/blog"
sed "s|/blog|$work/blog|g" "$root/docker-entrypoint.sh" > "$work/entrypoint.sh"
export TMPDIR="$work" TEST_LOG="$work/commands.log"
export PATH="$work/bin:$PATH"
export OPENBLOG_ADMIN_USER="" OPENBLOG_ADMIN_PASSWORD="" GIT_AUTHOR_NAME=""
export OPENBLOG_GIT_TOKEN="" OPENBLOG_GIT_SSH_KEY_PATH="" OPENBLOG_GIT_SSH_KNOWN_HOSTS_PATH=""
export OPENBLOG_GIT_REPOSITORY='git@github.com:example/blog.git'
export OPENBLOG_GIT_BRANCH='main' RENDER_GIT_COMMIT='0123456789abcdef'

cat > "$work/bin/git" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_LOG"
if [ "$3 $4 $5" = "remote get-url origin" ]; then
  printf '%s\n' "${TEST_REMOTE:-https://github.com/example/blog.git}"
fi
EOF
cat > "$work/bin/openblog" <<'EOF'
#!/bin/sh
printf 'openblog %s\n' "$*" >> "$TEST_LOG"
if [ "$1" = "serve" ] && [ -n "$OPENBLOG_GIT_SSH_KEY_PATH" ]; then
  printf '%s\n' "$GIT_SSH_COMMAND" >> "$TEST_LOG"
  key=$(printf '%s\n' "$GIT_SSH_COMMAND" | sed 's/^ssh -i "\([^"]*\)".*/\1/')
  test "$(stat -c %a "$key")" = 600
  cmp "$key" "$OPENBLOG_GIT_SSH_KEY_PATH"
fi
EOF
chmod +x "$work/bin/git" "$work/bin/openblog"

sh "$work/entrypoint.sh"
grep -q 'openblog serve --admin' "$TEST_LOG"
echo 'PASS: startup without publishing credentials'

printf 'dummy-private-key\n' > "$work/input-key"
printf 'github.com dummy-pinned-host-key\n' > "$work/known-hosts"
export OPENBLOG_GIT_SSH_KEY_PATH="$work/input-key"
export OPENBLOG_GIT_SSH_KNOWN_HOSTS_PATH="$work/known-hosts"
: > "$TEST_LOG"
sh "$work/entrypoint.sh"
if grep -q 'init -b main' "$TEST_LOG"; then
  grep -q 'remote add origin git@github.com:example/blog.git' "$TEST_LOG"
  grep -q 'fetch --depth=1 origin 0123456789abcdef' "$TEST_LOG"
  grep -q 'reset --mixed FETCH_HEAD' "$TEST_LOG"
else
  grep -q 'remote set-url origin git@github.com:example/blog.git' "$TEST_LOG"
fi
grep -q 'StrictHostKeyChecking=yes' "$TEST_LOG"
grep -q 'IdentitiesOnly=yes' "$TEST_LOG"
grep -Fq "UserKnownHostsFile=\"$work/known-hosts\"" "$TEST_LOG"
echo 'PASS: repository SSH remote, private key permissions, and pinned host verification'

export TEST_REMOTE='git@github.com:example/blog.git'
mkdir "$work/blog/.git"
: > "$TEST_LOG"
sh "$work/entrypoint.sh"
grep -q 'remote set-url origin git@github.com:example/blog.git' "$TEST_LOG"
if grep -q 'init -b' "$TEST_LOG"; then
  echo 'FAIL: an existing repository was reinitialized' >&2
  exit 1
fi
echo 'PASS: existing SSH remote'

export OPENBLOG_GIT_TOKEN='dummy-token'
if sh "$work/entrypoint.sh" > "$work/error.log" 2>&1; then
  echo 'FAIL: conflicting credentials were accepted' >&2
  exit 1
fi
grep -q 'Configure only one' "$work/error.log"
export OPENBLOG_GIT_TOKEN=''
echo 'PASS: conflicting credential methods rejected'

export OPENBLOG_GIT_SSH_KNOWN_HOSTS_PATH="$work/missing"
if sh "$work/entrypoint.sh" > "$work/error.log" 2>&1; then
  echo 'FAIL: missing host-key file was accepted' >&2
  exit 1
fi
grep -q 'pinned known-hosts' "$work/error.log"
echo 'PASS: missing pinned host-key file rejected'

export OPENBLOG_GIT_SSH_KNOWN_HOSTS_PATH="$work/known-hosts"
export TEST_REMOTE='https://example.com/other/repo.git'
export OPENBLOG_GIT_REPOSITORY="$TEST_REMOTE"
if sh "$work/entrypoint.sh" > "$work/error.log" 2>&1; then
  echo 'FAIL: unexpected repository host was accepted' >&2
  exit 1
fi
grep -q 'requires a GitHub repository remote' "$work/error.log"
echo 'PASS: unsupported repository host rejected'
