import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createAuditEvent, getHostedStore, getHostedStoreForUser, nowIso, transaction } from "./db.js";
import { resolvePolicy } from "./policy.js";
import { refreshPromotionScores } from "./marketplace.js";

const PROMOTION_TYPES = new Set(["feature_listing", "feature_store", "category_boost", "local_area_boost"]);

// The business logic only depends on this small provider contract. A real gateway
// can implement the same methods without changing store lifecycle code.
export class BillingProvider {
  constructor(name) { this.name = name; }
  createCheckout() { throw new Error(`${this.name} checkout is not configured.`); }
  verifyWebhook() { return false; }
  recordPayment() { throw new Error(`${this.name} payment recording is not configured.`); }
  recordWebhook() { throw new Error(`${this.name} webhook recording is not configured.`); }
  grantEntitlement() { throw new Error(`${this.name} entitlement grants are not configured.`); }
  refundPayment() { throw new Error(`${this.name} refunds are not configured.`); }
  getPaymentStatus() { throw new Error(`${this.name} payment status is not configured.`); }
}

export class MockPaymentProvider extends BillingProvider {
  constructor({ secret = "local-webhook-secret" } = {}) {
    super("mock");
    this.secret = secret;
  }

  createCheckout(db, details) { return createCheckout(db, details); }
  verifyWebhook(body, signature) { return verifyMockWebhook(this.secret, body, signature); }
  recordPayment(db, paymentId, actor = "mock-provider") { return completeMockPayment(db, paymentId, actor); }
  refundPayment(db, paymentId, actor = "mock-provider") { return refundPayment(db, paymentId, actor); }
  getPaymentStatus(db, paymentId) { return getPayment(db, paymentId); }
}

export class AbaPayWayProvider extends BillingProvider {
  constructor({ merchantId = "", apiKey = "", baseUrl = "https://checkout.payway.com.kh" } = {}) {
    super("aba-payway");
    this.merchantId = merchantId;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  get configured() { return Boolean(this.merchantId && this.apiKey); }

  createCheckout(db, details) {
    if (!this.configured) {
      throw new Error("ABA PayWay is not configured; set YARDSALE_CLOUD_ABA_MERCHANT_ID and YARDSALE_CLOUD_ABA_API_KEY.");
    }
    const payment = createCheckout(db, {
      ...details,
      provider: this.name,
      currency: "USD",
      providerReference: `ys${randomUUID().replaceAll("-", "").slice(0, 18)}`
    });
    const user = db.prepare("SELECT email FROM users WHERE id = ?").get(payment.user_id);
    const store = getHostedStore(db, payment.store_id);
    const checkout = paywayPurchaseForm({
      payment,
      merchantId: this.merchantId,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      returnUrl: details.returnUrl,
      cancelUrl: details.cancelUrl,
      successUrl: details.successUrl || details.cancelUrl,
      email: user?.email || "",
      storeName: store?.name || "YardSale Cloud"
    });
    return { ...payment, checkout };
  }

  verifyWebhook(body, signature) {
    if (!this.configured) return false;
    try {
      const payload = typeof body === "string" ? JSON.parse(body) : body;
      return verifyPayWayCallback(payload, signature, this.apiKey);
    } catch {
      return false;
    }
  }

  recordWebhook(db, payload, actor = "aba-payway") {
    const providerReference = paywayTransactionReference(payload);
    if (!providerReference) throw new Error("PayWay callback did not include a transaction reference.");
    return recordProviderPayment(db, {
      provider: this.name,
      providerReference,
      outcome: paywayPaymentSucceeded(payload) ? "paid" : "failed",
      payload,
      actor
    });
  }
}

export function createBillingProvider({ name = "mock", secret, merchantId, apiKey, baseUrl } = {}) {
  if (name === "aba-payway") return new AbaPayWayProvider({ merchantId, apiKey, baseUrl });
  return new MockPaymentProvider({ secret });
}

function addHours(value, hours) {
  return new Date(new Date(value).getTime() + Number(hours) * 60 * 60 * 1000).toISOString();
}

function safeJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const PAYWAY_PURCHASE_HASH_FIELDS = [
  "req_time", "merchant_id", "tran_id", "amount", "items", "shipping", "firstname", "lastname",
  "email", "phone", "type", "payment_option", "return_url", "cancel_url", "continue_success_url",
  "return_deeplink", "currency", "custom_fields", "return_params", "payout", "lifetime",
  "additional_params", "google_pay_token", "skip_success_page"
];

function paywayValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function base64(value) {
  return Buffer.from(String(value)).toString("base64");
}

function paywayRequestTime(at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid PayWay request time.");
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0")
  ].join("");
}

