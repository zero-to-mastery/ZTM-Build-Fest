# Running the relay on Oracle Cloud's free tier

The connection relay only passes encrypted bytes through and keeps a small
registry, so Oracle Cloud's Always Free tier is enough for it at no cost.
This guide sets up the Kin project's relay, `relay.kin.journeytocode.io`,
for the zone `home.kin.journeytocode.io`. The same steps work for any other
names: set `RELAY_NAME` and `RELAY_ZONE` when you run the script.

The script, `install-ubuntu.sh` beside this file, does everything on the
server. The steps below are the parts only the account owner can do.

## 1. The VM (Oracle Cloud console)

1. Sign up at cloud.oracle.com. It asks for a card to check who you are;
   Always Free resources are not charged. The **home region** can't be
   changed later: pick one near the people who will use Kin.
2. **Networking → Virtual cloud networks → Start VCN wizard → "Create VCN
   with Internet Connectivity"**, with the defaults.
3. In that VCN, open the **public subnet's security list** and add ingress
   rules from `0.0.0.0/0`:

   | Protocol | Destination port |
   | --- | --- |
   | TCP | 80 |
   | TCP | 443 |
   | TCP | 53 |
   | UDP | 53 |

   Keep the existing SSH rule (TCP 22).
4. **Compute → Instances → Create instance**:
   - Image: **Canonical Ubuntu 24.04** (or 22.04).
   - Shape: **VM.Standard.E2.1.Micro** (AMD, "Always Free-eligible").
   - Networking: the public subnet above, with a **public IPv4 address**.
   - Add your SSH public key.
5. Note the instance's **public IP address**.
6. **Keep Oracle from reclaiming it.** Oracle may reclaim *any* idle Always
   Free instance, this shape included: one whose CPU (95th percentile) and
   network use both stay under 20% for 7 days (for A1 shapes, memory too).
   A relay is idle most of the time, so it would qualify, and if it is
   stopped every home server loses its tunnel and every name in the zone
   stops resolving. The usual way out is to upgrade the account to **Pay As
   You Go** (Billing → Upgrade and manage payment): Oracle still doesn't
   charge for Always Free resources, and reclamation is commonly reported
   not to apply to paid accounts. Set a budget alert at a small amount so
   a mistake shows up. Check Oracle's "Always Free Resources" page for the
   current rules before relying on this.
7. Consider making the public IP a **reserved public IP** (Networking → IP
   management), so the address stays the same if the instance has to be
   recreated: the A and glue records below point at it.

## 2. Run the script (first time)

```sh
ssh ubuntu@<public IP>
curl -fsSLO https://raw.githubusercontent.com/mnichols08/ZTM-Build-Fest/kin-development/projects/kin/relay/deploy/install-ubuntu.sh
sudo RELAY_EMAIL=you@example.org RELAY_ABUSE=abuse@example.org bash install-ubuntu.sh
```

That URL works once `relay/deploy/` is on `kin-development`. Before then,
copy the script from a checkout of the branch that has it instead:
`scp projects/kin/relay/deploy/install-ubuntu.sh ubuntu@<public IP>:`.

`RELAY_EMAIL` is the address Let's Encrypt writes to about the relay's own
certificate. `RELAY_ABUSE` is the abuse address the relay shows on every
name's status page: use a mailbox someone reads, **outside**
`home.kin.journeytocode.io` (for example one at `journeytocode.io`). The
relay answers every name in its zone and has no mail records there, so an
address in the zone can't receive mail, and the script refuses one.

The first run installs Node.js, the relay, its service, the server's
firewall rules and a daily copy of the name registry, then stops and prints
the DNS records to add, because the certificate needs them.

On a VM that has just booted, Ubuntu's automatic updates often hold apt for
a few minutes. The script waits for them (it says "apt is busy"); if it
still stops with "Could not get lock", run it again a little later. It is
safe to run again at any point.

## 3. DNS records (Google Cloud DNS, zone `journeytocode.io`)

`journeytocode.io` is served by Google Cloud DNS. In **Network services →
Cloud DNS → journeytocode.io → Add standard**, add:

| DNS name | Type | Data |
| --- | --- | --- |
| `relay.kin.journeytocode.io.` | A | the VM's public IP |
| `home.kin.journeytocode.io.` | NS | `ns1.home.kin.journeytocode.io.` and `ns2.home.kin.journeytocode.io.` |
| `ns1.home.kin.journeytocode.io.` | A | the VM's public IP |
| `ns2.home.kin.journeytocode.io.` | A | the VM's public IP |

The NS record hands the whole `home.kin` zone to the relay, which answers
for every name in it. Don't add any other records under
`home.kin.journeytocode.io`: the relay must be the only one answering
there. Use a short TTL (300) while testing.

## 4. Run the script again

```sh
sudo RELAY_EMAIL=you@example.org RELAY_ABUSE=abuse@example.org bash install-ubuntu.sh
```

Once `relay.kin.journeytocode.io` points at the VM, it gets the relay's
certificate from Let's Encrypt, starts the relay and checks it. Then, from
any other computer:

```sh
dig @<public IP> home.kin.journeytocode.io SOA   # the relay answers DNS
dig home.kin.journeytocode.io NS                 # the delegation works (can take a while)
curl https://relay.kin.journeytocode.io/         # "Kin connection relay for home.kin.journeytocode.io ..."
```

## Looking after it

- **Status and logs:** `systemctl status kin-relay`, `journalctl -u kin-relay`.
  The relay logs only its start and certificate reloads, by design.
- **Updates:** run the script again; it installs the relay from
  `kin-development` (or `RELAY_REF`) and restarts it. The registry is kept.
- **Its own certificate** renews through certbot's timer. The relay stops
  for the few seconds certbot needs port 80, and home servers reconnect on
  their own.
- **The registry** (`/var/lib/kin-relay/registry.sqlite`) is copied daily to
  `/var/backups/kin-relay` (30 kept). Losing it would let names be claimed
  again by someone else, so also copy those backups off the VM now and then,
  for example with `scp`. To move to a new VM, restore the newest copy into
  `/var/lib/kin-relay` before the first start.
- **Abuse:** `relay/README.md`, "Abuse".
- **If Oracle changes its free tier:** the script works on any Ubuntu VM
  (about $4–6 a month elsewhere). Restore the registry there and point the
  four DNS records at the new address.

## Before opening free names to everyone

ADR 0025 asks for `home.kin.journeytocode.io` to be on the Public Suffix List
before free names open to the public, and until Let's Encrypt uses that
entry the relay holds new names to 20 a week (`KIN_RELAY_NEW_NAMES_PER_WEEK`).
Neither stops testing.
