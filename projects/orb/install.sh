#!/bin/sh
# orb installer:
#
#   curl -fsSL https://raw.githubusercontent.com/zqccer/orb/main/install.sh | sh
#
# Installs orb and zmx into ~/.local/bin, sets up orb's Claude Code and pi
# integrations, offers to install kitty and (on macOS) to add orb's Cmd keys
# to kitty.conf, then lists what is left. Safe to run again: every step checks
# first. Questions are asked on the terminal (/dev/tty), never on stdin.
#
# Settings (environment):
#   ORB_INSTALL_DIR    where orb and zmx go (default ~/.local/bin)
#   ORB_VERSION        the orb version to install (default: the latest release)
#   ORB_RELEASE_BASE   where orb's releases live (default: orb's GitHub releases)
#   ORB_INSTALL_YES=1  answer every question yes; ORB_INSTALL_NO=1 answers no
set -eu

ORB_INSTALL_DIR=${ORB_INSTALL_DIR:-$HOME/.local/bin}
ORB_RELEASE_BASE=${ORB_RELEASE_BASE:-https://github.com/zqccer/orb/releases}
ORB_REPO=https://github.com/zqccer/orb
ZMX_VERSION=0.8.1
ZMX_BASE=https://github.com/neurosnap/zmx/releases/download

nl='
'
done_lines=''
todo_lines=''
no_tty=''
kitty_ok=''

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
done_line() { done_lines="$done_lines  - $*$nl"; }
todo_line() { todo_lines="$todo_lines  - $*$nl"; }
has() { command -v "$1" >/dev/null 2>&1 || [ -x "$ORB_INSTALL_DIR/$1" ]; }

# ask QUESTION: succeeds on yes. Reads only /dev/tty: under `curl | sh`, stdin
# is this script. No terminal counts as no.
ask() {
  if [ -n "${ORB_INSTALL_NO:-}" ]; then return 1; fi
  if [ -n "${ORB_INSTALL_YES:-}" ]; then return 0; fi
  if ! (exec </dev/tty) 2>/dev/null; then
    no_tty=1
    return 1
  fi
  printf '%s [Y/n] ' "$1" >/dev/tty
  read -r answer </dev/tty || answer=n
  case $answer in '' | y | Y | yes | Yes) return 0 ;; *) return 1 ;; esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }

# version_ge A B: succeeds when version A >= B (an empty A is 0.0.0).
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) {
      if (x[i] + 0 > y[i] + 0) exit 0
      if (x[i] + 0 < y[i] + 0) exit 1
    }
    exit 0
  }'
}

# put_bin FILE NAME: installs FILE as $ORB_INSTALL_DIR/NAME by rename, so a
# running copy is never overwritten in place.
put_bin() {
  cp "$1" "$ORB_INSTALL_DIR/$2.new"
  chmod 755 "$ORB_INSTALL_DIR/$2.new"
  mv -f "$ORB_INSTALL_DIR/$2.new" "$ORB_INSTALL_DIR/$2"
}

zmx_version() { "$1" version </dev/null 2>/dev/null | awk '$1 == "zmx" { print $2; exit }'; }

install_orb() {
  ver=${ORB_VERSION:-}
  if [ -z "$ver" ]; then
    url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$ORB_RELEASE_BASE/latest" 2>/dev/null) || url=''
    case $url in */tag/v*) ver=${url##*/tag/v} ;; esac
  fi
  if [ -n "$ver" ] && [ "$("$ORB_INSTALL_DIR/orb" --version </dev/null 2>/dev/null)" = "orb $ver" ]; then
    done_line "orb $ver already installed"
    return
  fi
  url=$ORB_RELEASE_BASE
  if [ -n "$ver" ] && [ -n "$os" ] && [ -n "$arch" ]; then
    asset=orb-$ver-$os-$arch.tar.gz
    url=$ORB_RELEASE_BASE/download/v$ver/$asset
    say "Downloading $asset"
    if fetch "$url" "$tmp/$asset" && fetch "$url.sha256" "$tmp/$asset.sha256"; then
      if [ "$(sha256_of "$tmp/$asset")" != "$(awk '{print $1; exit}' "$tmp/$asset.sha256")" ]; then
        die "checksum mismatch for $asset; orb not installed"
      fi
      mkdir "$tmp/orb"
      tar -xzf "$tmp/$asset" -C "$tmp/orb"
      put_bin "$tmp/orb/orb" orb
      done_line "orb $ver installed in $ORB_INSTALL_DIR"
      return
    fi
    warn "couldn't download $url"
  fi
  has cargo || die "no orb release for this machine (tried $url); install Rust from https://rustup.rs and run this again"
  say "Building orb from source with cargo (this takes a few minutes)"
  set -- --git "$ORB_REPO" --locked --root "$tmp/cargo"
  if [ -n "$ver" ]; then set -- "$@" --tag "v$ver"; fi
  cargo install "$@" orb </dev/null
  put_bin "$tmp/cargo/bin/orb" orb
  done_line "orb ${ver:-(main)} built and installed in $ORB_INSTALL_DIR"
}

