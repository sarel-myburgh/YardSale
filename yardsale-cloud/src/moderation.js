import { createAuditEvent, nowIso, transaction } from "./db.js";

export const REPORT_REASONS = ["prohibited_item", "spam", "misleading", "copyright", "other"];
export const BLOCKLIST_KINDS = ["email", "domain", "phrase", "ip"];

function normalize(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

export function reportListing(db, { listingId, reporterEmail = "", reason, details = "" }) {
  if (!REPORT_REASONS.includes(reason)) throw new Error("Choose a valid report reason.");
  const listing = db.prepare("SELECT * FROM search_listings WHERE id = ?").get(listingId);
  if (!listing) throw new Error("Listing not found.");
  const result = db.prepare(`
    INSERT INTO moderation_reports (store_id, search_listing_id, reporter_email, reason, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(listing.store_id, listing.id, normalize(reporterEmail, 240), reason, normalize(details, 2000), nowIso());
  db.prepare("UPDATE search_listings SET moderation_status = 'reported' WHERE id = ? AND moderation_status = 'active'").run(listing.id);
  createAuditEvent(db, { actor: reporterEmail || "anonymous", storeId: listing.store_id, action: "listing.reported", metadata: { listing_id: listing.id, reason } });
  return db.prepare("SELECT * FROM moderation_reports WHERE id = ?").get(Number(result.lastInsertRowid));
}

export function reportStore(db, { storeId, reporterEmail = "", reason, details = "" }) {
  if (!REPORT_REASONS.includes(reason)) throw new Error("Choose a valid report reason.");
  const store = db.prepare("SELECT id FROM hosted_stores WHERE id = ? AND state <> 'deleted'").get(storeId);
  if (!store) throw new Error("Store not found.");
  const result = db.prepare(`
    INSERT INTO moderation_reports (store_id, reporter_email, reason, details, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(storeId, normalize(reporterEmail, 240), reason, normalize(details, 2000), nowIso());
  createAuditEvent(db, { actor: reporterEmail || "anonymous", storeId, action: "store.reported", metadata: { reason } });
  return db.prepare("SELECT * FROM moderation_reports WHERE id = ?").get(Number(result.lastInsertRowid));
}

export function listModerationReports(db, status = "open") {
  const allowed = ["open", "reviewing", "resolved", "dismissed"];
  const filter = allowed.includes(status) ? status : "open";
  return db.prepare(`
    SELECT moderation_reports.*, search_listings.title, search_listings.canonical_url,
      hosted_stores.slug AS store_slug
    FROM moderation_reports
    LEFT JOIN search_listings ON search_listings.id = moderation_reports.search_listing_id
    LEFT JOIN hosted_stores ON hosted_stores.id = moderation_reports.store_id
    WHERE moderation_reports.status = ?
    ORDER BY moderation_reports.created_at ASC, moderation_reports.id ASC
  `).all(filter);
}

export function resolveReport(db, { reportId, status, actor, blockListing = false }) {
  if (!["resolved", "dismissed", "reviewing"].includes(status)) throw new Error("Invalid moderation status.");
  return transaction(db, () => {
    const report = db.prepare("SELECT * FROM moderation_reports WHERE id = ?").get(reportId);
    if (!report) throw new Error("Report not found.");
    const now = nowIso();
    db.prepare(`
      UPDATE moderation_reports SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?
    `).run(status, status === "reviewing" ? null : now, actor, reportId);
    if (blockListing && report.search_listing_id) {
      db.prepare("UPDATE search_listings SET moderation_status = 'blocked' WHERE id = ?").run(report.search_listing_id);
    } else if (status === "dismissed" && report.search_listing_id) {
      const openReports = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM moderation_reports
        WHERE search_listing_id = ? AND status IN ('open', 'reviewing') AND id <> ?
      `).get(report.search_listing_id, reportId).count);
      const listing = db.prepare("SELECT moderation_status FROM search_listings WHERE id = ?").get(report.search_listing_id);
      if (!openReports && listing?.moderation_status === "reported") db.prepare("UPDATE search_listings SET moderation_status = 'active' WHERE id = ?").run(report.search_listing_id);
    }
    createAuditEvent(db, { actor, storeId: report.store_id, action: "moderation.report_resolved", metadata: { report_id: reportId, status, block_listing: Boolean(blockListing) } });
    return db.prepare("SELECT * FROM moderation_reports WHERE id = ?").get(reportId);
  });
}

export function addBlocklistEntry(db, { kind, value, reason = "", createdBy }) {
  if (!BLOCKLIST_KINDS.includes(kind)) throw new Error("Invalid blocklist type.");
  const normalized = normalize(value, 240).toLowerCase();
  if (!normalized) throw new Error("Blocklist value is required.");
  const result = db.prepare(`
    INSERT INTO blocklist (kind, value, reason, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(kind, normalized, normalize(reason, 500), createdBy, nowIso());
  createAuditEvent(db, { actor: createdBy, action: "moderation.blocklist_added", metadata: { kind, value: normalized } });
  return db.prepare("SELECT * FROM blocklist WHERE id = ?").get(Number(result.lastInsertRowid));
}

export function listBlocklist(db) {
  return db.prepare("SELECT * FROM blocklist ORDER BY created_at DESC, id DESC").all();
}

export function blockedAccountReason(db, email) {
  const normalized = normalize(email, 240).toLowerCase();
  const domain = normalized.split("@")[1] || "";
  const match = db.prepare(`
    SELECT kind, value, reason FROM blocklist
    WHERE (kind = 'email' AND value = ?) OR (kind = 'domain' AND value = ?)
    ORDER BY kind ASC LIMIT 1
  `).get(normalized, domain);
  return match ? `${match.kind}: ${match.reason || match.value}` : null;
}

export function blockedIpReason(db, ip) {
  const match = db.prepare("SELECT kind, value, reason FROM blocklist WHERE kind = 'ip' AND value = ?").get(normalize(ip, 120).toLowerCase());
  return match ? `${match.kind}: ${match.reason || match.value}` : null;
}

export function removeBlocklistEntry(db, id, actor) {
  const row = db.prepare("SELECT * FROM blocklist WHERE id = ?").get(id);
  if (!row) return false;
  db.prepare("DELETE FROM blocklist WHERE id = ?").run(id);
  createAuditEvent(db, { actor, action: "moderation.blocklist_removed", metadata: { kind: row.kind, value: row.value } });
  return true;
}

export function applyPhraseBlocklist(db) {
  const phrases = listBlocklist(db).filter((entry) => entry.kind === "phrase").map((entry) => entry.value);
  if (!phrases.length) return 0;
  const listings = db.prepare("SELECT id, title, description_excerpt, tags FROM search_listings WHERE moderation_status <> 'blocked'").all();
  const update = db.prepare("UPDATE search_listings SET moderation_status = 'blocked' WHERE id = ?");
  let blocked = 0;
  for (const listing of listings) {
    const haystack = `${listing.title} ${listing.description_excerpt} ${listing.tags}`.toLowerCase();
    if (phrases.some((phrase) => haystack.includes(phrase))) {
      update.run(listing.id);
      blocked += 1;
    }
  }
  return blocked;
}
