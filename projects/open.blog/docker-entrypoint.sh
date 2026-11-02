#!/bin/sh
# Starts open.blog inside the container. See the Dockerfile for the variables.
set -e

# Provision credentials before recovering Git metadata omitted by Docker hosts.
if [ -n "$OPENBLOG_GIT_TOKEN" ]; then
  git config --global --replace-all credential.https://github.com.helper ""
  git config --global --add credential.https://github.com.helper \
    '!f() { if [ "$1" = get ]; then printf "username=x-access-token\npassword=%s\n" "$OPENBLOG_GIT_TOKEN"; fi; }; f'
fi

if [ -n "$OPENBLOG_ADMIN_USER" ] || [ -n "$OPENBLOG_ADMIN_PASSWORD" ]; then
  if [ -z "$OPENBLOG_ADMIN_USER" ] || [ -z "$OPENBLOG_ADMIN_PASSWORD" ]; then
    echo "Set both OPENBLOG_ADMIN_USER and OPENBLOG_ADMIN_PASSWORD." >&2
    exit 1
  fi
  users=$(openblog user list)
  if printf '%s\n' "$users" | grep -Fqx -- "$OPENBLOG_ADMIN_USER"; then
    OPENBLOG_PASSWORD="$OPENBLOG_ADMIN_PASSWORD" openblog user passwd "$OPENBLOG_ADMIN_USER"
  else
    OPENBLOG_PASSWORD="$OPENBLOG_ADMIN_PASSWORD" openblog user add "$OPENBLOG_ADMIN_USER"
  fi
fi

if [ -n "$GIT_AUTHOR_NAME" ]; then
  git config --global user.name "$GIT_AUTHOR_NAME"
  git config --global user.email "${GIT_AUTHOR_EMAIL:-openblog@localhost}"
fi
git config --global --add safe.directory /blog

# With an SSH deploy key, publishing can be limited to this repository.
if [ -n "$OPENBLOG_GIT_SSH_KEY_PATH" ]; then
  if [ -n "$OPENBLOG_GIT_TOKEN" ]; then
    echo "Configure only one of OPENBLOG_GIT_SSH_KEY_PATH and OPENBLOG_GIT_TOKEN" >&2
    exit 1
  fi
  if [ ! -r "$OPENBLOG_GIT_SSH_KEY_PATH" ] || [ ! -r "$OPENBLOG_GIT_SSH_KNOWN_HOSTS_PATH" ]; then
    echo "SSH publishing requires readable deploy-key and pinned known-hosts files" >&2
    exit 1
  fi
  key_dir=$(mktemp -d)
  cp "$OPENBLOG_GIT_SSH_KEY_PATH" "$key_dir/deploy-key"
  chmod 600 "$key_dir/deploy-key"
  export GIT_SSH_COMMAND="ssh -i \"$key_dir/deploy-key\" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"$OPENBLOG_GIT_SSH_KNOWN_HOSTS_PATH\""
fi

if [ -n "$RENDER_GIT_COMMIT" ] && ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  sh /blog/scripts/container-git.sh
fi

if [ -n "$OPENBLOG_GIT_SSH_KEY_PATH" ]; then
  remote=$(git -C /blog remote get-url origin)
  case "$remote" in
    https://github.com/*)
      remote="git@github.com:${remote#https://github.com/}"
      ;;
    git@github.com:*)
      ;;
    *)
      echo "SSH deploy-key publishing requires a GitHub repository remote" >&2
      exit 1
      ;;
  esac
  git -C /blog remote set-url origin "$remote"
fi

# Read the token from the process environment only when Git requests credentials.
if [ -n "$OPENBLOG_GIT_TOKEN" ]; then
  remote=$(git -C /blog remote get-url origin)
  case "$remote" in
    https://github.com/*|https://*@github.com/*)
      host_path=$(printf '%s' "$remote" | sed 's#^https://\([^@]*@\)\{0,1\}##')
      git -C /blog remote set-url origin "https://${host_path}"
      ;;
    git@github.com:*)
      git -C /blog remote set-url origin "https://github.com/${remote#git@github.com:}"
      ;;
    *)
      echo "OPENBLOG_GIT_TOKEN requires a github.com origin remote." >&2
      exit 1
      ;;
  esac
fi

exec openblog serve --admin --host 0.0.0.0 --port "${PORT:-8080}" "$@"