install_zmx() {
  zmx=$ORB_INSTALL_DIR/zmx
  if [ ! -x "$zmx" ]; then zmx=$(command -v zmx 2>/dev/null) || zmx=''; fi
  have=''
  if [ -n "$zmx" ]; then have=$(zmx_version "$zmx"); fi
  if version_ge "$have" "$ZMX_VERSION"; then
    done_line "zmx $have already installed"
  else
    case $os-$arch in
      linux-aarch64) sum=943eb44c812333fd450da12097521afd3339436e86f8c2ac618b905c4c9ece68 ;;
      linux-x86_64) sum=dfd75720b942466f28870731cc86dbc07afa72fb8f3bd5eeb4ff707e4eecebe8 ;;
      macos-aarch64) sum=1d86b1c9fba47fa707a6f0e976b20510b07c1c26d0ed010b9414b2a2c5e6beef ;;
      macos-x86_64) sum=3208578ad91d8a62077772dc8a1369a92033d9e84169bac673ef8542b6ff9707 ;;
      *)
        todo_line "zmx: no build for this machine; install zmx $ZMX_VERSION or newer from https://github.com/neurosnap/zmx"
        return
        ;;
    esac
    asset=zmx-$ZMX_VERSION-$os-$arch.tar.gz
    say "Downloading $asset"
    fetch "$ZMX_BASE/v$ZMX_VERSION/$asset" "$tmp/$asset" || die "couldn't download $ZMX_BASE/v$ZMX_VERSION/$asset"
    [ "$(sha256_of "$tmp/$asset")" = "$sum" ] || die "checksum mismatch for $asset; zmx not installed"
    mkdir "$tmp/zmx"
    tar -xzf "$tmp/$asset" -C "$tmp/zmx"
    put_bin "$tmp/zmx/zmx" zmx
    done_line "zmx $ZMX_VERSION installed in $ORB_INSTALL_DIR"
  fi
  first=$(command -v zmx 2>/dev/null) || first=''
  if [ -n "$first" ] && [ "$first" != "$ORB_INSTALL_DIR/zmx" ] && [ -x "$ORB_INSTALL_DIR/zmx" ]; then
    v=$(zmx_version "$first")
    if ! version_ge "$v" "$ZMX_VERSION"; then
      todo_line "zmx: the older ${v:-unknown} at $first comes first on PATH; put $ORB_INSTALL_DIR before it or remove it"
    fi
  fi
}

install_integrations() {
  say "Setting up orb's Claude Code and pi integrations"
  out=$("$ORB_INSTALL_DIR/orb" integration install </dev/null 2>&1) || die "orb integration install failed:$nl$out"
  printf '%s\n' "$out" | sed 's/^/  /'
  done_line "Claude Code and pi integrations set up"
}

have_kitty() {
  has kitty && return 0
  case $os in
    macos) [ -d /Applications/kitty.app ] || [ -d "$HOME/Applications/kitty.app" ] ;;
    linux) [ -x "$HOME/.local/kitty.app/bin/kitty" ] ;;
    *) return 1 ;;
  esac
}

install_kitty() {
  if have_kitty; then
    kitty_ok=1
    done_line "kitty found"
    return
  fi
  declined="kitty: orb runs inside it, get it from https://sw.kovidgoyal.net/kitty/ (another terminal needs Nerd Font symbols and the kitty keyboard protocol)"
  if ! ask "Install kitty (orb runs inside it)?"; then
    todo_line "$declined"
    return
  fi
  if [ "$os" = macos ] && has brew; then
    brew install --cask kitty </dev/null || {
      todo_line "$declined"
      return
    }
  else
    curl -fsSL https://sw.kovidgoyal.net/kitty/installer.sh | sh /dev/stdin launch=n || {
      todo_line "$declined"
      return
    }
  fi
  if [ "$os" = linux ]; then
    app=$HOME/.local/kitty.app
    apps=$HOME/.local/share/applications
    ln -sf "$app/bin/kitty" "$app/bin/kitten" "$ORB_INSTALL_DIR/"
    mkdir -p "$apps"
    cp "$app"/share/applications/kitty*.desktop "$apps/"
    sed -i "s|Icon=kitty|Icon=$app/share/icons/hicolor/256x256/apps/kitty.png|g; s|Exec=kitty|Exec=$app/bin/kitty|g" "$apps"/kitty*.desktop
  fi
  kitty_ok=1
  done_line "kitty installed"
}

