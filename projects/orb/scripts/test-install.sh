#!/bin/sh
# Tests install.sh against a local fake orb release in a scratch HOME.
#
#   sh scripts/test-install.sh             # install.sh run by sh
#   INSTALL_SH=dash sh scripts/test-install.sh
#
# Needs python3 (the local release server) and the network (the real zmx is
# downloaded, since install.sh pins its checksums). Nothing outside a temp
# folder is touched, and no run has a terminal to ask on.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
install_sh=${INSTALL_SH:-sh}
t=$(mktemp -d)
server=''
trap 'if [ -n "$server" ]; then kill "$server"; wait "$server" || :; fi 2>/dev/null; rm -rf "$t"' EXIT

case $(uname -s) in Darwin) os=macos ;; Linux) os=linux ;; *) os=unknown ;; esac
case $(uname -m) in arm64 | aarch64) arch=aarch64 ;; x86_64 | amd64) arch=x86_64 ;; *) arch=unknown ;; esac
if [ "$os" = macos ] && [ "$(/usr/sbin/sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then arch=aarch64; fi

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# A stub orb: reports 0.1.0 and logs `integration …` into the scratch HOME.
mkdir -p "$t/stub" "$t/srv/download/v0.1.0" "$t/srv/download/v0.0.9" "$t/fakebin" "$t/home"
cat >"$t/stub/orb" <<'EOF'
#!/bin/sh
case ${1:-} in
  --version | -V) echo "orb 0.1.0" ;;
  integration) echo "$*" >>"$HOME/stub.log" && echo "stub: integrations installed" ;;
esac
EOF
chmod 755 "$t/stub/orb"
asset=orb-0.1.0-$os-$arch.tar.gz
tar -czf "$t/srv/download/v0.1.0/$asset" -C "$t/stub" orb
(cd "$t/srv/download/v0.1.0" && printf '%s  %s\n' "$(sha "$asset")" "$asset" >"$asset.sha256")
bad=orb-0.0.9-$os-$arch.tar.gz
cp "$t/srv/download/v0.1.0/$asset" "$t/srv/download/v0.0.9/$bad"
printf '%s  %s\n' 0000000000000000000000000000000000000000000000000000000000000000 "$bad" >"$t/srv/download/v0.0.9/$bad.sha256"

# A stub kitty, so kitty counts as installed and a yes never installs it.
printf '#!/bin/sh\n' >"$t/fakebin/kitty"
chmod 755 "$t/fakebin/kitty"

port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$t/srv" >/dev/null 2>&1 &
server=$!
tries=0
until curl -fs -o /dev/null "http://127.0.0.1:$port/download/v0.1.0/$asset.sha256"; do
  tries=$((tries + 1))
  [ "$tries" -lt 50 ] || {
    echo "release server didn't start" >&2
    exit 1
  }
  sleep 0.1
done

# run [VAR=value…]: install.sh piped into a shell like the real one-liner, with
# a clean environment, no cargo on PATH, and no controlling terminal.
run() {
  python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    env -i HOME="$t/home" PATH="$t/fakebin:/usr/bin:/bin" \
    ORB_RELEASE_BASE="http://127.0.0.1:$port" ORB_VERSION=0.1.0 "$@" \
    "$install_sh" <"$root/install.sh" >"$t/out" 2>&1
}

failed=0
check() {
  name=$1
  shift
  if "$@"; then
    echo "ok - $name"
  else
    echo "not ok - $name"
    sed 's/^/    | /' "$t/out"
    failed=1
  fi
}
bin=$t/home/.local/bin

run ORB_INSTALL_NO=1 && status=0 || status=$?
check "first run exits 0" [ "$status" = 0 ]
check "first run installs orb" [ "$("$bin/orb" --version)" = "orb 0.1.0" ]
check "first run installs zmx 0.8.1" [ "$("$bin/zmx" version | awk '$1 == "zmx" { print $2 }')" = 0.8.1 ]
check "first run installs the integrations" grep -qx 'integration install' "$t/home/stub.log"
check "first run names the PATH line to add" grep -q "PATH: .*$bin" "$t/out"
before="$(sha "$bin/orb") $(sha "$bin/zmx")"

run ORB_INSTALL_NO=1 && status=0 || status=$?
check "second run exits 0" [ "$status" = 0 ]
check "second run finds orb installed" grep -q "orb 0.1.0 already installed" "$t/out"
check "second run finds zmx installed" grep -q "zmx 0.8.1 already installed" "$t/out"
check "second run leaves the binaries alone" [ "$(sha "$bin/orb") $(sha "$bin/zmx")" = "$before" ]

run && status=0 || status=$?
check "no-terminal run exits 0" [ "$status" = 0 ]
if [ "$os" = macos ]; then
  check "no-terminal run says it had no terminal to ask" grep -q "no terminal to ask on" "$t/out"
  conf=$t/home/.config/kitty/kitty.conf
  run ORB_INSTALL_YES=1 && status=0 || status=$?
  check "yes run adds the Cmd keys to kitty.conf" grep -qx 'map cmd+h send_key alt+h' "$conf"
  run ORB_INSTALL_YES=1 && status=0 || status=$?
  check "second yes run adds the Cmd keys only once" [ "$(grep -cx 'map cmd+h send_key alt+h' "$conf")" = 1 ]
fi

run ORB_INSTALL_NO=1 ORB_VERSION=0.0.9 && status=0 || status=$?
check "tampered release fails" [ "$status" != 0 ]
check "tampered release says checksum mismatch" grep -q "checksum mismatch" "$t/out"
check "tampered release leaves orb 0.1.0" [ "$("$bin/orb" --version)" = "orb 0.1.0" ]

exit "$failed"
