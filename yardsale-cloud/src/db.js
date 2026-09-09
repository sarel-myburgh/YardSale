import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export const DEFAULT_POLICY_VALUES = {
  default_free_days: "14",
  default_paid_days: "30",
  default_store_price_minor: "500",
  default_grace_days: "14",
  free_active_store_limit: "1",
  paid_marketplace_enabled: "true",
  store_image_version: "yardsale:1.0.0",
  storage_quota_bytes: "1073741824",
  listing_limit: "1000",
  promotion_feature_listing_price_minor: "300",
  promotion_feature_store_price_minor: "500",
  promotion_duration_hours: "24"
};

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    country_code TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
    is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
    email_verified_at TEXT,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS platform_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    effective_from TEXT NOT NULL,
    effective_until TEXT,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(key, scope, effective_from)
  );

  CREATE INDEX IF NOT EXISTS platform_policies_active_idx
    ON platform_policies(scope, key, effective_from, effective_until);

  CREATE TABLE IF NOT EXISTS deployment_hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname TEXT NOT NULL UNIQUE,
    region TEXT NOT NULL,
    cpu_capacity INTEGER NOT NULL DEFAULT 1,
    memory_capacity_mb INTEGER NOT NULL DEFAULT 2048,
    disk_capacity_bytes INTEGER NOT NULL DEFAULT 0,
    instance_count INTEGER NOT NULL DEFAULT 0,
    next_port INTEGER NOT NULL DEFAULT 3100,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'draining', 'offline')),
    last_heartbeat_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hosted_stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    public_id TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    hostname TEXT NOT NULL UNIQUE,
    deployment_host_id INTEGER REFERENCES deployment_hosts(id),
    runtime_instance_id TEXT UNIQUE,
    runtime_port INTEGER,
    image_version TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'provisioning' CHECK (state IN ('provisioning', 'running', 'expired', 'suspended', 'failed', 'deleting', 'deleted')),
    mode TEXT NOT NULL DEFAULT 'free' CHECK (mode IN ('free', 'paid', 'comped')),
    created_at TEXT NOT NULL,
    current_period_ends_at TEXT NOT NULL,
    feed_url TEXT NOT NULL DEFAULT '',
    grace_ends_at TEXT,
    deletion_scheduled_at TEXT,
    storage_bytes INTEGER NOT NULL DEFAULT 0,
    marketplace_opted_out INTEGER NOT NULL DEFAULT 0 CHECK (marketplace_opted_out IN (0, 1)),
    provision_attempts INTEGER NOT NULL DEFAULT 0,
    last_provision_error TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS hosted_stores_user_idx ON hosted_stores(user_id, state, mode);
  CREATE INDEX IF NOT EXISTS hosted_stores_lifecycle_idx ON hosted_stores(state, current_period_ends_at, grace_ends_at);

  CREATE TABLE IF NOT EXISTS store_entitlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES hosted_stores(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('campaign', 'coupon', 'payment', 'admin_comp', 'manual_override', 'migration')),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT,
    reason TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS store_entitlements_active_idx
    ON store_entitlements(store_id, key, starts_at, ends_at, id);

  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    store_id INTEGER REFERENCES hosted_stores(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended')),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    eligibility_rule TEXT NOT NULL DEFAULT '{}',
    overrides TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS campaigns_active_idx ON campaigns(status, starts_at, ends_at);

  CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    max_redemptions INTEGER,
    per_account_limit INTEGER NOT NULL DEFAULT 1,
    eligibility_rule TEXT NOT NULL DEFAULT '{}',
    entitlement_payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store_id INTEGER REFERENCES hosted_stores(id) ON DELETE SET NULL,
    redeemed_at TEXT NOT NULL,
    UNIQUE(coupon_id, user_id, store_id)
  );

  CREATE INDEX IF NOT EXISTS coupon_redemptions_user_idx ON coupon_redemptions(coupon_id, user_id, redeemed_at);

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store_id INTEGER REFERENCES hosted_stores(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('store_extension', 'promotion')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
    provider_reference TEXT UNIQUE,
    entitlement_days INTEGER,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    paid_at TEXT,
    refunded_at TEXT
  );

  CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS search_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES hosted_stores(id) ON DELETE CASCADE,
    remote_listing_id TEXT NOT NULL,
    store_name TEXT NOT NULL,
    title TEXT NOT NULL,
    description_excerpt TEXT NOT NULL DEFAULT '',
    price_minor INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    category TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    condition TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'available',
    country_code TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    area TEXT NOT NULL DEFAULT '',
    display_location TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    canonical_url TEXT NOT NULL,
    thumbnail_url TEXT,
    source_updated_at TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    promotion_score INTEGER NOT NULL DEFAULT 0,
    moderation_status TEXT NOT NULL DEFAULT 'active' CHECK (moderation_status IN ('active', 'reported', 'blocked')),
    UNIQUE(store_id, remote_listing_id)
  );

  CREATE INDEX IF NOT EXISTS search_listings_filter_idx ON search_listings(status, moderation_status, city, category, price_minor);
  CREATE INDEX IF NOT EXISTS search_listings_store_idx ON search_listings(store_id, source_updated_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS search_listings_fts USING fts5(
    title, description_excerpt, category, tags,
    content='search_listings', content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS search_listings_fts_after_insert
  AFTER INSERT ON search_listings BEGIN
    INSERT INTO search_listings_fts(rowid, title, description_excerpt, category, tags)
    VALUES (new.id, new.title, new.description_excerpt, new.category, new.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS search_listings_fts_after_update
  AFTER UPDATE OF title, description_excerpt, category, tags ON search_listings BEGIN
    INSERT INTO search_listings_fts(search_listings_fts, rowid, title, description_excerpt, category, tags)
    VALUES ('delete', old.id, old.title, old.description_excerpt, old.category, old.tags);
    INSERT INTO search_listings_fts(rowid, title, description_excerpt, category, tags)
    VALUES (new.id, new.title, new.description_excerpt, new.category, new.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS search_listings_fts_after_delete
  AFTER DELETE ON search_listings BEGIN
    INSERT INTO search_listings_fts(search_listings_fts, rowid, title, description_excerpt, category, tags)
    VALUES ('delete', old.id, old.title, old.description_excerpt, old.category, old.tags);
  END;

  CREATE TABLE IF NOT EXISTS promotion_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES hosted_stores(id) ON DELETE CASCADE,
    listing_id INTEGER,
    promotion_type TEXT NOT NULL CHECK (promotion_type IN ('feature_listing', 'feature_store', 'category_boost', 'local_area_boost')),
    amount_minor INTEGER NOT NULL DEFAULT 0,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'expired', 'cancelled')),
    payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS promotions_active_idx ON promotion_purchases(status, starts_at, ends_at, store_id, listing_id);

  CREATE TABLE IF NOT EXISTS marketplace_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    search_listing_id INTEGER REFERENCES search_listings(id) ON DELETE SET NULL,
    store_id INTEGER REFERENCES hosted_stores(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('impression', 'click', 'report')),
    visitor_key TEXT NOT NULL DEFAULT '',
    referrer TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS marketplace_events_listing_idx
    ON marketplace_events(search_listing_id, event_type, created_at DESC);
  CREATE INDEX IF NOT EXISTS marketplace_events_created_idx
    ON marketplace_events(created_at DESC);

  CREATE TABLE IF NOT EXISTS moderation_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER REFERENCES hosted_stores(id) ON DELETE SET NULL,
    search_listing_id INTEGER REFERENCES search_listings(id) ON DELETE SET NULL,
    reporter_email TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT
  );

  CREATE INDEX IF NOT EXISTS moderation_reports_status_idx ON moderation_reports(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS blocklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('email', 'domain', 'phrase', 'ip')),
    value TEXT NOT NULL COLLATE NOCASE,
    reason TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(kind, value)
  );

  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx ON email_verification_tokens(user_id, expires_at);
