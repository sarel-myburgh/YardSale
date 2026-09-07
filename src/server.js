import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  addListingImage,
  adminCommentAction,
  adminReservationAction,
  cancelReservationByToken,
  createComment,
  createListing,
  createSetup,
  dashboardStats,
  deleteListing,
  expireReservations,
  getActiveReservationForListing,
  getListingById,
  getListingBySlug,
  getListingImageById,
  getReservationByToken,
  getStore,
  getUserByLogin,
  isSetupComplete,
  listListingImages,
  listListingFilterOptions,
  listApprovedComments,
  listComments,
  listListings,
  listReservations,
  makeUniqueSlug,
  openDatabase,
  reserveListing,
  setListingStatus,
  transaction,
  deleteListingImage,
  updateListing,
  updateStore
} from "./db.js";
import {
  clearCookie,
  clearLoginFailures,
  createSession,
  csrfCookie,
  getSession,
  hashPassword,
  loginBlocked,
  loginKey,
  noteLoginFailure,
  parseCookies,
  sessionCookie,
  sessionCsrfIsValid,
  verifyPassword
} from "./auth.js";
import {
  adminListingsPage,
  adminCommentsPage,
  dashboardPage,
  errorPage,
  homePage,
  itemPage,
  listingFormPage,
  loginPage,
  reservationsPage,
  reservationPage,
  exportPage,
  setupPage,
  storeSettingsPage
} from "./html.js";
import { federationCacheHeaders, federationFeed, federationManifest, publicOrigin } from "./federation.js";
import { createStoreExport, importStoreExport } from "./portable.js";
import {
  CONTACT_METHOD_OPTIONS,
  createSlidingWindowLimiter,
  dateTimeLocalToIso,
  normalizeCurrency,
  nowIso,
  parseMoney,
  safeNext,
  text,
  timezoneForInput
} from "./utils.js";

const MAX_FORM_BYTES = 128 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_PER_LISTING = 10;
const MAX_MULTIPART_BYTES = MAX_FORM_BYTES + (MAX_IMAGE_BYTES * MAX_IMAGES_PER_LISTING);
const RESERVATION_RATE_WINDOW_MS = 15 * 60 * 1000;
const reservationIpLimiter = createSlidingWindowLimiter({ limit: 5, windowMs: RESERVATION_RATE_WINDOW_MS });
const reservationListingLimiter = createSlidingWindowLimiter({ limit: 3, windowMs: RESERVATION_RATE_WINDOW_MS });
const COMMENT_RATE_WINDOW_MS = 15 * 60 * 1000;
const commentIpLimiter = createSlidingWindowLimiter({ limit: 5, windowMs: COMMENT_RATE_WINDOW_MS });
const commentListingLimiter = createSlidingWindowLimiter({ limit: 3, windowMs: COMMENT_RATE_WINDOW_MS });

const IMAGE_SIGNATURES = {
  jpeg: { extension: "jpg", contentType: "image/jpeg" },
  png: { extension: "png", contentType: "image/png" },
  webp: { extension: "webp", contentType: "image/webp" }
};

function configFromEnvironment() {
  const production = process.env.NODE_ENV === "production";
  const dataDir = process.env.YARDSALE_DATA_DIR || (production ? "/data" : join(process.cwd(), ".yardsale"));
  const port = Number(process.env.YARDSALE_PORT || process.env.PORT || 3000);
  return {
    dataDir,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000,
    cookieSecure: process.env.YARDSALE_COOKIE_SECURE === "true"
  };
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ time: nowIso(), event, ...fields }));
}

function applySecurityHeaders(response, secure = false) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
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

function sendFederationJson(request, response, payload, secure) {
  const { body, etag, lastModified } = federationCacheHeaders(payload);
  const notModified = request.headers["if-none-match"] === etag
    || (request.headers["if-none-match"] === undefined && Date.parse(request.headers["if-modified-since"] || "") >= Date.parse(lastModified));
  applySecurityHeaders(response, secure);
  response.statusCode = notModified ? 304 : 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=60");
  response.setHeader("ETag", etag);
  response.setHeader("Last-Modified", lastModified);
  if (!notModified) response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(notModified ? undefined : body);
}

function redirect(response, location, cookies = [], secure = false) {
  applySecurityHeaders(response, secure);
  response.statusCode = 303;
  response.setHeader("Location", location);
  if (cookies.length) response.setHeader("Set-Cookie", cookies);
  response.end();
}

function secureRequest(request, config) {
  return config.cookieSecure || request.headers["x-forwarded-proto"] === "https";
}

async function readForm(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_FORM_BYTES) throw new Error("Form is too large");
  }
  return Object.fromEntries(new URLSearchParams(body));
}

