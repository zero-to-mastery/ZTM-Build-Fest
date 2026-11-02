// Devices and members: the device and household views, temporary
// invitations, device replacement, recovery, removal and admin changes.
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { MAX_MEMBER_NAME_CHARS, MEMBER_KIND_LABELS, friendlyDeviceLabel, memberLabels, misleadingMemberName } from "./member-labels.js";
import { confirmWith, freshConfirmation } from "./fresh-confirmation.js";
import { CARRIED_OVER_STATUS, carriedOverButtonLabel, carriedOverConfirmation } from "./carried-over.js";

const MAX_ACTIVE_ADULTS = 4;
const MAX_ACTIVE_LIMITED = 8;
const connectionUnavailable = (error) => {
  if (error?.code) return error.code === "connection_unavailable";
  return (typeof navigator !== "undefined" && navigator.onLine === false) ||
    (error?.name === "TypeError" && /failed to fetch|network|load failed/i.test(error.message));
};
const deviceList = (response) => {
  if (!Array.isArray(response?.devices)) {
    const error = new Error("Kin could not read the trusted-device list. Try again, and contact the server operator if this continues.");
    error.code = "device_list_invalid";
    throw error;
  }
  return response.devices;
};
const localDateTimeValue = (timestamp) => {
  const date = new Date(timestamp);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};