`;

export function nowIso() {
  return new Date().toISOString();
}

export function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString();
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "yardsale-cloud.db"));
  db.exec(schema);
  ensureColumn(db, "users", "country_code", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "hosted_stores", "name", "TEXT NOT NULL DEFAULT 'Store'");
  ensureColumn(db, "hosted_stores", "feed_url", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "deployment_hosts", "next_port", "INTEGER NOT NULL DEFAULT 3100");
  ensureColumn(db, "hosted_stores", "runtime_port", "INTEGER");
  ensureColumn(db, "hosted_stores", "provision_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "hosted_stores", "last_provision_error", "TEXT");
  db.exec("INSERT INTO search_listings_fts(search_listings_fts) VALUES ('rebuild')");

  const now = nowIso();
  for (const [key, value] of Object.entries(DEFAULT_POLICY_VALUES)) {
    db.prepare(`
      INSERT INTO platform_policies (key, value, scope, effective_from, updated_by, updated_at)
      SELECT ?, ?, 'global', '1970-01-01T00:00:00.000Z', 'system', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM platform_policies WHERE key = ? AND scope = 'global'
      )
    `).run(key, value, now, key);
  }

  db.prepare(`
    INSERT INTO deployment_hosts (
      hostname, region, cpu_capacity, memory_capacity_mb, disk_capacity_bytes,
      instance_count, next_port, status, last_heartbeat_at, created_at
    )
    SELECT 'local', 'local', 1, 2048, 0, 0, 3100, 'ready', ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM deployment_hosts WHERE hostname = 'local')
  `).run(now, now);

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

export function countUsers(db) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM users").get().count);
}

export function createUser(db, { email, passwordHash, countryCode = "", isAdmin = false }) {
  const now = nowIso();
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, country_code, is_admin, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(email, passwordHash, countryCode, isAdmin ? 1 : 0, now);
  return getUserById(db, Number(result.lastInsertRowid));
}

export function getUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function getUserByEmail(db, email) {
  return db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email);
}

export function touchUserLogin(db, userId) {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), userId);
}

export function setUserStatus(db, userId, status, actor = "system") {
  if (!["active", "suspended", "deleted"].includes(status)) throw new Error("Invalid account status.");
  return transaction(db, () => {
    const user = getUserById(db, userId);
    if (!user) throw new Error("Account not found.");
    db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
    if (status !== "active") db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    createAuditEvent(db, { actor, userId, action: "account.status_changed", metadata: { previous_status: user.status, status } });
    return getUserById(db, userId);
  });
}

export function listPlatformPolicies(db) {
  return db.prepare(`
    SELECT * FROM platform_policies
    WHERE scope = 'global'
    ORDER BY key ASC, effective_from DESC, id DESC
  `).all();
}

export function setPlatformPolicy(db, { key, value, actor }) {
  const now = nowIso();
  return transaction(db, () => {
    const current = db.prepare(`
      SELECT id FROM platform_policies
      WHERE key = ? AND scope = 'global' AND effective_until IS NULL
      ORDER BY effective_from DESC, id DESC LIMIT 1
    `).get(key);

    if (current) {
      db.prepare(`
        UPDATE platform_policies SET value = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
      `).run(String(value), actor, now, current.id);
      return db.prepare("SELECT * FROM platform_policies WHERE id = ?").get(current.id);
    }

    const result = db.prepare(`
      INSERT INTO platform_policies (key, value, scope, effective_from, updated_by, updated_at)
      VALUES (?, ?, 'global', ?, ?, ?)
    `).run(key, String(value), now, actor, now);
    return db.prepare("SELECT * FROM platform_policies WHERE id = ?").get(Number(result.lastInsertRowid));
  });
}

export function getDefaultDeploymentHost(db) {
  return db.prepare(`
    SELECT * FROM deployment_hosts
    WHERE status = 'ready'
    ORDER BY instance_count ASC, id ASC LIMIT 1
  `).get();
}

export function makeUniqueSlug(db, value) {
  const base = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "store";

  let candidate = base;
  let suffix = 2;
  while (db.prepare("SELECT id FROM hosted_stores WHERE slug = ?").get(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function countActiveFreeStores(db, userId) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM hosted_stores
    WHERE user_id = ? AND mode = 'free'
      AND state IN ('provisioning', 'running', 'suspended')
  `).get(userId).count);
}

