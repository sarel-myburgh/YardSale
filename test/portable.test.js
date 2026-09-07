import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addListingImage,
  createComment,
  createListing,
  createSetup,
  getStore,
  getUserByLogin,
  listComments,
  listListingImages,
  listListings,
  listReservations,
  openDatabase,
  reserveListing,
  updateStore
} from "../src/db.js";
import { federationCacheHeaders, federationFeed, federationManifest } from "../src/federation.js";
import { createStoreExport, importStoreExport, readZip } from "../src/portable.js";

function listingValues(overrides = {}) {
  return {
    title: "Brass Lamp",
    slug: "brass-lamp",
    description: "Warm light for a reading corner.",
    priceMinor: 2500,
    currency: "USD",
    category: "Home",
    condition: "Good",
    pickupNotes: "Pickup nearby.",
    tags: "lamp, brass",
    published: true,
    quantity: 1,
    ...overrides
  };
}

test("store exports round-trip listings, media, reservations, comments, and settings", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "yardsale-export-source-"));
  const restoreDir = await mkdtemp(join(tmpdir(), "yardsale-export-restore-"));
  const filename = "123e4567-e89b-12d3-a456-426614174000.jpg";

  try {
    await mkdir(join(sourceDir, "uploads"), { recursive: true });
    await writeFile(join(sourceDir, "uploads", filename), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const sourceDb = openDatabase(sourceDir);
    createSetup(sourceDb, { login: "source", passwordHash: "source-hash", storeName: "Source Store", currency: "USD", timezone: "UTC" });
    updateStore(sourceDb, { ...getStore(sourceDb), location: "Phnom Penh", federationEnabled: true, contactMethods: [{ type: "telegram", label: "Telegram", value: "@source" }] });
    const sourcePublicId = getStore(sourceDb).publicId;
    const listing = createListing(sourceDb, listingValues());
    addListingImage(sourceDb, { listingId: listing.id, path: filename, altText: "Brass lamp", sortOrder: 0 });
    createComment(sourceDb, { listingId: listing.id, displayName: "Buyer", body: "Is this still available?" });
    assert.equal(reserveListing(sourceDb, listing.id, { buyerName: "Buyer", buyerContact: "@buyer", holdMinutes: 60 }).ok, true);

    const archive = await createStoreExport(sourceDb, sourceDir);
    const archiveFiles = readZip(archive);
    assert.deepEqual([...archiveFiles.keys()], ["manifest.json", "store.json", "listings.json", "reservations.json", "comments.json", `uploads/${filename}`]);
    sourceDb.close();

    const restoreDb = openDatabase(restoreDir);
    createSetup(restoreDb, { login: "restored", passwordHash: "restored-hash", storeName: "Restored Store", currency: "EUR", timezone: "UTC" });
    const result = await importStoreExport(restoreDb, restoreDir, archive);
    assert.deepEqual(result, { listings: 1, reservations: 1, comments: 1, uploads: 1 });
    assert.equal(getStore(restoreDb).name, "Source Store");
    assert.equal(getStore(restoreDb).publicId, sourcePublicId);
    assert.equal(getUserByLogin(restoreDb, "restored").password_hash, "restored-hash");
    assert.equal(listListings(restoreDb, { admin: true })[0].title, "Brass Lamp");
    assert.equal(listReservations(restoreDb).length, 1);
    assert.equal(listComments(restoreDb).length, 1);
    const restoredImage = listListingImages(restoreDb, listListings(restoreDb, { admin: true })[0].id)[0];
    assert.notEqual(restoredImage.path, filename);
    assert.deepEqual(await readFile(join(restoreDir, "uploads", restoredImage.path)), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    restoreDb.close();
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(restoreDir, { recursive: true, force: true });
  }
});

test("federation exposes public listing metadata only and supports cache validators", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yardsale-federation-"));
  const db = openDatabase(dataDir);

  try {
    createSetup(db, { login: "owner", passwordHash: "owner-hash", storeName: "Public Store", currency: "USD", timezone: "UTC" });
    updateStore(db, { ...getStore(db), federationEnabled: true, location: "Phnom Penh" });
    const listing = createListing(db, listingValues({ slug: "public-lamp" }));
    reserveListing(db, listing.id, { buyerName: "Private Buyer", buyerContact: "private@example.com", holdMinutes: 60 });
    const store = getStore(db);
    const feed = federationFeed(db, store, "https://store.example");
    const manifest = federationManifest(store, "https://store.example");
    const item = feed.listings[0];

    assert.equal(manifest.enabled, true);
    assert.equal(manifest.feed_url, "https://store.example/api/federation/v1/listings");
    assert.equal(item.title, "Brass Lamp");
    assert.equal(item.status, "held");
    assert.equal(item.canonical_url, "https://store.example/item/public-lamp");
    assert.equal("buyer_name" in item, false);
    assert.equal("buyer_contact" in item, false);
    assert.equal("manage_token_hash" in item, false);
    const firstHeaders = federationCacheHeaders(feed);
    const secondHeaders = federationCacheHeaders(feed);
    assert.equal(firstHeaders.etag, secondHeaders.etag);
    db.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