export class HouseholdMembership {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  async showDevices() {
    await this.host.run(async () => {
      // People & devices takes the panel: a pairing poll left from the view
      // underneath must not re-render it mid-build (the device rows would be
      // lost and only the actions appended). Back re-renders and restarts any
      // live pairing poll; a poll already in flight is caught by the
      // generation check below.
      clearTimeout(this.host.poll);
      clearInterval(this.host.timer);
      const generation = this.host.viewGeneration = (this.host.viewGeneration ?? 0) + 1;
      const superseded = () => this.host.viewGeneration !== generation;
      let deviceResponse;
      let showingCachedDevices = false;
      try {
        deviceResponse = await this.host.api("/api/devices");
      } catch (error) {
        if (!connectionUnavailable(error)) throw error;
        showingCachedDevices = true;
        deviceResponse = {
          canManageMembers: false,
          devices: this.deviceSnapshot ?? [{
            id: this.host.identity.deviceId,
            memberId: this.host.identity.memberId,
            label: "Device",
            revokedAt: null,
            statusUnavailable: true,
          }],
        };
      }
      let devices = deviceList(deviceResponse);
      if (!showingCachedDevices)
        this.deviceSnapshot = devices.map((device) => ({ ...device }));
      const { canManageMembers } = deviceResponse;
      let directoryDevices = [];
      if (!this.host.syncKeyError) {
        await this.ctx.api.openSyncKeyStore();
        let directoryResponse;
        try {
          directoryResponse = await this.host.api("/api/sync/devices");
        } catch (error) {
          if (!connectionUnavailable(error)) throw error;
          showingCachedDevices = true;
          directoryDevices = this.directorySnapshot ?? [];
        }
        if (directoryResponse) {
          directoryDevices = deviceList(directoryResponse);
          this.directorySnapshot = directoryDevices.map((device) => ({ ...device }));
        }
      }
      // Names come from encrypted household events (#71); the server only
      // knows each device's automatic name. A device that has not synced its
      // name yet shows as "New device" with the start of its sync code.
      let names = [];
      let encryptedNamesUnavailable = false;
      try {
        names = (await this.host.deviceNames?.load()) ?? [];
      } catch {
        encryptedNamesUnavailable = true;
      }
      // Preferred names are encrypted household projection data supplied by
      // the app. Keep this optional so an older/offline projection still has
      // stable member-ID grouping and useful fallback labels. The seam is
      // [{ memberId, preferredName }]; names are presentation, never keys.
      let memberNames = [];
      if (this.host.memberNames) {
        try {
          memberNames = (await this.host.memberNames.load()) ?? [];
        } catch {
          encryptedNamesUnavailable = true;
        }
      }
      // DEVICE_DESCRIBED events are encrypted durable local projection data.
      // On a cold offline start they reconstruct the known member/device
      // grouping without persisting a second plaintext identity cache.
      if (showingCachedDevices) {
        const known = new Set(devices.map((device) => device.id));
        const projected = names
          .filter((entry) => typeof entry?.deviceId === "string" &&
            typeof entry?.memberId === "string" && !known.has(entry.deviceId))
          .map((entry) => ({
            id: entry.deviceId,
            memberId: entry.memberId,
            label: entry.autoName ?? "Device",
            revokedAt: null,
            statusUnavailable: true,
          }));
        devices = [...devices, ...projected];
        this.deviceSnapshot = devices.map((device) => ({ ...device }));
      }
      const named = new Map(names.map((entry) => [entry.deviceId, entry]));
      const preferredNameByMember = new Map(
        memberNames
          .filter((entry) => typeof entry?.memberId === "string" && typeof entry?.preferredName === "string" && entry.preferredName.trim())
          // Nobody else may pass for "You" here, beside the trust controls.
          .filter((entry) => entry.memberId === this.host.identity.memberId || !misleadingMemberName(entry.preferredName))
          .map((entry) => [entry.memberId, entry.preferredName.trim()]),
      );
      if (superseded()) return;
      this.host.replaceChildren();
      const heading = document.createElement("h2");
      heading.textContent = "People & devices";
      this.host.append(heading);
      this.host.text(
        "People have their own household identity. Devices belong to a person, and a device name never changes who it belongs to or what it can access.",
      );
      const availabilityNotes = [];
      if (showingCachedDevices)
        availabilityNotes.push("The connection is unavailable. Showing encrypted device details saved on this device; management changes need a connection.");
      if (encryptedNamesUnavailable)
        availabilityNotes.push("Some encrypted names aren't available right now. Showing privacy-safe fallback labels.");
      if (availabilityNotes.length) this.host.message(availabilityNotes.join(" "));
      // Yours first, then each other member's, in the order the server lists them.
      const members = [...new Set([this.host.identity.memberId, ...devices.map((device) => device.memberId)])];
      const lists = new Map();
      const groupLabels = new Map();
      let otherMemberIndex = 0;
      for (const [index, memberId] of members.entries()) {
        if (!devices.some((device) => device.memberId === memberId)) continue;
        const isYou = memberId === this.host.identity.memberId;
        if (!isYou) otherMemberIndex += 1;
        const section = document.createElement("section");
        section.className = "device-group";
        section.dataset.memberId = memberId;
        const title = document.createElement("h3");
        title.id = `device-group-${index}`;
        const preferredName = preferredNameByMember.get(memberId);
        title.textContent = preferredName
          ? `${preferredName}${isYou ? " (You)" : ""}`
          : isYou ? "You" : `Household member ${otherMemberIndex}`;
        groupLabels.set(memberId, title.textContent);
        const list = document.createElement("ul");
        list.className = "device-list";
        list.setAttribute("aria-labelledby", title.id);
        section.append(title);
        // Only you can set your own name (#225); it changes no access.
        if (isYou && this.host.memberNames?.rename && this.host.syncStatus?.enabled)
          section.append(this.nameControl(preferredName ?? null));
        section.append(list);
        this.host.append(section);
        lists.set(memberId, list);
      }
      for (const device of devices) {
        const list = lists.get(device.memberId);
        const item = document.createElement("li");
        item.dataset.deviceId = device.id;
        const syncDevice = directoryDevices.find(
          (entry) => entry.deviceId === device.id,
        );
        const name = named.get(device.id);
        const automatic = name?.autoName ?? (device.label !== "Device" ? device.label : null);
        const fingerprint = syncDevice?.fingerprint ?? device.syncKeyFingerprint ?? "";
        // Nickname first, then the owner's name beside the automatic name
        // ("Mikey · Chrome on iPhone", #225), derived here and never stored.
        const displayName = friendlyDeviceLabel({
          nickname: name?.nickname,
          automatic,
          preferredName: preferredNameByMember.get(device.memberId),
        }) ?? (fingerprint ? `New device · ${fingerprint.slice(0, 4).toUpperCase()}` : "New device");
        const isThisDevice = device.id === this.host.identity.deviceId;
        // Carried over from the old address by a move (ADR 0026 §6): it
        // can't sign in here, so there is nothing to verify or replace.
        const carriedOver = device.carriedOver === true && !device.revokedAt && !device.statusUnavailable;
        const pinned = !syncDevice?.publicKeys || isThisDevice ||
          (await this.host.syncKeyStore.getPinnedDevice(
            this.host.identity.householdId,
            device.id,
          ));
        if (superseded()) return;
        const text = document.createElement("span");
        text.className = "device-name-line";
        const strong = document.createElement("strong");
        strong.textContent = displayName;
        text.append(strong);
        const details = [
          ...(name?.nickname && automatic ? [automatic] : []),
          ...(isThisDevice ? ["This device"] : []),
          device.statusUnavailable ? "Status unavailable offline" :
            device.revokedAt ? "Revoked" : carriedOver ? CARRIED_OVER_STATUS : pinned ? "Trusted" : "Untrusted",
        ];
        text.append(` — ${details.join(" · ")}`);
        item.append(text);
        if (!device.statusUnavailable && !device.revokedAt && device.memberId === this.host.identity.memberId && name)
          item.append(this.renameControl(device.id, displayName, name.nickname));
        if (syncDevice?.fingerprint) {
          if (
            device.id === this.host.identity.deviceId &&
            syncDevice.fingerprint !== this.host.localFingerprint
          ) {
            this.host.message(
              "This browser's saved device key does not match its trusted record. Device sync is paused.",
              true,
            );
            list.append(item);
            continue;
          }
          const displayedFingerprint =
            device.id === this.host.identity.deviceId
              ? this.host.localFingerprint
              : syncDevice.fingerprint;
          const keyCode = document.createElement("code");
          keyCode.className = "device-key-fingerprint";
          keyCode.textContent = displayedFingerprint.match(/.{1,4}/g).join(" ");
          keyCode.setAttribute(
            "aria-label",
            `Device sync code ${keyCode.textContent}`,
          );
          item.append(keyCode);
          if (!pinned && syncDevice.publicKeys && !carriedOver) {
            const verify = this.host.makeButton("Verify device", () => {
              verify.hidden = true;
              const prompt = document.createElement("p");
              prompt.textContent =
                "Compare this code with the code shown on that device.";
              const label = document.createElement("label");
              const confirmation = document.createElement("input");
              confirmation.type = "checkbox";
              label.append(
                confirmation,
                document.createTextNode(" The codes match."),
              );
              const approve = this.host.makeButton("Trust this device", async () => {
                let trusted = false;
                await this.host.run(async () => {
                  if (!confirmation.checked)
                    throw new Error(
                      "Compare the codes on both devices before trusting this device.",
                    );
                  const current = (
                    await this.host.api("/api/sync/devices")
                  ).devices.find((entry) => entry.deviceId === device.id);
                  if (
                    !current ||
                    current.fingerprint !== displayedFingerprint
                  )
                    throw new Error(
                      "This device code changed. Compare the codes again before trusting this device.",
                    );
                  await this.host.syncKeyStore.pinTrustedDevice({
                    householdId: this.host.identity.householdId,
                    memberId: current.memberId,
                    deviceId: current.deviceId,
                    publicKeys: current.publicKeys,
                    fingerprint: current.fingerprint,
                  });
                  this.ctx.api.requestSync();
                  trusted = true;
                });
                if (trusted) await this.host.showDevices();
              });
              this.host.setControlDisabled(approve, true);
              confirmation.addEventListener("change", () => {
                this.host.setControlDisabled(approve, !confirmation.checked);
              });
              item.append(prompt, label, approve);
            });
            item.append(verify);
          }
        }
        if (!device.statusUnavailable && !device.revokedAt && device.id !== this.host.identity.deviceId) {
          if (device.memberId === this.host.identity.memberId && !carriedOver)
            item.append(
              this.host.makeButton(
                "Replace this device",
                () => this.createReplacement(device.id),
                "secondary",
              ),
            );
          // Fail closed: show another member's revoke control only when the
          // server explicitly grants management authority. It enforces this too.
          if (device.memberId === this.host.identity.memberId || canManageMembers === true) item.append(
            this.host.makeButton(
              `Revoke ${displayName}`,
              async () => {
                if (!confirm(`Revoke ${displayName}? That device will lose future household access. Copies already saved there cannot be erased.`)) return;
                let revoked = false;
                await this.host.run(async () => {
                  const started = await this.host.api(`/api/devices/${device.id}/revocation/options`, {
                    method: "POST", body: "{}",
                  });
                  this.host.message(`Confirm revoking ${displayName} with ${confirmWith(started)}.`);
                  const proof = await freshConfirmation(started, { signal: this.host.connectionAbort.signal });
                  await this.host.api("/api/devices/revocation/finish", {
                    method: "POST",
                    body: JSON.stringify({ flow: started.flow, ...proof }),
                  });
                  revoked = true;
                });
                // showDevices() runs its own busy guard, so refresh only after
                // the revocation operation has released it.
                if (revoked) await this.host.showDevices();
              },
              "danger",
            ),
          );
        }
        list.append(item);
      }
      if (superseded()) return;
      // Fail closed: only with management authority and a live list; an
      // older server never marks a device, so the button never shows there.
      const carried = devices.filter((device) => device.carriedOver === true && !device.revokedAt);
      if (canManageMembers === true && !showingCachedDevices && carried.length) {
        const section = document.createElement("section");
        section.className = "carried-over-devices";
        // Its own heading, so the button doesn't read as part of the last
        // member's devices: it removes them for the whole household.
        const heading = document.createElement("h3");
        heading.id = "carried-over-devices-heading";
        heading.textContent = "Devices from the old address";
        section.setAttribute("aria-labelledby", heading.id);
        const copy = document.createElement("p");
        copy.textContent = "Devices from the old address can't sign in here. Once everyone has signed in here, remove them together.";
        // Members whose only devices are from the old address haven't signed in here yet.
        const waiting = [...groupLabels].filter(([memberId]) => memberId !== this.host.identity.memberId &&
          carried.some((device) => device.memberId === memberId) &&
          !devices.some((device) => device.memberId === memberId && !device.revokedAt && device.carriedOver !== true))
          .map(([, label]) => label);
        section.append(heading, copy, this.host.makeButton(
          carriedOverButtonLabel(carried.length),
          () => this.removeCarriedOver(carried.length, waiting),
          "danger",
        ));
        this.host.append(section);
      }
      const actions = document.createElement("section");
      actions.className = "people-device-actions";
      const actionsHeading = document.createElement("h3");
      actionsHeading.textContent = "Invite someone, or connect one of your own devices";
      actions.append(actionsHeading);
      if (canManageMembers === true) {
        const inviteCopy = document.createElement("p");
        // Choosing the person's role comes first, in Household access, so
        // this entry point never silently creates an Adult invitation (#297).
        inviteCopy.textContent = "Invite another person: choose their Adult, Limited, or Temporary role before creating an invitation. They get their own household member identity and role-based access.";
        actions.append(inviteCopy, this.host.makeButton("Invite another person", () => this.host.showHousehold()));
        // "Set up Kin for someone" (#613): a prepared invitation with their
        // name, easy mode and a printable sheet.
        const setupCopy = document.createElement("p");
        setupCopy.textContent = "Set up Kin for someone: prepare it with their name and easy mode, and print a sheet that shows them how to open it. They only choose a password.";
        const setup = this.host.makeButton("Set up Kin for someone", () => this.ctx.prepared.start(), "secondary setup-for-someone");
        actions.append(setupCopy, setup);
        const waiting = await this.ctx.prepared.waitingList();
        if (superseded()) return;
        if (waiting) actions.append(waiting);
      }
      const deviceCopy = document.createElement("p");
      deviceCopy.textContent = "Add my device: connect your own phone or computer under this same member identity. Your other devices will not notify you about your own changes.";
      actions.append(deviceCopy, this.host.makeButton("Add my device", () => this.host.createDevicePairing(), "secondary"));
      this.host.append(actions);
      this.host.append(
        this.host.makeButton("Back", () => this.host.render(), "secondary"),
      );
    });
  }

