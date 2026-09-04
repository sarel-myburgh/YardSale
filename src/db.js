import { mkdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { hashToken, nowIso, slugify } from "./utils.js";

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    category TEXT NOT NULL DEFAULT '',
    condition TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'reserved', 'sold', 'hidden')),
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    pickup_notes TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 1,
    comments_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sold_at TEXT
  );

  CREATE TABLE IF NOT EXISTS listing_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    alt_text TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS listing_images_listing_idx ON listing_images(listing_id, sort_order, id);

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'hidden')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    moderated_at TEXT
  );

  CREATE INDEX IF NOT EXISTS comments_listing_idx ON comments(listing_id, status, created_at);

  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT NOT NULL UNIQUE,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    buyer_name TEXT NOT NULL,
    buyer_contact TEXT NOT NULL,
    buyer_message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'reserved', 'expired', 'rejected', 'cancelled', 'completed')),
    manage_token_hash TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    hold_expires_at TEXT,
    approved_at TEXT,
    reservation_expires_at TEXT,
    completed_at TEXT,
    rejected_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

`;

function tableSql(db, table) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql || "";
}

function migrateLegacyTables(db) {
  const legacyListings = tableSql(db, "listings");
  if (legacyListings && !legacyListings.includes("'held'")) {
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      transaction(db, () => {
        db.exec(`
          CREATE TABLE listings_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            public_id TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
            currency TEXT NOT NULL DEFAULT 'USD',
            category TEXT NOT NULL DEFAULT '',
            condition TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'reserved', 'sold', 'hidden')),
            quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
            pickup_notes TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            published INTEGER NOT NULL DEFAULT 1,
            comments_enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            sold_at TEXT
          );
          INSERT INTO listings_v2 (
            id, public_id, title, slug, description, price_minor, currency, category, condition,
            status, quantity, pickup_notes, tags, sort_order, published, comments_enabled,
            created_at, updated_at, sold_at
          ) SELECT
            id, public_id, title, slug, description, price_minor, currency, category, condition,
            status, quantity, pickup_notes, tags, sort_order, published, comments_enabled,
            created_at, updated_at, sold_at
          FROM listings;
          DROP TABLE listings;
          ALTER TABLE listings_v2 RENAME TO listings;
          CREATE INDEX listings_status_idx ON listings(status, published, sort_order);
        `);
      });
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }

  const legacyReservations = tableSql(db, "reservations");
  if (legacyReservations && legacyReservations.includes("'active'")) {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE reservations_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          public_id TEXT NOT NULL UNIQUE,
          listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
          buyer_name TEXT NOT NULL,
          buyer_contact TEXT NOT NULL,
          buyer_message TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'reserved', 'expired', 'rejected', 'cancelled', 'completed')),
          manage_token_hash TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          hold_expires_at TEXT,
          approved_at TEXT,
          reservation_expires_at TEXT,
          completed_at TEXT,
          rejected_at TEXT,
          cancelled_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO reservations_v2 (
          id, public_id, listing_id, buyer_name, buyer_contact, buyer_message, status,
          manage_token_hash, requested_at, hold_expires_at, approved_at, reservation_expires_at,
          completed_at, rejected_at, cancelled_at, created_at, updated_at
        ) SELECT
          id, public_id, listing_id, buyer_name, buyer_contact, buyer_message,
          CASE WHEN status = 'active' THEN 'reserved' ELSE status END,
          manage_token_hash, reserved_at,
          CASE WHEN status = 'active' THEN NULL ELSE expires_at END,
          CASE WHEN status = 'active' THEN reserved_at ELSE NULL END,
          CASE WHEN status IN ('active', 'expired', 'cancelled', 'completed') THEN expires_at ELSE NULL END,
          completed_at, NULL, cancelled_at, created_at, updated_at
        FROM reservations;
        DROP TABLE reservations;
        ALTER TABLE reservations_v2 RENAME TO reservations;
        CREATE INDEX reservations_active_idx ON reservations(listing_id, status, reservation_expires_at);
      `);
    });
  }
}

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(`${dataDir}/yardsale.db`);
  db.exec(schema);
  migrateLegacyTables(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS listings_status_idx ON listings(status, published, sort_order);
    CREATE INDEX IF NOT EXISTS listing_images_listing_idx ON listing_images(listing_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS comments_listing_idx ON comments(listing_id, status, created_at);
    CREATE INDEX IF NOT EXISTS reservations_active_idx ON reservations(listing_id, status, reservation_expires_at);
  `);
  return db;
}

export function transaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Keep the original database error.
    }
    throw error;
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  return row?.value ?? fallback;
}

export function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

export function isSetupComplete(db) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM admin_users").get().count) > 0;
}

export function getStore(db) {
  let contactMethods = [];
  try {
    const parsed = JSON.parse(getSetting(db, "store.contact_methods", "[]"));
    if (Array.isArray(parsed)) contactMethods = parsed;
  } catch {
    // Keep an older or manually edited store usable.
  }

  return {
    name: getSetting(db, "store.name", "YardSale"),
    description: getSetting(db, "store.description", "A temporary storefront for good things finding a new home."),
    location: getSetting(db, "store.location", ""),
    currency: getSetting(db, "store.currency", "USD"),
    timezone: getSetting(db, "store.timezone", "UTC"),
    holdDurationMinutes: Number(getSetting(db, "store.hold_duration_minutes", "60")) || 60,
    reservationDurationMinutes: Number(getSetting(db, "store.reservation_duration_minutes", "1440")) || 1440,
    commentsEnabled: getSetting(db, "store.comments_enabled", "true") === "true",
    contactMethods
  };
}

export function createSetup(db, { login, passwordHash, storeName, currency, timezone }) {
  return transaction(db, () => {
    if (isSetupComplete(db)) throw new Error("Setup is already complete");

    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO admin_users (login, password_hash, created_at)
      VALUES (?, ?, ?)
    `).run(login, passwordHash, now);

    setSetting(db, "store.name", storeName);
    setSetting(db, "store.description", "A temporary storefront for good things finding a new home.");
    setSetting(db, "store.location", "");
    setSetting(db, "store.currency", currency);
    setSetting(db, "store.timezone", timezone);
    setSetting(db, "store.hold_duration_minutes", "60");
    setSetting(db, "store.reservation_duration_minutes", "1440");
    setSetting(db, "store.comments_enabled", "true");
    setSetting(db, "store.contact_methods", "[]");
    setSetting(db, "setup_complete", "true");

    return Number(result.lastInsertRowid);
  });
}

