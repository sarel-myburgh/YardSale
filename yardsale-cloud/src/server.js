import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countActiveFreeStores,
  countUsers,
  createCampaign,
  createAuditEvent,
  createCoupon,
  createHostedStore,
  createStoreEntitlement,
  createUser,
  extendStorePeriod,
  getHostedStore,
  getHostedStoreByPublicId,
  getHostedStoreForUser,
  getUserByEmail,
  listAuditEvents,
  listCampaigns,
  listCoupons,
  listDeploymentHosts,
  listHostedStores,
  listHostedStoresForUser,
  listPlatformPolicies,
  listUsers,
  makeUniqueSlug,
  markStoreDeleted,
  openDatabase,
  recordMarketplaceEvent,
  recordProvisionAttempt,
  releaseHostSlot,
  redeemCoupon,
  revokeStoreEntitlement,
  setCampaignStatus,
  setPlatformPolicy,
  setStoreExpiry,
  setStoreMarketplaceOptOut,
  setStoreRuntime,
  setStoreState,
  setUserStatus,
  touchUserLogin,
  transaction
} from "./db.js";
import { clearCsrfCookie, clearSessionCookie, createEmailVerificationToken, createSession as makeSession, csrfCookie, destroySession, getSession, hashPassword, parseCookies, CSRF_COOKIE, SESSION_COOKIE, sessionCookie, sessionCsrfIsValid, verifyEmailToken, verifyPassword } from "./auth.js";
import { isMarketplaceEligible, reconcileLifecycle, resolvePolicy, validatePolicyValue } from "./policy.js";
import { createRuntime } from "./runtime.js";
import { createBillingProvider, getPayment, listPaymentsForAdmin, listPaymentsForUser, refundPayment } from "./billing.js";
import { deindexStore, getMarketplaceListing, ingestFederationFeed, marketplaceFacets, reconcileStoreFeed, searchMarketplace, verifyIngestSignature } from "./marketplace.js";
import { addBlocklistEntry, blockedAccountReason, blockedIpReason, listBlocklist, listModerationReports, removeBlocklistEntry, reportListing, reportStore, resolveReport } from "./moderation.js";
import { collectMetrics, createBackup, listBackups, migrateStore, prometheusMetrics, pruneExpiredSessions, runJobs, upgradeStores } from "./ops.js";
import { adminPage, billingPage, dashboardPage, errorPage, landingPage, legalPage, loginPage, marketplacePage, mockCheckoutPage, newStorePage, paywayCheckoutPage, reportPage, signupPage, storePage, storeReportPage, verificationPage } from "./html.js";

const MAX_FORM_BYTES = 64 * 1024;
const loginAttempts = new Map();
const signupAttempts = new Map();
const storeCreationAttempts = new Map();
const PROJECT_DIR = fileURLToPath(new URL("..", import.meta.url));

function configFromEnvironment() {
  const production = process.env.NODE_ENV === "production";
  const dataDir = process.env.YARDSALE_CLOUD_DATA_DIR || join(PROJECT_DIR, ".yardsale-cloud");
  const port = Number(process.env.YARDSALE_CLOUD_PORT || process.env.PORT || 3010);
  const backupIntervalHours = Number(process.env.YARDSALE_CLOUD_BACKUP_INTERVAL_HOURS || 24);
  const trustedProxyAddresses = String(process.env.YARDSALE_CLOUD_TRUSTED_PROXY_ADDRESSES || "127.0.0.1,::1")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    dataDir,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3010,
    baseDomain: process.env.YARDSALE_CLOUD_BASE_DOMAIN || "yardsale.local",
    publicOrigin: process.env.YARDSALE_CLOUD_PUBLIC_ORIGIN || "",
    runtimeKind: process.env.YARDSALE_CLOUD_RUNTIME || "local",
    runtimeExecute: process.env.YARDSALE_CLOUD_RUNTIME_EXECUTE === "true",
    backupDir: process.env.YARDSALE_CLOUD_BACKUP_DIR || join(dataDir, "backups"),
    backupIntervalMs: Number.isFinite(backupIntervalHours) && backupIntervalHours > 0 ? Math.min(365 * 24, backupIntervalHours) * 60 * 60 * 1000 : 24 * 60 * 60 * 1000,
    webhookSecret: process.env.YARDSALE_CLOUD_WEBHOOK_SECRET || "local-webhook-secret",
    requireEmailVerification: production || process.env.YARDSALE_CLOUD_REQUIRE_EMAIL_VERIFICATION === "true",
    cookieSecure: production || process.env.YARDSALE_CLOUD_COOKIE_SECURE === "true",
    trustProxy: process.env.YARDSALE_CLOUD_TRUST_PROXY === "true",
    trustedProxyAddresses,
    billingProvider: process.env.YARDSALE_CLOUD_BILLING_PROVIDER || "mock",
    abaMerchantId: process.env.YARDSALE_CLOUD_ABA_MERCHANT_ID || "",
    abaApiKey: process.env.YARDSALE_CLOUD_ABA_API_KEY || "",
    abaBaseUrl: process.env.YARDSALE_CLOUD_ABA_BASE_URL || "https://checkout.payway.com.kh"
  };
}

function applySecurityHeaders(response, secure = false) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' https: data:; style-src 'self'; form-action 'self' https://checkout.payway.com.kh https://checkout-sandbox.payway.com.kh; base-uri 'self'; frame-ancestors 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (secure) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function sendHtml(response, html, status = 200, cookies = [], secure = false) {
  applySecurityHeaders(response, secure);
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (cookies.length) response.setHeader("Set-Cookie", cookies);
  response.end(html);
}

function sendJson(response, data, status = 200, secure = false) {
  applySecurityHeaders(response, secure);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(data));
}

function sendText(response, body, contentType, status = 200, secure = false) {
  applySecurityHeaders(response, secure);
  response.statusCode = status;
  response.setHeader("Content-Type", `${contentType}; charset=utf-8`);
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

function redirect(response, location, cookies = [], secure = false) {
  applySecurityHeaders(response, secure);
  response.statusCode = 303;
  response.setHeader("Location", location);
  if (cookies.length) response.setHeader("Set-Cookie", cookies);
  response.end();
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_FORM_BYTES) throw new Error("Form is too large");
  }
  return body;
}

async function readForm(request) {
  return Object.fromEntries(new URLSearchParams(await readBody(request)));
}

function parseMoneyMinor(value) {
  const amount = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(amount) && amount >= 0 && amount <= 100000000 ? Math.round(amount * 100) : null;
}