  // "Set my name" / "Edit my name" opens an inline field for your own
  // preferred name (#224, #225). Saving records an encrypted MEMBER_NAMED
  // event that only ever names its author; an empty field, or "Remove my
  // name", goes back to the fallback label. A name is presentation only: it
  // changes no member ID, role, device trust or notification audience.
  nameControl(preferredName, { onSaved = () => this.host.showDevices() } = {}) {
    const wrapper = document.createElement("div");
    wrapper.className = "member-name";
    const open = this.host.makeButton(preferredName ? "Edit my name" : "Set my name", () => {
      open.hidden = true;
      form.hidden = false;
      input.focus();
      input.select?.();
    }, "secondary");
    const form = document.createElement("form");
    form.className = "member-name-form";
    form.hidden = true;
    const label = document.createElement("label");
    label.textContent = "Your name in this household";
    const input = document.createElement("input");
    input.name = "member-name";
    // 32 characters, checked on save: maxLength counts UTF-16 units.
    input.maxLength = MAX_MEMBER_NAME_CHARS * 4;
    input.autocomplete = "nickname";
    input.value = preferredName ?? "";
    input.placeholder = "Mikey";
    input.setAttribute("aria-describedby", "member-name-help");
    label.append(input);
    const help = document.createElement("p");
    help.id = "member-name-help";
    help.className = "hint";
    help.textContent = "Your household sees this instead of “You” or “Household member”. It doesn't change your access, and your devices show it beside their names unless you've given them nicknames.";
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Save name";
    const close = () => {
      form.hidden = true;
      open.hidden = false;
      input.value = preferredName ?? "";
      open.focus();
    };
    const cancel = this.host.makeButton("Cancel", close, "secondary");
    const rename = async (value) => {
      let saved = false;
      await this.host.run(async () => {
        const next = value.trim();
        if ([...next].length > MAX_MEMBER_NAME_CHARS)
          throw new Error(`Use a name of ${MAX_MEMBER_NAME_CHARS} characters or fewer.`);
        if (misleadingMemberName(next))
          throw new Error("Choose your own name rather than “You”.");
        if ((next || null) === (preferredName ?? null)) { saved = true; return; }
        await this.host.memberNames.rename(next);
        saved = true;
      });
      if (saved) await onSaved();
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void rename(input.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    });
    form.append(label, help, save, cancel);
    if (preferredName) {
      const remove = this.host.makeButton("Remove my name", () => rename(""), "secondary");
      form.append(remove);
    }
    wrapper.append(open, form);
    return wrapper;
  }