export function getUserByLogin(db, login) {
  return db.prepare("SELECT * FROM admin_users WHERE login = ? COLLATE NOCASE").get(login);
}

export function touchUserLogin(db, userId) {
  db.prepare("UPDATE admin_users SET last_login_at = ? WHERE id = ?").run(nowIso(), userId);
}

export function updateStore(db, values) {
  return transaction(db, () => {
    setSetting(db, "store.name", values.name);
    setSetting(db, "store.description", values.description);
    setSetting(db, "store.location", values.location);
    setSetting(db, "store.currency", values.currency);
    setSetting(db, "store.timezone", values.timezone);
    setSetting(db, "store.hold_duration_minutes", values.holdDurationMinutes);
    setSetting(db, "store.reservation_duration_minutes", values.reservationDurationMinutes);
    setSetting(db, "store.comments_enabled", values.commentsEnabled ? "true" : "false");
    setSetting(db, "store.contact_methods", JSON.stringify(Array.isArray(values.contactMethods) ? values.contactMethods : []));
  });
}

export function makeUniqueSlug(db, title, excludeId = null) {
  const base = slugify(title);
  let candidate = base;
  let suffix = 2;

  while (true) {
    const row = excludeId === null
      ? db.prepare("SELECT id FROM listings WHERE slug = ?").get(candidate)
      : db.prepare("SELECT id FROM listings WHERE slug = ? AND id <> ?").get(candidate, excludeId);
    if (!row) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
}

export function listListings(db, { admin = false, query = "", status = "", category = "" } = {}) {
  const clauses = admin ? [] : ["published = 1", "status <> 'hidden'"];
  const params = [];
  const search = String(query).trim();

  if (search) {
    clauses.push("(title LIKE ? OR description LIKE ? OR category LIKE ? OR tags LIKE ?)");
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }
  if (status && ["available", "held", "reserved", "sold", "hidden"].includes(status)) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (category) {
    clauses.push("category = ?");
    params.push(category);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT * FROM listings
    ${where}
      ORDER BY CASE status WHEN 'available' THEN 0 WHEN 'held' THEN 1 WHEN 'reserved' THEN 2 WHEN 'sold' THEN 3 ELSE 4 END,
      sort_order ASC, created_at DESC
  `).all(...params);
}

export function getListingById(db, id) {
  return db.prepare("SELECT * FROM listings WHERE id = ?").get(id);
}

export function getListingBySlug(db, slug) {
  return db.prepare("SELECT * FROM listings WHERE slug = ?").get(slug);
}

export function listListingImages(db, listingId) {
  return db.prepare(`
    SELECT * FROM listing_images WHERE listing_id = ? ORDER BY sort_order ASC, id ASC
  `).all(listingId);
}

export function getListingImageById(db, id) {
  return db.prepare("SELECT * FROM listing_images WHERE id = ?").get(id);
}

export function addListingImage(db, { listingId, path, altText = "", sortOrder = 0 }) {
  const result = db.prepare(`
    INSERT INTO listing_images (listing_id, path, alt_text, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(listingId, path, altText, sortOrder, nowIso());
  return getListingImageById(db, Number(result.lastInsertRowid));
}

export function deleteListingImage(db, id) {
  const image = getListingImageById(db, id);
  if (image) db.prepare("DELETE FROM listing_images WHERE id = ?").run(id);
  return image;
}

export function createListing(db, values) {
  const now = nowIso();
  const publicId = randomUUID();
  const result = db.prepare(`
    INSERT INTO listings (
      public_id, title, slug, description, price_minor, currency, category, condition,
      status, quantity, pickup_notes, tags, sort_order, published, comments_enabled,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    publicId,
    values.title,
    values.slug,
    values.description,
    values.priceMinor,
    values.currency,
    values.category,
    values.condition,
    values.status ?? "available",
    values.quantity ?? 1,
    values.pickupNotes,
    values.tags,
    values.sortOrder ?? 0,
    values.published ? 1 : 0,
    values.commentsEnabled === false ? 0 : 1,
    now,
    now
  );
  return getListingById(db, Number(result.lastInsertRowid));
}

export function updateListing(db, id, values) {
  db.prepare(`
    UPDATE listings SET
      title = ?, slug = ?, description = ?, price_minor = ?, currency = ?, category = ?,
      condition = ?, quantity = ?, pickup_notes = ?, tags = ?, published = ?, comments_enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(
    values.title,
    values.slug,
    values.description,
    values.priceMinor,
    values.currency,
    values.category,
    values.condition,
    values.quantity,
    values.pickupNotes,
    values.tags,
    values.published ? 1 : 0,
    values.commentsEnabled === false ? 0 : 1,
    nowIso(),
    id
  );
  return getListingById(db, id);
}

export function getCommentById(db, id) {
  return db.prepare("SELECT * FROM comments WHERE id = ?").get(id);
}

export function createComment(db, { listingId, displayName, body }) {
  const now = nowIso();
  const result = db.prepare(`
    INSERT INTO comments (listing_id, display_name, body, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(listingId, displayName, body, now, now);
  return getCommentById(db, Number(result.lastInsertRowid));
}

export function listApprovedComments(db, listingId) {
  return db.prepare(`
    SELECT * FROM comments
    WHERE listing_id = ? AND status = 'approved'
    ORDER BY created_at ASC, id ASC
  `).all(listingId);
}

export function listComments(db) {
  return db.prepare(`
    SELECT comments.*, listings.title, listings.slug
    FROM comments JOIN listings ON listings.id = comments.listing_id
    ORDER BY CASE comments.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
      comments.created_at DESC, comments.id DESC
  `).all();
}

export function adminCommentAction(db, id, action) {
  if (action === "delete") {
    return Number(db.prepare("DELETE FROM comments WHERE id = ?").run(id).changes) > 0;
  }
  const status = action === "approve" ? "approved" : action === "hide" ? "hidden" : null;
  if (!status) return false;
  const now = nowIso();
  return Number(db.prepare("UPDATE comments SET status = ?, moderated_at = ?, updated_at = ? WHERE id = ?").run(status, now, now, id).changes) > 0;
}

export function deleteListing(db, id) {
  const images = listListingImages(db, id);
  db.prepare("DELETE FROM listings WHERE id = ?").run(id);
  return images;
}

export function setListingStatus(db, id, status) {
  if (!["available", "reserved", "sold", "hidden"].includes(status)) throw new Error("Invalid listing status");

  return transaction(db, () => {
    const now = nowIso();
    if (status === "sold") {
      db.prepare(`
        UPDATE reservations SET
          status = CASE WHEN status = 'held' THEN 'rejected' ELSE 'completed' END,
          completed_at = CASE WHEN status = 'reserved' THEN ? ELSE completed_at END,
          rejected_at = CASE WHEN status = 'held' THEN ? ELSE rejected_at END,
          updated_at = ?
        WHERE listing_id = ? AND status IN ('held', 'reserved')
      `).run(now, now, now, id);
    } else if (status === "available" || status === "hidden") {
      db.prepare(`
        UPDATE reservations SET status = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE listing_id = ? AND status IN ('held', 'reserved')
      `).run(now, now, id);
    }

    db.prepare(`
      UPDATE listings SET status = ?, sold_at = ?, updated_at = ? WHERE id = ?
    `).run(status, status === "sold" ? now : null, now, id);
    return getListingById(db, id);
  });
}

export function dashboardStats(db) {
  const counts = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) AS count FROM listings GROUP BY status")
      .all()
      .map((row) => [row.status, Number(row.count)])
  );
  return {
    available: counts.available ?? 0,
    held: counts.held ?? 0,
    reserved: counts.reserved ?? 0,
    sold: counts.sold ?? 0,
    hidden: counts.hidden ?? 0,
    activeReservations: Number(db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE status IN ('held', 'reserved')").get().count)
  };
}

export function expireReservations(db) {
  return transaction(db, () => {
    const now = nowIso();
    const expired = db.prepare(`
      SELECT id, listing_id, status FROM reservations
      WHERE (status = 'held' AND hold_expires_at <= ?)
         OR (status = 'reserved' AND reservation_expires_at <= ?)
    `).all(now, now);

    for (const reservation of expired) {
      db.prepare("UPDATE reservations SET status = 'expired', updated_at = ? WHERE id = ?")
        .run(now, reservation.id);
      db.prepare(`
        UPDATE listings SET status = 'available', updated_at = ?
        WHERE id = ? AND status = ?
      `).run(now, reservation.listing_id, reservation.status);
    }
    return expired.length;
  });
}

export function reserveListing(db, listingId, { buyerName, buyerContact, buyerMessage = "", durationMinutes, holdMinutes } = {}) {
  return transaction(db, () => {
    const now = nowIso();
    const listing = db.prepare("SELECT * FROM listings WHERE id = ?").get(listingId);
    if (!listing || !listing.published || listing.status !== "available") {
      return { ok: false, reason: "unavailable" };
    }

    const secret = randomBytes(32).toString("base64url");
    const publicId = randomUUID();
    const holdDuration = Math.max(5, Number(holdMinutes ?? durationMinutes) || 60);
    const holdExpiresAt = new Date(Date.now() + holdDuration * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO reservations (
        public_id, listing_id, buyer_name, buyer_contact, buyer_message, status,
        manage_token_hash, requested_at, hold_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?)
    `).run(
      publicId,
      listingId,
      buyerName,
      buyerContact,
      buyerMessage,
      hashToken(secret),
      now,
      holdExpiresAt,
      now,
      now
    );
    db.prepare("UPDATE listings SET status = 'held', updated_at = ? WHERE id = ? AND status = 'available'")
      .run(now, listingId);

    return { ok: true, publicId, secret, holdExpiresAt, expiresAt: holdExpiresAt };
  });
}

export function getActiveReservationForListing(db, listingId) {
  return db.prepare(`
    SELECT * FROM reservations WHERE listing_id = ? AND status IN ('held', 'reserved') ORDER BY id DESC LIMIT 1
  `).get(listingId);
}

export function getReservationByToken(db, publicId, secret) {
  return db.prepare(`
    SELECT reservations.*, listings.title, listings.slug, listings.currency, listings.price_minor
    FROM reservations JOIN listings ON listings.id = reservations.listing_id
    WHERE reservations.public_id = ? AND reservations.manage_token_hash = ?
  `).get(publicId, hashToken(secret));
}

export function cancelReservationByToken(db, publicId, secret) {
  return transaction(db, () => {
    const reservation = getReservationByToken(db, publicId, secret);
    if (!reservation || !["held", "reserved"].includes(reservation.status)) return false;
    const now = nowIso();
    db.prepare(`
      UPDATE reservations SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, reservation.id);
    db.prepare(`
      UPDATE listings SET status = 'available', updated_at = ?
      WHERE id = ? AND status IN ('held', 'reserved')
    `).run(now, reservation.listing_id);
    return true;
  });
}

export function listReservations(db) {
  return db.prepare(`
    SELECT reservations.*, listings.title, listings.slug, listings.currency, listings.price_minor
    FROM reservations JOIN listings ON listings.id = reservations.listing_id
    ORDER BY CASE reservations.status WHEN 'held' THEN 0 WHEN 'reserved' THEN 1 ELSE 2 END, reservations.created_at DESC
  `).all();
}

export function adminReservationAction(db, id, action, { holdDurationMinutes = 60, reservationDurationMinutes = 1440, reservationExpiresAt = null } = {}) {
  return transaction(db, () => {
    const reservation = db.prepare("SELECT * FROM reservations WHERE id = ?").get(id);
    if (!reservation) return false;
    const now = nowIso();

    if (action === "cancel" && ["held", "reserved"].includes(reservation.status)) {
      db.prepare("UPDATE reservations SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, id);
      db.prepare("UPDATE listings SET status = 'available', updated_at = ? WHERE id = ? AND status IN ('held', 'reserved')")
        .run(now, reservation.listing_id);
      return true;
    }

    if (action === "reject" && reservation.status === "held") {
      db.prepare("UPDATE reservations SET status = 'rejected', rejected_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, id);
      db.prepare("UPDATE listings SET status = 'available', updated_at = ? WHERE id = ? AND status = 'held'")
        .run(now, reservation.listing_id);
      return true;
    }

    if (action === "approve" && reservation.status === "held") {
      const requestedExpiry = String(reservationExpiresAt ?? "").trim();
      const parsedExpiry = requestedExpiry ? Date.parse(requestedExpiry) : NaN;
      if (requestedExpiry && (!Number.isFinite(parsedExpiry) || parsedExpiry <= Date.parse(now))) return false;
      const approvedUntil = requestedExpiry
        ? new Date(parsedExpiry).toISOString()
        : new Date(Date.now() + Math.max(5, Number(reservationDurationMinutes) || 1440) * 60 * 1000).toISOString();
      db.prepare(`
        UPDATE reservations SET status = 'reserved', approved_at = ?, reservation_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'held'
      `).run(now, approvedUntil, now, id);
      db.prepare("UPDATE listings SET status = 'reserved', updated_at = ? WHERE id = ? AND status = 'held'")
        .run(now, reservation.listing_id);
      return true;
    }

    if (action === "extend" && ["held", "reserved"].includes(reservation.status)) {
      const expiryColumn = reservation.status === "held" ? "hold_expires_at" : "reservation_expires_at";
      const parsedExpiry = Date.parse(reservation[expiryColumn] || "");
      const currentExpiry = Math.max(Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now(), Date.now());
      const duration = reservation.status === "held" ? holdDurationMinutes : reservationDurationMinutes;
      const expiresAt = new Date(currentExpiry + Math.max(5, Number(duration) || 60) * 60 * 1000).toISOString();
      db.prepare(`UPDATE reservations SET ${expiryColumn} = ?, updated_at = ? WHERE id = ?`).run(expiresAt, now, id);
      return true;
    }

    if (action === "complete" && reservation.status === "reserved") {
      db.prepare("UPDATE reservations SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, id);
      db.prepare("UPDATE listings SET status = 'sold', sold_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, reservation.listing_id);
      return true;
    }

    return false;
  });
}