# macOS only: kitty takes Cmd keys orb uses, so hand them to orb as Alt keys.
kitty_keys() {
  conf=${KITTY_CONFIG_DIRECTORY:-${XDG_CONFIG_HOME:-$HOME/.config}/kitty}/kitty.conf
  if [ -f "$conf" ] && grep -q -e 'send_key alt+h' -e '^[[:space:]]*macos_option_as_alt' "$conf"; then
    done_line "kitty.conf already sends orb its Alt keys"
    return
  fi
  if ! ask "Add orb's Cmd keys to $conf (Cmd+h/j/k/l and others send Alt to orb)?"; then
    todo_line "Cmd keys: add the block from https://github.com/zqccer/orb/blob/main/docs/keys.md to $conf, or set macos_option_as_alt yes"
    return
  fi
  mkdir -p "$(dirname "$conf")"
  {
    printf '\n# orb: Cmd keys send Alt\n'
    for key in h j k l left down up right n x f plus equal minus 1 2 3 4 5 6 7 8 9 '[' ']' i o; do
      printf 'map cmd+%s send_key alt+%s\n' "$key" "$key"
    done
  } >>"$conf"
  done_line "orb's Cmd keys added to $conf"
  todo_line "kitty: reload its config (ctrl+cmd+,) or restart it"
}

check_tools() {
  py=$(command -v python3 2>/dev/null) || py=''
  if [ -z "$py" ] || { [ "$os" = macos ] && [ "$py" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; }; then
    todo_line "python3: orb's Claude Code hook needs it; run xcode-select --install (macOS) or install your distro's python3"
  fi
  if ! has claude && ! has pi; then
    todo_line "an agent: Claude Code (curl -fsSL https://claude.ai/install.sh | bash) or pi (npm install -g @earendil-works/pi-coding-agent)"
  fi
  case ":$PATH:" in
    *":$ORB_INSTALL_DIR:"*)
      first=$(command -v orb 2>/dev/null) || first=''
      if [ "$first" != "$ORB_INSTALL_DIR/orb" ]; then
        todo_line "PATH: $first comes before $ORB_INSTALL_DIR/orb; remove it or put $ORB_INSTALL_DIR first"
      fi
      ;;
    *)
      case ${SHELL##*/} in
        fish) todo_line "PATH: run  fish_add_path $ORB_INSTALL_DIR" ;;
        zsh) todo_line "PATH: add  export PATH=\"$ORB_INSTALL_DIR:\$PATH\"  to $HOME/.zshrc, then open a new terminal" ;;
        bash) todo_line "PATH: add  export PATH=\"$ORB_INSTALL_DIR:\$PATH\"  to $HOME/.bashrc, then open a new terminal" ;;
        *) todo_line "PATH: add  export PATH=\"$ORB_INSTALL_DIR:\$PATH\"  to $HOME/.profile, then open a new terminal" ;;
      esac
      ;;
  esac
}

main() {
  has curl || die "need curl"
  has sha256sum || has shasum || die "need sha256sum or shasum to check downloads"
  case $(uname -s) in Darwin) os=macos ;; Linux) os=linux ;; *) os='' ;; esac
  case $(uname -m) in arm64 | aarch64) arch=aarch64 ;; x86_64 | amd64) arch=x86_64 ;; *) arch='' ;; esac
  # A Rosetta shell on an Apple Silicon Mac reports x86_64; the native build is better.
  if [ "$os" = macos ] && [ "$(/usr/sbin/sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then arch=aarch64; fi
  SHELL=${SHELL:-}

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$ORB_INSTALL_DIR"

  install_orb
  install_zmx
  install_integrations
  install_kitty
  if [ -n "$kitty_ok" ] && [ "$os" = macos ]; then kitty_keys; fi
  check_tools

  if [ -n "$no_tty" ]; then
    todo_line "some questions were skipped (no terminal to ask on); run this again in a terminal, or with ORB_INSTALL_YES=1"
  fi
  say ""
  say "Done:"
  printf '%s' "$done_lines"
  if [ -n "$todo_lines" ]; then
    say "Left for you:"
    printf '%s' "$todo_lines"
  else
    say "Nothing left: run orb inside kitty."
  fi
  say "Start: orb"
}

# Everything runs from here, after sh has read the whole script, so nothing
# below can read the rest of the script from a `curl | sh` stdin.
main "$@"