  // "Rename" opens an inline nickname field for one of your devices; saving
  // records an encrypted DEVICE_NICKNAMED event. An empty field, or "Remove
  // nickname", goes back to the automatic name.
  renameControl(deviceId, displayName, nickname) {
    const wrapper = document.createElement("span");
    wrapper.className = "device-rename";
    const open = this.host.makeButton("Rename", () => {
      open.hidden = true;
      form.hidden = false;
      input.focus();
      input.select();
    }, "secondary");
    open.setAttribute("aria-label", `Rename ${displayName}`);
    const form = document.createElement("form");
    form.className = "device-rename-form";
    form.hidden = true;
    const label = document.createElement("label");
    label.textContent = `Nickname for ${displayName}`;
    const input = document.createElement("input");
    input.name = "nickname";
    // 32 characters, checked on save: maxLength counts UTF-16 units, which
    // would cut an emoji nickname short. 128 units is the most 32 can take.
    input.maxLength = 128;
    input.autocomplete = "off";
    input.value = nickname ?? "";
    input.placeholder = "Kitchen tablet";
    label.append(input);
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Save nickname";
    const close = () => {
      form.hidden = true;
      open.hidden = false;
      input.value = nickname ?? "";
      open.focus();
    };
    const cancel = this.host.makeButton("Cancel", close, "secondary");
    const rename = async (value) => {
      let saved = false;
      await this.host.run(async () => {
        const next = value.trim();
        if ([...next].length > 32) throw new Error("Use a nickname of 32 characters or fewer.");
        if ((next || null) === (nickname ?? null)) { saved = true; return; }
        await this.host.deviceNames.rename(deviceId, next);
        saved = true;
      });
      if (saved) await this.host.showDevices();
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void rename(input.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    });
    form.append(label, save, cancel);
    if (nickname) {
      const remove = this.host.makeButton("Remove nickname", () => rename(""), "secondary");
      remove.setAttribute("aria-label", `Remove the nickname ${nickname}`);
      form.append(remove);
    }
    wrapper.append(open, form);
    return wrapper;
  }

