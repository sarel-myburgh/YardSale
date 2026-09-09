import { createAuditEvent } from "./db.js";

export const POLICY_KEYS = [
  "default_free_days",
  "default_paid_days",
  "default_store_price_minor",
  "default_grace_days",
  "free_active_store_limit",
  "paid_marketplace_enabled",
  "store_image_version",
  "storage_quota_bytes",
  "listing_limit",
  "promotion_feature_listing_price_minor",
  "promotion_feature_store_price_minor",
  "promotion_duration_hours",
  "marketplace_enabled"
];

const POLICY_TYPES = {
  default_free_days: "positiveInteger",
  default_paid_days: "positiveInteger",
  default_store_price_minor: "nonNegativeInteger",
  default_grace_days: "positiveInteger",
  free_active_store_limit: "positiveInteger",
  paid_marketplace_enabled: "boolean",
  store_image_version: "text",
  storage_quota_bytes: "nonNegativeInteger",
  listing_limit: "positiveInteger",
  promotion_feature_listing_price_minor: "nonNegativeInteger",
  promotion_feature_store_price_minor: "nonNegativeInteger",
  promotion_duration_hours: "positiveInteger",
  marketplace_enabled: "boolean"
};

const ENTITLEMENT_PRIORITY = {
  migration: 0,
  campaign: 10,
  coupon: 20,
  payment: 30,
  admin_comp: 40,
  manual_override: 50
};

function parsePolicyValue(key, value) {
  const type = POLICY_TYPES[key] || "text";
  if (type === "boolean") return String(value).toLowerCase() === "true";
  if (type === "positiveInteger" || type === "nonNegativeInteger") return Number(value);
  return String(value);
}

function jsonValue(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function ruleMatches(db, rule, userId) {
  if (!rule || Object.keys(rule).length === 0 || rule.all === true) return true;
  if (!userId) return false;
  const user = db.prepare("SELECT email, country_code FROM users WHERE id = ?").get(userId);
  if (!user) return false;
  if (rule.country_code && String(rule.country_code).toUpperCase() !== String(user.country_code || "").toUpperCase()) return false;
  if (rule.email_domain && String(user.email).split("@")[1]?.toLowerCase() !== String(rule.email_domain).toLowerCase()) return false;
  if (rule.email && String(user.email).toLowerCase() !== String(rule.email).toLowerCase()) return false;
  return true;
}

export function validatePolicyValue(key, value) {
  if (!POLICY_KEYS.includes(key)) throw new Error("That policy is not editable.");
  const type = POLICY_TYPES[key];
  const text = String(value ?? "").trim();
  if (type === "boolean") {
    if (text !== "true" && text !== "false") throw new Error("Use true or false.");
    return text;
  }
  if (type === "positiveInteger") {
    if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 3650) throw new Error("Use a whole number from 1 to 3650.");
    return text;
  }
  if (type === "nonNegativeInteger") {
    if (!/^\d+$/.test(text) || Number(text) > 100000000) throw new Error("Use a non-negative whole number.");
    return text;
  }
  if (!text || text.length > 160) throw new Error("Use a short non-empty value.");
  return text;
}

