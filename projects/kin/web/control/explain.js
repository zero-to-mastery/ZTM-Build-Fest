// Plain words for every state and error code the control panel shows (ADR
// 0025 §11, #719–#722). The codes come from the home server: the tunnel
// (server/home/tunnel-client.mjs), the certificate manager and ACME client
// (server/acme/), the setup flow, the panel, the backups and the updater
// (server/home/). Each answer
// says what happened and, where there is one, what to do. A code this file
// doesn't know still gets a sentence by its family, never a raw code alone.

const TUNNEL_STATES = {
  connected: "Connected to the relay. Phones can reach this home server from anywhere.",
  connecting: "Connecting to the relay…",
  waiting: "Not connected. Kin tries again by itself.",
  stopped: "The connection to the relay is off.",
};

const TUNNEL_ERRORS = {
  "relay-unreachable": "Kin couldn't reach the relay. Check that this computer is online; Kin keeps trying.",
  "relay-certificate": "The relay's certificate wasn't trusted. Check the computer's date and time, and the relay address in the settings.",
  "relay-tls": "The secure connection to the relay failed. Kin keeps trying; if it goes on, check the relay address.",
  "sign-in-timeout": "The relay didn't answer in time. Kin keeps trying.",
  "auth-failed": "The relay didn't accept this home server's key. If you restored a backup, make sure it included the home folder.",
  replaced: "Another computer is using this home server's key, so the relay switched to it. Only one copy of a home server can run at a time: stop the other one.",
  limit: "The relay's limit was reached for this name. Kin waits and tries again.",
  suspended: "The relay operator has suspended this name. Contact the relay's abuse address to sort it out.",
  "relay-overloaded": "The relay is busy. Kin tries again shortly.",
  "relay-shutting-down": "The relay is restarting. Kin reconnects by itself.",
  "protocol-error": "The relay and this home server didn't understand each other. Update Kin; if it goes on, report it.",
  "tunnel-dead": "The connection went quiet and was closed. Kin reconnects by itself.",
  "connection-lost": "The connection to the relay dropped. Kin reconnects by itself.",
  "name-taken": "That name belongs to another home server. Choose another name.",
  "name-not-allowed": "The relay doesn't allow that name. Choose another one.",
  "name-limit": "The relay can't give out this name now: this server already has a name, or too many new names were claimed this week. Kin tries again later.",
  "name-unknown": "The relay doesn't know this name. For your own domain, check the _kin-relay TXT record.",
  "name-failed": "The relay didn't confirm the name. Kin tries again.",
  "tunnel-not-ready": "The relay hasn't routed this server's name yet.",
  "tunnel-timeout": "The relay didn't answer in time.",
  "tunnel-lost": "The connection dropped during the request.",
  "tunnel-stopped": "The connection to the relay was stopped.",
};

const CERTIFICATE_STATES = {
  none: "No certificate yet.",
  valid: "The certificate is valid.",
  renewing: "Getting a certificate…",
  "valid-retrying": "The certificate is valid, but renewing it failed. Kin tries again before it runs out.",
  failed: "Kin couldn't get a certificate. It tries again by itself.",
  expired: "The certificate has run out. Phones will warn that the site isn't secure until Kin gets a new one.",
};