async function readRequestBuffer(request, maxBytes) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("Upload is too large");

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("Upload is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let cursor = body.indexOf(delimiter);

  while (cursor !== -1) {
    let partStart = cursor + delimiter.length;
    if (body.subarray(partStart, partStart + 2).toString() === "--") break;
    if (body.subarray(partStart, partStart + 2).toString() === "\r\n") partStart += 2;

    const nextBoundary = body.indexOf(delimiter, partStart);
    if (nextBoundary === -1) throw new Error("Invalid multipart form");
    let part = body.subarray(partStart, nextBoundary);
    if (part.subarray(-2).toString() === "\r\n") part = part.subarray(0, -2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) throw new Error("Invalid multipart form");
    const headers = part.subarray(0, headerEnd).toString("utf8").split("\r\n");
    const disposition = headers.find((header) => /^content-disposition:/i.test(header)) || "";
    const nameMatch = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition);
    if (!nameMatch) {
      cursor = nextBoundary;
      continue;
    }

    const name = nameMatch[1];
    const filenameMatch = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition);
    const contentType = (headers.find((header) => /^content-type:/i.test(header)) || "")
      .replace(/^content-type:\s*/i, "")
      .trim();
    const data = part.subarray(headerEnd + 4);
    if (filenameMatch) {
      files.push({ name, filename: filenameMatch[1], contentType, data });
    } else {
      fields[name] = data.toString("utf8");
    }
    cursor = nextBoundary;
  }

  return { form: fields, files };
}

async function readRequestForm(request) {
  const contentType = String(request.headers["content-type"] || "");
  if (!/^multipart\/form-data/i.test(contentType)) {
    return { form: await readForm(request), files: [] };
  }

  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || "").trim();
  if (!boundary || boundary.length > 200) throw new Error("Invalid multipart form");
  return parseMultipart(await readRequestBuffer(request, MAX_MULTIPART_BYTES), boundary);
}