  async showHousehold() {
    // This view takes over the panel like People & devices: it bumps the view
    // generation (so polls and load() leave it alone) and gives way if a newer
    // view took over while its request was out (#327, as #304/#305/#307).
    clearTimeout(this.host.poll);
    clearInterval(this.host.timer);
    const generation = this.host.viewGeneration = (this.host.viewGeneration ?? 0) + 1;
    await this.host.run(async () => {
      const household = await this.host.api("/api/household");
      if (this.host.viewGeneration !== generation) return;
      this.host.replaceChildren();
      const heading = document.createElement("h2");
      heading.textContent = "Household access";
      this.host.append(heading);
      this.host.text(
        household.adminRecorded
          ? "Household admins manage who has access. Removing a member blocks future access, but cannot erase information already copied."
          : "Only adults can manage household access. Removing a member blocks future access, but cannot erase information already copied.",
      );
      const activeMembers = household.members.filter((value) => value.active);
      const labels = memberLabels(household.members, household.members.find((value) => value.current)?.id);
      const me = household.members.find((value) => value.current);
      const canManage = household.canManageMembers === true;
      for (const kind of ["adult", "limited", "temporary"]) {
        const sectionMembers = household.members.filter((member) =>
          kind === "temporary" ? member.kind === kind : member.kind === kind && member.active,
        );
        if (!sectionMembers.length && kind === "temporary") continue;
        const section = document.createElement("section");
        const title = document.createElement("h3");
        title.textContent = kind === "adult" ? "Adults" : kind === "limited" ? "Children & Limited Members" : "Babysitters, Caregivers & Guests";
        section.append(title);
        const list = document.createElement("ul");
        for (const [index, member] of sectionMembers.entries()) {
        const item = document.createElement("li");
        const memberLabel = labels.get(member.id) ?? (member.current ? "You" : `${MEMBER_KIND_LABELS[kind]} ${index + 1}`);
        const expiryText = kind === "temporary" && member.expiresAt ? ` — ends ${new Date(member.expiresAt).toLocaleString()}` : "";
        item.textContent = `${memberLabel}${member.admin ? " — Household admin" : ""}${member.simpleView ? " — Simple view on" : ""}${expiryText}${member.active ? "" : " — access ended"}`;
        if (member.current && kind === "temporary") item.textContent = `Temporary household access — ends ${new Date(member.expiresAt).toLocaleString()}`;
        if (me?.admin && kind === "adult" && member.active && (!member.current || member.admin))
          item.append(
            this.host.makeButton(
              member.current
                ? "Stop being a household admin"
                : member.admin
                  ? `Remove household admin from ${memberLabel}`
                  : `Make ${memberLabel} a household admin`,
              () => this.host.setHouseholdAdmin(member.id, memberLabel, !member.admin),
              "secondary",
            ),
          );
        // Simple view (#343, ADR 0013): an admin's choice for a Limited member.
        if (me?.admin && kind === "limited" && member.active)
          item.append(
            this.host.makeButton(
              member.simpleView ? `Turn off Simple view for ${memberLabel}` : `Turn on Simple view for ${memberLabel}`,
              () => this.host.setSimpleView(member.id, memberLabel, !member.simpleView),
              "secondary",
            ),
          );
        if (me?.kind === "adult" && !member.current && member.active) {
          // Recovering an admin issues admin authority, so the server
          // requires an admin approver for it.
          if (kind !== "temporary" && (!member.admin || me.admin)) item.append(
            this.host.makeButton(
              `Authorize recovery for ${memberLabel}`,
              () => this.authorizeRecovery(member.id),
              "secondary",
            ),
          );
          if (canManage) item.append(
            this.host.makeButton(
              kind === "temporary" ? `Revoke ${memberLabel}'s temporary access` : `Remove ${memberLabel} from household`,
              () => this.removeMember(member.id, memberLabel, kind),
              "danger",
            ),
          );
        }
        list.append(item);
        }
        section.append(list);
        this.host.append(section);
      }
      this.host.append(
        ...(canManage && activeMembers.length < 12
          ? [
              ...(activeMembers.filter((member) => member.kind === "adult").length < MAX_ACTIVE_ADULTS
                ? [this.host.makeButton("Add Adult", () => this.host.createPairing("adult"))]
                : []),
              ...(activeMembers.filter((member) => member.kind === "limited").length < MAX_ACTIVE_LIMITED
                ? [this.host.makeButton("Add Child or Limited Member", () => this.host.createPairing("limited"))]
                : []),
              ...(activeMembers.length < 12
                ? [this.temporaryInvitationForm()]
                : []),
            ]
          : []),
        ...(canManage ? [this.host.makeButton(
          "Move to a home server",
          () => this.ctx.move.show(),
          "secondary",
        )] : []),
        ...(canManage ? [this.host.makeButton(
          "Delete household",
          () => this.ctx.lifecycle.deleteHousehold(),
          "danger",
        )] : []),
        this.host.makeButton("Leave household", () => this.host.leave(), "danger"),
        this.host.makeButton("Back", () => this.host.render(), "secondary"),
      );
    });
  }