export function paywayPurchaseHash(fields, secret) {
  const canonical = PAYWAY_PURCHASE_HASH_FIELDS.map((key) => paywayValue(fields?.[key])).join("");
  return createHmac("sha512", String(secret)).update(canonical).digest("base64");
}

export function paywayCallbackSignature(payload, secret) {
  const canonical = Object.keys(payload || {}).sort().map((key) => paywayValue(payload[key])).join("");
  return createHmac("sha512", String(secret)).update(canonical).digest("base64");
}

export function verifyPayWayCallback(payload, signature, secret) {
  if (!payload || typeof payload !== "object" || !secret || !signature) return false;
  const expected = Buffer.from(paywayCallbackSignature(payload, secret));
  const actual = Buffer.from(String(signature));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function paywayPurchaseForm({ payment, merchantId, apiKey, baseUrl, returnUrl, cancelUrl, successUrl, email = "", storeName = "YardSale Cloud", at = new Date() }) {
  if (!payment || !merchantId || !apiKey || !returnUrl || !cancelUrl) throw new Error("PayWay checkout details are incomplete.");
  const amount = (Number(payment.amount_minor) / 100).toFixed(2);
  const itemName = payment.kind === "promotion" ? `${storeName} promotion` : `${storeName} hosted time`;
  const fields = {
    req_time: paywayRequestTime(at),
    merchant_id: String(merchantId),
    tran_id: String(payment.provider_reference),
    amount,
    items: base64(JSON.stringify([{ name: itemName.slice(0, 120), quantity: 1, price: Number(amount) }])),
    shipping: "",
    firstname: "",
    lastname: "",
    email: String(email).slice(0, 50),
    phone: "",
    type: "purchase",
    payment_option: "",
    return_url: base64(returnUrl),
    cancel_url: String(cancelUrl),
    continue_success_url: String(successUrl || cancelUrl),
    return_deeplink: "",
    currency: String(payment.currency || "USD"),
    custom_fields: "",
    return_params: JSON.stringify({ payment_id: String(payment.id) }),
    payout: "",
    lifetime: "30",
    additional_params: "",
    google_pay_token: "",
    skip_success_page: "0",
    view_type: "hosted_view",
    payment_gate: "0"
  };
  fields.hash = paywayPurchaseHash(fields, apiKey);
  return {
    action: `${String(baseUrl || "https://checkout.payway.com.kh").replace(/\/+$/, "")}/api/payment-gateway/v1/payments/purchase`,
    fields
  };
}

export function paywayTransactionReference(payload) {
  const reference = payload?.tran_id || payload?.transaction_id || payload?.merchant_ref;
  return reference ? String(reference).slice(0, 120) : "";
}

export function paywayPaymentSucceeded(payload) {
  const code = String(payload?.status ?? payload?.payment_status_code ?? payload?.status?.code ?? "");
  const status = String(payload?.payment_status || payload?.description || "").toUpperCase();
  return code === "0" || code === "00" || status === "APPROVED" || status === "COMPLETED" || status === "SUCCESS";
}

export function mockWebhookSignature(secret, body) {
  return `sha256=${createHmac("sha256", String(secret)).update(String(body)).digest("hex")}`;
}

export function verifyMockWebhook(secret, body, signature) {
  const expected = Buffer.from(mockWebhookSignature(secret, body));
  const actual = Buffer.from(String(signature || ""));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createCheckout(db, { userId, storeId, kind = "store_extension", promotionType = null, listingId = null, actor, provider = "mock", currency = "USD", providerReference = null }) {
  const store = getHostedStoreForUser(db, storeId, userId);
  if (!store) throw new Error("Store not found.");
  if (!['store_extension', 'promotion'].includes(kind)) throw new Error("That payment type is not available.");
  if (["deleting", "deleted"].includes(store.state)) throw new Error("This store is past its retention window.");
  const policy = resolvePolicy(db, { storeId, userId });
  const normalizedType = promotionType ? String(promotionType) : null;
  if (kind === "promotion" && !PROMOTION_TYPES.has(normalizedType)) throw new Error("That promotion is not available.");
  if (kind === "promotion" && (store.mode === "free" || store.state !== "running")) throw new Error("Promotions are available after a store is extended and running.");
  if (kind === "promotion" && normalizedType === "feature_listing") {
    const listing = db.prepare("SELECT id, moderation_status FROM search_listings WHERE id = ? AND store_id = ?").get(Number(listingId), storeId);
    if (!listing || listing.moderation_status === "blocked") throw new Error("Choose an active listing to feature.");
  }

  const entitlementDays = kind === "store_extension" ? Number(policy.default_paid_days) : null;
  const amountMinor = kind === "promotion"
    ? normalizedType === "feature_listing" ? Number(policy.promotion_feature_listing_price_minor)
      : Number(policy.promotion_feature_store_price_minor)
    : Number(policy.default_store_price_minor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error("The current price policy is invalid.");
  if (String(provider) === "aba-payway" && amountMinor < 1) throw new Error("ABA PayWay does not accept a zero-value payment.");
  const metadata = kind === "promotion" ? { promotion_type: normalizedType, listing_id: listingId ? Number(listingId) : null } : {};
  const now = nowIso();
  const reference = providerReference || `mock_${randomUUID()}`;
  const result = db.prepare(`
    INSERT INTO payments (
      user_id, store_id, provider, kind, amount_minor, currency, status,
      provider_reference, entitlement_days, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(userId, storeId, String(provider), kind, amountMinor, String(currency), reference, entitlementDays, JSON.stringify(metadata), now);
  createAuditEvent(db, { actor: actor || "system", userId, storeId, action: "payment.checkout_created", metadata: { payment_id: Number(result.lastInsertRowid), kind, amount_minor: amountMinor } });
  return getPayment(db, Number(result.lastInsertRowid));
}

export function getPayment(db, id) {
  return db.prepare(`
    SELECT payments.*, hosted_stores.slug, hosted_stores.name AS store_name
    FROM payments LEFT JOIN hosted_stores ON hosted_stores.id = payments.store_id
    WHERE payments.id = ?
  `).get(id);
}

export function listPaymentsForUser(db, userId) {
  return db.prepare(`
    SELECT payments.*, hosted_stores.slug, hosted_stores.name AS store_name
    FROM payments LEFT JOIN hosted_stores ON hosted_stores.id = payments.store_id
    WHERE payments.user_id = ?
    ORDER BY payments.created_at DESC, payments.id DESC LIMIT 100
  `).all(userId);
}

export function listPaymentsForAdmin(db) {
  return db.prepare(`
    SELECT payments.*, users.email, hosted_stores.slug, hosted_stores.name AS store_name
    FROM payments JOIN users ON users.id = payments.user_id
    LEFT JOIN hosted_stores ON hosted_stores.id = payments.store_id
    ORDER BY payments.created_at DESC, payments.id DESC LIMIT 100
  `).all();
}

function applyPaidPayment(db, paymentId, actor) {
  const payment = getPayment(db, paymentId);
  if (!payment) throw new Error("Payment not found.");
  if (payment.status === "paid") return payment;
  if (payment.status !== "pending") throw new Error("That payment cannot be completed.");
  const now = nowIso();
  db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ?").run(now, paymentId);

  if (payment.kind === "store_extension") {
    const store = getHostedStore(db, payment.store_id);
    if (!store) throw new Error("The store for this payment no longer exists.");
    const currentEnd = Date.parse(store.current_period_ends_at);
    const start = Math.max(Number.isFinite(currentEnd) ? currentEnd : 0, Date.now());
    const endsAt = new Date(start + Number(payment.entitlement_days || 0) * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      UPDATE hosted_stores SET mode = 'paid', state = 'running', current_period_ends_at = ?,
        grace_ends_at = NULL, deletion_scheduled_at = NULL, updated_at = ? WHERE id = ?
    `).run(endsAt, now, store.id);
    db.prepare(`
      INSERT INTO store_entitlements (store_id, source, key, value, starts_at, ends_at, reason, created_by, created_at)
      VALUES (?, 'payment', 'marketplace_enabled', 'true', ?, ?, ?, ?, ?)
    `).run(store.id, now, endsAt, `Payment ${payment.id}`, actor, now);
    createAuditEvent(db, { actor, userId: payment.user_id, storeId: payment.store_id, action: "store.reactivated", metadata: { payment_id: payment.id, ends_at: endsAt } });
  } else {
    const metadata = safeJson(payment.metadata);
    const durationHours = Number(resolvePolicy(db, { storeId: payment.store_id }).promotion_duration_hours) || 24;
    const startsAt = now;
    const endsAt = addHours(now, durationHours);
    db.prepare(`
      INSERT INTO promotion_purchases (
        store_id, listing_id, promotion_type, amount_minor, starts_at, ends_at, status, payment_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(payment.store_id, metadata.listing_id, metadata.promotion_type, payment.amount_minor, startsAt, endsAt, payment.id, now);
    refreshPromotionScores(db);
    createAuditEvent(db, { actor, userId: payment.user_id, storeId: payment.store_id, action: "promotion.activated", metadata: { payment_id: payment.id, promotion_type: metadata.promotion_type, ends_at: endsAt } });
  }
  return getPayment(db, paymentId);
}

export function completeMockPayment(db, paymentId, actor = "mock-provider") {
  return transaction(db, () => applyPaidPayment(db, paymentId, actor));
}

export function recordProviderPayment(db, { provider, providerReference, outcome, payload = {}, actor = "payment-provider" }) {
  return transaction(db, () => {
    const payment = db.prepare("SELECT id, status FROM payments WHERE provider = ? AND provider_reference = ?").get(String(provider), String(providerReference));
    if (!payment) throw new Error("Payment reference not found.");
    if (outcome === "paid") return applyPaidPayment(db, payment.id, actor);
    if (outcome !== "failed") throw new Error("Unknown provider payment outcome.");
    if (payment.status === "paid" || payment.status === "refunded" || payment.status === "failed") return getPayment(db, payment.id);
    db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(payment.id);
    createAuditEvent(db, {
      actor,
      storeId: getPayment(db, payment.id)?.store_id || null,
      action: "payment.failed",
      metadata: { payment_id: payment.id, provider: String(provider), provider_reference: String(providerReference), payload: JSON.stringify(payload).slice(0, 1000) }
    });
    return getPayment(db, payment.id);
  });
}

export function refundPayment(db, paymentId, actor) {
  return transaction(db, () => {
    const payment = getPayment(db, paymentId);
    if (!payment) throw new Error("Payment not found.");
    if (payment.status !== "paid") throw new Error("Only paid payments can be refunded.");
    const now = nowIso();
    db.prepare("UPDATE payments SET status = 'refunded', refunded_at = ? WHERE id = ?").run(now, paymentId);
    if (payment.kind === "promotion") {
      db.prepare("UPDATE promotion_purchases SET status = 'cancelled' WHERE payment_id = ? AND status = 'active'").run(paymentId);
      refreshPromotionScores(db);
    }
    createAuditEvent(db, { actor, userId: payment.user_id, storeId: payment.store_id, action: "payment.refunded", metadata: { payment_id: paymentId } });
    return getPayment(db, paymentId);
  });
}

export function expirePromotions(db, at = new Date()) {
  const now = at instanceof Date ? at.toISOString() : String(at);
  return Number(db.prepare(`
    UPDATE promotion_purchases SET status = 'expired'
    WHERE status = 'active' AND ends_at <= ?
  `).run(now).changes);
}
