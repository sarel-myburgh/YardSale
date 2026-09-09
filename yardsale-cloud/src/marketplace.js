import { createHmac, timingSafeEqual } from "node:crypto";
import { createAuditEvent, getHostedStore, nowIso, transaction } from "./db.js";
import { isMarketplaceEligible, resolvePolicy } from "./policy.js";

export const INGEST_SIGNATURE_TOLERANCE_SECONDS = 300;

function text(value, max = 5000) {
  return String(value ?? "").trim().slice(0, max);
}

function locationParts(location) {
  if (typeof location === "string") return { countryCode: "", region: "", city: "", area: "", displayLocation: text(location, 240), latitude: null, longitude: null };
  if (!location || typeof location !== "object") return { countryCode: "", region: "", city: "", area: "", displayLocation: "", latitude: null, longitude: null };
  return {
    countryCode: text(location.country_code, 8).toUpperCase(),
    region: text(location.region, 120),
    city: text(location.city, 120),
    area: text(location.area, 120),
    displayLocation: text(location.display_location, 240),
    latitude: Number.isFinite(Number(location.latitude)) ? Number(location.latitude) : null,
    longitude: Number.isFinite(Number(location.longitude)) ? Number(location.longitude) : null
  };
}

function publicUrl(value, max = 1000) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString().slice(0, max) : "";
  } catch {
    return "";
  }
}

function ftsQuery(value) {
  const tokens = text(value, 200).normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

export function ingestSignature(secret, timestamp, body) {
  return `sha256=${createHmac("sha256", String(secret)).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifyIngestSignature(secret, timestamp, body, signature, now = Date.now()) {
  if (!secret || !/^\d+$/.test(String(timestamp || ""))) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > INGEST_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(ingestSignature(secret, seconds, body));
  const actual = Buffer.from(String(signature || ""));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function deindexStore(db, storeId, actor = "system") {
  const changes = Number(db.prepare("DELETE FROM search_listings WHERE store_id = ?").run(storeId).changes);
  if (changes) createAuditEvent(db, { actor, storeId, action: "marketplace.deindexed", metadata: { listings: changes } });
  return changes;
}

export function ingestFederationFeed(db, { storeId, payload, actor = "webhook" }) {
  const store = getHostedStore(db, storeId);
  if (!store) throw new Error("Store not found.");
  if (!payload || payload.protocol !== "yardsale-federation" || Number(payload.version) !== 1) throw new Error("Unsupported federation payload.");
  const policy = resolvePolicy(db, { storeId });
  if (!payload.enabled || !isMarketplaceEligible(store, policy)) {
    deindexStore(db, storeId, actor);
    return { indexed: 0, deindexed: true };
  }
  if (!Array.isArray(payload.listings)) throw new Error("Federation listings must be an array.");

  return transaction(db, () => {
    const now = nowIso();
    const ids = [];
    const upsert = db.prepare(`
      INSERT INTO search_listings (
        store_id, remote_listing_id, store_name, title, description_excerpt, price_minor,
        currency, category, tags, condition, status, country_code, region, city, area,
        display_location, latitude, longitude, canonical_url, thumbnail_url,
        source_updated_at, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(store_id, remote_listing_id) DO UPDATE SET
        store_name = excluded.store_name, title = excluded.title,
        description_excerpt = excluded.description_excerpt, price_minor = excluded.price_minor,
        currency = excluded.currency, category = excluded.category, tags = excluded.tags,
        condition = excluded.condition, status = excluded.status, country_code = excluded.country_code,
        region = excluded.region, city = excluded.city, area = excluded.area,
        display_location = excluded.display_location, latitude = excluded.latitude,
        longitude = excluded.longitude, canonical_url = excluded.canonical_url,
        thumbnail_url = excluded.thumbnail_url, source_updated_at = excluded.source_updated_at,
        indexed_at = excluded.indexed_at
    `);
    for (const listing of payload.listings) {
      const remoteId = text(listing.listing_id, 120);
      const title = text(listing.title, 180);
      if (!remoteId || !title) continue;
      const location = locationParts(listing.location);
      const updatedAt = text(listing.updated_at || listing.created_at || payload.updated_at, 40) || now;
      const tags = Array.isArray(listing.tags) ? listing.tags.map((tag) => text(tag, 40)).filter(Boolean).join(", ") : text(listing.tags, 500);
      const priceMinor = Number(listing.price_minor);
      const status = text(listing.status || "available", 30).toLowerCase();
      const canonicalUrl = publicUrl(listing.canonical_url);
      if (!Number.isSafeInteger(priceMinor) || priceMinor < 0 || !["available", "held", "reserved", "sold", "hidden"].includes(status) || !canonicalUrl) continue;
      upsert.run(
        storeId, remoteId, text(listing.store_name || store.name, 160), title,
        text(listing.description, 280), priceMinor,
        text(listing.currency || "USD", 3).toUpperCase(), text(listing.category, 100), tags,
        text(listing.condition, 80), status, location.countryCode,
        location.region, location.city, location.area, location.displayLocation,
        location.latitude, location.longitude, canonicalUrl, listing.thumbnail_url ? publicUrl(listing.thumbnail_url) || null : null,
        updatedAt, now
      );
      ids.push(remoteId);
    }
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM search_listings WHERE store_id = ? AND remote_listing_id NOT IN (${placeholders})`).run(storeId, ...ids);
    } else {
      db.prepare("DELETE FROM search_listings WHERE store_id = ?").run(storeId);
    }
    createAuditEvent(db, { actor, storeId, action: "marketplace.ingested", metadata: { indexed: ids.length } });
    return { indexed: ids.length, deindexed: false };
  });
}