const CERTIFICATE_ERRORS = {
  "acme-no-account": "Let's Encrypt doesn't know this server's account. Kin makes a new one on its next try.",
  "acme-already-revoked": "That certificate was already revoked.",
  "acme-bad-csr": "Let's Encrypt refused the certificate request. Update Kin; if it goes on, report it.",
  "acme-bad-nonce": "A request to Let's Encrypt went stale. Kin tries again.",
  "acme-bad-key": "Let's Encrypt refused this server's key. Update Kin; if it goes on, report it.",
  "acme-bad-request": "Let's Encrypt refused the request. Kin tries again later.",
  "acme-caa": "The name's CAA record doesn't allow this server's account. For your own domain, check the CAA record shown in setup.",
  "acme-compound": "Let's Encrypt found more than one problem. Kin tries again later.",
  "acme-connection": "Let's Encrypt couldn't connect to this server through the relay. Check that the relay shows Connected.",
  "acme-dns": "Let's Encrypt couldn't look up the name. For your own domain, check its A and AAAA records.",
  "acme-already-replaced": "This certificate was already replaced by a newer one. Kin orders again without linking them; nothing for you to do.",
  "acme-account-binding-required": "This certificate authority needs an account set up elsewhere first. Kin uses Let's Encrypt, which doesn't.",
  "acme-incorrect-response": "Let's Encrypt reached a server that didn't answer as this one. Check that no other computer uses this name.",
  "acme-bad-contact": "Let's Encrypt refused the contact details.",
  "acme-malformed": "Let's Encrypt couldn't read a request. Update Kin; if it goes on, report it.",
  "acme-order-not-ready": "The certificate wasn't ready yet. Kin tries again.",
  "acme-rate-limited": "Let's Encrypt's limit for new certificates was reached. Kin waits as long as it asks, then tries again.",
  "acme-rejected-name": "Let's Encrypt won't issue a certificate for this name.",
  "acme-server-error": "Let's Encrypt had a problem of its own. Kin tries again later.",
  "acme-tls": "Let's Encrypt's secure check of this server failed. Check that the relay shows Connected.",
  "acme-unauthorized": "Let's Encrypt couldn't confirm this server controls the name. Check that the relay shows Connected and, for your own domain, the DNS records.",
  "acme-terms-changed": "Let's Encrypt changed its terms. Agree to them again in setup.",
  "acme-error": "Something went wrong getting the certificate. Kin tries again later.",
  "acme-network": "Kin couldn't reach Let's Encrypt. Check that this computer is online.",
  "acme-timeout": "Let's Encrypt didn't answer in time. Kin tries again.",
  "acme-bad-response": "Let's Encrypt sent an answer Kin couldn't use. Kin tries again later.",
  "acme-no-challenge": "Let's Encrypt offered no check Kin can do. Kin tries again later.",
  "acme-authorization-invalid": "Let's Encrypt couldn't confirm this server controls the name. Check that the relay shows Connected.",
  "acme-order-invalid": "The certificate order failed. Kin tries again later.",
  "acme-terms-not-agreed": "Kin needs your agreement to Let's Encrypt's terms. Agree to them in setup.",
  "acme-insecure-url": "The certificate authority's address isn't secure. Check the ACME directory setting.",
  "acme-key-mismatch": "The certificate didn't match its key. Kin tries again.",
  "tunnel-caa-name-taken": "The relay won't set the CAA record: the name belongs to another server.",
  "tunnel-caa-name-not-allowed": "The relay refused this server's account in the CAA record.",
  "tunnel-caa-name-limit": "The relay is limiting changes. Kin tries again.",
  "tunnel-caa-name-unknown": "The relay doesn't know this name yet. Kin tries again once it is routed.",
  "tunnel-caa-suspended": "The relay operator has suspended this name.",
  "tunnel-caa-refused": "The relay refused to set the CAA record. Kin tries again.",
  ...Object.fromEntries(["tunnel-not-ready", "tunnel-timeout", "tunnel-lost", "tunnel-stopped"].map((code) => [code, "Kin is waiting for the relay to route this server's name before it asks for a certificate."])),
};

const TRANSPARENCY = {
  "not-checked": "Not checked yet. Kin checks the public certificate logs once a day.",
  ok: "Only this server's own certificates appear in the public logs.",
  alert: "A certificate for this name that this server didn't make appears in the public logs. Someone may be pretending to be your home server. Read “If a certificate you didn't make appears” in the guide.",
};

const BACKUP_STATES = {
  ok: "Kin backs this home server up every day by itself.",
  none: "No backup yet. Kin makes the first one within a few minutes.",
  running: "Making a backup now…",
  failed: "The last backup didn't work. Kin tries again in an hour.",
  restoring: "Kin is starting again to restore a backup. This page comes back by itself in a minute.",
  off: "Backups start once this home server is set up.",
};

