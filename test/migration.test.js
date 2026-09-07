import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getActiveReservationForListing, getListingById, openDatabase } from "../src/db.js";

test("opening a legacy database migrates listing and reservation statuses", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yardsale-migration-"));
  const legacyPath = join(dataDir, "yardsale.db");
  const legacy = new DatabaseSync(legacyPath);
  const createdAt = "2025-01-01T00:00:00.000Z";
  const expiresAt = "2099-01-01T00:00:00.000Z";

  try {
    legacy.exec(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE listings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        price_minor INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        category TEXT NOT NULL DEFAULT '',
        condition TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'sold', 'hidden')),
        quantity INTEGER NOT NULL DEFAULT 1,
        pickup_notes TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        published INTEGER NOT NULL DEFAULT 1,
        comments_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sold_at TEXT
      );
      CREATE TABLE reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL UNIQUE,
        listing_id INTEGER NOT NULL,
        buyer_name TEXT NOT NULL,
        buyer_contact TEXT NOT NULL,
        buyer_message TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled', 'completed')),
        manage_token_hash TEXT NOT NULL,
        reserved_at TEXT NOT NULL,
        expires_at TEXT,
        completed_at TEXT,
        cancelled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO listings (public_id, title, slug, description, price_minor, currency, status, created_at, updated_at)
      VALUES ('legacy-listing', 'Legacy lamp', 'legacy-lamp', 'A migrated item', 2500, 'USD', 'available', '${createdAt}', '${createdAt}');
      INSERT INTO reservations (public_id, listing_id, buyer_name, buyer_contact, status, manage_token_hash, reserved_at, expires_at, created_at, updated_at)
      VALUES ('legacy-reservation', 1, 'Buyer', 'buyer@example.com', 'active', 'token-hash', '${createdAt}', '${expiresAt}', '${createdAt}', '${createdAt}');
    `);
  } finally {
    legacy.close();
  }

  try {
    const db = openDatabase(dataDir);
    try {
      const listing = getListingById(db, 1);
      const reservation = getActiveReservationForListing(db, 1);
      assert.equal(listing.title, "Legacy lamp");
      assert.equal(listing.status, "available");
      assert.equal(reservation.status, "reserved");
      assert.equal(reservation.reservation_expires_at, expiresAt);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM listing_search").get().count, 1);
      assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'listings'").get().sql, /'held'/);
    } finally {
      db.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