export function createHostedStore(db, {
  userId,
  slug,
  name = slug,
  hostname,
  feedUrl = "",
  imageVersion,
  freeDays,
  mode = "free"
}) {
  const now = nowIso();
  const host = getDefaultDeploymentHost(db);
  const runtimePort = host?.next_port ?? null;
  const publicId = randomUUID();
  const result = db.prepare(`
    INSERT INTO hosted_stores (
      user_id, name, public_id, slug, hostname, deployment_host_id, runtime_port, feed_url, image_version,
      state, mode, created_at, current_period_ends_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?)
  `).run(
    userId,
    name,
    publicId,
    slug,
    hostname,
    host?.id ?? null,
    runtimePort,
    feedUrl || `https://${hostname}/api/federation/v1/listings`,
    imageVersion,
    mode,
    now,
    addDays(now, freeDays),
    now
  );
  if (host) {
    db.prepare("UPDATE deployment_hosts SET instance_count = instance_count + 1, next_port = next_port + 1, last_heartbeat_at = ? WHERE id = ?")
      .run(now, host.id);
  }
  return getHostedStore(db, Number(result.lastInsertRowid));
}

export function getHostedStore(db, id) {
  return db.prepare(`
    SELECT hosted_stores.*, users.email AS owner_email, deployment_hosts.hostname AS deployment_host
    FROM hosted_stores
    JOIN users ON users.id = hosted_stores.user_id
    LEFT JOIN deployment_hosts ON deployment_hosts.id = hosted_stores.deployment_host_id
    WHERE hosted_stores.id = ?
  `).get(id);
}