function parseDateInput(value) {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function campaignStatus(value) {
  return ["draft", "active", "paused", "ended"].includes(String(value));
}

function couponStatus(value) {
  return ["active", "paused", "ended"].includes(String(value));
}

function parseJsonObject(value, fallback = {}) {
  if (!String(value || "").trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch {
    throw new Error("Enter valid JSON object data.");
  }
}

function safeNext(value) {
  const next = String(value || "");
  return next.startsWith("/")
    && !next.startsWith("//")
    && !next.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(next)
    ? next
    : "/dashboard";
}

function normalizeAddress(value) {
  const address = String(value || "").trim().replace(/^\[|\]$/g, "");
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function isTrustedProxy(request, config) {
  const direct = normalizeAddress(request.socket?.remoteAddress);
  return Boolean(config.trustProxy && direct && (config.trustedProxyAddresses || []).some((value) => normalizeAddress(value) === direct));
}

function clientAddress(request, config) {
  const direct = normalizeAddress(request.socket?.remoteAddress) || "unknown";
  if (!isTrustedProxy(request, config)) return direct;
  const forwarded = normalizeAddress(String(request.headers["x-forwarded-for"] || "").split(",")[0]);
  return forwarded || direct;
}

function secureRequest(request, config) {
  return config.cookieSecure || (isTrustedProxy(request, config) && request.headers["x-forwarded-proto"] === "https");
}

function userContext(session, csrfToken) {
  return { id: session.user_id, email: session.email, is_admin: Boolean(session.is_admin), email_verified_at: session.email_verified_at, country_code: session.country_code, csrfToken };
}

function loginAllowed(key) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const attempts = (loginAttempts.get(key) || []).filter((time) => time > now - windowMs);
  if (attempts.length >= 8) {
    loginAttempts.set(key, attempts);
    return false;
  }
  attempts.push(now);
  loginAttempts.set(key, attempts);
  return true;
}

function signupAllowed(key) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const attempts = (signupAttempts.get(key) || []).filter((time) => time > now - windowMs);
  if (attempts.length >= 8) {
    signupAttempts.set(key, attempts);
    return false;
  }
  attempts.push(now);
  signupAttempts.set(key, attempts);
  return true;
}

function storeCreationAllowed(key) {
  const now = Date.now();
  const recent = (storeCreationAttempts.get(key) || []).filter((time) => time > now - 60 * 60 * 1000);
  if (recent.length >= 3) {
    storeCreationAttempts.set(key, recent);
    return false;
  }
  recent.push(now);
  storeCreationAttempts.set(key, recent);
  return true;
}

const reportAttempts = new Map();
function reportAllowed(key) {
  const now = Date.now();
  const recent = (reportAttempts.get(key) || []).filter((time) => time > now - 60 * 60 * 1000);
  if (recent.length >= 12) {
    reportAttempts.set(key, recent);
    return false;
  }
  recent.push(now);
  reportAttempts.set(key, recent);
  return true;
}

function visitorKey(request) {
  return createHash("sha256")
    .update(`${request.clientAddress || request.socket?.remoteAddress || "unknown"}|${request.headers["user-agent"] || ""}|${new Date().toISOString().slice(0, 10)}`)
    .digest("hex");
}

function externalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function appUrl(request, config, path, secure) {
  const fallbackOrigin = `${secure ? "https" : "http"}://${request.headers.host || "localhost"}`;
  try { return new URL(path, config.publicOrigin || fallbackOrigin).toString(); } catch { return new URL(path, fallbackOrigin).toString(); }
}

function getPageSession(request, db) {
  const cookies = parseCookies(request.headers.cookie);
  return { token: cookies[SESSION_COOKIE], csrfToken: cookies[CSRF_COOKIE], session: getSession(db, cookies[SESSION_COOKIE]) };
}

function requireSession(request, response, db, config, next) {
  const { token, csrfToken, session } = getPageSession(request, db);
  if (!session) {
    redirect(response, `/login?next=${encodeURIComponent(next)}`, [], secureRequest(request, config));
    return null;
  }
  return { token, csrfToken, session, secure: secureRequest(request, config) };
}

function requireAdmin(request, response, db, config, next) {
  const auth = requireSession(request, response, db, config, next);
  if (!auth) return null;
  if (!auth.session.is_admin) {
    sendHtml(response, errorPage("Not available", "This area is reserved for platform operators.", 403).html, 403, [], auth.secure);
    return null;
  }
  return auth;
}

function adminView(db, config, auth, values = {}) {
  const user = userContext(auth.session, auth.csrfToken);
  return adminPage({
    user,
    policies: listPlatformPolicies(db),
    stores: listHostedStores(db),
    campaigns: listCampaigns(db),
    coupons: listCoupons(db),
    reports: listModerationReports(db),
    blocklist: listBlocklist(db),
    backups: listBackups(config.backupDir),
    metrics: collectMetrics(db),
    payments: listPaymentsForAdmin(db),
    hosts: listDeploymentHosts(db),
    users: listUsers(db, values.userQuery || ""),
    csrf: auth.csrfToken,
    ...values
  });
}

function readiness(db, config) {
  try {
    db.prepare("SELECT 1 AS ready").get();
    return {
      status: "ready",
      runtime: config.runtimeKind,
      billing: config.billingProvider,
      data_dir: config.dataDir
    };
  } catch (error) {
    return { status: "not_ready", error: error.message };
  }
}

async function handleRequest(request, response, context) {
  const { db, config, runtime, billing } = context;
  request.clientAddress = clientAddress(request, config);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const secure = secureRequest(request, config);
  const host = String(request.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  const tenantHost = host ? db.prepare("SELECT state FROM hosted_stores WHERE lower(hostname) = ?").get(host) : null;
  if (tenantHost) {
    sendJson(response, { error: "Tenant host routing is not configured on this control plane." }, 503, secure);
    return;
  }
  const baseDomain = String(config.baseDomain || "").toLowerCase();
  if (baseDomain && host.endsWith(`.${baseDomain}`)) {
    sendJson(response, { error: "Unknown tenant host." }, 404, secure);
    return;
  }

  if (url.pathname === "/styles.css" && request.method === "GET") {
    const css = await readFile(join(PROJECT_DIR, "public", "styles.css"));
    applySecurityHeaders(response, secure);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/css; charset=utf-8");
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.end(css);
    return;
  }

  if (url.pathname === "/fonts/PermanentMarker-Regular.ttf" && request.method === "GET") {
    const font = await readFile(join(PROJECT_DIR, "public", "fonts", "PermanentMarker-Regular.ttf"));
    applySecurityHeaders(response, secure);
    response.statusCode = 200;
    response.setHeader("Content-Type", "font/ttf");
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.end(font);
    return;
  }

  if (url.pathname === "/healthz" && request.method === "GET") {
    sendJson(response, { status: "ok" }, 200, secure);
    return;
  }

  if (url.pathname === "/readyz" && request.method === "GET") {
    const result = readiness(db, config);
    sendJson(response, result, result.status === "ready" ? 200 : 503, secure);
    return;
  }

  if (url.pathname === "/metrics" && request.method === "GET") {
    const expected = process.env.YARDSALE_CLOUD_METRICS_TOKEN;
    const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (expected && supplied !== expected) {
      sendJson(response, { error: "Unauthorized" }, 401, secure);
      return;
    }
    sendText(response, prometheusMetrics(collectMetrics(db)), "text/plain", 200, secure);
    return;
  }

  if (url.pathname.startsWith("/legal/") && request.method === "GET") {
    const legal = {
      "/legal/terms": ["Terms", "Terms of service", ["YardSale Cloud provides managed storefront hosting, lifecycle controls, and optional marketplace discovery. Sellers remain responsible for their listings, buyer interactions, and compliance with applicable law.", "Hosted time, promotion charges, and retention windows follow the platform policy shown in the account dashboard. We do not process payments between buyers and sellers."]],
      "/legal/privacy": ["Privacy", "Privacy policy", ["The control plane stores account, store, billing, audit, and public marketplace metadata needed to operate the service. Buyer contact data belongs to the tenant storefront and is not copied into marketplace search.", "Operational logs and backups are retained only as long as needed for security, support, and recovery."]],
      "/legal/acceptable-use": ["Acceptable use", "Keep the marketplace useful", ["Do not use YardSale Cloud for illegal goods, fraud, spam, harassment, malware, infringement, or activity that puts other sellers or buyers at risk.", "Listings can be reported. Operators may de-index or suspend content while a report is reviewed."]],
      "/legal/prohibited-items": ["Prohibited items", "What cannot be listed", ["Do not list weapons, controlled substances, stolen goods, counterfeit goods, regulated financial products, unsafe goods, adult sexual services, or anything illegal where you sell or operate.", "Operators may remove, de-index, suspend, or delete content when safety, legal, or abuse concerns require it."]],
      "/legal/abuse": ["Abuse process", "Report a problem", ["Use the Report link on a public listing for marketplace issues. Include the listing URL, the concern, and enough detail for an operator to review it.", "For urgent safety or legal requests, contact the service operator through the production support channel configured for your deployment. Do not include private buyer information in a public report."]]
    }[url.pathname];
    if (!legal) {
      sendHtml(response, errorPage("Not found", "That policy page does not exist.", 404).html, 404, [], secure);
      return;
    }
    sendHtml(response, legalPage(...legal), 200, [], secure);
    return;
  }

  if (url.pathname === "/verify-email" && request.method === "GET") {
    const user = verifyEmailToken(db, url.searchParams.get("token"));
    sendHtml(response, verificationPage({ verified: Boolean(user), email: user?.email }), user ? 200 : 422, [], secure);
    return;
  }

  reconcileLifecycle(db);

  if (url.pathname === "/" && request.method === "GET") {
    const { session } = getPageSession(request, db);
    if (session) {
      redirect(response, "/dashboard", [], secure);
      return;
    }
    sendHtml(response, landingPage({ policy: resolvePolicy(db) }), 200, [], secure);
    return;
  }

  if (url.pathname === "/signup") {
    if (request.method === "GET") {
      sendHtml(response, signupPage(), 200, [], secure);
      return;
    }
    if (request.method !== "POST") {
      sendHtml(response, errorPage("Method not allowed", "Use the signup form to create an account.", 405).html, 405, [], secure);
      return;
    }
    const form = await readForm(request);
    const email = String(form.email || "").trim().toLowerCase();
    const password = String(form.password || "");
    const countryCode = String(form.countryCode || "").trim().toUpperCase();
    const errors = [];
    if (!signupAllowed(request.clientAddress || "unknown")) errors.push("Too many signup attempts from this network. Try again later.");
    if (!/^\S+@\S+\.\S+$/.test(email)) errors.push("Enter a valid email address.");
    if (password.length < 10) errors.push("Use a password with at least 10 characters.");
    if (password !== String(form.confirmPassword || "")) errors.push("The passwords do not match.");
    if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) errors.push("Use a two-letter country code or leave it blank.");
    if (blockedAccountReason(db, email) || blockedIpReason(db, request.clientAddress)) errors.push("That signup cannot be completed.");
    if (getUserByEmail(db, email)) errors.push("An account with that email already exists.");
    if (errors.length) {
      sendHtml(response, signupPage({ errors, values: { email, countryCode } }), 422, [], secure);
      return;
    }
    let user;
    try {
      const passwordHash = await hashPassword(password);
      user = transaction(db, () => createUser(db, { email, countryCode, passwordHash, isAdmin: countUsers(db) === 0 }));
    } catch (error) {
      sendHtml(response, signupPage({ errors: [error.message.includes("UNIQUE") ? "An account with that email already exists." : "The account could not be created."], values: { email, countryCode } }), 422, [], secure);
      return;
    }
    createAuditEvent(db, { actor: email, userId: user.id, action: "account.created", metadata: { country_code: countryCode } });
    const verification = createEmailVerificationToken(db, user.id);
    console.log(JSON.stringify({ event: "email_verification_created", email, url: `/verify-email?token=${verification.token}`, expires_at: verification.expiresAt }));
    const session = makeSession(db, user.id);
    redirect(response, "/dashboard", [sessionCookie(session.token, secure), csrfCookie(session.csrfToken, secure)], secure);
    return;
  }

  if (url.pathname === "/login") {
    const next = safeNext(url.searchParams.get("next"));
    if (request.method === "GET") {
      sendHtml(response, loginPage({ next }), 200, [], secure);
      return;
    }
    if (request.method !== "POST") {
      sendHtml(response, errorPage("Method not allowed", "Use the sign-in form to continue.", 405).html, 405, [], secure);
      return;
    }
    const form = await readForm(request);
    const email = String(form.email || "").trim().toLowerCase();
    if (!loginAllowed(`${request.clientAddress || "unknown"}:${email}`)) {
      sendHtml(response, loginPage({ errors: ["Too many attempts. Try again in a few minutes."], values: { email }, next: safeNext(form.next) }), 429, [], secure);
      return;
    }
    const user = getUserByEmail(db, email);
    if (!user || !(await verifyPassword(String(form.password || ""), user.password_hash))) {
      sendHtml(response, loginPage({ errors: ["The email or password is not correct."], values: { email }, next: safeNext(form.next) }), 401, [], secure);
      return;
    }
    if (user.status !== "active") {
      sendHtml(response, loginPage({ errors: ["This account is not active."], values: { email }, next: safeNext(form.next) }), 403, [], secure);
      return;
    }
    touchUserLogin(db, user.id);
    const session = makeSession(db, user.id);
    redirect(response, safeNext(form.next), [sessionCookie(session.token, secure), csrfCookie(session.csrfToken, secure)], secure);
    return;
  }

  if (url.pathname === "/logout") {
    const auth = requireSession(request, response, db, config, "/dashboard");
    if (!auth) return;
    if (request.method !== "POST") {
      sendHtml(response, errorPage("Method not allowed", "Please use the sign-out button.", 405).html, 405, [], auth.secure);
      return;
    }
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    destroySession(db, auth.token);
    redirect(response, "/", [clearSessionCookie(auth.secure), clearCsrfCookie(auth.secure)], auth.secure);
    return;
  }

  if (url.pathname === "/dashboard" && request.method === "GET") {
    const auth = requireSession(request, response, db, config, "/dashboard");
    if (!auth) return;
    const user = userContext(auth.session, auth.csrfToken);
    sendHtml(response, dashboardPage({ user, stores: listHostedStoresForUser(db, user.id), policy: resolvePolicy(db, { userId: user.id }), csrf: auth.csrfToken, requireEmailVerification: config.requireEmailVerification, message: url.searchParams.get("notice") === "verification-sent" ? "A fresh verification link was written to the server log." : url.searchParams.get("deleted") === "1" ? "Store deleted." : "" }), 200, [], auth.secure);
    return;
  }

  if (url.pathname === "/account/verification" && request.method === "POST") {
    const auth = requireSession(request, response, db, config, "/dashboard");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    if (!auth.session.email_verified_at) {
      const verification = createEmailVerificationToken(db, auth.session.user_id);
      console.log(JSON.stringify({ event: "email_verification_created", email: auth.session.email, url: `/verify-email?token=${verification.token}`, expires_at: verification.expiresAt }));
    }
    redirect(response, "/dashboard?notice=verification-sent", [], auth.secure);
    return;
  }

  if (url.pathname === "/stores/new" && request.method === "GET") {
    const auth = requireSession(request, response, db, config, "/stores/new");
    if (!auth) return;
    const user = userContext(auth.session, auth.csrfToken);
    sendHtml(response, newStorePage({ user, policy: resolvePolicy(db, { userId: user.id }), csrf: auth.csrfToken, baseDomain: config.baseDomain }), 200, [], auth.secure);
    return;
  }

  if (url.pathname === "/stores" && request.method === "POST") {
    const auth = requireSession(request, response, db, config, "/stores/new");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid. Refresh the page and try again.", 403).html, 403, [], auth.secure);
      return;
    }
    const user = userContext(auth.session, auth.csrfToken);
    const name = String(form.name || "").trim();
    const requestedSlug = String(form.slug || "").trim();
    const requestedCoupon = String(form.coupon || "").trim();
    const errors = [];
    if (name.length < 2 || name.length > 80) errors.push("Store name must be between 2 and 80 characters.");
    if (requestedSlug && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requestedSlug) || requestedSlug.length > 48)) errors.push("Use up to 48 lowercase letters, numbers, and single hyphens for the slug.");
    const policy = resolvePolicy(db, { userId: user.id });
    if (!storeCreationAllowed(request.clientAddress || "unknown")) errors.push("Too many store creation attempts. Try again later.");
    if (config.requireEmailVerification && !auth.session.email_verified_at) errors.push("Verify your email before creating a hosted store.");
    const activeFreeLimit = Number(policy.free_active_store_limit) || 1;
    if (errors.length) {
      sendHtml(response, newStorePage({ user, policy, csrf: auth.csrfToken, baseDomain: config.baseDomain, errors, values: { name, slug: requestedSlug, coupon: requestedCoupon } }), 422, [], auth.secure);
      return;
    }

    let store;
    try {
      store = transaction(db, () => {
        if (countActiveFreeStores(db, user.id) >= activeFreeLimit) throw new Error("You have reached the active free-store limit. Extend the existing store or wait until it expires.");
        const slug = requestedSlug || makeUniqueSlug(db, name);
        if (db.prepare("SELECT id FROM hosted_stores WHERE slug = ?").get(slug)) throw new Error("That public slug is already in use.");
        const hostname = `${slug}.${config.baseDomain}`;
        const created = createHostedStore(db, {
          userId: user.id,
          name,
          slug,
          hostname,
          imageVersion: String(policy.store_image_version),
          freeDays: Number(policy.default_free_days) || 14
        });
        createAuditEvent(db, { actor: user.email, userId: user.id, storeId: created.id, action: "store.created", metadata: { mode: "free", free_days: Number(policy.default_free_days) || 14 } });
        return created;
      });
    } catch (error) {
      sendHtml(response, newStorePage({ user, policy, csrf: auth.csrfToken, baseDomain: config.baseDomain, errors: [error.message || "The store could not be created."], values: { name, slug: requestedSlug, coupon: requestedCoupon } }), 422, [], auth.secure);
      return;
    }

    try {
      recordProvisionAttempt(db, store.id);
      const instance = await runtime.createInstance({ store });
      if (config.runtimeExecute && runtime.waitUntilReady && !(await runtime.waitUntilReady({ store }))) {
        throw new Error("The store runtime did not become ready in time.");
      }
      store = setStoreRuntime(db, store.id, instance);
      createAuditEvent(db, { actor: user.email, userId: user.id, storeId: store.id, action: "store.provisioned", metadata: { runtime: config.runtimeKind, runtime_instance_id: instance.runtimeInstanceId } });
    } catch (error) {
      try { await runtime.deleteInstance({ store }); } catch { /* Best-effort cleanup; the failed row remains auditable. */ }
      db.prepare("UPDATE hosted_stores SET last_provision_error = ?, updated_at = ? WHERE id = ?").run(String(error.message || error).slice(0, 1000), new Date().toISOString(), store.id);
      store = setStoreState(db, store.id, "failed");
      createAuditEvent(db, { actor: "system", userId: user.id, storeId: store.id, action: "store.provisioning_failed", metadata: { error: error.message } });
      sendHtml(response, errorPage("Provisioning failed", "The store record was kept for retry, but its runtime could not be created.", 500).html, 500, [], auth.secure);
      return;
    }
    let message = "";
    if (requestedCoupon) {
      try {
        redeemCoupon(db, { code: requestedCoupon, userId: user.id, storeId: store.id, actor: user.email });
        message = "Coupon applied.";
      } catch (error) {
        message = error.message || "The coupon could not be applied.";
      }
    }
    redirect(response, `/stores/${store.id}${message ? `?notice=${encodeURIComponent(message)}` : ""}`, [], auth.secure);
    return;
  }

  const storeMatch = /^\/stores\/(\d+)$/.exec(url.pathname);
  if (storeMatch && request.method === "GET") {
    const auth = requireSession(request, response, db, config, url.pathname);
    if (!auth) return;
    const user = userContext(auth.session, auth.csrfToken);
    const store = getHostedStoreForUser(db, Number(storeMatch[1]), user.id);
    if (!store) {
      sendHtml(response, errorPage("Store not found", "That store does not belong to this account.", 404).html, 404, [], auth.secure);
      return;
    }
    const policy = resolvePolicy(db, { storeId: store.id });
    sendHtml(response, storePage({ user, store, policy, audits: listAuditEvents(db, { storeId: store.id }), entitlements: db.prepare("SELECT * FROM store_entitlements WHERE store_id = ? ORDER BY created_at DESC, id DESC").all(store.id), listings: db.prepare("SELECT id, title FROM search_listings WHERE store_id = ? AND moderation_status = 'active' AND status NOT IN ('sold', 'hidden') ORDER BY title COLLATE NOCASE LIMIT 100").all(store.id), csrf: auth.csrfToken, message: url.searchParams.get("notice") || "" }), 200, [], auth.secure);
    return;
  }

  const storeActionMatch = /^\/stores\/(\d+)\/(checkout|promotions|coupon|marketplace|delete)$/.exec(url.pathname);
  if (storeActionMatch && request.method === "POST") {
    const auth = requireSession(request, response, db, config, `/stores/${storeActionMatch[1]}`);
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid. Refresh the page and try again.", 403).html, 403, [], auth.secure);
      return;
    }
    const user = userContext(auth.session, auth.csrfToken);
    const store = getHostedStoreForUser(db, Number(storeActionMatch[1]), user.id);
    if (!store) {
      sendHtml(response, errorPage("Store not found", "That store does not belong to this account.", 404).html, 404, [], auth.secure);
      return;
    }
    try {
      const action = storeActionMatch[2];
      if (action === "checkout") {
        const payment = billing.createCheckout(db, {
          userId: user.id,
          storeId: store.id,
          actor: user.email,
          returnUrl: appUrl(request, config, "/api/payments/payway/callback", auth.secure),
          cancelUrl: appUrl(request, config, `/stores/${store.id}`, auth.secure),
          successUrl: appUrl(request, config, "/billing?paid=1", auth.secure)
        });
        if (payment.checkout) {
          sendHtml(response, paywayCheckoutPage({ user, payment, checkout: payment.checkout, csrf: auth.csrfToken }), 200, [], auth.secure);
        } else {
          redirect(response, `/billing/mock/${payment.id}`, [], auth.secure);
        }
        return;
      }
      if (action === "promotions") {
        const payment = billing.createCheckout(db, {
          userId: user.id,
          storeId: store.id,
          kind: "promotion",
          promotionType: form.promotionType,
          listingId: form.listingId,
          actor: user.email,
          returnUrl: appUrl(request, config, "/api/payments/payway/callback", auth.secure),
          cancelUrl: appUrl(request, config, `/stores/${store.id}`, auth.secure),
          successUrl: appUrl(request, config, "/billing?paid=1", auth.secure)
        });
        if (payment.checkout) {
          sendHtml(response, paywayCheckoutPage({ user, payment, checkout: payment.checkout, csrf: auth.csrfToken }), 200, [], auth.secure);
        } else {
          redirect(response, `/billing/mock/${payment.id}`, [], auth.secure);
        }
        return;
      }
      if (action === "coupon") {
        redeemCoupon(db, { code: form.code, userId: user.id, storeId: store.id, actor: user.email });
        redirect(response, `/stores/${store.id}?notice=${encodeURIComponent("Coupon applied.")}`, [], auth.secure);
        return;
      }
      if (action === "marketplace") {
        const optedOut = form.enabled !== "1";
        setStoreMarketplaceOptOut(db, store.id, optedOut);
        if (optedOut) deindexStore(db, store.id, user.email);
        else if (store.state === "running") {
          try { await reconcileStoreFeed(db, { storeId: store.id, actor: user.email }); } catch (error) {
            createAuditEvent(db, { actor: user.email, userId: user.id, storeId: store.id, action: "marketplace.reconcile_failed", metadata: { error: error.message } });
          }
        }
        createAuditEvent(db, { actor: user.email, userId: user.id, storeId: store.id, action: optedOut ? "marketplace.opted_out" : "marketplace.opted_in" });
        redirect(response, `/stores/${store.id}?notice=${encodeURIComponent(optedOut ? "Marketplace indexing disabled." : "Marketplace indexing enabled when the store feed is available.")}`, [], auth.secure);
        return;
      }
      if (["deleting", "deleted"].includes(store.state)) throw new Error("This store is already in its removal flow.");
      if (form.confirm !== "DELETE") throw new Error("Type DELETE to confirm store removal.");
      await runtime.deleteInstance({ store });
      markStoreDeleted(db, store.id);
      releaseHostSlot(db, store);
      createAuditEvent(db, { actor: user.email, userId: user.id, storeId: store.id, action: "store.deleted" });
      redirect(response, "/dashboard?deleted=1", [], auth.secure);
    } catch (error) {
      redirect(response, `/stores/${store.id}?notice=${encodeURIComponent(error.message || "That action could not be completed.")}`, [], auth.secure);
    }
    return;
  }

  if (url.pathname === "/billing" && request.method === "GET") {
    const auth = requireSession(request, response, db, config, "/billing");
    if (!auth) return;
    const user = userContext(auth.session, auth.csrfToken);
    sendHtml(response, billingPage({ user, payments: listPaymentsForUser(db, user.id), csrf: auth.csrfToken, message: url.searchParams.get("paid") === "1" ? "Payment completed." : "" }), 200, [], auth.secure);
    return;
  }

  const checkoutMatch = /^\/billing\/mock\/(\d+)$/.exec(url.pathname);
  if (checkoutMatch) {
    const auth = requireSession(request, response, db, config, `/billing/mock/${checkoutMatch[1]}`);
    if (!auth) return;
    const user = userContext(auth.session, auth.csrfToken);
    const payment = getPayment(db, Number(checkoutMatch[1]));
    if (!payment || payment.user_id !== user.id) {
      sendHtml(response, errorPage("Payment not found", "That checkout does not belong to this account.", 404).html, 404, [], auth.secure);
      return;
    }
    if (request.method === "GET") {
      sendHtml(response, mockCheckoutPage({ user, payment, csrf: auth.csrfToken }), 200, [], auth.secure);
      return;
    }
    if (request.method !== "POST") {
      sendHtml(response, errorPage("Method not allowed", "Use the checkout button to complete this payment.", 405).html, 405, [], auth.secure);
      return;
    }
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      if (payment.kind === "store_extension") {
        const store = getHostedStore(db, payment.store_id);
        if (store?.state === "expired") await runtime.startInstance({ store });
      }
      if (payment.provider !== "mock") throw new Error("This checkout is not available in the mock payment flow.");
      billing.recordPayment(db, payment.id, user.email);
      redirect(response, "/billing?paid=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, mockCheckoutPage({ user, payment, csrf: auth.csrfToken, error: error.message }), 422, [], auth.secure);
    }
    return;
  }

  if (url.pathname === "/marketplace" && request.method === "GET") {
    const parseFilterPrice = (value) => {
      const minor = parseMoneyMinor(value);
      return minor === null ? null : minor;
    };
    const filters = {
      q: url.searchParams.get("q") || "",
      country: url.searchParams.get("country") || "",
      city: url.searchParams.get("city") || "",
      area: url.searchParams.get("area") || "",
      category: url.searchParams.get("category") || "",
      condition: url.searchParams.get("condition") || "",
      currency: url.searchParams.get("currency") || "",
      min: url.searchParams.get("min") || "",
      max: url.searchParams.get("max") || "",
      sort: url.searchParams.get("sort") || "relevance"
    };
    const results = searchMarketplace(db, { ...filters, minPriceMinor: parseFilterPrice(filters.min), maxPriceMinor: parseFilterPrice(filters.max) });
    const facets = marketplaceFacets(db);
    const key = visitorKey(request);
    for (const listing of results) recordMarketplaceEvent(db, { listingId: listing.id, storeId: listing.store_id, eventType: "impression", visitorKey: key, referrer: request.headers.referer || "" });
    sendHtml(response, marketplacePage({ results, filters, ...facets }), 200, [], secure);
    return;
  }

  const marketplaceClickMatch = /^\/marketplace\/click\/(\d+)$/.exec(url.pathname);
  if (marketplaceClickMatch && request.method === "GET") {
    const listing = getMarketplaceListing(db, Number(marketplaceClickMatch[1]));
    const destination = externalUrl(listing?.canonical_url);
    if (!listing || !destination || listing.moderation_status !== "active" || ["sold", "hidden"].includes(listing.status) || !isMarketplaceEligible(listing, resolvePolicy(db, { storeId: listing.store_id }))) {
      sendHtml(response, errorPage("Listing not found", "That marketplace listing is no longer available.", 404).html, 404, [], secure);
      return;
    }
    recordMarketplaceEvent(db, { listingId: listing.id, storeId: listing.store_id, eventType: "click", visitorKey: visitorKey(request), referrer: request.headers.referer || "" });
    redirect(response, destination, [], secure);
    return;
  }

  if (url.pathname === "/marketplace/report") {
    const listingId = Number(url.searchParams.get("listing"));
    const listing = getMarketplaceListing(db, listingId);
    if (!listing || listing.moderation_status !== "active" || ["sold", "hidden"].includes(listing.status) || !isMarketplaceEligible(listing, resolvePolicy(db, { storeId: listing.store_id }))) {
      sendHtml(response, errorPage("Listing not found", "That marketplace listing is no longer available.", 404).html, 404, [], secure);
      return;
    }
    if (request.method === "GET") {
      sendHtml(response, reportPage({ listing }), 200, [], secure);
      return;
    }
    if (request.method !== "POST") {
      sendHtml(response, errorPage("Method not allowed", "Use the report form to continue.", 405).html, 405, [], secure);
      return;
    }
    const form = await readForm(request);
    try {
      if (!reportAllowed(`${request.clientAddress || "unknown"}:${String(form.reporterEmail || "").toLowerCase()}`)) throw new Error("Too many reports from this source. Try again later.");
      reportListing(db, { listingId, reporterEmail: form.reporterEmail, reason: form.reason, details: form.details });
      recordMarketplaceEvent(db, { listingId, storeId: listing.store_id, eventType: "report", visitorKey: visitorKey(request), referrer: request.headers.referer || "" });
      sendHtml(response, reportPage({ listing, submitted: true }), 200, [], secure);
    } catch (error) {
      sendHtml(response, reportPage({ listing, errors: [error.message] }), 422, [], secure);
    }
    return;
  }

  if (url.pathname === "/marketplace/report-store") {
    const storeId = Number(url.searchParams.get("store"));
    const store = getHostedStore(db, storeId);
    if (!store || store.state === "deleted") {
      sendHtml(response, errorPage("Store not found", "That store is no longer available.", 404).html, 404, [], secure);
      return;
    }
    if (request.method === "GET") {
      sendHtml(response, storeReportPage({ store }), 200, [], secure);
      return;
    }
    if (request.method !== "POST") {
      sendHtml(response, errorPage("Method not allowed", "Use the report form to continue.", 405).html, 405, [], secure);
      return;
    }
    const form = await readForm(request);
    try {
      if (!reportAllowed(`${request.clientAddress || "unknown"}:${String(form.reporterEmail || "").toLowerCase()}`)) throw new Error("Too many reports from this source. Try again later.");
      reportStore(db, { storeId, reporterEmail: form.reporterEmail, reason: form.reason, details: form.details });
      recordMarketplaceEvent(db, { storeId, eventType: "report", visitorKey: visitorKey(request), referrer: request.headers.referer || "" });
      sendHtml(response, storeReportPage({ store, submitted: true }), 200, [], secure);
    } catch (error) {
      sendHtml(response, storeReportPage({ store, errors: [error.message] }), 422, [], secure);
    }
    return;
  }

  if (url.pathname === "/api/federation/v1/ingest" && request.method === "POST") {
    const timestamp = request.headers["x-yardsale-timestamp"];
    const signature = request.headers["x-yardsale-signature"];
    let body;
    try { body = await readBody(request); } catch (error) {
      sendJson(response, { error: error.message || "Request body is too large." }, 413, secure);
      return;
    }
    if (!verifyIngestSignature(config.webhookSecret, timestamp, body, signature)) {
      sendJson(response, { error: "Invalid signature" }, 401, secure);
      return;
    }
    try {
      const payload = JSON.parse(body);
      const store = getHostedStoreByPublicId(db, payload.store_id);
      if (!store) {
        sendJson(response, { error: "Store not found" }, 404, secure);
        return;
      }
      sendJson(response, ingestFederationFeed(db, { storeId: store.id, payload, actor: "federation-webhook" }), 200, secure);
    } catch (error) {
      sendJson(response, { error: error.message || "Invalid federation payload" }, 422, secure);
    }
    return;
  }

  if (url.pathname === "/api/payments/mock/webhook" && request.method === "POST") {
    let body;
    try { body = await readBody(request); } catch (error) {
      sendJson(response, { error: error.message || "Request body is too large." }, 413, secure);
      return;
    }
    if (!billing.verifyWebhook(body, request.headers["x-payment-signature"])) {
      sendJson(response, { error: "Invalid signature" }, 401, secure);
      return;
    }
    try {
      const payload = JSON.parse(body);
      const payment = billing.recordPayment(db, Number(payload.payment_id), "mock-provider");
      sendJson(response, { ok: true, payment_id: payment.id, status: payment.status }, 200, secure);
    } catch (error) {
      sendJson(response, { error: error.message || "Payment webhook failed" }, 422, secure);
    }
    return;
  }

  if (url.pathname === "/api/payments/payway/callback" && request.method === "POST") {
    if (config.billingProvider !== "aba-payway") {
      sendJson(response, { error: "PayWay billing is not enabled." }, 404, secure);
      return;
    }
    let body;
    try { body = await readBody(request); } catch (error) {
      sendJson(response, { error: error.message || "Request body is too large." }, 413, secure);
      return;
    }
    if (!billing.verifyWebhook(body, request.headers["x-payway-hmac-sha512"])) {
      sendJson(response, { error: "Invalid signature" }, 401, secure);
      return;
    }
    try {
      const payload = JSON.parse(body);
      const payment = billing.recordWebhook(db, payload, "aba-payway");
      sendJson(response, { ok: true, payment_id: payment.id, status: payment.status }, 200, secure);
    } catch (error) {
      sendJson(response, { error: error.message || "PayWay callback failed" }, 422, secure);
    }
    return;
  }

  if (url.pathname === "/admin" && request.method === "GET") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    sendHtml(response, adminView(db, config, auth, { userQuery: url.searchParams.get("user_q") || "", message: url.searchParams.get("saved") === "1" ? "Policy saved." : url.searchParams.get("action") === "1" ? "Store action applied." : url.searchParams.get("done") === "1" ? "Operation completed." : "" }), 200, [], auth.secure);
    return;
  }

  if (url.pathname === "/admin/policies" && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      const key = String(form.key || "");
      const value = validatePolicyValue(key, form.value);
      const before = resolvePolicy(db)[key];
      setPlatformPolicy(db, { key, value, actor: auth.session.email });
      createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, action: "policy.updated", metadata: { key, previous_value: before, new_value: value } });
      redirect(response, "/admin?saved=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message || "The policy could not be saved."] }), 422, [], auth.secure);
    }
    return;
  }

  if (url.pathname === "/admin/campaigns" && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      const startsAt = parseDateInput(form.startsAt);
      const endsAt = parseDateInput(form.endsAt);
      if (!String(form.name || "").trim() || !startsAt || !endsAt || endsAt <= startsAt) throw new Error("Campaign name and a valid date range are required.");
      const overrides = {};
      if (form.freeDays) overrides.default_free_days = validatePolicyValue("default_free_days", form.freeDays);
      if (form.paidDays) overrides.default_paid_days = validatePolicyValue("default_paid_days", form.paidDays);
      if (form.priceMinor) overrides.default_store_price_minor = validatePolicyValue("default_store_price_minor", form.priceMinor);
      if (form.marketplace !== undefined && form.marketplace !== "") overrides.marketplace_enabled = validatePolicyValue("marketplace_enabled", form.marketplace);
      if (form.storageQuota) overrides.storage_quota_bytes = validatePolicyValue("storage_quota_bytes", form.storageQuota);
      if (form.listingLimit) overrides.listing_limit = validatePolicyValue("listing_limit", form.listingLimit);
      const campaign = createCampaign(db, { name: String(form.name).trim().slice(0, 160), status: "active", startsAt, endsAt, eligibilityRule: parseJsonObject(form.eligibilityRule), overrides, createdBy: auth.session.email });
      createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, action: "campaign.created", metadata: { campaign_id: campaign.id, overrides } });
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message || "The campaign could not be created."] }), 422, [], auth.secure);
    }
    return;
  }

  if (url.pathname === "/admin/campaigns/status" && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      if (!campaignStatus(form.status)) throw new Error("Invalid campaign status.");
      setCampaignStatus(db, Number(form.id), form.status);
      createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, action: "campaign.status_changed", metadata: { campaign_id: Number(form.id), status: form.status } });
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message] }), 422, [], auth.secure);
    }
    return;
  }

  if (url.pathname === "/admin/coupons" && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      const startsAt = parseDateInput(form.startsAt);
      const endsAt = parseDateInput(form.endsAt);
      if (!String(form.code || "").trim() || !startsAt || !endsAt || endsAt <= startsAt) throw new Error("Coupon code and a valid date range are required.");
      const entitlementPayload = form.payloadJson ? parseJsonObject(form.payloadJson) : (form.freeDays ? { default_free_days: validatePolicyValue("default_free_days", form.freeDays) } : {});
      for (const [key, value] of Object.entries(entitlementPayload)) {
        if (!["period_extension_days", "default_free_days", "default_paid_days", "default_store_price_minor", "default_grace_days", "free_active_store_limit", "paid_marketplace_enabled", "marketplace_enabled", "storage_quota_bytes", "listing_limit"].includes(key)) throw new Error(`Coupon entitlement ${key} is not allowed.`);
        if (key !== "period_extension_days") validatePolicyValue(key, value);
        else if (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 3650) throw new Error("Coupon extension days must be a whole number from 1 to 3650.");
      }
      const maxRedemptions = form.maxRedemptions ? Number(form.maxRedemptions) : null;
      if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) throw new Error("Max redemptions must be a positive whole number.");
      const perAccountLimit = form.perAccountLimit ? Number(form.perAccountLimit) : 1;
      if (!Number.isInteger(perAccountLimit) || perAccountLimit < 1 || perAccountLimit > 100) throw new Error("Per-account limit must be a whole number from 1 to 100.");
      const coupon = createCoupon(db, { code: form.code, startsAt, endsAt, maxRedemptions, perAccountLimit, eligibilityRule: parseJsonObject(form.eligibilityRule), entitlementPayload, createdBy: auth.session.email });
      createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, action: "coupon.created", metadata: { coupon_id: coupon.id, code: coupon.code } });
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message || "The coupon could not be created."] }), 422, [], auth.secure);
    }
    return;
  }

  if (url.pathname === "/admin/coupons/status" && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      if (!couponStatus(form.status)) throw new Error("Invalid coupon status.");
      db.prepare("UPDATE coupons SET status = ?, updated_at = ? WHERE id = ?").run(form.status, new Date().toISOString(), Number(form.id));
      createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, action: "coupon.status_changed", metadata: { coupon_id: Number(form.id), status: form.status } });
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message] }), 422, [], auth.secure);
    }
    return;
  }

  if (url.pathname === "/admin/entitlements" && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      const storeId = Number(form.storeId);
      const key = String(form.key || "");
      const store = getHostedStore(db, storeId);
      if (!store) throw new Error("Store not found.");
      if (key === "period_extension_days") {
        const days = Number(form.value);
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Extension days must be a whole number from 1 to 3650.");
        extendStorePeriod(db, storeId, { days, mode: form.mode === "paid" ? "paid" : "comped", source: form.source === "manual_override" ? "manual_override" : "admin_comp", reason: form.reason || "Admin entitlement", actor: auth.session.email });
      } else {
        const value = validatePolicyValue(key, form.value);
        const endsAt = form.endsAt ? parseDateInput(form.endsAt) : null;
        if (form.endsAt && !endsAt) throw new Error("Enter a valid entitlement end date.");
        createStoreEntitlement(db, { storeId, source: form.source === "manual_override" ? "manual_override" : "admin_comp", key, value, endsAt, reason: String(form.reason || "Admin override").slice(0, 500), createdBy: auth.session.email });
      }
      createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, storeId, action: "entitlement.created", metadata: { key, value: form.value, reason: form.reason || "" } });
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message || "The entitlement could not be created."] }), 422, [], auth.secure);
    }
    return;
  }

  if (url.pathname === "/admin/expiry" && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      setStoreExpiry(db, Number(form.storeId), { endsAt: parseDateInput(form.endsAt), mode: form.mode === "paid" ? "paid" : "comped", reason: String(form.reason || "Admin expiry override").slice(0, 500), actor: auth.session.email });
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message] }), 422, [], auth.secure);
    }
    return;
  }

  const entitlementRevokeMatch = /^\/admin\/entitlements\/(\d+)\/revoke$/.exec(url.pathname);
  if (entitlementRevokeMatch && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      if (!revokeStoreEntitlement(db, Number(entitlementRevokeMatch[1]), auth.session.email)) throw new Error("Entitlement not found.");
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message] }), 422, [], auth.secure);
    }
    return;
  }

  const adminUserMatch = /^\/admin\/users\/(\d+)\/action$/.exec(url.pathname);
  if (adminUserMatch && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      const userId = Number(adminUserMatch[1]);
      if (userId === auth.session.user_id) throw new Error("Do not suspend the current operator session.");
      const status = form.action === "suspend" ? "suspended" : form.action === "resume" ? "active" : null;
      if (!status) throw new Error("That account action is not valid.");
      setUserStatus(db, userId, status, auth.session.email);
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message] }), 422, [], auth.secure);
    }
    return;
  }

  const adminPaymentMatch = /^\/admin\/payments\/(\d+)\/refund$/.exec(url.pathname);
  if (adminPaymentMatch && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      refundPayment(db, Number(adminPaymentMatch[1]), auth.session.email);
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message] }), 422, [], auth.secure);
    }
    return;
  }

  const adminReportMatch = /^\/admin\/reports\/(\d+)$/.exec(url.pathname);
  if (adminReportMatch && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      resolveReport(db, { reportId: Number(adminReportMatch[1]), status: form.status, actor: auth.session.email, blockListing: form.blockListing === "1" });
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message] }), 422, [], auth.secure);
    }
    return;
  }

  if (url.pathname === "/admin/blocklist" && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      addBlocklistEntry(db, { kind: form.kind, value: form.value, reason: form.reason, createdBy: auth.session.email });
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message] }), 422, [], auth.secure);
    }
    return;
  }

  const blocklistRemoveMatch = /^\/admin\/blocklist\/(\d+)\/remove$/.exec(url.pathname);
  if (blocklistRemoveMatch && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      if (!removeBlocklistEntry(db, Number(blocklistRemoveMatch[1]), auth.session.email)) throw new Error("Blocklist entry not found.");
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message] }), 422, [], auth.secure);
    }
    return;
  }

  if (url.pathname === "/admin/backup" && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      await createBackup(db, { dataDir: config.dataDir, backupDir: config.backupDir, runtime });
      createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, action: "backup.created" });
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message] }), 422, [], auth.secure);
    }
    return;
  }

  if (url.pathname === "/admin/upgrade" && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      await upgradeStores(db, runtime, { imageVersion: String(form.imageVersion || "").trim(), actor: auth.session.email });
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message] }), 422, [], auth.secure);
    }
    return;
  }

  if (url.pathname === "/admin/search/reconcile" && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    const stores = listHostedStores(db).filter((store) => store.state === "running");
    let reconciled = 0;
    for (const store of stores) {
      try { await reconcileStoreFeed(db, { storeId: store.id, actor: auth.session.email }); reconciled += 1; } catch (error) { console.error(JSON.stringify({ event: "search_reconcile_failed", store_id: store.id, error: error.message })); }
    }
    createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, action: "marketplace.reconciled", metadata: { stores: reconciled } });
    redirect(response, "/admin?done=1", [], auth.secure);
    return;
  }

  const adminStoreMatch = /^\/admin\/stores\/(\d+)\/action$/.exec(url.pathname);
  if (adminStoreMatch && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    const store = getHostedStore(db, Number(adminStoreMatch[1]));
    if (!store) {
      sendHtml(response, errorPage("Store not found", "That store no longer exists.", 404).html, 404, [], auth.secure);
      return;
    }
    try {
      const action = String(form.action || "");
      if (action === "suspend" && store.state === "running") {
        await runtime.suspendInstance({ store });
        setStoreState(db, store.id, "suspended");
        createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, storeId: store.id, action: "store.suspended" });
      } else if (action === "resume" && store.state === "suspended") {
        await runtime.resumeInstance({ store });
        setStoreState(db, store.id, "running");
        createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, storeId: store.id, action: "store.resumed" });
      } else if (action === "comp") {
        const days = Number(form.days);
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Comp days must be a whole number from 1 to 3650.");
        extendStorePeriod(db, store.id, { days, mode: "comped", reason: "Admin comp", actor: auth.session.email });
        createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, storeId: store.id, action: "store.comped", metadata: { days } });
      } else if (action === "deindex") {
        setStoreMarketplaceOptOut(db, store.id, true);
        deindexStore(db, store.id, auth.session.email);
        createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, storeId: store.id, action: "marketplace.opted_out" });
      } else if (action === "index") {
        setStoreMarketplaceOptOut(db, store.id, false);
        if (store.state === "running") await reconcileStoreFeed(db, { storeId: store.id, actor: auth.session.email });
        createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, storeId: store.id, action: "marketplace.opted_in" });
      } else if (action === "extend") {
        const days = Number(form.days);
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Extension days must be a whole number from 1 to 3650.");
        extendStorePeriod(db, store.id, { days, mode: "paid", source: "manual_override", reason: "Admin extension", actor: auth.session.email });
        createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, storeId: store.id, action: "store.extended", metadata: { days } });
      } else if (action === "delete") {
        await runtime.deleteInstance({ store });
        markStoreDeleted(db, store.id);
        releaseHostSlot(db, store);
        createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, storeId: store.id, action: "store.deleted" });
      } else if (action === "retry" && ["failed", "provisioning"].includes(store.state)) {
        recordProvisionAttempt(db, store.id);
        const instance = await runtime.createInstance({ store });
        if (config.runtimeExecute && runtime.waitUntilReady && !(await runtime.waitUntilReady({ store }))) throw new Error("The store runtime did not become ready in time.");
        setStoreRuntime(db, store.id, instance);
        createAuditEvent(db, { actor: auth.session.email, userId: auth.session.user_id, storeId: store.id, action: "store.provisioned_retry", metadata: { runtime_instance_id: instance.runtimeInstanceId } });
      } else {
        throw new Error("That store action is not valid for its current state.");
      }
      redirect(response, "/admin?action=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message || "The store action could not be applied."] }), 422, [], auth.secure);
    }
    return;
  }

  const adminMigrateMatch = /^\/admin\/stores\/(\d+)\/migrate$/.exec(url.pathname);
  if (adminMigrateMatch && request.method === "POST") {
    const auth = requireAdmin(request, response, db, config, "/admin");
    if (!auth) return;
    const form = await readForm(request);
    if (!sessionCsrfIsValid(auth.session, form.csrf)) {
      sendHtml(response, errorPage("Request blocked", "Your session form token was not valid.", 403).html, 403, [], auth.secure);
      return;
    }
    try {
      await migrateStore(db, runtime, { storeId: Number(adminMigrateMatch[1]), destinationHostId: Number(form.destinationHostId), actor: auth.session.email });
      redirect(response, "/admin?done=1", [], auth.secure);
    } catch (error) {
      sendHtml(response, adminView(db, config, auth, { errors: [error.message || "The store could not be migrated."] }), 422, [], auth.secure);
    }
    return;
  }

  sendHtml(response, errorPage("Not found", "That YardSale Cloud page does not exist.", 404).html, 404, [], secure);
}

