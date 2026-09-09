import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHostedStore, createUser, getHostedStore, openDatabase, setStoreExpiry } from "../src/db.js";
import { reconcileLifecycle } from "../src/policy.js";

test("store lifecycle moves through expiry and deletion scheduling", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yardsale-cloud-lifecycle-"));
  const db = openDatabase(dataDir);
  try {
    const user = createUser(db, { email: "seller@example.com", passwordHash: "hash" });
    const store = createHostedStore(db, {
      userId: user.id,
      name: "Expired Sale",
      slug: "expired-sale",
      hostname: "expired-sale.yardsale.local",
      imageVersion: "yardsale:1.0.0",
      freeDays: 1
    });
    const expiredAt = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(setStoreExpiry(db, store.id, { endsAt: expiredAt.toISOString(), actor: "admin@example.com" }).state, "running");
    assert.equal(reconcileLifecycle(db, new Date("2026-01-02T00:00:00.000Z")), 1);
    const expired = getHostedStore(db, store.id);
    assert.equal(expired.state, "expired");
    assert.equal(expired.grace_ends_at, "2026-01-15T00:00:00.000Z");
    assert.equal(reconcileLifecycle(db, new Date("2026-01-16T00:00:00.000Z")), 1);
    assert.equal(getHostedStore(db, store.id).state, "deleting");
  } finally {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