export function getHostedStoreByPublicId(db, publicId) {
  return db.prepare(`
    SELECT hosted_stores.*, users.email AS owner_email, deployment_hosts.hostname AS deployment_host
    FROM hosted_stores
    JOIN users ON users.id = hosted_stores.user_id
    LEFT JOIN deployment_hosts ON deployment_hosts.id = hosted_stores.deployment_host_id
    WHERE hosted_stores.public_id = ?
  `).get(publicId);
}

export function getHostedStoreForUser(db, id, userId) {
  return db.prepare(`
    SELECT hosted_stores.*, users.email AS owner_email, deployment_hosts.hostname AS deployment_host
    FROM hosted_stores
    JOIN users ON users.id = hosted_stores.user_id
    LEFT JOIN deployment_hosts ON deployment_hosts.id = hosted_stores.deployment_host_id
    WHERE hosted_stores.id = ? AND hosted_stores.user_id = ?
  `).get(id, userId);
}

export function listHostedStoresForUser(db, userId) {
  return db.prepare(`
    SELECT hosted_stores.*, deployment_hosts.hostname AS deployment_host
    FROM hosted_stores
    LEFT JOIN deployment_hosts ON deployment_hosts.id = hosted_stores.deployment_host_id
    WHERE hosted_stores.user_id = ?
    ORDER BY CASE hosted_stores.state WHEN 'running' THEN 0 WHEN 'provisioning' THEN 1 WHEN 'suspended' THEN 2 WHEN 'expired' THEN 3 ELSE 4 END,
      hosted_stores.created_at DESC, hosted_stores.id DESC
  `).all(userId);
}

export function listHostedStores(db) {
  return db.prepare(`
    SELECT hosted_stores.*, users.email AS owner_email, deployment_hosts.hostname AS deployment_host
    FROM hosted_stores
    JOIN users ON users.id = hosted_stores.user_id
    LEFT JOIN deployment_hosts ON deployment_hosts.id = hosted_stores.deployment_host_id
    ORDER BY hosted_stores.created_at DESC, hosted_stores.id DESC
  `).all();
}

export function listDeploymentHosts(db) {
  return db.prepare("SELECT * FROM deployment_hosts ORDER BY status ASC, hostname ASC").all();
}

