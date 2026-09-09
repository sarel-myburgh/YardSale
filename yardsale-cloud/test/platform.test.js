import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { completeMockPayment, createCheckout } from "../src/billing.js";
import { createCampaign, createCoupon, createHostedStore, createUser, getHostedStore, openDatabase, redeemCoupon, setStoreRuntime, setUserStatus } from "../src/db.js";
import { ingestFederationFeed, searchMarketplace } from "../src/marketplace.js";
import { reportListing, resolveReport } from "../src/moderation.js";
import { createBackup } from "../src/ops.js";
import { isMarketplaceEligible, resolvePolicy } from "../src/policy.js";

test("commercial, discovery, moderation, and backup slices compose", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yardsale-cloud-platform-"));
  const backupDir = join(dataDir, "backups");
  const db = openDatabase(dataDir);
  try {
    const user = createUser(db, { email: "operator@example.com", passwordHash: "hash", isAdmin: true, countryCode: "KH" });
    const store = createHostedStore(db, {
      userId: user.id,
      name: "Phnom Penh Finds",
      slug: "phnom-penh-finds",
      hostname: "phnom-penh-finds.yardsale.local",
      imageVersion: "yardsale:1.0.0",
      freeDays: 14
    });
    setStoreRuntime(db, store.id, { runtimeInstanceId: "local:test", state: "running" });
    createCampaign(db, {
      name: "Cambodia launch",
      status: "active",
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2099-01-01T00:00:00.000Z",
      eligibilityRule: { country_code: "KH" },
      overrides: { default_free_days: 30 },
      createdBy: user.email
    });
    assert.equal(resolvePolicy(db, { userId: user.id }).default_free_days, 30);

    createCoupon(db, {
      code: "LOCAL30",
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2099-01-01T00:00:00.000Z",
      entitlementPayload: { marketplace_enabled: true },
      createdBy: user.email
    });
    redeemCoupon(db, { code: "LOCAL30", userId: user.id, storeId: store.id, actor: user.email });
    const runningStore = getHostedStore(db, store.id);
    assert.equal(isMarketplaceEligible({ ...runningStore, state: "running", mode: "free" }, resolvePolicy(db, { storeId: store.id })), true);

    const extension = createCheckout(db, { userId: user.id, storeId: store.id, actor: user.email });
    completeMockPayment(db, extension.id);
    completeMockPayment(db, extension.id);
    assert.equal(getHostedStore(db, store.id).mode, "paid");

    const feed = {
      protocol: "yardsale-federation",
      version: 1,
      store_id: getHostedStore(db, store.id).public_id,
      enabled: true,
      updated_at: "2026-01-02T00:00:00.000Z",
      listings: [{
        listing_id: "lamp-1",
        title: "Brass reading lamp",
        description: "Warm light for a reading corner.",
        price_minor: 2500,
        currency: "USD",
        category: "Home",
        condition: "Good",
        tags: ["lamp", "brass"],
        status: "available",
        location: { country_code: "KH", city: "Phnom Penh", area: "BKK1", display_location: "BKK1" },
        canonical_url: "https://store.example/item/lamp-1",
        updated_at: "2026-01-02T00:00:00.000Z"
      }]
    };
    assert.equal(ingestFederationFeed(db, { storeId: store.id, payload: feed }).indexed, 1);
    assert.equal(searchMarketplace(db, { query: "brass", city: "Phnom Penh" }).length, 1);
    setUserStatus(db, user.id, "suspended", "operator@example.com");
    assert.equal(searchMarketplace(db, { query: "brass" }).length, 0);
    setUserStatus(db, user.id, "active", "operator@example.com");
    assert.equal(searchMarketplace(db, { query: "brass" }).length, 1);
    const listing = db.prepare("SELECT * FROM search_listings LIMIT 1").get();
    const report = reportListing(db, { listingId: listing.id, reason: "spam", details: "Needs review" });
    assert.equal(resolveReport(db, { reportId: report.id, status: "resolved", actor: user.email, blockListing: true }).status, "resolved");
    assert.equal(searchMarketplace(db, {}).length, 0);

    const backup = await createBackup(db, { dataDir, backupDir });
    assert.ok(backup.directory.endsWith("/backups/" + backup.directory.split("/").pop()));
  } finally {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
