// DurableStore identity: households, members, devices and sessions loaded
// into and saved from the pairing service, and household settings.
import { normalizeUsername } from "../../web/security/account-credentials.js";
import {
  validCredentialId,
  validStoredCredential,
  validStoredDevice,
} from "../durable-identity.mjs";
import {
  MAX_ACTIVE_ADULTS,
  MAX_ACTIVE_LIMITED_MEMBERS,
  MAX_ACTIVE_MEMBERS,
  MAX_TRUSTED_DEVICES,
} from "../identity-limits.mjs";
import {
  auditDetails,
  DurableConflictError,
  DurableStoreError,
  isId,
  isTimestamp,
  MAX_AUDIT_ROWS,
  parseJson,
  parseStoredJson,
  stringifyStored,
} from "./shared.mjs";

export const identityMethods = {
  /** Replaces every stored device label that `normalize` changes, in one
   * transaction, and returns how many changed. Since v1.1 the only label the
   * server keeps is a device's automatic name (#71): a name someone typed
   * before then is reset here when the service starts. Freed pages are
   * zeroed (secure_delete) and the WAL is checkpointed and truncated, so the
   * old text is not left in the database files; backups taken before the
   * reset still hold it. Rows that do not parse are left for loadIdentity to
   * report. */
  resetDeviceLabels(normalize) {
    this.assertAvailable();
    const secureDelete = this.db.prepare("PRAGMA secure_delete").get().secure_delete;
    this.db.exec("PRAGMA secure_delete = ON");
    try {
      const changed = this.rewriteDeviceLabels(normalize);
      if (changed) this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      return changed;
    } finally {
      this.db.exec(`PRAGMA secure_delete = ${secureDelete ? "ON" : "OFF"}`);
    }
  },

  rewriteDeviceLabels(normalize) {
    return this.transaction(() => {
      const update = this.db.prepare("UPDATE devices SET device_json = ? WHERE id = ?");
      let changed = 0;
      for (const row of this.db.prepare("SELECT id, device_json FROM devices").all()) {
        let device;
        try {
          device = parseStoredJson(row.device_json);
        } catch {
          continue;
        }
        if (typeof device?.label !== "string") continue;
        const label = normalize(device.label);
        if (label === device.label) continue;
        update.run(stringifyStored({ ...device, label }), row.id);
        changed += 1;
      }
      return changed;
    });
  },

  loadIdentity() {
    this.assertAvailable();
    try {
      const households = new Map();
      const members = new Map();
      const credentials = new Map();
      const devices = new Map();
      const activeMemberCounts = new Map();
      const activeKindCounts = new Map();
      const trustedDeviceCounts = new Map();
      for (const row of this.db.prepare("SELECT * FROM households").all()) {
        if (
          !isId(row.id) ||
          !Number.isSafeInteger(row.version) ||
          row.version < 1 ||
          !["active", "deletion_pending", "deleted"].includes(
            row.lifecycle_state,
          ) ||
          (row.lifecycle_state === "active" &&
            (row.deletion_requested_at !== null ||
              row.deletion_finalize_at !== null ||
              row.deleted_at !== null)) ||
          (row.lifecycle_state === "deletion_pending" &&
            (!isTimestamp(row.deletion_requested_at) ||
              !isTimestamp(row.deletion_finalize_at) ||
              row.deletion_finalize_at <= row.deletion_requested_at ||
              row.deleted_at !== null)) ||
          (row.lifecycle_state === "deleted" &&
            (row.deletion_requested_at !== null ||
              row.deletion_finalize_at !== null ||
              !isTimestamp(row.deleted_at)))
        )
          throw new DurableStoreError("Kin server household data is invalid.");
        households.set(row.id, {
          id: row.id,
          members: new Set(),
          version: row.version,
          lifecycleState: row.lifecycle_state,
          deletionRequestedAt: row.deletion_requested_at,
          deletionFinalizeAt: row.deletion_finalize_at,
          deletedAt: row.deleted_at,
          ownerMemberId: row.owner_member_id ?? null,
          chatPolicy: {
            limited: row.chat_limited ?? "write",
            temporary: row.chat_temporary ?? "write",
            revision: row.chat_policy_revision ?? 0,
          },
          boardPolicy: {
            limited: row.board_limited ?? "write",
            temporary: row.board_temporary ?? "write",
            revision: row.board_policy_revision ?? 0,
          },
          privatePolicy: {
            limited: (row.private_limited ?? 1) === 1,
            revision: row.private_policy_revision ?? 0,
          },
          // ADR 0021 §2: unknown bits (a newer server's) are kept as stored;
          // featuresOf() reads only the bits this server knows.
          features: { off: row.features_off ?? 0, revision: row.features_revision ?? 0 },
          // ADR 0022 §6 (#676): adults on the chore chart, off by default.
          choreChart: { adults: (row.chore_adults ?? 0) === 1, revision: row.chore_adults_revision ?? 0 },
        });
      }
      for (const row of this.db.prepare("SELECT * FROM members").all()) {
        const credentialIds = parseJson(row.credential_ids);
        if (
          !isId(row.id) ||
          !isId(row.household_id) ||
          ![0, 1].includes(row.active) ||
          !Array.isArray(credentialIds) ||
          credentialIds.some((id) => !validCredentialId(id)) ||
          new Set(credentialIds).size !== credentialIds.length
        )
          throw new DurableStoreError("Kin server membership data is invalid.");
        const member = {
          id: row.id,
          householdId: row.household_id,
          active: Boolean(row.active),
          memberStatus: row.member_status ?? (row.active ? "active" : "removed"),
          kind: row.kind ?? "adult",
          ...(row.expires_at == null ? {} : { expiresAt: row.expires_at }),
          ...(row.household_admin === 1 ? { householdAdmin: true } : {}),
          ...(row.simple_view === 1 ? { simpleView: true } : {}),
          ...(row.username == null ? {} : { username: row.username }),
          credentials: new Set(credentialIds),
        };
        if (!["adult", "limited", "temporary"].includes(member.kind) ||
            ![0, 1].includes(row.household_admin ?? 0) ||
            (member.householdAdmin && member.kind !== "adult") ||
            ![0, 1].includes(row.simple_view ?? 0) ||
            (member.simpleView && member.kind !== "limited") ||
            !["active", "removed", "expired"].includes(member.memberStatus) ||
            (member.memberStatus === "expired" && member.kind !== "temporary") ||
            (member.kind === "temporary" && !Number.isSafeInteger(member.expiresAt)) ||
            (member.kind !== "temporary" && member.expiresAt !== undefined) ||
            (member.username !== undefined && normalizeUsername(member.username) !== member.username))
          throw new DurableStoreError("Kin server membership data is invalid.");
        members.set(member.id, member);
        const household = households.get(member.householdId);
        if (!household)
          throw new DurableStoreError("Kin server membership data is invalid.");
        household.members.add(member.id);
        const activeCount =
          (activeMemberCounts.get(household.id) ?? 0) + row.active;
        if (activeCount > MAX_ACTIVE_MEMBERS)
          throw new DurableStoreError("Kin server membership data is invalid.");
        activeMemberCounts.set(household.id, activeCount);
        if (row.active) {
          const kindCount = activeKindCounts.get(`${household.id}:${member.kind}`) ?? 0;
          const limit = member.kind === "adult" ? MAX_ACTIVE_ADULTS : member.kind === "limited" ? MAX_ACTIVE_LIMITED_MEMBERS : MAX_ACTIVE_MEMBERS;
          if (kindCount + 1 > limit)
            throw new DurableStoreError("Kin server membership data is invalid.");
          activeKindCounts.set(`${household.id}:${member.kind}`, kindCount + 1);
        }
      }
      // Password verifiers (#558): every active member with a username has
      // one. (A row whose member is gone is ignored: like a vault, it
      // outlives an authority restore.)
      for (const row of this.db.prepare("SELECT member_id, household_id, kdf_salt, kdf_iterations, verifier, updated_at FROM account_passwords").all()) {
        const member = members.get(row.member_id);
        if (!member) continue;
        if (member.householdId !== row.household_id ||
            !(row.kdf_salt instanceof Uint8Array) || row.kdf_salt.length !== 16 || typeof row.verifier !== "string")
          throw new DurableStoreError("Kin server password data is invalid.");
        member.password = { salt: new Uint8Array(row.kdf_salt), iterations: row.kdf_iterations, verifier: row.verifier, updatedAt: row.updated_at };
      }
      for (const member of members.values())
        if (member.active && member.username !== undefined && !member.password)
          throw new DurableStoreError("Kin server password data is invalid.");
      for (const household of households.values()) {
        if (household.ownerMemberId === null) continue;
        const owner = members.get(household.ownerMemberId);
        if (!isId(household.ownerMemberId) || !owner || owner.householdId !== household.id || owner.kind !== "adult")
          throw new DurableStoreError("Kin server household ownership data is invalid.");
      }
      for (const row of this.db.prepare("SELECT * FROM credentials").all()) {
        const credential = parseStoredJson(row.credential_json);
        if (
          !validStoredCredential(credential) ||
          !validCredentialId(row.id) ||
          credential.id !== row.id ||
          credential.memberId !== row.member_id ||
          !members.get(row.member_id)?.credentials.has(row.id)
        )
          throw new DurableStoreError("Kin server credential data is invalid.");
        credentials.set(row.id, credential);
      }
      for (const row of this.db.prepare("SELECT * FROM devices").all()) {
        const device = parseStoredJson(row.device_json);
        if (
          !validStoredDevice(device) ||
          !isId(row.id) ||
          !isId(row.household_id) ||
          !isId(row.member_id) ||
          device.id !== row.id ||
          device.memberId !== row.member_id ||
          device.householdId !== row.household_id ||
          device.tokenHash !== row.token_hash ||
          device.revokedAt !== row.revoked_at ||
          !households.has(row.household_id) ||
          members.get(row.member_id)?.householdId !== row.household_id
        )
          throw new DurableStoreError("Kin server device data is invalid.");
        devices.set(row.id, device);
        const trustedCount =
          (trustedDeviceCounts.get(row.household_id) ?? 0) +
          Number(row.revoked_at === null);
        if (trustedCount > MAX_TRUSTED_DEVICES)
          throw new DurableStoreError("Kin server device data is invalid.");
        trustedDeviceCounts.set(row.household_id, trustedCount);
      }
      for (const device of devices.values()) {
        const certificate = device.deviceAuthorizationCertificate;
        // A version 2 certificate's issuer is the device that endorsed the
        // member's certification key (#568): the same member's device.
        const issuer = certificate?.version === 2
          ? devices.get(certificate.endorsement.issuerDeviceId)
          : devices.get(certificate?.issuerDeviceId);
        if (
          certificate &&
          (issuer?.householdId !== device.householdId ||
            (certificate.version === 2 && issuer.memberId !== device.memberId))
        )
          throw new DurableStoreError("Kin server device data is invalid.");
      }
      // At most one endorsed certification key per member.
      const endorsed = new Map();
      for (const device of devices.values()) {
        const fingerprint = device.certificationEndorsement?.fingerprint;
        if (!fingerprint) continue;
        if (endorsed.has(device.memberId) && endorsed.get(device.memberId) !== fingerprint)
          throw new DurableStoreError("Kin server device data is invalid.");
        endorsed.set(device.memberId, fingerprint);
      }
      for (const member of members.values())
        for (const credentialId of member.credentials)
          if (credentials.get(credentialId)?.memberId !== member.id)
            throw new DurableStoreError(
              "Kin server credential data is invalid.",
            );
      for (const household of households.values())
        if (household.lifecycleState === "deleted" && household.members.size)
          throw new DurableStoreError("Kin deleted-household data is invalid.");
      return { households, members, credentials, devices };
    } catch (error) {
      this.failed = true;
      if (error instanceof DurableStoreError) throw error;
      throw new DurableStoreError("Kin server identity data is invalid.", {
        cause: error,
      });
    }
  },

  saveIdentityHousehold(householdId, service) {
    const household = service.households.get(householdId);
    if (!household)
      throw new DurableStoreError("Kin server household data is unavailable.");
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO households(id, version, owner_member_id, chat_limited, chat_temporary, chat_policy_revision,
             board_limited, board_temporary, board_policy_revision, private_limited, private_policy_revision,
             features_off, features_revision, chore_adults, chore_adults_revision)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET version = excluded.version, owner_member_id = excluded.owner_member_id,
             chat_limited = excluded.chat_limited, chat_temporary = excluded.chat_temporary, chat_policy_revision = excluded.chat_policy_revision,
             board_limited = excluded.board_limited, board_temporary = excluded.board_temporary, board_policy_revision = excluded.board_policy_revision,
             private_limited = excluded.private_limited, private_policy_revision = excluded.private_policy_revision,
             features_off = excluded.features_off, features_revision = excluded.features_revision,
             chore_adults = excluded.chore_adults, chore_adults_revision = excluded.chore_adults_revision`,
        )
        .run(
          household.id, household.version, household.ownerMemberId ?? null,
          household.chatPolicy?.limited ?? "write", household.chatPolicy?.temporary ?? "write", household.chatPolicy?.revision ?? 0,
          household.boardPolicy?.limited ?? "write", household.boardPolicy?.temporary ?? "write", household.boardPolicy?.revision ?? 0,
          household.privatePolicy?.limited === false ? 0 : 1, household.privatePolicy?.revision ?? 0,
          household.features?.off ?? 0, household.features?.revision ?? 0,
          household.choreChart?.adults === true ? 1 : 0, household.choreChart?.revision ?? 0,
        );

      for (const memberId of household.members) {
        const member = service.members.get(memberId);
        if (!member || member.householdId !== householdId)
          throw new DurableStoreError("Kin server membership data is invalid.");
        this.db
          .prepare(
            "INSERT INTO members(id, household_id, active, credential_ids, kind, expires_at, member_status, household_admin, simple_view, username) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET active = excluded.active, credential_ids = excluded.credential_ids, kind = excluded.kind, expires_at = excluded.expires_at, member_status = excluded.member_status, household_admin = excluded.household_admin, simple_view = excluded.simple_view, username = excluded.username",
          )
          .run(
            member.id,
            householdId,
            Number(member.active),
            JSON.stringify([...member.credentials]),
            member.kind ?? "adult",
            member.expiresAt ?? null,
            member.memberStatus ?? (member.active ? "active" : "removed"),
            Number(member.householdAdmin === true),
            Number(member.simpleView === true && member.kind === "limited"),
            member.username ?? null,
          );
        // The verifier changes only when the password does; it is rewritten
        // with the member (an upsert of identical values otherwise).
        if (member.password)
          this.db
            .prepare(`INSERT INTO account_passwords (member_id, household_id, kdf_salt, kdf_iterations, verifier, updated_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (member_id) DO UPDATE SET kdf_salt = excluded.kdf_salt, kdf_iterations = excluded.kdf_iterations,
                verifier = excluded.verifier, updated_at = excluded.updated_at WHERE account_passwords.household_id = excluded.household_id`)
            .run(member.id, householdId, member.password.salt, member.password.iterations, member.password.verifier, member.password.updatedAt);
        for (const credentialId of member.credentials) {
          const credential = service.credentials.get(credentialId);
          if (!credential || credential.memberId !== memberId)
            throw new DurableStoreError("Kin server credential data is invalid.");
          this.db
            .prepare(
              "INSERT INTO credentials(id, member_id, credential_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET member_id = excluded.member_id, credential_json = excluded.credential_json",
            )
            .run(credentialId, memberId, stringifyStored(credential));
        }
      }

      const retainedCredentialIds = [...household.members].flatMap(
        (memberId) => [...service.members.get(memberId).credentials],
      );
      const removeCredential = this.db.prepare(
        "DELETE FROM credentials WHERE member_id = ? AND id NOT IN (SELECT value FROM json_each(?))",
      );
      for (const memberId of household.members)
        removeCredential.run(memberId, JSON.stringify(retainedCredentialIds));

      const devices = [...service.devices.values()].filter(
        (device) => device.householdId === householdId,
      );
      for (const device of devices) {
        this.db
          .prepare(
            "INSERT INTO devices(id, household_id, member_id, token_hash, revoked_at, device_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, revoked_at = excluded.revoked_at, device_json = excluded.device_json",
          )
          .run(
            device.id,
            householdId,
            device.memberId,
            device.tokenHash,
            device.revokedAt,
            stringifyStored(device),
          );
      }

      const pendingAudit = service.events.filter(
        (event) => event.persisted !== true && event.householdId === householdId,
      );
      const insertAudit = this.db.prepare(
        "INSERT INTO security_audit(household_id, created_at, event_type, details_json) VALUES (?, ?, ?, ?)",
      );
      for (const event of pendingAudit) {
        insertAudit.run(
          householdId,
          event.at,
          event.type,
          JSON.stringify(auditDetails(event)),
        );
        event.persisted = true;
      }
      this.db
        .prepare(
          "DELETE FROM security_audit WHERE sequence <= COALESCE((SELECT MAX(sequence) - ? FROM security_audit), 0)",
        )
        .run(MAX_AUDIT_ROWS);
    });
  },

  getHouseholdSettings(householdId) {
    const row = this.db.prepare("SELECT * FROM household_settings WHERE household_id = ?").get(householdId);
    return row ? { revision: row.revision, keyEpoch: row.key_epoch, ciphertext: Buffer.from(row.ciphertext), digest: row.digest, updatedAt: row.updated_at } : null;
  },

  putHouseholdSettings(householdId, expectedRevision, value) {
    return this.transaction(() => {
      const current = this.getHouseholdSettings(householdId);
      if ((current?.revision ?? 0) !== expectedRevision)
        throw new DurableConflictError("household_settings_stale", "Household settings changed on another device. Reload and try again.");
      this.db.prepare(`INSERT INTO household_settings
        (household_id, revision, key_epoch, ciphertext, digest, updated_by_member_id, updated_by_device_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(household_id) DO UPDATE SET revision=excluded.revision, key_epoch=excluded.key_epoch,
          ciphertext=excluded.ciphertext, digest=excluded.digest, updated_by_member_id=excluded.updated_by_member_id,
          updated_by_device_id=excluded.updated_by_device_id, updated_at=excluded.updated_at`)
        .run(householdId, expectedRevision + 1, value.keyEpoch, value.ciphertext, value.digest, value.memberId, value.deviceId, value.updatedAt);
      return expectedRevision + 1;
    });
  },
};