export function setStoreHost(db, id, hostId) {
  db.prepare("UPDATE hosted_stores SET deployment_host_id = ?, updated_at = ? WHERE id = ?").run(hostId, nowIso(), id);
  return getHostedStore(db, id);
}

export function setStoreRuntime(db, id, { runtimeInstanceId, state = "running" }) {
  db.prepare(`
    UPDATE hosted_stores SET runtime_instance_id = ?, state = ?, last_provision_error = NULL, updated_at = ? WHERE id = ?
  `).run(runtimeInstanceId, state, nowIso(), id);
  return getHostedStore(db, id);
}

export function recordProvisionAttempt(db, id, error = null) {
  db.prepare(`
    UPDATE hosted_stores SET provision_attempts = provision_attempts + 1,
      last_provision_error = ?, updated_at = ? WHERE id = ?
  `).run(error ? String(error).slice(0, 1000) : null, nowIso(), id);
  return getHostedStore(db, id);
}

export function setStoreState(db, id, state) {
  db.prepare("UPDATE hosted_stores SET state = ?, updated_at = ? WHERE id = ?").run(state, nowIso(), id);
  return getHostedStore(db, id);
}

export function moveStoreHost(db, id, hostId) {
  return transaction(db, () => {
    const store = getHostedStore(db, id);
    const destination = db.prepare("SELECT * FROM deployment_hosts WHERE id = ? AND status = 'ready'").get(hostId);
    if (!store || !destination) throw new Error("Store or destination host not found.");
    if (store.deployment_host_id === destination.id) return store;
    const now = nowIso();
    if (store.deployment_host_id) {
      db.prepare("UPDATE deployment_hosts SET instance_count = MAX(0, instance_count - 1) WHERE id = ?")
        .run(store.deployment_host_id);
    }
    const runtimePort = destination.next_port;
    db.prepare("UPDATE deployment_hosts SET instance_count = instance_count + 1, next_port = next_port + 1, last_heartbeat_at = ? WHERE id = ?")
      .run(now, destination.id);
    db.prepare("UPDATE hosted_stores SET deployment_host_id = ?, runtime_port = ?, updated_at = ? WHERE id = ?")
      .run(destination.id, runtimePort, now, id);
    return getHostedStore(db, id);
  });
}