  temporaryInvitationForm() {
    const form = document.createElement("form");
    form.className = "temporary-invitation-form";
    const label = document.createElement("label");
    label.textContent = "Babysitter, caregiver, or guest access ends";
    const expiry = document.createElement("input");
    expiry.type = "datetime-local";
    expiry.required = true;
    expiry.min = localDateTimeValue(Date.now() + 60_000);
    expiry.value = localDateTimeValue(Date.now() + 7 * 24 * 60 * 60_000);
    const help = document.createElement("small");
    help.textContent = "Uses your device's local time. Kin checks the expiry on every server request.";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Add Babysitter or Guest";
    label.append(expiry);
    form.append(label, help, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const timestamp = Date.parse(expiry.value);
      if (!Number.isSafeInteger(timestamp) || timestamp <= Date.now()) {
        this.host.message("Choose a future expiry date and time.", true);
        return;
      }
      this.host.createPairing("temporary", timestamp);
    });
    return form;
  }

  // Removes every device carried over from the old address in one step,
  // after one fresh confirmation. The wording comes first, so the dialog
  // can stay open without the server's confirmation running out.
  async removeCarriedOver(count, waiting) {
    if (!confirm(carriedOverConfirmation({ count, waiting }))) return;
    let removed = false;
    await this.host.run(async () => {
      const started = await this.host.api("/api/devices/carried-over/revocation/options", {
        method: "POST", body: "{}",
      });
      this.host.message(`Confirm removing the devices from the old address with ${confirmWith(started)}.`);
      const proof = await freshConfirmation(started, { signal: this.host.connectionAbort.signal });
      await this.host.api("/api/devices/carried-over/revocation/finish", {
        method: "POST",
        body: JSON.stringify({ flow: started.flow, ...proof }),
      });
      removed = true;
    });
    // showDevices() runs its own busy guard, so refresh only once released.
    if (removed) await this.host.showDevices();
  }

  async createReplacement(deviceId) {
    if (
      !confirm(
        "Replace this device? The selected device will no longer be trusted as soon as you approve the fresh device. Previously copied information cannot be erased.",
      )
    )
      return;
    await this.host.run(async () => {
      this.host.pairing = await this.host.api("/api/devices/replacements", {
        method: "POST",
        body: JSON.stringify({ deviceId }),
      });
      this.host.render();
    });
  }

  async authorizeRecovery(memberId) {
    if (
      !confirm(
        "Authorize recovery for this adult? They must create and activate a fresh passkey. Approval will revoke their old credentials, sessions, and devices.",
      )
    )
      return;
    await this.host.run(async () => {
      this.host.pairing = await this.host.api("/api/household/recovery", {
        method: "POST",
        body: JSON.stringify({ memberId }),
      });
      this.host.render();
    });
  }

  async removeMember(memberId, memberLabel = "member", kind = "adult") {
    if (
      !confirm(
        kind === "temporary"
          ? `Revoke ${memberLabel}'s temporary access? Kin will block future sync and rotate household access. Copies already decrypted on a device cannot be erased.`
          : `Remove ${memberLabel} and revoke their trusted devices? This blocks future access but cannot erase copies already decrypted on a device.`,
      )
    )
      return;
    await this.host.run(() => this.host.authenticateRemoval(memberId));
    await this.host.showHousehold();
  }

  async setHouseholdAdmin(memberId, memberLabel, admin) {
    if (
      !confirm(
        admin
          ? `Make ${memberLabel} a household admin? Admins can add and remove members, change shared household settings, and make other Adults admins.`
          : `Remove household admin from ${memberLabel}? They stay an Adult member, and invitations they started will be cancelled.`,
      )
    )
      return;
    await this.host.run(async () => {
      const started = await this.host.api("/api/household/admins/options", {
        method: "POST",
        body: JSON.stringify({ memberId, admin }),
      });
      this.host.message(`Confirm the household admin change with ${confirmWith(started)}.`);
      const proof = await freshConfirmation(started, { signal: this.host.connectionAbort.signal });
      await this.host.api("/api/household/admins/finish", {
        method: "POST",
        body: JSON.stringify({ flow: started.flow, ...proof }),
      });
    });
    await this.host.showHousehold();
  }

  async setSimpleView(memberId, memberLabel, simpleView) {
    if (
      !confirm(
        simpleView
          ? `Turn on Simple view for ${memberLabel}? Their devices show a simpler layout: their own things for today, Chat and the Fridge, with big buttons. It's a layout, not a lock: Kin hides the rest, it can't prevent it. They can't turn it off.`
          : `Turn off Simple view for ${memberLabel}? Their devices show the full Kin again when they next connect.`,
      )
    )
      return;
    await this.host.run(async () => {
      const started = await this.host.api("/api/household/simple-view/options", {
        method: "POST",
        body: JSON.stringify({ memberId, simpleView }),
      });
      this.host.message(`Confirm Simple view with ${confirmWith(started)}.`);
      const proof = await freshConfirmation(started, { signal: this.host.connectionAbort.signal });
      await this.host.api("/api/household/simple-view/finish", {
        method: "POST",
        body: JSON.stringify({ flow: started.flow, ...proof }),
      });
    });
    await this.host.showHousehold();
  }

  async authenticateRemoval(memberId) {
    const started = await this.host.api("/api/household/membership/remove/options", {
      method: "POST",
      body: JSON.stringify({ memberId }),
    });
    const proof = await freshConfirmation(started, { signal: this.host.connectionAbort.signal });
    await this.host.api("/api/household/membership/remove/finish", {
      method: "POST",
      body: JSON.stringify({ flow: started.flow, ...proof }),
    });
  }
}
