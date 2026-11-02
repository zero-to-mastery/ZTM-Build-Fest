#!/bin/sh
set -eu

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  exit 0
fi

if [ -e .git ]; then
  echo "Container Git metadata exists but HEAD is invalid; refusing to replace it." >&2
  exit 1
fi

slug=${RENDER_GIT_REPO_SLUG:-}
commit=${RENDER_GIT_COMMIT:-}
branch=${RENDER_GIT_BRANCH:-main}
case "$slug" in
  ""|*[!a-zA-Z0-9_./-]*|/*|*..*|*/|*/*/*)
    echo "Missing or invalid RENDER_GIT_REPO_SLUG; cannot recover the source checkout." >&2
    exit 1 ;;
  */*) ;;
  *) echo "RENDER_GIT_REPO_SLUG must be owner/repository." >&2; exit 1 ;;
esac
case "$commit" in
  ""|*[!a-fA-F0-9]*)
    echo "Missing or invalid RENDER_GIT_COMMIT; cannot identify the shipped source." >&2
    exit 1 ;;
esac
if [ "${#commit}" -ne 40 ]; then
  echo "RENDER_GIT_COMMIT must be a full commit SHA." >&2
  exit 1
fi
git check-ref-format --branch "$branch" >/dev/null
git init -q --initial-branch="$branch"
git config core.filemode false
if [ -n "${OPENBLOG_GIT_SSH_KEY_PATH:-}" ]; then
  git remote add origin "git@github.com:${slug}.git"
else
  git remote add origin "https://github.com/${slug}.git"
fi
echo "Restoring container Git metadata for the shipped commit."
GIT_TERMINAL_PROMPT=0 git -c credential.interactive=false fetch -q origin "$commit"
# Attach metadata to the shipped files without replacing any file contents.
git read-tree "$commit"
if ! git diff --quiet "$commit" --; then
  echo "Container files differ from RENDER_GIT_COMMIT; refusing an ambiguous workspace baseline." >&2
  exit 1
fi
git update-ref "refs/heads/$branch" "$commit"
