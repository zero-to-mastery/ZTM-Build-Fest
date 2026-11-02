#!/usr/bin/env bash
# Installs the Kin connection relay on a fresh Ubuntu 22.04/24.04 server
# (written for an Oracle Cloud Always Free VM; relay/deploy/ORACLE.md).
# Run it as root; running it again updates the relay and keeps its data.
#
#   sudo RELAY_EMAIL=you@example.org RELAY_ABUSE=abuse@example.org bash install-ubuntu.sh
#
# Settings (environment), with their defaults:
#   RELAY_NAME     relay.kin.journeytocode.io  the relay's own name
#   RELAY_ZONE     home.kin.journeytocode.io   the zone for free names
#   RELAY_EMAIL    (required)                  Let's Encrypt account e-mail
#   RELAY_ABUSE    (required)                  abuse address on the status page;
#                                              a read mailbox outside RELAY_ZONE
#   RELAY_IP       found from the internet     the VM's public IPv4
#   RELAY_REPO     https://github.com/mnichols08/ZTM-Build-Fest.git
#   RELAY_REF      kin-development             branch or tag to install from
#   NODE_VERSION   24.22.0                     the Node.js the relay runs on
#
# It stops before asking for a certificate until the DNS records point at
# this server, so the first run can be made before DNS is set up.
set -euo pipefail

RELAY_NAME=${RELAY_NAME:-relay.kin.journeytocode.io}
RELAY_ZONE=${RELAY_ZONE:-home.kin.journeytocode.io}
RELAY_EMAIL=${RELAY_EMAIL:-}
RELAY_ABUSE=${RELAY_ABUSE:-}
RELAY_REPO=${RELAY_REPO:-https://github.com/mnichols08/ZTM-Build-Fest.git}
RELAY_REF=${RELAY_REF:-kin-development}
NODE_VERSION=${NODE_VERSION:-24.22.0}

APP_DIR=/opt/kin/relay
CONF_DIR=/etc/kin-relay
TLS_DIR=$CONF_DIR/tls
DATA_DIR=/var/lib/kin-relay
BACKUP_DIR=/var/backups/kin-relay
NODE=/usr/local/bin/node

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'install-ubuntu.sh: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run it as root (sudo)."
[ -n "$RELAY_EMAIL" ] || fail "set RELAY_EMAIL to the e-mail for Let's Encrypt."
[[ "$RELAY_ABUSE" == ?*@?* ]] || fail "set RELAY_ABUSE to the abuse address shown on the status page."
# The relay answers every name in its zone and has no mail records there,
# so an address in the zone (the relay's old default) can't receive mail.
case "${RELAY_ABUSE##*@}" in
  "$RELAY_ZONE"|*".$RELAY_ZONE") fail "RELAY_ABUSE can't be in $RELAY_ZONE: mail there can't be delivered. Use a mailbox outside it." ;;
esac
command -v apt-get >/dev/null || fail "this script is for Ubuntu (apt-get not found)."

say "Packages"
export DEBIAN_FRONTEND=noninteractive
# On a new VM, apt-daily and unattended-upgrades run within minutes of the
# first boot and hold apt's locks; apt-get would give up at once.
apt_install() { apt-get -o DPkg::Lock::Timeout=900 install -y -q "$@"; }
for try in $(seq 90); do
  apt-get -o DPkg::Lock::Timeout=900 update -q && break
  [ "$try" -lt 90 ] || fail "apt-get update kept failing (is another apt still running?)."
  echo "apt is busy (often the first boot's automatic updates); trying again in 10 seconds."
  sleep 10
done
apt_install ca-certificates curl git xz-utils certbot sqlite3 dnsutils