// The copy to a second folder (#763), which the launcher makes.
const BACKUP_COPY_STATES = {
  off: "Backups aren't copied anywhere else. Choose a second folder, such as a USB drive, in the settings below.",
  waiting: "Kin looks at the folder within a minute. If this doesn't change after a few minutes, Kin was started in a way that doesn't copy backups: start it as kin, or as a service.",
  copying: "Copying backups to the second folder now…",
  ok: "Each backup is copied to the second folder too.",
  failed: "The last copy to the second folder didn't work.",
};

const BACKUP_ERRORS = {
  "backup-copy-missing": "Kin can't find the second folder. If it's on a USB drive, plug the drive in; Kin copies within a minute. Kin never makes this folder itself.",
  "backup-copy-not-folder": "The second folder's path names a file, not a folder. Choose a folder.",
  "backup-copy-same-disk": "The second folder is on the same drive as Kin's data, so a copy there wouldn't survive that drive failing. If it's on a USB drive, the drive may not be plugged in; otherwise choose a folder on another drive.",
  "backup-copy-denied": "Kin isn't allowed to write in the second folder. Give the account Kin runs as permission to write there; on Linux, run kin --install-service again if Kin was installed before this version.",
  "backup-copy-full": "The second folder's drive is full, so Kin couldn't copy the newest backup. Free some space there; Kin tries again in an hour and never deletes your files to make room.",
  "backup-copy-too-big": "A backup is too big for the drive's format (FAT32 holds files up to 4 GB). Use a drive formatted as exFAT or NTFS.",
  "backup-copy-failed": "Copying to the second folder didn't work, and Kin removed the unfinished copy. Kin tries again in an hour; if it goes on, try another drive.",
  "backup-copy-not-private": "Kin couldn't make the copies in the second folder private, so other accounts on this computer, and any computer the drive is plugged into, may read them. A FAT32 or exFAT drive can't keep anyone out: use one formatted as NTFS, or keep the drive locked away. On an NTFS drive, give the account Kin runs as full control of the folder. Kin tries again with the next backup.",
  "control-backup-copy-invalid": "Type the folder's full path, such as E:\\ on Windows or /media/usb on Linux. It can't be inside Kin's own data folder.",
  "backup-failed": "Kin couldn't make a backup. Check that this computer's disk is working and has room; Kin tries again in an hour.",
  "backup-disk-full": "The disk is full, so Kin couldn't make a backup. Free some space; Kin tries again in an hour.",
  "backup-busy": "Another backup or restore was using Kin's data at the same time. Kin tries again in an hour.",
  "backup-restore-pending": "Kin is about to restore a backup, so it isn't making new ones.",
  "backup-unknown": "Kin doesn't have that backup any more. Reload the page and choose another.",
  "backup-unreadable": "That backup doesn't open, so Kin won't restore it. Choose another one.",
  "control-backup-hour-invalid": "Choose an hour of the day.",
  "restore-failed": "Something went wrong putting the backup back.",
  "restore-deletion-pending": "A household on this server is being deleted. Cancel the deletion or let it finish, then restore.",
  "restore-newer-household": "The backup is older than a household that's on this server now, and restoring it would remove that household. Choose a newer backup.",
};

const UPDATE_ERRORS = {
  "update-network": "Kin couldn't reach the releases. Check that this computer is online; Kin tries again later.",
  "update-signature": "The release wasn't signed by the Kin project, so Kin ignored it. If it goes on, report it.",
  "update-manifest": "Kin didn't understand the release's details. A newer Kin may be needed: download it from the releases page.",
  "update-no-file": "This release has no file for this kind of computer.",
  "update-too-old": "This version is too old to update straight to that one. Download the new version from the releases page.",
  "update-download": "The download didn't finish. Kin tries again later.",
  "update-checksum": "The download didn't match the signed release, so Kin threw it away.",
  "update-prepare": "The new version couldn't unpack itself, so Kin kept the version it has.",
  "update-backup": "Kin couldn't back up before updating, so it didn't update.",
  "update-unhealthy": "The new version didn't answer as it should.",
  "update-exited": "The new version stopped by itself.",
  "update-swap": "Kin couldn't put the new version in place of the old one.",
  "update-failed": "Something went wrong with the update. Look at Kin's log on this computer.",
  "control-update-unknown": "That update isn't available any more. Reload the page.",
  "control-update-manual": "This copy of Kin can't update itself. Download the new version from the releases page.",
  "control-update-busy": "Kin is installing an update now.",
  "control-move-not-ready": "Finish setting up this home server first: it needs its name and certificate before a household can move here.",
  "control-move-limit": "This home server's household limit is reached. Raise it under New households first.",
};