export function resolvePolicy(db, { storeId = null, userId = null, at = new Date() } = {}) {
  const timestamp = at instanceof Date ? at.toISOString() : String(at);
  const policy = {};
  const globalRows = db.prepare(`
    SELECT key, value FROM platform_policies
    WHERE scope = 'global' AND effective_from <= ?
      AND (effective_until IS NULL OR effective_until > ?)
    ORDER BY effective_from DESC, id DESC
  `).all(timestamp, timestamp);

  for (const row of globalRows) {
    if (!(row.key in policy)) policy[row.key] = parsePolicyValue(row.key, row.value);
  }

  const storeUserId = storeId === null
    ? userId
    : db.prepare("SELECT user_id FROM hosted_stores WHERE id = ?").get(storeId)?.user_id || userId;
  const campaigns = db.prepare(`
    SELECT * FROM campaigns
    WHERE status = 'active' AND starts_at <= ? AND ends_at > ?
    ORDER BY id ASC
  `).all(timestamp, timestamp);
  for (const campaign of campaigns) {
    if (!ruleMatches(db, jsonValue(campaign.eligibility_rule), storeUserId)) continue;
    const overrides = jsonValue(campaign.overrides);
    for (const [key, value] of Object.entries(overrides)) {
      if (POLICY_KEYS.includes(key)) policy[key] = parsePolicyValue(key, value);
    }
  }

  if (storeId !== null) {
    const entitlements = db.prepare(`
      SELECT * FROM store_entitlements
      WHERE store_id = ? AND starts_at <= ?
        AND (ends_at IS NULL OR ends_at > ?)
      ORDER BY id ASC
    `).all(storeId, timestamp, timestamp);
    const chosen = new Map();
    for (const entitlement of entitlements) {
      if (!POLICY_KEYS.includes(entitlement.key)) continue;
      const priority = ENTITLEMENT_PRIORITY[entitlement.source] ?? 0;
      const current = chosen.get(entitlement.key);
      if (!current || priority > current.priority || (priority === current.priority && entitlement.id > current.id)) {
        chosen.set(entitlement.key, { priority, value: entitlement.value });
      }
    }
    for (const [key, value] of chosen) policy[key] = parsePolicyValue(key, value.value);
  }

  return policy;
}

export function isMarketplaceEligible(store, policy) {
  const state = store?.state || store?.store_state;
  const mode = store?.mode || store?.store_mode;
  if (!store || state !== "running" || store.marketplace_opted_out) return false;
  if (typeof policy.marketplace_enabled === "boolean") return policy.marketplace_enabled;
  return mode !== "free" && policy.paid_marketplace_enabled === true;
}

export function reconcileLifecycle(db, at = new Date()) {
  const timestamp = at instanceof Date ? at : new Date(at);
  const now = timestamp.toISOString();
  let changed = 0;

  const running = db.prepare(`
    SELECT * FROM hosted_stores
    WHERE state = 'running' AND current_period_ends_at <= ?
  `).all(now);
  for (const store of running) {
    const policy = resolvePolicy(db, { storeId: store.id, at: timestamp });
    const graceDays = Number(policy.default_grace_days) || 14;
    const periodEnd = Date.parse(store.current_period_ends_at);
    const graceEndsAt = new Date((Number.isFinite(periodEnd) ? periodEnd : timestamp.getTime()) + graceDays * 24 * 60 * 60 * 1000).toISOString();
    if (graceEndsAt <= now) {
      db.prepare(`
        UPDATE hosted_stores SET state = 'deleting', grace_ends_at = ?, deletion_scheduled_at = ?, updated_at = ? WHERE id = ?
      `).run(graceEndsAt, now, now, store.id);
      createAuditEvent(db, {
        actor: "system",
        userId: store.user_id,
        storeId: store.id,
        action: "store.deletion_scheduled",
        metadata: { scheduled_at: now, grace_ends_at: graceEndsAt }
      });
    } else {
      db.prepare(`
        UPDATE hosted_stores SET state = 'expired', grace_ends_at = ?, updated_at = ? WHERE id = ?
      `).run(graceEndsAt, now, store.id);
      createAuditEvent(db, {
        actor: "system",
        userId: store.user_id,
        storeId: store.id,
        action: "store.expired",
        metadata: { grace_ends_at: graceEndsAt }
      });
    }
    changed += 1;
  }

  const graceExpired = db.prepare(`
    SELECT * FROM hosted_stores
    WHERE state = 'expired' AND grace_ends_at IS NOT NULL AND grace_ends_at <= ?
  `).all(now);
  for (const store of graceExpired) {
    db.prepare(`
      UPDATE hosted_stores SET state = 'deleting', deletion_scheduled_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, store.id);
    createAuditEvent(db, {
      actor: "system",
      userId: store.user_id,
      storeId: store.id,
      action: "store.deletion_scheduled",
      metadata: { scheduled_at: now }
    });
    changed += 1;
  }

  return changed;
}