function pathParts(url) {
  return url.pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

function contactMethodsFromForm(form) {
  const methods = [];
  const errors = [];
  for (let index = 1; index <= 3; index += 1) {
    const type = text(form[`contactMethod${index}`], 40).toLowerCase();
    const value = text(form[`contactDetails${index}`], 200);
    if (!type && !value) continue;

    const option = CONTACT_METHOD_OPTIONS.find((candidate) => candidate.value === type);
    if (!option) errors.push(`Choose a contact method for contact ${index}.`);
    if (!value) errors.push(`Enter details for contact ${index}.`);
    methods.push({ type, label: option?.label || type, value });
  }
  return { methods, errors };
}

function formErrorsForSetup(form) {
  const errors = [];
  if (!text(form.login, 120)) errors.push("Enter an email address or username.");
  if (String(form.password ?? "").length < 10) errors.push("Use a password with at least 10 characters.");
  if (!text(form.storeName, 100)) errors.push("Enter a store name.");
  if (!normalizeCurrency(form.currency)) errors.push("Enter a valid three-letter currency code.");
  if (!timezoneForInput(form.timezone)) errors.push("Choose a city or enter a valid timezone.");
  return errors;
}

function formErrorsForStore(form, contactResult = contactMethodsFromForm(form)) {
  const errors = [];
  if (!text(form.name, 100)) errors.push("Enter a store name.");
  if (!normalizeCurrency(form.currency)) errors.push("Enter a valid three-letter currency code.");
  if (!timezoneForInput(form.timezone)) errors.push("Choose a city or enter a valid timezone.");
  const holdDuration = Number(form.holdDurationMinutes ?? 60);
  if (!Number.isInteger(holdDuration) || holdDuration < 5 || holdDuration > 43200) errors.push("Hold duration must be between 5 and 43,200 minutes.");
  const reservationDuration = Number(form.reservationDurationMinutes);
  if (!Number.isInteger(reservationDuration) || reservationDuration < 5 || reservationDuration > 43200) errors.push("Reservation duration must be between 5 and 43,200 minutes.");
  errors.push(...contactResult.errors);
  return errors;
}

function storeValuesFromForm(form, contactResult = contactMethodsFromForm(form)) {
  return {
    name: text(form.name, 100),
    description: text(form.description, 3000),
    location: text(form.location, 200),
    currency: normalizeCurrency(form.currency) || "USD",
    timezone: timezoneForInput(form.timezone) || "UTC",
    holdDurationMinutes: Number(form.holdDurationMinutes ?? 60),
    reservationDurationMinutes: Number(form.reservationDurationMinutes),
    commentsEnabled: form.commentsEnabled === "on",
    federationEnabled: form.federationEnabled === "on",
    contactMethods: contactResult.methods
  };
}

function listingValuesFromForm(form, store, existing = null) {
  return {
    title: text(form.title, 160),
    description: text(form.description, 5000),
    price: String(form.price ?? "").trim(),
    priceMinor: parseMoney(form.price),
    currency: store.currency,
    category: text(form.category, 80),
    condition: text(form.condition, 80),
    quantity: String(form.quantity ?? "1").trim(),
    pickupNotes: text(form.pickupNotes, 1000),
    tags: text(form.tags, 500),
    published: form.published === "1" || form.published === "on",
    commentsEnabled: form.commentsEnabled === "1" || form.commentsEnabled === "on",
    slug: existing?.slug ?? ""
  };
}

function formErrorsForListing(values) {
  const errors = [];
  if (!values.title) errors.push("Enter a title.");
  if (values.priceMinor === null) errors.push("Enter a price with up to two decimal places.");
  const quantity = Number(values.quantity);
  if (!Number.isInteger(quantity) || quantity !== 1) errors.push("Quantity is 1 for now; each listing represents one item.");
  return errors;
}

function reservationRateLimited(request, listingId) {
  const clientKey = request.socket?.remoteAddress ?? "unknown";
  if (!reservationIpLimiter.allow(clientKey)) return true;
  return !reservationListingLimiter.allow(`${clientKey}:${listingId}`);
}

function commentRateLimited(request, listingId) {
  const clientKey = request.socket?.remoteAddress ?? "unknown";
  if (!commentIpLimiter.allow(clientKey)) return true;
  return !commentListingLimiter.allow(`${clientKey}:${listingId}`);
}

function detectImageType(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return IMAGE_SIGNATURES.jpeg;
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return IMAGE_SIGNATURES.png;
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return IMAGE_SIGNATURES.webp;
  return null;
}

function validateImageFiles(files, existingCount = 0) {
  const imageFiles = files.filter((file) => file.name === "images" && file.filename && file.data.length > 0);
  const errors = [];
  if (existingCount + imageFiles.length > MAX_IMAGES_PER_LISTING) {
    errors.push(`Keep the listing to ${MAX_IMAGES_PER_LISTING} photos or fewer.`);
  }
  for (const file of imageFiles) {
    if (file.data.length > MAX_IMAGE_BYTES) errors.push("Each photo must be 10 MB or smaller.");
    if (!detectImageType(file.data)) errors.push("Photos must be JPG, PNG, or WebP images.");
  }
  return { imageFiles, errors };
}

async function saveListingImages(db, config, listing, imageFiles, existingCount = 0) {
  if (!imageFiles.length) return [];
  const uploadDir = join(config.dataDir, "uploads");
  await mkdir(uploadDir, { recursive: true });
  const writtenPaths = [];

  try {
    for (const file of imageFiles) {
      const type = detectImageType(file.data);
      const filename = `${randomUUID()}.${type.extension}`;
      const destination = join(uploadDir, filename);
      await writeFile(destination, file.data, { flag: "wx", mode: 0o600 });
      writtenPaths.push(destination);
    }

    return transaction(db, () => writtenPaths.map((path, index) => addListingImage(db, {
      listingId: listing.id,
      path: basename(path),
      altText: listing.title,
      sortOrder: existingCount + index
    })));
  } catch (error) {
    await Promise.all(writtenPaths.map((path) => unlink(path).catch(() => {})));
    throw error;
  }
}

async function removeImageFiles(config, images = []) {
  await Promise.all(images.map((image) => unlink(join(config.dataDir, "uploads", basename(image.path))).catch(() => {})));
}

function listingWithImages(db, listing) {
  return listing ? { ...listing, images: listListingImages(db, listing.id) } : listing;
}

function listingsWithImages(db, listings) {
  return listings.map((listing) => listingWithImages(db, listing));
}

function listingFormValues(values) {
  return {
    ...values,
    quantity: values.quantity || "1"
  };
}

function csrfIsValid(request, session, form) {
  const cookieCsrf = parseCookies(request.headers.cookie).yardsale_csrf;
  return Boolean(cookieCsrf && form.csrf === cookieCsrf && sessionCsrfIsValid(session, form.csrf));
}

function adminSession(request, db) {
  return getSession(db, request.headers.cookie);
}

function loginRedirect(response, request, next, config) {
  redirect(response, `/login?next=${encodeURIComponent(next)}`, [], secureRequest(request, config));
}

async function handleSetup(request, response, db, config) {
  const secure = secureRequest(request, config);
  if (request.method === "GET") {
    sendHtml(response, setupPage({ values: { currency: "USD", timezone: "UTC" } }), 200, [], secure);
    return;
  }
  if (request.method !== "POST") {
    sendHtml(response, errorPage("Method not allowed", "That action is not available.", 405).html, 405, [], secure);
    return;
  }

  const form = await readForm(request);
  const errors = [];
  if (!sameOrigin(request)) errors.push("Open the setup page directly before submitting it.");
  errors.push(...formErrorsForSetup(form));
  if (errors.length) {
    sendHtml(response, setupPage({ values: { ...form, currency: String(form.currency ?? "").toUpperCase() }, errors }), 422, [], secure);
    return;
  }

  try {
    const userId = createSetup(db, {
      login: text(form.login, 120),
      passwordHash: await hashPassword(form.password),
      storeName: text(form.storeName, 100),
      currency: normalizeCurrency(form.currency),
      timezone: timezoneForInput(form.timezone)
    });
    const session = createSession(db, userId);
    log("setup_complete", { user_id: userId });
    redirect(response, "/admin", [
      sessionCookie(session.token, secure),
      csrfCookie(session.csrfToken, secure)
    ], secure);
  } catch (error) {
    if (String(error.message).includes("already complete") || String(error.code).includes("CONSTRAINT")) {
      redirect(response, "/login", [], secure);
      return;
    }
    throw error;
  }
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = request.headers.host;
  return origin === `http://${host}` || origin === `https://${host}`;
}

async function handleLogin(request, response, db, config, url) {
  const secure = secureRequest(request, config);
  const next = url.searchParams.get("next") || "";
  if (request.method === "GET") {
    sendHtml(response, loginPage({ next }), 200, [], secure);
    return;
  }
  if (request.method !== "POST") {
    sendHtml(response, errorPage("Method not allowed", "That action is not available.", 405).html, 405, [], secure);
    return;
  }

  const form = await readForm(request);
  const login = text(form.login, 120);
  const key = loginKey(request, login);
  if (loginBlocked(key)) {
    sendHtml(response, loginPage({ errors: ["Too many attempts. Try again in a few minutes."], login, next: form.next }), 429, [], secure);
    return;
  }

  const user = getUserByLogin(db, login);
  const valid = user && await verifyPassword(form.password, user.password_hash);
  if (!valid) {
    noteLoginFailure(key);
    log("login_failure");
    sendHtml(response, loginPage({ errors: ["The login details are not correct."], login, next: form.next }), 401, [], secure);
    return;
  }

  clearLoginFailures(key);
  db.prepare("UPDATE admin_users SET last_login_at = ? WHERE id = ?").run(nowIso(), user.id);
  const session = createSession(db, user.id);
  log("login_success", { user_id: user.id });
  redirect(response, safeNext(form.next), [sessionCookie(session.token, secure), csrfCookie(session.csrfToken, secure)], secure);
}

async function handleLogout(request, response, db, config) {
  const secure = secureRequest(request, config);
  const session = adminSession(request, db);
  if (!session) {
    redirect(response, "/", [], secure);
    return;
  }
  if (request.method !== "POST") {
    sendHtml(response, errorPage("Method not allowed", "Please use the log out button.", 405).html, 405, [], secure);
    return;
  }
  const form = await readForm(request);
  if (!csrfIsValid(request, session, form)) {
    sendHtml(response, errorPage("Request blocked", "Your session form token was not valid. Try again.", 403).html, 403, [], secure);
    return;
  }
  db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
  log("logout", { user_id: session.user_id });
  redirect(response, "/", [clearCookie("yardsale_session"), clearCookie("yardsale_csrf")], secure);
}

async function handleStoreAdmin(request, response, db, config, session, url) {
  const secure = secureRequest(request, config);
  const store = getStore(db);
  const csrf = parseCookies(request.headers.cookie).yardsale_csrf || "";
  if (request.method === "GET") {
    sendHtml(response, storeSettingsPage({ store, csrf, message: url.searchParams.get("saved") === "1" ? "Store settings saved." : "" }), 200, [], secure);
    return;
  }
  if (request.method !== "POST") {
    sendHtml(response, errorPage("Method not allowed", "That action is not available.", 405).html, 405, [], secure);
    return;
  }
  const form = await readForm(request);
  const errors = csrfIsValid(request, session, form) ? formErrorsForStore(form) : ["Your session form token was not valid. Refresh the page and try again."];
  const values = storeValuesFromForm(form);
  if (errors.length) {
    sendHtml(response, storeSettingsPage({ store, csrf, errors, values }), 422, [], secure);
    return;
  }
  updateStore(db, values);
  log("store_updated", { user_id: session.user_id });
  redirect(response, "/admin/store?saved=1", [], secure);
}

async function handleExportAdmin(request, response, db, config, session, parts, url) {
  const secure = secureRequest(request, config);
  const store = getStore(db);
  const csrf = parseCookies(request.headers.cookie).yardsale_csrf || "";

  if (parts.length === 2 && request.method === "GET") {
    const message = url.searchParams.get("imported") === "1" ? "Store data imported successfully." : "";
    sendHtml(response, exportPage({ store, csrf, message }), 200, [], secure);
    return;
  }

  if (parts.length === 3 && parts[2] === "download" && request.method === "GET") {
    const archive = await createStoreExport(db, config.dataDir);
    applySecurityHeaders(response, secure);
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Disposition", `attachment; filename="yardsale-export-${new Date().toISOString().slice(0, 10)}.zip"`);
    response.setHeader("Content-Length", archive.length);
    response.setHeader("Cache-Control", "no-store");
    response.end(archive);
    return;
  }

  if (parts.length === 2 && request.method === "POST") {
    const { form, files } = await readRequestForm(request);
    const errors = [];
    if (!csrfIsValid(request, session, form)) errors.push("Your session form token was not valid. Refresh the page and try again.");
    const archive = files.find((file) => file.name === "archive" && file.data.length > 0);
    if (!archive) errors.push("Choose a YardSale export file.");
    if (errors.length) {
      sendHtml(response, exportPage({ store, csrf, errors }), 422, [], secure);
      return;
    }

    try {
      const result = await importStoreExport(db, config.dataDir, archive.data);
      log("store_imported", { user_id: session.user_id, ...result });
      redirect(response, "/admin/export?imported=1", [], secure);
    } catch (error) {
      sendHtml(response, exportPage({ store, csrf, errors: [error.message || "The export could not be imported."] }), 422, [], secure);
    }
    return;
  }

  sendHtml(response, errorPage("Method not allowed", "That export action is not available.", 405).html, 405, [], secure);
}

async function handleNewListing(request, response, db, config, session) {
  const secure = secureRequest(request, config);
  const store = getStore(db);
  const csrf = parseCookies(request.headers.cookie).yardsale_csrf || "";
  if (request.method === "GET") {
    sendHtml(response, listingFormPage({ store, csrf }), 200, [], secure);
    return;
  }
  if (request.method !== "POST") {
    sendHtml(response, errorPage("Method not allowed", "That action is not available.", 405).html, 405, [], secure);
    return;
  }
  const { form, files } = await readRequestForm(request);
  const values = listingValuesFromForm(form, store);
  const imageValidation = validateImageFiles(files);
  const errors = csrfIsValid(request, session, form)
    ? [...formErrorsForListing(values), ...imageValidation.errors]
    : ["Your session form token was not valid. Refresh the page and try again."];
  if (errors.length) {
    sendHtml(response, listingFormPage({ store, values: listingFormValues(values), errors, csrf }), 422, [], secure);
    return;
  }
  const listing = createListing(db, {
    ...values,
    slug: makeUniqueSlug(db, values.title),
    priceMinor: values.priceMinor,
    quantity: 1
  });
  try {
    await saveListingImages(db, config, listing, imageValidation.imageFiles);
  } catch (error) {
    const images = deleteListing(db, listing.id);
    await removeImageFiles(config, images);
    throw error;
  }
  log("listing_created", { user_id: session.user_id, listing_id: listing.id });
  redirect(response, "/admin/listings?saved=1", [], secure);
}

async function handleEditListing(request, response, db, config, session, id, url = null) {
  const secure = secureRequest(request, config);
  const listing = listingWithImages(db, getListingById(db, id));
  if (!listing) {
    sendHtml(response, errorPage("Listing not found", "That item may have been removed.", 404).html, 404, [], secure);
    return;
  }
  const store = getStore(db);
  const csrf = parseCookies(request.headers.cookie).yardsale_csrf || "";
  if (request.method === "GET") {
    const saved = url?.searchParams.get("saved") === "1";
    const message = saved ? (url?.searchParams.get("photo") === "1" ? "Photo removed." : "Listing changes saved.") : "";
    sendHtml(response, listingFormPage({ store, listing, csrf, message, values: { ...listing, price: undefined, quantity: String(listing.quantity), published: Boolean(listing.published) } }), 200, [], secure);
    return;
  }
  if (request.method !== "POST") {
    sendHtml(response, errorPage("Method not allowed", "That action is not available.", 405).html, 405, [], secure);
    return;
  }
  const { form, files } = await readRequestForm(request);
  const values = listingValuesFromForm(form, store, listing);
  const existingImages = listing.images ?? [];
  const imageValidation = validateImageFiles(files, existingImages.length);
  const errors = csrfIsValid(request, session, form)
    ? [...formErrorsForListing(values), ...imageValidation.errors]
    : ["Your session form token was not valid. Refresh the page and try again."];
  if (errors.length) {
    sendHtml(response, listingFormPage({ store, listing, values: listingFormValues(values), errors, csrf }), 422, [], secure);
    return;
  }
  updateListing(db, id, { ...values, slug: listing.slug, quantity: 1 });
  await saveListingImages(db, config, listing, imageValidation.imageFiles, existingImages.length);
  log("listing_updated", { user_id: session.user_id, listing_id: id });
  redirect(response, `/admin/listings/${id}/edit?saved=1`, [], secure);
}

async function handleListingAction(request, response, db, config, session, id, action) {
  const secure = secureRequest(request, config);
  if (request.method !== "POST") {
    sendHtml(response, errorPage("Method not allowed", "That action is not available.", 405).html, 405, [], secure);
    return;
  }
  const form = await readForm(request);
  if (!csrfIsValid(request, session, form)) {
    sendHtml(response, errorPage("Request blocked", "Your session form token was not valid. Refresh the page and try again.", 403).html, 403, [], secure);
    return;
  }
  if (action === "delete") {
    const images = deleteListing(db, id);
    await removeImageFiles(config, images);
    log("listing_deleted", { user_id: session.user_id, listing_id: id });
  } else if (action === "status") {
    setListingStatus(db, id, form.status);
    log("listing_status_changed", { user_id: session.user_id, listing_id: id, status: form.status });
  }
  redirect(response, "/admin/listings?saved=1", [], secure);
}

async function handleDeleteImage(request, response, db, config, session, id) {
  const secure = secureRequest(request, config);
  if (request.method !== "POST") {
    sendHtml(response, errorPage("Method not allowed", "That action is not available.", 405).html, 405, [], secure);
    return;
  }
  const form = await readForm(request);
  if (!csrfIsValid(request, session, form)) {
    sendHtml(response, errorPage("Request blocked", "Your session form token was not valid. Refresh the page and try again.", 403).html, 403, [], secure);
    return;
  }
  const image = getListingImageById(db, id);
  if (!image) {
    sendHtml(response, errorPage("Photo not found", "That photo may have already been removed.", 404).html, 404, [], secure);
    return;
  }
  const deleted = deleteListingImage(db, id);
  if (deleted) await removeImageFiles(config, [deleted]);
  log("listing_image_deleted", { user_id: session.user_id, image_id: id, listing_id: image.listing_id });
  redirect(response, `/admin/listings/${image.listing_id}/edit?saved=1&photo=1`, [], secure);
}

async function handleAdminReservationAction(request, response, db, config, session, id) {
  const secure = secureRequest(request, config);
  if (request.method !== "POST") {
    sendHtml(response, errorPage("Method not allowed", "That action is not available.", 405).html, 405, [], secure);
    return;
  }
  const form = await readForm(request);
  if (!csrfIsValid(request, session, form)) {
    sendHtml(response, errorPage("Request blocked", "Your session form token was not valid. Refresh the page and try again.", 403).html, 403, [], secure);
    return;
  }
  const currentStore = getStore(db);
  const csrf = parseCookies(request.headers.cookie).yardsale_csrf || "";
  const reservationUntil = String(form.reservationUntil ?? "").trim();
  let reservationExpiresAt = null;
  if (form.action === "approve" && reservationUntil) {
    reservationExpiresAt = dateTimeLocalToIso(reservationUntil, currentStore.timezone);
    if (!reservationExpiresAt || Date.parse(reservationExpiresAt) <= Date.now()) {
      sendHtml(response, reservationsPage({
        store: currentStore,
        reservations: listReservations(db),
        csrf,
        errors: ["Choose a future reservation end time."],
        reservationForm: { id, value: reservationUntil }
      }), 422, [], secure);
      return;
    }
  }
  adminReservationAction(db, id, form.action, {
    holdDurationMinutes: currentStore.holdDurationMinutes,
    reservationDurationMinutes: currentStore.reservationDurationMinutes,
    reservationExpiresAt
  });
  log("reservation_action", { user_id: session.user_id, reservation_id: id, action: form.action });
  redirect(response, "/admin/reservations", [], secure);
}

async function handleAdminCommentAction(request, response, db, config, session, id) {
  const secure = secureRequest(request, config);
  if (request.method !== "POST") {
    sendHtml(response, errorPage("Method not allowed", "That action is not available.", 405).html, 405, [], secure);
    return;
  }
  const form = await readForm(request);
  if (!csrfIsValid(request, session, form)) {
    sendHtml(response, errorPage("Request blocked", "Your session form token was not valid. Refresh the page and try again.", 403).html, 403, [], secure);
    return;
  }
  adminCommentAction(db, id, form.action);
  log("comment_action", { user_id: session.user_id, comment_id: id, action: form.action });
  redirect(response, "/admin/comments?saved=1", [], secure);
}

async function handleAdmin(request, response, db, config, parts, url) {
  const session = adminSession(request, db);
  if (!session) {
    loginRedirect(response, request, `${url.pathname}${url.search}`, config);
    return;
  }

  expireReservations(db);
  const csrf = parseCookies(request.headers.cookie).yardsale_csrf || "";
  const store = getStore(db);

  if (parts.length === 1 && parts[0] === "admin" && request.method === "GET") {
    sendHtml(response, dashboardPage({ store, stats: dashboardStats(db), reservations: listReservations(db), csrf }), 200, [], secureRequest(request, config));
    return;
  }

  if (parts[1] === "store") {
    await handleStoreAdmin(request, response, db, config, session, url);
    return;
  }

  if (parts[1] === "export") {
    await handleExportAdmin(request, response, db, config, session, parts, url);
    return;
  }

  if (parts[1] === "images" && parts.length === 4 && parts[3] === "delete") {
    const imageId = Number(parts[2]);
    if (!Number.isInteger(imageId) || imageId < 1) {
      sendHtml(response, errorPage("Photo not found", "That photo may have been removed.", 404).html, 404, [], secureRequest(request, config));
      return;
    }
    await handleDeleteImage(request, response, db, config, session, imageId);
    return;
  }

  if (parts[1] === "listings") {
    if (parts.length === 2 && request.method === "GET") {
      sendHtml(response, adminListingsPage({ store, listings: listingsWithImages(db, listListings(db, { admin: true })), csrf, message: url.searchParams.get("saved") === "1" ? "Listing changes saved." : "" }), 200, [], secureRequest(request, config));
      return;
    }
    if (parts.length === 3 && parts[2] === "new") {
      await handleNewListing(request, response, db, config, session);
      return;
    }
    const id = Number(parts[2]);
    if (!Number.isInteger(id) || id < 1) {
      sendHtml(response, errorPage("Listing not found", "That item may have been removed.", 404).html, 404, [], secureRequest(request, config));
      return;
    }
    if (parts.length === 4 && parts[3] === "edit") {
      await handleEditListing(request, response, db, config, session, id, url);
      return;
    }
    if (parts.length === 4 && (parts[3] === "delete" || parts[3] === "status")) {
      await handleListingAction(request, response, db, config, session, id, parts[3]);
      return;
    }
  }

  if (parts[1] === "comments") {
    if (parts.length === 2 && request.method === "GET") {
      sendHtml(response, adminCommentsPage({ store, comments: listComments(db), csrf, message: url.searchParams.get("saved") === "1" ? "Comment updated." : "" }), 200, [], secureRequest(request, config));
      return;
    }
    const id = Number(parts[2]);
    if (parts.length === 4 && parts[3] === "action" && Number.isInteger(id) && id > 0) {
      await handleAdminCommentAction(request, response, db, config, session, id);
      return;
    }
  }

  if (parts[1] === "reservations") {
    if (parts.length === 2 && request.method === "GET") {
      sendHtml(response, reservationsPage({ store, reservations: listReservations(db), csrf }), 200, [], secureRequest(request, config));
      return;
    }
    const id = Number(parts[2]);
    if (parts.length === 4 && parts[3] === "action" && Number.isInteger(id) && id > 0) {
      await handleAdminReservationAction(request, response, db, config, session, id);
      return;
    }
  }

  sendHtml(response, errorPage("Not found", "That seller page does not exist.", 404).html, 404, [], secureRequest(request, config));
}

async function handlePublicHome(request, response, db, config, url) {
  expireReservations(db);
  const store = getStore(db);
  const query = url.searchParams.get("q") || "";
  const status = url.searchParams.get("status") || "";
  const category = url.searchParams.get("category") || "";
  const condition = url.searchParams.get("condition") || "";
  const minPrice = url.searchParams.get("minPrice") || "";
  const maxPrice = url.searchParams.get("maxPrice") || "";
  const sort = url.searchParams.get("sort") || "default";
  const filters = listListingFilterOptions(db);
  const listings = listingsWithImages(db, listListings(db, {
    query,
    status,
    category,
    condition,
    minPriceMinor: parseMoney(minPrice),
    maxPriceMinor: parseMoney(maxPrice),
    sort
  }));
  sendHtml(response, homePage({
    store,
    listings,
    query,
    status,
    category,
    condition,
    minPrice,
    maxPrice,
    sort,
    categories: filters.categories,
    conditions: filters.conditions
  }), 200, [], secureRequest(request, config));
}

async function handlePublicItem(request, response, db, config, slug, reserveRoute = false, commentRoute = false, url = null) {
  expireReservations(db);
  const listing = listingWithImages(db, getListingBySlug(db, slug));
  const secure = secureRequest(request, config);
  if (!listing || !listing.published || listing.status === "hidden") {
    sendHtml(response, errorPage("Item not found", "This listing is no longer public.", 404).html, 404, [], secure);
    return;
  }
  const store = getStore(db);
  const activeReservation = getActiveReservationForListing(db, listing.id);
  const commentsEnabled = Boolean(store.commentsEnabled && listing.comments_enabled !== 0);
  const comments = commentsEnabled ? listApprovedComments(db, listing.id) : [];
  if (request.method === "GET") {
    sendHtml(response, itemPage({
      store,
      listing,
      reservation: activeReservation,
      comments,
      commentMessage: url?.searchParams.get("commented") === "1" ? "Thanks — your comment is waiting for seller approval." : ""
    }), 200, [], secure);
    return;
  }
  if (request.method !== "POST" || (!reserveRoute && !commentRoute)) {
    sendHtml(response, errorPage("Method not allowed", "That action is not available.", 405).html, 405, [], secure);
    return;
  }

  const form = await readForm(request);
  if (commentRoute) {
    if (!commentsEnabled) {
      sendHtml(response, errorPage("Comments unavailable", "Comments are turned off for this listing.", 404).html, 404, [], secure);
      return;
    }
    if (String(form.website ?? "").trim()) {
      redirect(response, `/item/${encodeURIComponent(slug)}?commented=1`, [], secure);
      return;
    }

    const rawCommentName = String(form.commentName ?? "").trim();
    const rawCommentBody = String(form.commentBody ?? "").trim();
    const commentValues = {
      commentName: rawCommentName.slice(0, 80),
      commentBody: rawCommentBody.slice(0, 2000)
    };
    const commentErrors = [];
    if (!rawCommentName) commentErrors.push("Enter your name.");
    if (rawCommentName.length > 80) commentErrors.push("Keep your name to 80 characters or fewer.");
    if (!rawCommentBody) commentErrors.push("Write a comment.");
    if (rawCommentBody.length > 2000) commentErrors.push("Keep your comment to 2,000 characters or fewer.");
    if (commentErrors.length) {
      sendHtml(response, itemPage({ store, listing, reservation: activeReservation, comments, commentErrors, commentValues }), 422, [], secure);
      return;
    }
    if (commentRateLimited(request, listing.id)) {
      log("comment_rate_limited", { listing_id: listing.id });
      sendHtml(response, itemPage({ store, listing, reservation: activeReservation, comments, commentErrors: ["Too many comments. Please try again in a few minutes."], commentValues }), 429, [], secure);
      return;
    }
    createComment(db, { listingId: listing.id, displayName: commentValues.commentName, body: commentValues.commentBody });
    log("comment_created", { listing_id: listing.id });
    redirect(response, `/item/${encodeURIComponent(slug)}?commented=1`, [], secure);
    return;
  }

  const values = {
    buyerName: text(form.buyerName, 100),
    buyerContact: text(form.buyerContact, 200),
    buyerMessage: text(form.buyerMessage, 1000)
  };
  const errors = [];
  if (!values.buyerName) errors.push("Enter your name.");
  if (!values.buyerContact) errors.push("Enter one way for the seller to contact you.");
  if (errors.length) {
    sendHtml(response, itemPage({ store, listing, reservation: activeReservation, errors }), 422, [], secure);
    return;
  }
  if (reservationRateLimited(request, listing.id)) {
    log("reservation_rate_limited", { listing_id: listing.id });
    sendHtml(response, itemPage({ store, listing, reservation: activeReservation, errors: ["Too many hold requests. Please try again in a few minutes."] }), 429, [], secure);
    return;
  }
  const result = reserveListing(db, listing.id, { ...values, holdMinutes: store.holdDurationMinutes });
  if (!result.ok) {
    sendHtml(response, itemPage({ store, listing: listingWithImages(db, getListingBySlug(db, slug)), errors: ["This item was just reserved by someone else. Please choose another item."] }), 409, [], secure);
    return;
  }
  log("reservation_created", { listing_id: listing.id });
  redirect(response, `/reservation/${encodeURIComponent(result.publicId)}/${encodeURIComponent(result.secret)}`, [], secure);
}

async function handleReservation(request, response, db, config, parts, url) {
  const secure = secureRequest(request, config);
  if (parts.length < 3) {
    sendHtml(response, errorPage("Reservation not found", "That private link is incomplete.", 404).html, 404, [], secure);
    return;
  }
  expireReservations(db);
  const publicId = parts[1];
  const secret = parts[2];
  const reservation = getReservationByToken(db, publicId, secret);
  if (!reservation) {
    sendHtml(response, errorPage("Reservation not found", "That private link is not valid.", 404).html, 404, [], secure);
    return;
  }
  const store = getStore(db);
  if (request.method === "POST" && parts[3] === "cancel") {
    const cancelled = cancelReservationByToken(db, publicId, secret);
    log("reservation_cancelled_by_buyer", { reservation_id: reservation.id });
    redirect(response, `/reservation/${encodeURIComponent(publicId)}/${encodeURIComponent(secret)}?cancelled=${cancelled ? "1" : "0"}`, [], secure);
    return;
  }
  if (request.method !== "GET") {
    sendHtml(response, errorPage("Method not allowed", "That action is not available.", 405).html, 405, [], secure);
    return;
  }
  sendHtml(response, reservationPage({ store, reservation, secret, message: url.searchParams.get("cancelled") === "1" ? "Reservation cancelled." : "" }), 200, [], secure);
}

async function serveUpload(request, response, config, filename) {
  const secure = secureRequest(request, config);
  if (basename(filename) !== filename || !/^[a-f0-9-]{36}\.(?:jpg|png|webp)$/i.test(filename)) {
    sendHtml(response, errorPage("Not found", "That photo does not exist.", 404).html, 404, [], secure);
    return;
  }

  try {
    const image = await readFile(join(config.dataDir, "uploads", filename));
    applySecurityHeaders(response, secure);
    response.statusCode = 200;
    response.setHeader("Content-Type", {
      jpg: "image/jpeg",
      png: "image/png",
      webp: "image/webp"
    }[filename.split(".").pop().toLowerCase()]);
    response.setHeader("Content-Length", image.length);
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.end(request.method === "HEAD" ? undefined : image);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendHtml(response, errorPage("Not found", "That photo does not exist.", 404).html, 404, [], secure);
      return;
    }
    throw error;
  }
}