const SETUP_ERRORS = {
  "setup-name-empty": "Type a name.",
  "setup-name-invalid": "Use only letters a–z, digits and hyphens, with dots only between parts of your own domain.",
  "setup-name-length": "A free name is 3 to 40 letters, digits or hyphens, and doesn't start or end with a hyphen.",
  "setup-name-taken": "That name belongs to another home server. Choose another.",
  "setup-name-not-allowed": "The relay doesn't allow that name. Choose another.",
  "setup-name-limit": "This server already has a free name, or the relay's limit was reached. Try again later.",
  "setup-name-first": "Choose a name first.",
  "setup-name-from-environment": "The name is set on this computer (KIN_HOME_NAME), so it can't be changed here.",
  "setup-finished": "This home server is set up. Its name can't change: devices, passkeys and the installed app all belong to it.",
  "setup-restarting": "Kin is restarting. Wait a moment.",
  "setup-terms-required": "Kin needs your agreement to Let's Encrypt's terms to get a certificate.",
  "setup-records-not-needed": "A free name needs no DNS records.",
  "setup-records-not-ready": "The DNS records aren't all in place yet. Check them again after you add them.",
  "setup-not-connected": "The home server isn't connected yet.",
};

const PANEL_ERRORS = {
  "control-code-wrong": "That code isn't right. Check Kin's window or log and type it again.",
  "control-code-expired": "That code has expired. Ask for a new one.",
  "control-code-locked": "Too many wrong tries, so that code no longer works. Ask for a new one.",
  "control-code-none": "There's no code to use now. Ask for a new one.",
  "control-code-malformed": "A code is 10 letters and digits, like ABCDE-23456.",
  "control-code-too-soon": "Kin printed a code a moment ago. Look for it in Kin's window or log.",
  "control-confirm-wrong": "That confirmation code isn't right. Check Kin's window or log.",
  "control-confirm-expired": "That confirmation code has expired. Ask for a new one.",
  "control-confirm-locked": "Too many wrong tries. Ask for a new confirmation code.",
  "control-confirm-none": "Ask Kin for a confirmation code first.",
  "control-confirm-malformed": "A code is 10 letters and digits, like ABCDE-23456.",
  "control-sign-in-required": "Enter the code Kin printed to open the control panel.",
  "control-loopback-only": "This works only on the home server's own computer.",
  "control-origin-rejected": "The control panel only accepts changes from its own page. Reload it and try again.",
  "control-limit-invalid": "Choose a number from 1 to 10.",
  "control-limit-from-environment": "This limit is set on this computer (KIN_MAX_HOUSEHOLDS), so it can't be changed here.",
  "control-change-unknown": "Kin doesn't know that change. Reload the page.",
  "control-bad-request": "Kin couldn't read that request. Reload the page and try again.",
  "control-failed": "Kin couldn't do that. Look at Kin's log on this computer.",
  "control-not-found": "That isn't part of the control panel. Reload the page.",
  household_admin_required: "Only a household admin can use the control panel.",
  authentication_required: "Sign in to Kin first.",
  home_setup_required: "Finish setting up this home server first, on its own computer.",
  fresh_auth_required: "Confirm it's you to make this change.",
  challenge_expired: "The confirmation took too long. Try again.",
  passkey_member_mismatch: "Use your own passkey.",
  network: "Kin didn't answer. It may be restarting; the page tries again.",
};

