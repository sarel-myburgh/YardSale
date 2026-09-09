import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStoreEntitlement, createUser, createHostedStore, getHostedStore, openDatabase, setPlatformPolicy } from "../src/db.js";
import { isMarketplaceEligible, resolvePolicy, validatePolicyValue } from "../src/policy.js";

test("policy resolution applies store entitlements over global defaults", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yardsale-cloud-policy-"));
  const db = openDatabase(dataDir);
  try {
    setPlatformPolicy(db, { key: "default_free_days", value: "21", actor: "admin@example.com" });
    const user = createUser(db, { email: "seller@example.com", passwordHash: "hash" });
    const store = createHostedStore(db, {
      userId: user.id,
      name: "Local Sale",
      slug: "local-sale",
      hostname: "local-sale.yardsale.local",
      imageVersion: "yardsale:1.0.0",
      freeDays: 21
    });
    createStoreEntitlement(db, {
      storeId: store.id,
      source: "manual_override",
      key: "default_free_days",
      value: "45",
      reason: "launch exception",
      createdBy: "admin@example.com"
    });
    assert.equal(resolvePolicy(db).default_free_days, 21);
    assert.equal(resolvePolicy(db, { storeId: store.id }).default_free_days, 45);
    assert.equal(isMarketplaceEligible({ ...getHostedStore(db, store.id), state: "running", mode: "free" }, resolvePolicy(db, { storeId: store.id })), false);
    assert.equal(validatePolicyValue("paid_marketplace_enabled", "false"), "false");
    assert.throws(() => validatePolicyValue("default_free_days", "0"), /whole number/);
  } finally {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