export function searchMarketplace(db, {
  query = "",
  q = "",
  country = "",
  city = "",
  area = "",
  category = "",
  condition = "",
  minPriceMinor = null,
  maxPriceMinor = null,
  currency = "",
  sort = "relevance",
  limit = 60
} = {}) {
  const clauses = [
    "users.status = 'active'",
    "hosted_stores.state = 'running'",
    "search_listings.status NOT IN ('sold', 'hidden')",
    "search_listings.moderation_status = 'active'"
  ];
  const params = [];
  const search = ftsQuery(query || q);
  if (search) {
    clauses.push("search_listings.id IN (SELECT rowid FROM search_listings_fts WHERE search_listings_fts MATCH ?)");
    params.push(search);
  }
  for (const [column, value] of [["country_code", country], ["city", city], ["area", area], ["category", category], ["condition", condition], ["currency", currency]]) {
    if (String(value || "").trim()) {
      clauses.push(`search_listings.${column} = ? COLLATE NOCASE`);
      params.push(String(value).trim());
    }
  }
  if (Number.isSafeInteger(minPriceMinor) && minPriceMinor >= 0) { clauses.push("search_listings.price_minor >= ?"); params.push(minPriceMinor); }
  if (Number.isSafeInteger(maxPriceMinor) && maxPriceMinor >= 0) { clauses.push("search_listings.price_minor <= ?"); params.push(maxPriceMinor); }
  const order = sort === "newest"
    ? "search_listings.source_updated_at DESC, search_listings.id DESC"
    : sort === "price-asc"
      ? "search_listings.price_minor ASC, search_listings.source_updated_at DESC"
      : sort === "price-desc"
        ? "search_listings.price_minor DESC, search_listings.source_updated_at DESC"
        : `${search ? "bm25(search_listings_fts) ASC, " : ""}search_listings.promotion_score DESC, ((search_listings.id + CAST(strftime('%H', 'now') AS INTEGER)) % 17) ASC, search_listings.source_updated_at DESC, search_listings.id DESC`;
  const ftsJoin = search ? "JOIN search_listings_fts ON search_listings_fts.rowid = search_listings.id" : "";
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 60));
  const rows = db.prepare(`
    SELECT search_listings.*, ${search ? "bm25(search_listings_fts)" : "0"} AS text_rank, hosted_stores.slug AS store_slug, hosted_stores.hostname,
      hosted_stores.mode AS store_mode, hosted_stores.state AS state, hosted_stores.marketplace_opted_out
    FROM search_listings ${ftsJoin} JOIN hosted_stores ON hosted_stores.id = search_listings.store_id
      JOIN users ON users.id = hosted_stores.user_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY ${order} LIMIT ${safeLimit}
  `).all(...params);
  return rows.filter((row) => isMarketplaceEligible(row, resolvePolicy(db, { storeId: row.store_id })));
}

export function getMarketplaceListing(db, id) {
  return db.prepare(`
    SELECT search_listings.*, hosted_stores.slug AS store_slug, hosted_stores.hostname,
      hosted_stores.mode AS store_mode, hosted_stores.state AS store_state,
      hosted_stores.marketplace_opted_out
    FROM search_listings JOIN hosted_stores ON hosted_stores.id = search_listings.store_id
      JOIN users ON users.id = hosted_stores.user_id AND users.status = 'active'
    WHERE search_listings.id = ?
  `).get(id);
}

export function marketplaceFacets(db) {
  const values = (column) => db.prepare(`
    SELECT DISTINCT search_listings.${column} AS value FROM search_listings
    JOIN hosted_stores ON hosted_stores.id = search_listings.store_id
    JOIN users ON users.id = hosted_stores.user_id
    WHERE users.status = 'active' AND hosted_stores.state = 'running'
      AND search_listings.status NOT IN ('sold', 'hidden')
      AND search_listings.moderation_status = 'active'
      AND TRIM(search_listings.${column}) <> '' ORDER BY search_listings.${column} COLLATE NOCASE
  `).all().map((row) => row.value);
  return {
    countries: values("country_code"),
    cities: values("city"),
    areas: values("area"),
    categories: values("category"),
    conditions: values("condition"),
    currencies: values("currency")
  };
}

export function refreshPromotionScores(db, at = new Date()) {
  const now = at instanceof Date ? at.toISOString() : String(at);
  const listings = db.prepare("SELECT id, store_id FROM search_listings").all();
  const promotions = db.prepare(`
    SELECT * FROM promotion_purchases
    WHERE status = 'active' AND starts_at <= ? AND ends_at > ?
  `).all(now, now);
  const weights = { feature_listing: 100, feature_store: 60, category_boost: 30, local_area_boost: 20 };
  const update = db.prepare("UPDATE search_listings SET promotion_score = ? WHERE id = ?");
  for (const listing of listings) {
    const score = promotions
      .filter((promotion) => promotion.store_id === listing.store_id && (promotion.listing_id === null || promotion.listing_id === listing.id))
      .reduce((sum, promotion) => sum + (weights[promotion.promotion_type] || 0), 0);
    update.run(score, listing.id);
  }
  return listings.length;
}

export async function reconcileStoreFeed(db, { storeId, fetchImpl = fetch, actor = "reconciler" }) {
  const store = getHostedStore(db, storeId);
  if (!store || !store.feed_url) throw new Error("Store feed is not configured.");
  const response = await fetchImpl(store.feed_url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Feed returned ${response.status}.`);
  return ingestFederationFeed(db, { storeId, payload: await response.json(), actor });
}
