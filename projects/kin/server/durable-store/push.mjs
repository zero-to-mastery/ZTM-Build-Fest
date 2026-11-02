// DurableStore push notifications (#85): one Web Push subscription per
// device and the service's VAPID key pair.
const subscription = (row) => row ? {
  deviceId: row.device_id, householdId: row.household_id, memberId: row.member_id, endpoint: row.endpoint,
  p256dh: Buffer.from(row.p256dh), auth: Buffer.from(row.auth), mutedUntil: row.muted_until,
  mutedIndefinitely: row.muted_indefinitely === 1, createdAt: row.created_at,
} : null;

export const pushMethods = {
  /** The VAPID key pair, created on first use. */
  vapidKeys(generate) {
    return this.transaction(() => {
      let row = this.db.prepare("SELECT private_jwk, public_jwk FROM push_vapid_keys WHERE id = 1").get();
      if (!row) {
        const keys = generate();
        this.db.prepare("INSERT INTO push_vapid_keys(id, private_jwk, public_jwk, created_at) VALUES (1, ?, ?, ?)")
          .run(JSON.stringify(keys.privateJwk), JSON.stringify(keys.publicJwk), Date.now());
        row = { private_jwk: JSON.stringify(keys.privateJwk), public_jwk: JSON.stringify(keys.publicJwk) };
      }
      return { privateJwk: JSON.parse(row.private_jwk), publicJwk: JSON.parse(row.public_jwk) };
    });
  },

  getPushSubscription(deviceId) {
    this.assertAvailable();
    return subscription(this.db.prepare("SELECT * FROM push_subscriptions WHERE device_id = ?").get(deviceId));
  },

  householdPushSubscriptions(householdId) {
    this.assertAvailable();
    return this.db.prepare("SELECT * FROM push_subscriptions WHERE household_id = ?").all(householdId).map(subscription);
  },

  /** Saves a device's subscription, replacing its earlier one. A new
   * subscription starts unmuted unless the device keeps its mute. */
  putPushSubscription(value) {
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO push_subscriptions
        (device_id, household_id, member_id, endpoint, p256dh, auth, muted_until, muted_indefinitely, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET household_id=excluded.household_id, member_id=excluded.member_id,
          endpoint=excluded.endpoint, p256dh=excluded.p256dh, auth=excluded.auth, created_at=excluded.created_at`)
        .run(value.deviceId, value.householdId, value.memberId, value.endpoint, value.p256dh, value.auth,
          value.mutedUntil ?? null, value.mutedIndefinitely ? 1 : 0, value.createdAt);
    });
  },

  /** Mutes until a time, indefinitely (`indefinitely`), or unmutes (null). */
  setPushMute(deviceId, mutedUntil, indefinitely = false) {
    return this.transaction(() =>
      this.db.prepare("UPDATE push_subscriptions SET muted_until = ?, muted_indefinitely = ? WHERE device_id = ?")
        .run(indefinitely ? null : mutedUntil, indefinitely ? 1 : 0, deviceId).changes > 0);
  },

  deletePushSubscriptions(deviceIds) {
    if (!deviceIds.length) return 0;
    return this.transaction(() => {
      const remove = this.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ?");
      return deviceIds.reduce((count, id) => count + remove.run(id).changes, 0);
    });
  },

  /** Deletes a subscription only if it still has this endpoint (a push
   * service said it is gone; the device may have re-subscribed meanwhile). */
  deleteGonePushSubscription(deviceId, endpoint) {
    return this.transaction(() =>
      this.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?").run(deviceId, endpoint).changes > 0);
  },
};