const DNS_PROBLEMS = {
  "dns-unavailable": "Kin couldn't look this up. Check that this computer is online and try again.",
  "dns-relay-unknown": "Kin couldn't find the relay's addresses. Check the relay address in the settings.",
  "dns-cname": "The name is a CNAME. Use A and AAAA records with the relay's addresses instead: a CNAME would hand the CAA record to the relay.",
  "dns-address-missing": "There's no A or AAAA record yet. New records can take a few minutes to appear.",
  "dns-address-wrong": "An A or AAAA record points somewhere other than the relay. Remove it or change it to the relay's address.",
  "dns-txt-missing": "The _kin-relay TXT record isn't there yet, or doesn't hold this server's value.",
  "dns-caa-missing": "The CAA record that names this server's Let's Encrypt account isn't there yet.",
  "dns-caa-other": "Another CAA issue record lets someone else get certificates for this name. Remove it.",
  "dns-ech": "Your DNS provider publishes Encrypted Client Hello for this name, which the relay can't route. Turn ECH off for this name in your DNS provider's settings.",
  "relay-txt-not-seen": "The relay can't see the TXT record yet. DNS changes can take a while to reach it; check again in a few minutes.",
};

const FAMILY = [
  [/^acme-/, "Something went wrong with Let's Encrypt. Kin tries again later."],
  [/^tunnel-caa-/, "The relay didn't set the CAA record. Kin tries again."],
  [/^(?:tunnel|relay|name)-/, "There's a problem with the connection to the relay. Kin keeps trying."],
  [/^dns-/, "A DNS record isn't right yet."],
  [/^setup-/, "Setup couldn't do that. Reload the page and try again."],
  [/^(?:backup|restore)-/, "Something went wrong with a backup. Look at Kin's log on this computer."],
  [/^update-/, "Something went wrong with the update. Look at Kin's log on this computer."],
  [/^control-/, "The control panel couldn't do that. Reload the page and try again."],
];

function family(code) {
  for (const [pattern, sentence] of FAMILY) if (pattern.test(code)) return sentence;
  return "Something went wrong. Reload the page and try again.";
}

/** Plain words for any code the panel shows; `known` says whether this
 * file has a sentence of its own for it. */
export function explain(code) {
  const text = TUNNEL_ERRORS[code] ?? CERTIFICATE_ERRORS[code] ?? SETUP_ERRORS[code] ?? PANEL_ERRORS[code] ?? DNS_PROBLEMS[code] ?? BACKUP_ERRORS[code] ?? UPDATE_ERRORS[code];
  return text ?? family(String(code ?? ""));
}

export function isExplained(code) {
  return Boolean(TUNNEL_ERRORS[code] ?? CERTIFICATE_ERRORS[code] ?? SETUP_ERRORS[code] ?? PANEL_ERRORS[code] ?? DNS_PROBLEMS[code] ?? BACKUP_ERRORS[code] ?? UPDATE_ERRORS[code]);
}

export const explainTunnelState = (state) => TUNNEL_STATES[state] ?? "The connection's state isn't known.";
export const explainCertificateState = (state) => CERTIFICATE_STATES[state] ?? "The certificate's state isn't known.";
export const explainTransparency = (state) => TRANSPARENCY[state] ?? TRANSPARENCY["not-checked"];
export const explainBackupState = (state) => BACKUP_STATES[state] ?? "The backups' state isn't known.";
export const explainBackupCopyState = (state) => BACKUP_COPY_STATES[state] ?? "The second copy's state isn't known.";

/** Every state with words of its own, for tests. */
export const KNOWN = Object.freeze({
  tunnelStates: Object.keys(TUNNEL_STATES),
  certificateStates: Object.keys(CERTIFICATE_STATES),
  transparency: Object.keys(TRANSPARENCY),
  backupStates: Object.keys(BACKUP_STATES),
  backupCopyStates: Object.keys(BACKUP_COPY_STATES),
});