async function handleFederationManifest(request, response, db, config) {
  const secure = secureRequest(request, config);
  if (request.method !== "GET") {
    sendJson(response, { error: "Method not allowed" }, 405, secure);
    return;
  }
  const store = getStore(db);
  sendFederationJson(request, response, federationManifest(store, publicOrigin(request, secure)), secure);
}

async function handleFederationFeed(request, response, db, config) {
  const secure = secureRequest(request, config);
  if (request.method !== "GET") {
    sendJson(response, { error: "Method not allowed" }, 405, secure);
    return;
  }
  const store = getStore(db);
  sendFederationJson(request, response, federationFeed(db, store, publicOrigin(request, secure)), secure);
}

async function handleRequest(request, response, db, config) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const parts = pathParts(url);
  const secure = secureRequest(request, config);

  if (url.pathname === "/styles.css" && request.method === "GET") {
    const css = await readFile(join(process.cwd(), "public", "styles.css"));
    applySecurityHeaders(response, secure);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/css; charset=utf-8");
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.end(css);
    return;
  }
  if (url.pathname === "/app.js" && request.method === "GET") {
    const script = await readFile(join(process.cwd(), "public", "app.js"));
    applySecurityHeaders(response, secure);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.end(script);
    return;
  }
  if (parts[0] === "uploads" && parts.length === 2 && (request.method === "GET" || request.method === "HEAD")) {
    await serveUpload(request, response, config, parts[1]);
    return;
  }
  if (url.pathname === "/healthz") {
    sendJson(response, { status: "ok" }, 200, secure);
    return;
  }
  if (url.pathname === "/readyz") {
    sendJson(response, { status: "ready", setupRequired: !isSetupComplete(db) }, 200, secure);
    return;
  }

  if (!isSetupComplete(db)) {
    if (url.pathname === "/setup") {
      await handleSetup(request, response, db, config);
      return;
    }
    redirect(response, "/setup", [], secure);
    return;
  }

  if (url.pathname === "/setup") {
    redirect(response, "/admin", [], secure);
    return;
  }
  if (url.pathname === "/.well-known/yardsale-store.json") {
    await handleFederationManifest(request, response, db, config);
    return;
  }
  if (url.pathname === "/api/federation/v1/listings") {
    await handleFederationFeed(request, response, db, config);
    return;
  }
  if (url.pathname === "/login") {
    await handleLogin(request, response, db, config, url);
    return;
  }
  if (url.pathname === "/logout") {
    await handleLogout(request, response, db, config);
    return;
  }
  if (parts[0] === "admin") {
    await handleAdmin(request, response, db, config, parts, url);
    return;
  }
  if (parts[0] === "item" && parts[1]) {
    await handlePublicItem(request, response, db, config, parts[1], parts[2] === "reserve", parts[2] === "comment", url);
    return;
  }
  if (parts[0] === "reservation") {
    await handleReservation(request, response, db, config, parts, url);
    return;
  }
  if (parts.length === 0 && request.method === "GET") {
    await handlePublicHome(request, response, db, config, url);
    return;
  }
  sendHtml(response, errorPage("Not found", "That page does not exist.", 404).html, 404, [], secure);
}

export { handleRequest };

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnvironment();
  const db = openDatabase(config.dataDir);
  const server = createServer((request, response) => {
    handleRequest(request, response, db, config).catch((error) => {
      log("request_error", { message: error.message });
      if (!response.headersSent) {
        const secure = secureRequest(request, config);
        sendHtml(response, errorPage("Something went wrong", "The request could not be completed.", 500).html, 500, [], secure);
      } else {
        response.end();
      }
    });
  });

  server.listen(config.port, "0.0.0.0", () => {
    log("startup", { port: config.port, data_dir: config.dataDir });
  });
}