export function releaseHostSlot(db, store) {
  if (!store?.id) return;
  transaction(db, () => {
    const current = db.prepare("SELECT deployment_host_id FROM hosted_stores WHERE id = ?").get(store.id);
    if (!current?.deployment_host_id) return;
    db.prepare("UPDATE deployment_hosts SET instance_count = MAX(0, instance_count - 1) WHERE id = ?")
      .run(current.deployment_host_id);
    db.prepare("UPDATE hosted_stores SET deployment_host_id = NULL, runtime_port = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), store.id);
  });
}

export function extendStorePeriod(db, id, { days, mode = "comped", source = "admin_comp", reason, actor }) {
  const store = getHostedStore(db, id);
  if (!store) throw new Error("Store not found");
  if (["deleting", "deleted"].includes(store.state)) throw new Error("This store is past its retention window.");
  const now = nowIso();
  const currentEnd = Date.parse(store.current_period_ends_at);
  const start = Math.max(Number.isFinite(currentEnd) ? currentEnd : 0, Date.now());
  const endsAt = new Date(start + Number(days) * 24 * 60 * 60 * 1000).toISOString();

  return transaction(db, () => {
    db.prepare(`
      UPDATE hosted_stores SET
        mode = ?, state = 'running', current_period_ends_at = ?, grace_ends_at = NULL,
        deletion_scheduled_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(mode, endsAt, now, id);
    db.prepare(`
      INSERT INTO store_entitlements (store_id, source, key, value, starts_at, ends_at, reason, created_by, created_at)
      VALUES (?, ?, 'period_extension_days', ?, ?, ?, ?, ?, ?)
    `).run(id, source, String(days), now, endsAt, reason || "", actor, now);
    return getHostedStore(db, id);
  });
}

export function setStoreExpiry(db, id, { endsAt, mode = "comped", reason = "Admin expiry override", actor }) {
  const parsed = Date.parse(endsAt);
  if (!Number.isFinite(parsed)) throw new Error("A valid expiry date is required.");
  const store = getHostedStore(db, id);
  if (!store) throw new Error("Store not found.");
  if (["deleting", "deleted"].includes(store.state)) throw new Error("This store is past its retention window.");
  const now = nowIso();
  return transaction(db, () => {
    db.prepare(`
      UPDATE hosted_stores SET mode = ?, state = ?, current_period_ends_at = ?,
        grace_ends_at = NULL, deletion_scheduled_at = NULL, updated_at = ? WHERE id = ?
    `).run(mode, "running", new Date(parsed).toISOString(), now, id);
    db.prepare(`
      INSERT INTO store_entitlements (store_id, source, key, value, starts_at, ends_at, reason, created_by, created_at)
      VALUES (?, 'manual_override', 'explicit_expiry', ?, ?, ?, ?, ?, ?)
    `).run(id, new Date(parsed).toISOString(), now, new Date(parsed).toISOString(), reason, actor, now);
    createAuditEvent(db, { actor, storeId: id, action: "store.expiry_overridden", metadata: { previous_value: store.current_period_ends_at, new_value: new Date(parsed).toISOString(), reason } });
    return getHostedStore(db, id);
  });
}

export function createStoreEntitlement(db, {
  storeId,
  source,
  key,
  value,
  startsAt = nowIso(),
  endsAt = null,
  reason = "",
  createdBy
}) {
  const result = db.prepare(`
    INSERT INTO store_entitlements (
      store_id, source, key, value, starts_at, ends_at, reason, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(storeId, source, key, String(value), startsAt, endsAt, reason, createdBy, nowIso());
  return db.prepare("SELECT * FROM store_entitlements WHERE id = ?").get(Number(result.lastInsertRowid));
}

export function listStoreEntitlements(db, storeId) {
  return db.prepare(`
    SELECT * FROM store_entitlements WHERE store_id = ? ORDER BY created_at DESC, id DESC
  `).all(storeId);
}

export function revokeStoreEntitlement(db, id, actor) {
  return transaction(db, () => {
    const entitlement = db.prepare("SELECT * FROM store_entitlements WHERE id = ?").get(id);
    if (!entitlement) return false;
    db.prepare("DELETE FROM store_entitlements WHERE id = ?").run(id);
    createAuditEvent(db, { actor, storeId: entitlement.store_id, action: "entitlement.revoked", metadata: { entitlement_id: id, key: entitlement.key, previous_value: entitlement.value, reason: entitlement.reason } });
    return true;
  });
}

export function createAuditEvent(db, { actor, userId = null, storeId = null, action, metadata = {} }) {
  const result = db.prepare(`
    INSERT INTO audit_events (actor, user_id, store_id, action, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(actor, userId, storeId, action, JSON.stringify(metadata), nowIso());
  return db.prepare("SELECT * FROM audit_events WHERE id = ?").get(Number(result.lastInsertRowid));
}

export function listAuditEvents(db, { storeId = null, limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  if (storeId === null) {
    return db.prepare(`
      SELECT audit_events.*, users.email AS user_email
      FROM audit_events LEFT JOIN users ON users.id = audit_events.user_id
      ORDER BY audit_events.created_at DESC, audit_events.id DESC LIMIT ${safeLimit}
    `).all();
  }
  return db.prepare(`
    SELECT audit_events.*, users.email AS user_email
    FROM audit_events LEFT JOIN users ON users.id = audit_events.user_id
    WHERE audit_events.store_id = ?
    ORDER BY audit_events.created_at DESC, audit_events.id DESC LIMIT ${safeLimit}
  `).all(storeId);
}

export function listCampaigns(db) {
  return db.prepare("SELECT * FROM campaigns ORDER BY starts_at DESC, id DESC").all();
}

export function createCampaign(db, {
  name,
  status = "draft",
  startsAt,
  endsAt,
  eligibilityRule = {},
  overrides = {},
  createdBy
}) {
  const now = nowIso();
  const result = db.prepare(`
    INSERT INTO campaigns (name, status, starts_at, ends_at, eligibility_rule, overrides, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, status, startsAt, endsAt, JSON.stringify(eligibilityRule), JSON.stringify(overrides), createdBy, now, now);
  return db.prepare("SELECT * FROM campaigns WHERE id = ?").get(Number(result.lastInsertRowid));
}

export function setCampaignStatus(db, id, status) {
  db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
  return db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
}

export function listCoupons(db) {
  return db.prepare("SELECT * FROM coupons ORDER BY ends_at DESC, id DESC").all();
}

export function createCoupon(db, {
  code,
  startsAt,
  endsAt,
  maxRedemptions = null,
  perAccountLimit = 1,
  eligibilityRule = {},
  entitlementPayload = {},
  createdBy
}) {
  const now = nowIso();
  const result = db.prepare(`
    INSERT INTO coupons (
      code, starts_at, ends_at, max_redemptions, per_account_limit,
      eligibility_rule, entitlement_payload, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code.trim().toUpperCase(), startsAt, endsAt, maxRedemptions, perAccountLimit, JSON.stringify(eligibilityRule), JSON.stringify(entitlementPayload), createdBy, now, now);
  return db.prepare("SELECT * FROM coupons WHERE id = ?").get(Number(result.lastInsertRowid));
}

export function getCouponByCode(db, code) {
  return db.prepare("SELECT * FROM coupons WHERE code = ? COLLATE NOCASE").get(String(code || "").trim());
}

function couponRuleMatches(db, rule, userId) {
  if (!rule || Object.keys(rule).length === 0 || rule.all === true) return true;
  const user = db.prepare("SELECT email, country_code FROM users WHERE id = ? AND status = 'active'").get(userId);
  if (!user) return false;
  if (rule.country_code && String(rule.country_code).toUpperCase() !== String(user.country_code || "").toUpperCase()) return false;
  if (rule.email_domain && String(user.email).split("@")[1]?.toLowerCase() !== String(rule.email_domain).toLowerCase()) return false;
  if (rule.email && String(user.email).toLowerCase() !== String(rule.email).toLowerCase()) return false;
  return true;
}

export function redeemCoupon(db, { code, userId, storeId, actor }) {
  const now = nowIso();
  return transaction(db, () => {
    const store = db.prepare("SELECT id, user_id, mode, state, created_at, current_period_ends_at FROM hosted_stores WHERE id = ? AND state NOT IN ('deleted', 'deleting')").get(storeId);
    if (!store || store.user_id !== userId) throw new Error("Store not found.");
    const coupon = getCouponByCode(db, code);
    if (!coupon || coupon.status !== "active" || coupon.starts_at > now || coupon.ends_at <= now) throw new Error("That coupon is not active.");
    let eligibilityRule = {};
    try { eligibilityRule = JSON.parse(coupon.eligibility_rule || "{}"); } catch { throw new Error("The coupon eligibility rule is invalid."); }
    if (!couponRuleMatches(db, eligibilityRule, userId)) throw new Error("This account is not eligible for that coupon.");
    const accountRedemptions = Number(db.prepare("SELECT COUNT(*) AS count FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?").get(coupon.id, userId).count);
    if (accountRedemptions >= coupon.per_account_limit) throw new Error("That coupon has already been used for this account.");
    if (coupon.max_redemptions !== null) {
      const totalRedemptions = Number(db.prepare("SELECT COUNT(*) AS count FROM coupon_redemptions WHERE coupon_id = ?").get(coupon.id).count);
      if (totalRedemptions >= coupon.max_redemptions) throw new Error("That coupon has reached its redemption limit.");
    }
    db.prepare(`
      INSERT INTO coupon_redemptions (coupon_id, user_id, store_id, redeemed_at)
      VALUES (?, ?, ?, ?)
    `).run(coupon.id, userId, storeId, now);
    let payload = {};
    try { payload = JSON.parse(coupon.entitlement_payload || "{}"); } catch { throw new Error("The coupon entitlement is invalid."); }
    for (const [key, value] of Object.entries(payload)) {
      db.prepare(`
        INSERT INTO store_entitlements (store_id, source, key, value, starts_at, ends_at, reason, created_by, created_at)
        VALUES (?, 'coupon', ?, ?, ?, ?, ?, ?, ?)
      `).run(storeId, key, String(value), now, coupon.ends_at, `Coupon ${coupon.code}`, actor, now);
    }
    const freeDays = Number(payload.default_free_days);
    if (store.mode === "free" && Number.isInteger(freeDays) && freeDays > 0 && freeDays <= 3650) {
      const currentEnd = Date.parse(store.current_period_ends_at);
      const couponEnd = Date.parse(addDays(store.created_at, freeDays));
      if (Number.isFinite(couponEnd) && couponEnd > currentEnd) {
        db.prepare("UPDATE hosted_stores SET current_period_ends_at = ?, updated_at = ? WHERE id = ?")
          .run(new Date(couponEnd).toISOString(), now, storeId);
      }
    }
    const extensionDays = Number(payload.period_extension_days);
    if (Number.isInteger(extensionDays) && extensionDays > 0 && extensionDays <= 3650) {
      const end = Date.parse(store.current_period_ends_at);
      const start = Math.max(Number.isFinite(end) ? end : 0, Date.now());
      const endsAt = new Date(start + extensionDays * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`
        UPDATE hosted_stores SET mode = CASE WHEN mode = 'free' THEN 'paid' ELSE mode END,
          state = 'running', current_period_ends_at = ?, grace_ends_at = NULL,
          deletion_scheduled_at = NULL, updated_at = ? WHERE id = ?
      `).run(endsAt, now, storeId);
    }
    createAuditEvent(db, { actor, userId, storeId, action: "coupon.redeemed", metadata: { coupon: coupon.code } });
    return coupon;
  });
}

export function listUsers(db, query = "") {
  const value = String(query || "").trim();
  if (!value) return db.prepare("SELECT * FROM users ORDER BY created_at DESC, id DESC LIMIT 100").all();
  return db.prepare(`
    SELECT * FROM users WHERE email LIKE ? COLLATE NOCASE
    ORDER BY created_at DESC, id DESC LIMIT 100
  `).all(`%${value}%`);
}

export function recordMarketplaceEvent(db, {
  listingId = null,
  storeId = null,
  eventType,
  visitorKey = "",
  referrer = ""
}) {
  if (!["impression", "click", "report"].includes(eventType)) throw new Error("Invalid marketplace event.");
  const result = db.prepare(`
    INSERT INTO marketplace_events (search_listing_id, store_id, event_type, visitor_key, referrer, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(listingId, storeId, eventType, String(visitorKey).slice(0, 120), String(referrer).slice(0, 500), nowIso());
  return Number(result.lastInsertRowid);
}

export function marketplaceEventCounts(db, { since = null } = {}) {
  const rows = since
    ? db.prepare("SELECT event_type, COUNT(*) AS count FROM marketplace_events WHERE created_at >= ? GROUP BY event_type").all(since)
    : db.prepare("SELECT event_type, COUNT(*) AS count FROM marketplace_events GROUP BY event_type").all();
  return Object.fromEntries(rows.map((row) => [row.event_type, Number(row.count)]));
}

export function setStoreMarketplaceOptOut(db, id, optedOut) {
  db.prepare("UPDATE hosted_stores SET marketplace_opted_out = ?, updated_at = ? WHERE id = ?")
    .run(optedOut ? 1 : 0, nowIso(), id);
  return getHostedStore(db, id);
}

export function setStoreImageVersion(db, id, imageVersion) {
  db.prepare("UPDATE hosted_stores SET image_version = ?, updated_at = ? WHERE id = ?")
    .run(imageVersion, nowIso(), id);
  return getHostedStore(db, id);
}

export function markStoreDeleted(db, id) {
  db.prepare("UPDATE hosted_stores SET state = 'deleted', updated_at = ? WHERE id = ?").run(nowIso(), id);
  return getHostedStore(db, id);
}