export function createApp({ config = configFromEnvironment() } = {}) {
  const db = openDatabase(config.dataDir);
  const runtime = createRuntime({ kind: config.runtimeKind, dataDir: config.dataDir, execute: config.runtimeExecute });
  const billing = createBillingProvider({ name: config.billingProvider, secret: config.webhookSecret, merchantId: config.abaMerchantId, apiKey: config.abaApiKey, baseUrl: config.abaBaseUrl });
  let lastScheduledBackup = 0;
  const jobTimer = setInterval(() => {
    const shouldBackup = Date.now() - lastScheduledBackup >= (config.backupIntervalMs || 24 * 60 * 60 * 1000);
    runJobs({ db, runtime, ...(shouldBackup ? { dataDir: config.dataDir, backupDir: config.backupDir } : {}) })
      .then((result) => { if (shouldBackup && result.backup) lastScheduledBackup = Date.now(); })
      .catch((error) => console.error(JSON.stringify({ event: "scheduled_job_failed", error: error.message })));
  }, 60 * 1000);
  jobTimer.unref();
  const server = createServer((request, response) => {
    handleRequest(request, response, { db, config, runtime, billing }).catch((error) => {
      console.error(error);
      const secure = secureRequest(request, config);
      sendHtml(response, errorPage("Something went wrong", "The request could not be completed.", 500).html, 500, [], secure);
    });
  });
  server.on("close", () => {
    clearInterval(jobTimer);
    db.close();
  });
  return { server, db, runtime, billing, config };
}

if (process.argv[1] && process.argv[1].endsWith("/src/server.js")) {
  const app = createApp();
  app.server.listen(app.config.port, "0.0.0.0", () => {
    console.log(`YardSale Cloud listening on http://localhost:${app.config.port}`);
  });
}