RELAY_IP=${RELAY_IP:-$(curl -fsS4 --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]' || true)}
[[ "$RELAY_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "could not find the public IPv4; set RELAY_IP."
echo "Public IPv4: $RELAY_IP"

# A 1 GB VM can run out of memory while apt or certbot runs.
if [ ! -e /swapfile ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ]; then
  say "Swap (1 GB)"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Node.js $NODE_VERSION"
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) fail "unsupported CPU $(uname -m)." ;;
esac
if [ "$("$NODE" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  tarball="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -) || fail "the Node.js download did not match its checksum."
  rm -rf /opt/node && mkdir -p /opt/node
  # The tarball's files belong to uid 1001; root must own the runtime.
  tar --no-same-owner -xJf "$tmp/$tarball" -C /opt/node --strip-components=1
  chown -R root:root /opt/node
  ln -sf /opt/node/bin/node "$NODE"
  rm -rf "$tmp"
fi
"$NODE" --version

say "Relay code from $RELAY_REF"
tmp=$(mktemp -d)
git clone -q --depth 1 --filter=blob:none --sparse --branch "$RELAY_REF" "$RELAY_REPO" "$tmp/repo"
git -C "$tmp/repo" sparse-checkout set projects/kin/relay
mkdir -p "$APP_DIR"
# Only the relay's own modules: no tests, test fixtures or test helpers.
find "$APP_DIR" -maxdepth 1 -name '*.mjs' -delete
for file in "$tmp"/repo/projects/kin/relay/*.mjs; do
  case "$file" in *.test.mjs) continue ;; esac
  install -m 0644 "$file" "$APP_DIR/"
done
install -m 0644 "$tmp/repo/projects/kin/relay/README.md" "$APP_DIR/"
echo "Installed $(git -C "$tmp/repo" rev-parse --short HEAD) into $APP_DIR"
rm -rf "$tmp"

say "The kin-relay account"
id kin-relay >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin kin-relay
install -d -m 0750 -o root -g kin-relay "$CONF_DIR" "$TLS_DIR"
install -d -m 0700 -o root -g root "$BACKUP_DIR"

say "Port 53: turn off systemd-resolved's local stub"
# The stub holds 127.0.0.53:53, which keeps the relay from listening on
# every address. The server still resolves names through resolved.
if systemctl is-active --quiet systemd-resolved; then
  mkdir -p /etc/systemd/resolved.conf.d
  printf '[Resolve]\nDNSStubListener=no\n' > /etc/systemd/resolved.conf.d/kin-relay.conf
  ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
  systemctl restart systemd-resolved
fi

say "Firewall on the server (Oracle's Ubuntu images reject new ports)"
open_port() { # tool protocol port
  if ! "$1" -C INPUT -p "$2" --dport "$3" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; then
    # Before the image's catch-all REJECT, or at the top when there is none.
    local line
    line=$("$1" -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')
    "$1" -I INPUT "${line:-1}" -p "$2" --dport "$3" -m conntrack --ctstate NEW -j ACCEPT
  fi
}
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 53
else
  # Oracle's images keep their rules with netfilter-persistent. Installing it
  # where ufw is installed would remove ufw, so only do that without ufw.
  if ! command -v netfilter-persistent >/dev/null && ! command -v ufw >/dev/null; then
    apt_install iptables-persistent
  fi
  for tool in iptables ip6tables; do
    open_port "$tool" tcp 80
    open_port "$tool" tcp 443
    open_port "$tool" tcp 53
    open_port "$tool" udp 53
  done
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null
  else echo "Note: these firewall rules last until the next reboot (no netfilter-persistent)."; fi
fi

say "Settings ($CONF_DIR/relay.env)"
cat > "$CONF_DIR/relay.env" <<EOF
KIN_RELAY_ZONE=$RELAY_ZONE
KIN_RELAY_NAME=$RELAY_NAME
KIN_RELAY_TLS_CERT=$TLS_DIR/fullchain.pem
KIN_RELAY_TLS_KEY=$TLS_DIR/privkey.pem
KIN_RELAY_ADDRESSES=$RELAY_IP
KIN_RELAY_DATA_DIR=$DATA_DIR
KIN_RELAY_ABUSE=$RELAY_ABUSE
EOF
chown root:kin-relay "$CONF_DIR/relay.env"
chmod 0640 "$CONF_DIR/relay.env"

say "The service"
cat > /etc/systemd/system/kin-relay.service <<EOF
[Unit]
Description=Kin connection relay
After=network-online.target
Wants=network-online.target

[Service]
User=kin-relay
Group=kin-relay
EnvironmentFile=$CONF_DIR/relay.env
ExecStart=$NODE --permission --allow-fs-read=$APP_DIR --allow-fs-read=$TLS_DIR --allow-fs-read=$DATA_DIR --allow-fs-write=$DATA_DIR $APP_DIR/start.mjs
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=5
StateDirectory=kin-relay
StateDirectoryMode=0700
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
LimitNOFILE=200000

[Install]
WantedBy=multi-user.target
EOF

say "A daily copy of the name registry ($BACKUP_DIR, 30 kept)"
cat > /usr/local/sbin/kin-relay-backup <<EOF
#!/bin/sh
# Losing registry.sqlite would let names be claimed again (relay/README.md).
set -e
[ -f $DATA_DIR/registry.sqlite ] || exit 0
sqlite3 $DATA_DIR/registry.sqlite ".backup $BACKUP_DIR/registry-\$(date +%F).sqlite"
chmod 600 $BACKUP_DIR/registry-*.sqlite
ls -1t $BACKUP_DIR/registry-*.sqlite | tail -n +31 | xargs -r rm --
EOF
chmod 0755 /usr/local/sbin/kin-relay-backup
cat > /etc/systemd/system/kin-relay-backup.service <<'EOF'
[Unit]
Description=Copy the Kin relay's name registry

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/kin-relay-backup
EOF
cat > /etc/systemd/system/kin-relay-backup.timer <<'EOF'
[Unit]
Description=Copy the Kin relay's name registry daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
EOF

say "Certificate renewal hooks"
# certbot answers on port 80 itself, so the relay stops for the moment it
# renews (about every 60 days; home servers reconnect on their own).
mkdir -p /etc/letsencrypt/renewal-hooks/pre /etc/letsencrypt/renewal-hooks/post /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl stop kin-relay || true\n' > /etc/letsencrypt/renewal-hooks/pre/kin-relay
printf '#!/bin/sh\nsystemctl start kin-relay || true\n' > /etc/letsencrypt/renewal-hooks/post/kin-relay
cat > /etc/letsencrypt/renewal-hooks/deploy/kin-relay <<EOF
#!/bin/sh
# Copies the renewed certificate where the relay may read it.
set -e
live=/etc/letsencrypt/live/$RELAY_NAME
install -m 0640 -o root -g kin-relay "\$live/fullchain.pem" $TLS_DIR/fullchain.pem
install -m 0640 -o root -g kin-relay "\$live/privkey.pem" $TLS_DIR/privkey.pem
EOF
chmod 0755 /etc/letsencrypt/renewal-hooks/*/kin-relay
systemctl daemon-reload
systemctl enable --now kin-relay-backup.timer >/dev/null

say "DNS"
resolved=$(dig +short +time=5 +tries=2 A "$RELAY_NAME" @8.8.8.8 2>/dev/null | grep -E '^[0-9.]+$' | tail -n 1 || true)
if [ "$resolved" != "$RELAY_IP" ]; then
  cat <<EOF

Not finished yet: $RELAY_NAME does not point at this server
(it resolves to "${resolved:-nothing}"). At the DNS provider for the parent
domain, add these records, then run this script again:

  $RELAY_NAME.            A    $RELAY_IP
  $RELAY_ZONE.             NS   ns1.$RELAY_ZONE.
  $RELAY_ZONE.             NS   ns2.$RELAY_ZONE.
  ns1.$RELAY_ZONE.         A    $RELAY_IP
  ns2.$RELAY_ZONE.         A    $RELAY_IP

Also open TCP 80, 443 and 53 and UDP 53 to 0.0.0.0/0 in the cloud's network
rules (Oracle: the subnet's security list). This server's own firewall is
already open.
EOF
  exit 2
fi

say "The relay's certificate"
if [ ! -s "$TLS_DIR/fullchain.pem" ]; then
  systemctl stop kin-relay 2>/dev/null || true
  certbot certonly --standalone --non-interactive --agree-tos -m "$RELAY_EMAIL" -d "$RELAY_NAME" \
    || fail "certbot could not get a certificate. Is TCP port 80 open in the cloud's network rules?"
  RENEWED_LINEAGE=/etc/letsencrypt/live/$RELAY_NAME /etc/letsencrypt/renewal-hooks/deploy/kin-relay
fi

say "Start"
systemctl enable kin-relay >/dev/null
systemctl restart kin-relay
sleep 2
systemctl is-active --quiet kin-relay || { journalctl -u kin-relay -n 20 --no-pager; fail "the relay did not start."; }
journalctl -u kin-relay -n 5 --no-pager

say "Checks"
echo "SOA:    $(dig +short SOA "$RELAY_ZONE" @127.0.0.1)"
echo "CAA:    $(dig +short CAA "$RELAY_ZONE" @127.0.0.1)"
echo "Status: $(curl -fsS --max-time 10 --resolve "$RELAY_NAME:443:127.0.0.1" "https://$RELAY_NAME/" || echo 'no answer')"
echo "Port 80: $(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 -H "Host: test.$RELAY_ZONE" http://127.0.0.1/)"
cat <<EOF

The relay is running. From another computer, check that the internet reaches it:
  dig @$RELAY_IP $RELAY_ZONE SOA
  dig $RELAY_ZONE NS              (once the delegation has spread)
  curl https://$RELAY_NAME/
EOF
