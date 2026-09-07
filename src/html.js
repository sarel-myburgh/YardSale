import { CONTACT_METHOD_OPTIONS, escapeHtml, formatDate, formatMoney, moneyInput, TIMEZONE_OPTIONS, timezoneDisplay } from "./utils.js";

const statusLabel = {
  available: "Available",
  held: "Held",
  reserved: "Reserved",
  sold: "Sold",
  hidden: "Hidden",
  pending: "Pending",
  approved: "Approved",
  expired: "Expired",
  rejected: "Rejected",
  cancelled: "Cancelled",
  completed: "Completed"
};

function statusBadge(status) {
  return `<span class="badge badge-${escapeHtml(status)}">${statusLabel[status] ?? escapeHtml(status)}</span>`;
}

function openReservation(status) {
  return status === "held" || status === "reserved";
}

function reservationExpiry(reservation) {
  return reservation.status === "held" ? reservation.hold_expires_at : reservation.reservation_expires_at;
}

function statusAction(id, csrf, status, label) {
  return `<form method="post" action="/admin/listings/${id}/status" class="inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="status" value="${escapeHtml(status)}"><button class="button secondary" type="submit">${escapeHtml(label)}</button></form>`;
}

function commentAction(id, csrf, action, label, primary = false) {
  return `<form method="post" action="/admin/comments/${id}/action" class="inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="action" value="${escapeHtml(action)}"><button class="button ${primary ? "primary" : "secondary"}" type="submit">${escapeHtml(label)}</button></form>`;
}

function listingActions(listing, csrf) {
  if (listing.status === "available") {
    return `${statusAction(listing.id, csrf, "reserved", "Mark as reserved")}${statusAction(listing.id, csrf, "sold", "Mark sold")}${statusAction(listing.id, csrf, "hidden", "Hide")}`;
  }
  if (listing.status === "held") {
    return `${statusAction(listing.id, csrf, "reserved", "Mark as reserved")}${statusAction(listing.id, csrf, "available", "Make available")}`;
  }
  if (listing.status === "reserved") {
    return `${statusAction(listing.id, csrf, "available", "Make available")}${statusAction(listing.id, csrf, "sold", "Mark sold")}${statusAction(listing.id, csrf, "hidden", "Hide")}`;
  }
  return statusAction(listing.id, csrf, "available", listing.status === "hidden" ? "Unhide" : "Make available");
}

function layout({ title, body, storeName = "YardSale", admin = false, csrf = "" }) {
  const nav = admin
    ? `<nav class="nav"><a href="/admin">Dashboard</a><a href="/admin/listings">Listings</a><a href="/admin/reservations">Reservations</a><a href="/admin/comments">Comments</a><a href="/admin/store">Store settings</a><a href="/admin/export">Export / import</a><form method="post" action="/logout" class="inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="link-button" type="submit">Log out</button></form></nav>`
    : `<nav class="nav"><a href="/">Storefront</a><a href="/admin">Seller login</a></nav>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} · ${escapeHtml(storeName)}</title>
    <link rel="stylesheet" href="/styles.css?v=6">
    <script src="/app.js?v=3" defer></script>
  </head>
  <body>
    <header class="site-header"><div class="container header-inner"><a class="brand" href="/">${escapeHtml(storeName)}</a>${nav}</div></header>
    <main class="container">${body}</main>
    <footer class="site-footer"><div class="container">Powered by YardSale</div></footer>
  </body>
</html>`;
}

function errorsBlock(errors = []) {
  if (!errors.length) return "";
  return `<div class="notice error" role="alert"><strong>Please check the form:</strong><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`;
}

function notice(message, type = "success") {
  return message ? `<div class="notice ${type}" role="status">${escapeHtml(message)}</div>` : "";
}

function field(label, name, value, { type = "text", required = false, autocomplete = "", placeholder = "", help = "", minLength = 0, maxLength = 0 } = {}) {
  return `<label class="field"><span>${escapeHtml(label)}${required ? " *" : ""}</span><input type="${type}" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${required ? " required" : ""}${minLength ? ` minlength="${minLength}"` : ""}${maxLength ? ` maxlength="${maxLength}"` : ""}${autocomplete ? ` autocomplete="${escapeHtml(autocomplete)}"` : ""}${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ""}>${help ? `<small>${escapeHtml(help)}</small>` : ""}</label>`;
}

function timezoneField(value) {
  const options = TIMEZONE_OPTIONS.map((item) => `<option value="${escapeHtml(`${item.city} (${item.offset})`)}" label="${escapeHtml(item.timezone)}"></option>`).join("");
  return `<label class="field"><span>Timezone *</span><input list="timezone-options" name="timezone" value="${escapeHtml(timezoneDisplay(value))}" required placeholder="Type a city, e.g. Phnom Penh" autocomplete="off" data-select-on-focus><datalist id="timezone-options">${options}</datalist><small>Type a city or choose one. Phnom Penh automatically saves as GMT+7.</small></label>`;
}

function structuredLocationFields(location = {}) {
  return `<fieldset class="location-fieldset"><legend>Public location</legend><p class="muted">Add a simple display name plus optional city and country details. These fields can appear in public federation data.</p>
    ${field("Display location", "location", location.displayLocation ?? "", { placeholder: "Central Phnom Penh", maxLength: 200, help: "Shown to buyers, for example TTP / Russian Market." })}
    <div class="two-column">${field("City / town", "city", location.city ?? "", { placeholder: "Phnom Penh", maxLength: 100 })}${field("Area / neighborhood", "area", location.area ?? "", { placeholder: "Toul Tom Poung", maxLength: 100 })}</div>
    <div class="two-column">${field("Region / province", "region", location.region ?? "", { placeholder: "Phnom Penh", maxLength: 100 })}${field("Country", "countryName", location.countryName ?? "", { placeholder: "Cambodia", maxLength: 100 })}</div>
    <div class="two-column">${field("Country code", "countryCode", location.countryCode ?? "", { placeholder: "KH", maxLength: 3, help: "Optional two-letter code." })}${field("Latitude", "latitude", location.latitude ?? "", { type: "number", placeholder: "11.5564", help: "Optional, from -90 to 90." })}</div>
    ${field("Longitude", "longitude", location.longitude ?? "", { type: "number", placeholder: "104.9282", help: "Optional, from -180 to 180." })}
  </fieldset>`;
}

function textarea(label, name, value, { required = false, placeholder = "", rows = 5, help = "", maxLength = 0 } = {}) {
  return `<label class="field"><span>${escapeHtml(label)}${required ? " *" : ""}</span><textarea name="${escapeHtml(name)}" rows="${rows}"${required ? " required" : ""}${maxLength ? ` maxlength="${maxLength}"` : ""}${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ""}>${escapeHtml(value)}</textarea>${help ? `<small>${escapeHtml(help)}</small>` : ""}</label>`;
}

function adminPage(title, body, store, csrf, message = "") {
  return layout({ title, body: `${notice(message)}${body}`, storeName: store.name, admin: true, csrf });
}

function listingImages(listing) {
  return Array.isArray(listing?.images) ? listing.images.filter((image) => image?.path) : [];
}

function imageTag(image, listing, className, loading = "lazy") {
  return `<img class="${escapeHtml(className)}" src="${escapeHtml(`/uploads/${encodeURIComponent(image.path)}`)}" alt="${escapeHtml(image.alt_text || listing.title)}" loading="${loading}" decoding="async">`;
}

function listingCardVisual(listing) {
  const image = listingImages(listing)[0];
  return image
    ? imageTag(image, listing, "card-image")
    : `<div class="listing-placeholder" aria-hidden="true">${escapeHtml(listing.title.slice(0, 1).toUpperCase())}</div>`;
}

function listingMainVisual(listing) {
  const images = listingImages(listing);
  return images.length
    ? `<div class="gallery main-gallery${images.length === 1 ? " gallery-single" : ""}" aria-label="Photos of ${escapeHtml(listing.title)}">${images.map((image, index) => `<div class="gallery-frame">${imageTag(image, listing, "gallery-image", index === 0 ? "eager" : "lazy")}</div>`).join("")}</div>`
    : `<div class="listing-placeholder large" aria-hidden="true">${escapeHtml(listing.title.slice(0, 1).toUpperCase())}</div>`;
}

function adminListingVisual(listing) {
  const image = listingImages(listing)[0];
  return image
    ? imageTag(image, listing, "admin-listing-image")
    : `<div class="listing-placeholder small-placeholder" aria-hidden="true">${escapeHtml(listing.title.slice(0, 1).toUpperCase())}</div>`;
}

function contactMethodsMarkup(methods = []) {
  const entries = (Array.isArray(methods) ? methods : []).filter((method) => method?.value);
  if (!entries.length) return "";
  return `<section class="card contact-card"><div class="section-heading"><div><h2>Contact seller</h2><p class="muted">Questions? Reach out using one of these methods.</p></div></div><div class="contact-table"><div class="contact-table-row contact-table-head"><span>Method</span><span>Details</span></div>${entries.map((method) => `<div class="contact-table-row"><strong>${escapeHtml(method.label || method.type || "Contact")}</strong><span>${escapeHtml(method.value)}</span></div>`).join("")}</div></section>`;
}

function commentsSectionMarkup({ store, listing, comments = [], errors = [], values = {}, message = "" }) {
  const commentList = comments.length
    ? `<div class="comments-list">${comments.map((comment) => `<article class="comment"><div class="comment-meta"><strong>${escapeHtml(comment.display_name)}</strong><time datetime="${escapeHtml(comment.created_at)}">${escapeHtml(formatDate(comment.created_at, store.timezone))}</time></div><p>${escapeHtml(comment.body).replace(/\n/g, "<br>")}</p></article>`).join("")}</div>`
    : `<p class="muted">No comments yet. Ask a question or leave a note for the seller.</p>`;
  return `<section class="card comments-card"><div class="section-heading"><div><h2>Comments</h2><p class="muted">Comments are reviewed before they appear publicly.</p></div></div>${commentList}${message ? notice(message) : ""}${errorsBlock(errors)}<form method="post" action="/item/${encodeURIComponent(listing.slug)}/comment" class="form-grid"><input type="hidden" name="commentForm" value="1">${field("Display name", "commentName", values.commentName ?? "", { required: true, autocomplete: "name", maxLength: 80, placeholder: "Your name" })}${textarea("Comment", "commentBody", values.commentBody ?? "", { required: true, rows: 4, maxLength: 2000, placeholder: "Ask a question or share a helpful note." })}<label class="honeypot" aria-hidden="true">Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label><button class="button primary" type="submit">Post comment</button></form></section>`;
}

function contactMethodsField(methods = []) {
  const entries = Array.isArray(methods) ? methods : [];
  const visibleCount = Math.max(1, Math.min(entries.length, 3));
  const optionMarkup = (selected) => `<option value="">Choose a method</option>${CONTACT_METHOD_OPTIONS.map((option) => `<option value="${escapeHtml(option.value)}"${selected === option.value ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}`;
  const rows = [0, 1, 2].map((index) => {
    const entry = entries[index] ?? {};
    const selected = String(entry.type ?? "").toLowerCase();
    const details = entry.value ?? entry.details ?? "";
    return `<div class="contact-entry" data-contact-row${index >= visibleCount ? " hidden" : ""}><label class="field"><span>Method</span><select name="contactMethod${index + 1}" aria-label="Contact method ${index + 1}">${optionMarkup(selected)}</select></label><label class="field"><span>Details</span><input type="text" name="contactDetails${index + 1}" value="${escapeHtml(details)}" maxlength="200" placeholder="${index === 0 ? "+855 12 345 678 or username" : "Optional additional contact"}"></label></div>`;
  }).join("");
  return `<fieldset class="contact-fieldset"><legend>Public contact details</legend><p class="muted">These details appear on your public storefront and listing pages.</p><div data-contact-list>${rows}</div><button class="button secondary add-contact" type="button" data-add-contact${visibleCount >= 3 ? " hidden" : ""}>Add another</button></fieldset>`;
}

function existingImagesMarkup(listing, csrf) {
  const images = listingImages(listing);
  if (!images.length) return "";
  return `<section class="image-manager"><div class="section-heading"><h2>Current photos</h2><span class="muted">${images.length} saved</span></div><div class="existing-images">${images.map((image) => `<div class="existing-image">${imageTag(image, listing, "existing-image-preview", "lazy")}<form method="post" action="/admin/images/${image.id}/delete" class="inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="button secondary image-remove" type="submit">Remove</button></form></div>`).join("")}</div></section>`;
}

export function setupPage({ values = {}, errors = [] } = {}) {
  const body = `<section class="auth-shell">
    <div class="eyebrow">Welcome to YardSale</div>
    <h1>Create your store</h1>
    <p class="lede">Set up your seller account and storefront once. You can change the store details later.</p>
    ${errorsBlock(errors)}
    <form method="post" action="/setup" class="card form-grid">
      ${field("Email or username", "login", values.login ?? "", { required: true, autocomplete: "username", help: "Used when you sign in as the seller." })}
      ${field("Password", "password", "", { type: "password", required: true, minLength: 10, autocomplete: "new-password", help: "Use at least 10 characters. No capitals, numbers, or symbols are required." })}
      <div class="form-divider"></div>
      ${field("Store name", "storeName", values.storeName ?? "", { required: true, placeholder: "Saturday Yard Sale" })}
      ${field("Currency", "currency", values.currency ?? "USD", { required: true, placeholder: "USD", help: "Three-letter currency code, such as USD or EUR." })}
      ${timezoneField(values.timezone ?? "UTC")}
      <button class="button primary" type="submit">Create account and store</button>
    </form>
  </section>`;
  return layout({ title: "Create your store", body });
}

export function loginPage({ errors = [], login = "", next = "" } = {}) {
  const body = `<section class="auth-shell compact">
    <div class="eyebrow">Seller area</div>
    <h1>Sign in</h1>
    ${errorsBlock(errors)}
    <form method="post" action="/login" class="card form-grid">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      ${field("Email or username", "login", login, { required: true, autocomplete: "username" })}
      ${field("Password", "password", "", { type: "password", required: true, autocomplete: "current-password" })}
      <button class="button primary" type="submit">Sign in</button>
    </form>
  </section>`;
  return layout({ title: "Sign in", body });
}

export function homePage({
  store,
  listings,
  query = "",
  status = "",
  category = "",
  condition = "",
  minPrice = "",
  maxPrice = "",
  sort = "default",
  categories = [],
  conditions = []
}) {
  const categoryOptions = categories.length ? categories : [...new Set(listings.map((listing) => listing.category).filter(Boolean))].sort();
  const conditionOptions = conditions.length ? conditions : [...new Set(listings.map((listing) => listing.condition).filter(Boolean))].sort();
  const sortValue = ["default", "newest", "price-asc", "price-desc"].includes(sort) ? sort : "default";
  const listingMarkup = listings.length
    ? `<div class="listing-grid">${listings.map((listing) => listingCard(listing, store)).join("")}</div>`
    : `<div class="empty-state"><h2>No items found</h2><p>Try a different search, or check back soon.</p></div>`;
  const body = `<section class="store-hero">
    <div class="eyebrow">A little place for good things</div>
    <h1>${escapeHtml(store.name)}</h1>
    <p class="lede">${escapeHtml(store.description)}</p>
    ${store.location ? `<p class="muted">Pickup area: ${escapeHtml(store.location)}</p>` : ""}
  </section>
  ${contactMethodsMarkup(store.contactMethods)}
  <form class="filters card" method="get" action="/">
    <label class="search-field"><span class="sr-only">Search listings</span><input type="search" name="q" value="${escapeHtml(query)}" placeholder="Search items"></label>
    <label><span class="sr-only">Availability</span><select name="status"><option value="">All availability</option><option value="available"${status === "available" ? " selected" : ""}>Available</option><option value="held"${status === "held" ? " selected" : ""}>Held</option><option value="reserved"${status === "reserved" ? " selected" : ""}>Reserved</option><option value="sold"${status === "sold" ? " selected" : ""}>Sold</option></select></label>
    <label><span class="sr-only">Category</span><select name="category"><option value="">All categories</option>${categoryOptions.map((item) => `<option value="${escapeHtml(item)}"${category === item ? " selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select></label>
    <label><span class="sr-only">Condition</span><select name="condition"><option value="">All conditions</option>${conditionOptions.map((item) => `<option value="${escapeHtml(item)}"${condition === item ? " selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select></label>
    <label class="filter-price"><span class="sr-only">Minimum price</span><input type="number" name="minPrice" value="${escapeHtml(minPrice)}" min="0" step="0.01" placeholder="Min price"></label>
    <label class="filter-price"><span class="sr-only">Maximum price</span><input type="number" name="maxPrice" value="${escapeHtml(maxPrice)}" min="0" step="0.01" placeholder="Max price"></label>
    <label><span class="sr-only">Sort listings</span><select name="sort"><option value="default"${sortValue === "default" ? " selected" : ""}>Recommended</option><option value="newest"${sortValue === "newest" ? " selected" : ""}>Newest</option><option value="price-asc"${sortValue === "price-asc" ? " selected" : ""}>Price: low to high</option><option value="price-desc"${sortValue === "price-desc" ? " selected" : ""}>Price: high to low</option></select></label>
    <div class="filter-actions"><button class="button" type="submit">Search</button>${query || status || category || condition || minPrice || maxPrice || sortValue !== "default" ? `<a class="button secondary" href="/">Clear</a>` : ""}</div>
  </form>
  ${listingMarkup}`;
  return layout({ title: "Storefront", body, storeName: store.name });
}

function listingCard(listing, store) {
  return `<article class="listing-card">
    <a class="listing-card-link" href="/item/${encodeURIComponent(listing.slug)}">
      ${listingCardVisual(listing)}
      <div class="listing-card-content"><div class="card-top"><h2>${escapeHtml(listing.title)}</h2>${statusBadge(listing.status)}</div><p class="price">${formatMoney(listing.price_minor, listing.currency || store.currency)}</p>${listing.condition ? `<p class="muted">${escapeHtml(listing.condition)}</p>` : ""}</div>
    </a>
  </article>`;
}

export function itemPage({ store, listing, reservation = null, comments = [], commentErrors = [], commentValues = {}, commentMessage = "", errors = [], values = {}, message = "" }) {
  const available = listing.status === "available";
  const commentsEnabled = Boolean(store.commentsEnabled && listing.comments_enabled !== 0);
  const body = `<section class="item-layout">
    <div class="item-visual">${listingMainVisual(listing)}</div>
    <article class="item-content">
      <div class="card-top"><div>${listing.category ? `<div class="eyebrow">${escapeHtml(listing.category)}</div>` : ""}<h1>${escapeHtml(listing.title)}</h1></div>${statusBadge(listing.status)}</div>
      <p class="price large-price">${formatMoney(listing.price_minor, listing.currency || store.currency)}</p>
      ${listing.condition ? `<p class="muted">Condition: ${escapeHtml(listing.condition)}</p>` : ""}
      ${listing.description ? `<div class="prose">${escapeHtml(listing.description).replace(/\n/g, "<br>")}</div>` : ""}
      ${listing.pickup_notes ? `<div class="note"><strong>Pickup / delivery</strong><p>${escapeHtml(listing.pickup_notes).replace(/\n/g, "<br>")}</p></div>` : ""}
      ${contactMethodsMarkup(store.contactMethods)}
      ${reservation ? `<div class="notice warning">${reservation.status === "held" ? "Hold requested until" : "Reserved until"} ${escapeHtml(formatDate(reservationExpiry(reservation), store.timezone))}.</div>` : listing.status === "reserved" ? `<div class="notice warning">This item is currently reserved.</div>` : ""}
      ${available ? `<div class="card reserve-card"><h2>Request a hold</h2><p class="muted">No buyer account is needed. The seller will review your request before the item is reserved.</p>${errorsBlock(errors)}<form method="post" action="/item/${encodeURIComponent(listing.slug)}/reserve" class="form-grid">${field("Your name", "buyerName", values.buyerName ?? "", { required: true, autocomplete: "name" })}${field("Contact method", "buyerContact", values.buyerContact ?? "", { required: true, placeholder: "Phone, email, or messenger" })}${textarea("Message (optional)", "buyerMessage", values.buyerMessage ?? "", { rows: 3 })}<button class="button primary" type="submit">Request hold</button></form></div>` : ""}
      ${message ? notice(message) : ""}
      ${commentsEnabled ? commentsSectionMarkup({ store, listing, comments, errors: commentErrors, values: commentValues, message: commentMessage }) : ""}
    </article>
  </section>`;
  return layout({ title: listing.title, body, storeName: store.name });
}

export function reservationPage({ store, reservation, secret, message = "" }) {
  const active = openReservation(reservation.status);
  const held = reservation.status === "held";
  const cancelPath = `/reservation/${encodeURIComponent(reservation.public_id)}/${encodeURIComponent(secret)}/cancel`;
  const body = `<section class="auth-shell">
    <div class="eyebrow">Private reservation link</div>
    <h1>${held ? "Your hold request" : reservation.status === "reserved" ? "Your item is reserved" : "Reservation details"}</h1>
    ${notice(message)}
    <div class="card">
      <div class="card-top"><h2>${escapeHtml(reservation.title)}</h2>${statusBadge(reservation.status)}</div>
      <p class="price">${formatMoney(reservation.price_minor, reservation.currency || store.currency)}</p>
      <dl class="details"><div><dt>Name</dt><dd>${escapeHtml(reservation.buyer_name)}</dd></div><div><dt>Contact</dt><dd>${escapeHtml(reservation.buyer_contact)}</dd></div>${reservation.buyer_message ? `<div><dt>Message</dt><dd>${escapeHtml(reservation.buyer_message)}</dd></div>` : ""}${active ? `<div><dt>${held ? "Hold expires" : "Reserved until"}</dt><dd>${escapeHtml(formatDate(reservationExpiry(reservation), store.timezone))}</dd></div>` : ""}</dl>
      <p><a href="/item/${encodeURIComponent(reservation.slug)}">View listing</a></p>
      ${active ? `<form method="post" action="${cancelPath}" class="inline-form"><button class="button secondary" type="submit">Cancel ${held ? "hold request" : "reservation"}</button></form>` : `<p class="muted">This reservation is no longer active.</p>`}
    </div>
  </section>`;
  return layout({ title: "Reservation", body, storeName: store.name });
}

export function dashboardPage({ store, stats, reservations, csrf }) {
  const recent = reservations.filter((item) => openReservation(item.status)).slice(0, 5);
  const recentMarkup = recent.length
    ? `<div class="stack">${recent.map((item) => `<div class="list-row"><div><strong>${escapeHtml(item.title)}</strong><span class="muted"> · ${escapeHtml(item.buyer_name)}</span><br><small>Until ${escapeHtml(formatDate(reservationExpiry(item), store.timezone))}</small></div>${statusBadge(item.status)}</div>`).join("")}</div>`
    : `<div class="empty-state small"><p>No active holds or reservations.</p></div>`;
  const body = `<div class="page-heading"><div><div class="eyebrow">Seller area</div><h1>Dashboard</h1></div><a class="button primary" href="/admin/listings/new">Add item</a></div>
    <div class="stat-grid"><div class="stat"><span>Available</span><strong>${stats.available}</strong></div><div class="stat"><span>Held</span><strong>${stats.held}</strong></div><div class="stat"><span>Reserved</span><strong>${stats.reserved}</strong></div><div class="stat"><span>Sold</span><strong>${stats.sold}</strong></div><div class="stat"><span>Open requests</span><strong>${stats.activeReservations}</strong></div></div>
    <section class="card"><div class="section-heading"><h2>Open requests</h2><a href="/admin/reservations">View all</a></div>${recentMarkup}</section>`;
  return adminPage("Dashboard", body, store, csrf);
}

export function adminListingsPage({ store, listings, csrf, message = "" }) {
  const markup = listings.length
    ? `<div class="admin-list">${listings.map((listing) => `<article class="admin-listing card">${adminListingVisual(listing)}<div class="admin-listing-main"><div class="card-top"><div><h2>${escapeHtml(listing.title)}</h2><p class="muted">${formatMoney(listing.price_minor, listing.currency || store.currency)}${listing.category ? ` · ${escapeHtml(listing.category)}` : ""} · ${listing.published ? "Public" : "Private"}</p></div>${statusBadge(listing.status)}</div><div class="button-row"><a class="button secondary" href="/admin/listings/${listing.id}/edit">Edit</a><a class="button secondary" href="/item/${encodeURIComponent(listing.slug)}">View</a>${listingActions(listing, csrf)}</div></div></article>`).join("")}</div>`
    : `<div class="empty-state"><h2>Your storefront is empty</h2><p>Add your first item to make the public page useful.</p><a class="button primary" href="/admin/listings/new">Add item</a></div>`;
  const body = `<div class="page-heading"><div><div class="eyebrow">Seller area</div><h1>Listings</h1></div><a class="button primary" href="/admin/listings/new">Add item</a></div>${notice(message)}${markup}`;
  return adminPage("Listings", body, store, csrf);
}

export function listingFormPage({ store, listing = null, values = {}, errors = [], csrf = "", message = "" }) {
  const editing = Boolean(listing);
  const published = values.published === undefined
    ? true
    : values.published === true || values.published === 1 || values.published === "1" || values.published === "on";
  const commentsEnabled = values.commentsEnabled === undefined
    ? listing?.comments_enabled !== 0
    : values.commentsEnabled === true || values.commentsEnabled === 1 || values.commentsEnabled === "1" || values.commentsEnabled === "on";
  const body = `<div class="page-heading"><div><div class="eyebrow">Seller area</div><h1>${editing ? "Edit item" : "Add item"}</h1></div><a class="button secondary" href="/admin/listings">Back to listings</a></div>
    ${errorsBlock(errors)}
    <form method="post" action="${editing ? `/admin/listings/${listing.id}/edit` : "/admin/listings/new"}" class="card form-grid" enctype="multipart/form-data">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      ${field("Title", "title", values.title ?? "", { required: true, placeholder: "Vintage desk lamp" })}
      ${textarea("Description", "description", values.description ?? "", { rows: 6, placeholder: "Tell buyers what makes it useful." })}
      <div class="two-column">${field("Price", "price", values.price ?? (listing ? moneyInput(listing.price_minor) : ""), { required: true, placeholder: "25.00", help: `Displayed in ${store.currency}.` })}${field("Category", "category", values.category ?? "", { placeholder: "Home" })}</div>
      <div class="two-column">${field("Condition", "condition", values.condition ?? "", { placeholder: "Good" })}${field("Quantity", "quantity", values.quantity ?? "1", { type: "number", required: true, help: "This first slice reserves one listing at a time." })}</div>
      ${textarea("Pickup / delivery notes", "pickupNotes", values.pickupNotes ?? "", { rows: 3, placeholder: "Pickup near..." })}
      ${field("Tags", "tags", values.tags ?? "", { placeholder: "lamp, vintage, brass", help: "Separate tags with commas." })}
      <label class="checkbox-field"><input type="checkbox" name="published" value="1"${published ? " checked" : ""}> <span>Show this item on the public storefront</span></label>
      <label class="checkbox-field"><input type="checkbox" name="commentsEnabled" value="1"${commentsEnabled ? " checked" : ""}> <span>Allow comments on this item</span></label>
      <label class="field"><span>Photos</span><input type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple data-image-input><small>Select up to 10 JPG, PNG, or WebP photos. Each photo can be up to 10 MB.</small><span id="image-selection" class="muted" aria-live="polite"></span></label>
      ${editing ? existingImagesMarkup(listing, csrf) : ""}
      <div class="button-row"><button class="button primary" type="submit">${editing ? "Save changes" : "Create item"}</button>${editing ? `<a class="button secondary" href="/item/${encodeURIComponent(listing.slug)}">View public page</a>` : ""}</div>
    </form>`;
  return adminPage(editing ? "Edit item" : "Add item", body, store, csrf, message);
}

export function storeSettingsPage({ store, csrf, errors = [], message = "", values = {} }) {
  const current = { ...store, ...values };
  const location = { ...(store.structuredLocation ?? {}), ...(current.structuredLocation ?? {}) };
  const body = `<div class="page-heading"><div><div class="eyebrow">Seller area</div><h1>Store settings</h1></div></div>${errorsBlock(errors)}
    <form method="post" action="/admin/store" class="card form-grid"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      ${field("Store name", "name", current.name, { required: true })}
      ${textarea("Description", "description", current.description, { rows: 4 })}
      ${structuredLocationFields(location)}
      <div class="two-column">${field("Currency", "currency", current.currency, { required: true })}${timezoneField(current.timezone)}</div>
      <div class="two-column">${field("Hold duration (minutes)", "holdDurationMinutes", String(current.holdDurationMinutes), { type: "number", required: true, help: "Default: 60 minutes while you review a request." })}${field("Reservation duration (minutes)", "reservationDurationMinutes", String(current.reservationDurationMinutes), { type: "number", required: true, help: "Default: 1440 minutes after approval." })}</div>
      ${contactMethodsField(current.contactMethods)}
      <label class="checkbox-field"><input type="checkbox" name="commentsEnabled"${current.commentsEnabled ? " checked" : ""}> <span>Allow comments on listings</span></label>
      <label class="checkbox-field"><input type="checkbox" name="federationEnabled"${current.federationEnabled ? " checked" : ""}> <span>Allow public marketplace indexing</span></label>
      ${field("Federation control secret", "federationControlSecret", "", { type: "password", autocomplete: "new-password", placeholder: current.federationControlConfigured ? "Leave blank to keep the current secret" : "Optional shared secret", help: "Optional: managed federation can use this secret to sign settings requests. It is never shown or exported." })}
      ${current.federationControlConfigured ? `<label class="checkbox-field"><input type="checkbox" name="clearFederationControlSecret"> <span>Remove the federation control secret</span></label>` : ""}
      <button class="button primary" type="submit">Save store settings</button>
    </form>`;
  return adminPage("Store settings", body, current, csrf, message);
}

export function exportPage({ store, csrf, errors = [], message = "" }) {
  const body = `<div class="page-heading"><div><div class="eyebrow">Seller area</div><h1>Export / import</h1></div></div>${errorsBlock(errors)}${notice(message)}
    <div class="two-column">
      <section class="card form-grid"><div><h2>Download a backup</h2><p class="muted">Includes your store settings, listings, photos, reservations, and comments.</p></div><a class="button primary" href="/admin/export/download">Download export</a></section>
      <section class="card form-grid"><div><h2>Restore an export</h2><p class="muted">This replaces the current store data but keeps your seller login.</p></div><form method="post" action="/admin/export" class="form-grid" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label class="field"><span>YardSale export</span><input type="file" name="archive" accept=".zip,application/zip" required><small>Choose a YardSale .zip export.</small></label><button class="button primary" type="submit">Import export</button></form></section>
    </div>`;
  return adminPage("Export / import", body, store, csrf);
}

export function adminCommentsPage({ store, comments, csrf, message = "" }) {
  const markup = comments.length
    ? `<div class="stack">${comments.map((comment) => {
      const actions = comment.status === "pending"
        ? `${commentAction(comment.id, csrf, "approve", "Approve", true)}${commentAction(comment.id, csrf, "hide", "Hide")}${commentAction(comment.id, csrf, "delete", "Delete")}`
        : comment.status === "approved"
          ? `${commentAction(comment.id, csrf, "hide", "Hide")}${commentAction(comment.id, csrf, "delete", "Delete")}`
          : `${commentAction(comment.id, csrf, "approve", "Approve", true)}${commentAction(comment.id, csrf, "delete", "Delete")}`;
      return `<article class="card comment-admin-row"><div class="card-top"><div><h2>${escapeHtml(comment.display_name)}</h2><p class="muted"><a href="/item/${encodeURIComponent(comment.slug)}">${escapeHtml(comment.title)}</a> · ${escapeHtml(formatDate(comment.created_at, store.timezone))}</p></div>${statusBadge(comment.status)}</div><p>${escapeHtml(comment.body).replace(/\n/g, "<br>")}</p><div class="button-row">${actions}</div></article>`;
    }).join("")}</div>`
    : `<div class="empty-state"><h2>No comments yet</h2><p>Public comments will appear here for review.</p></div>`;
  const body = `<div class="page-heading"><div><div class="eyebrow">Seller area</div><h1>Comments</h1></div></div>${notice(message)}${markup}`;
  return adminPage("Comments", body, store, csrf);
}

export function reservationsPage({ store, reservations, csrf, errors = [], reservationForm = {} }) {
  const markup = reservations.length
    ? `<div class="stack">${reservations.map((reservation) => {
      const held = reservation.status === "held";
      const expiry = reservationExpiry(reservation);
      const reservationUntil = reservationForm.id === reservation.id ? reservationForm.value : "";
      const actions = held
        ? `<form method="post" action="/admin/reservations/${reservation.id}/action" class="reservation-approve-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="action" value="approve"><label class="field"><span>Reservation until <span class="muted">(optional)</span></span><input type="datetime-local" name="reservationUntil" value="${escapeHtml(reservationUntil)}"><small>Leave blank for the default ${escapeHtml(String(store.reservationDurationMinutes))} minutes. Local time: ${escapeHtml(timezoneDisplay(store.timezone))}.</small></label><button class="button primary" type="submit">Approve</button></form><form method="post" action="/admin/reservations/${reservation.id}/action" class="inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="action" value="reject"><button class="button secondary" type="submit">Reject</button></form><form method="post" action="/admin/reservations/${reservation.id}/action" class="inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="action" value="extend"><button class="button secondary" type="submit">Extend hold</button></form>`
        : reservation.status === "reserved"
          ? `<form method="post" action="/admin/reservations/${reservation.id}/action" class="inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="action" value="extend"><button class="button secondary" type="submit">Extend reservation</button></form><form method="post" action="/admin/reservations/${reservation.id}/action" class="inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="action" value="complete"><button class="button secondary" type="submit">Confirm sale</button></form><form method="post" action="/admin/reservations/${reservation.id}/action" class="inline-form"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="action" value="cancel"><button class="button secondary" type="submit">Cancel</button></form>`
          : "";
      return `<article class="card reservation-row"><div class="card-top"><div><h2>${escapeHtml(reservation.title)}</h2><p class="muted">${escapeHtml(reservation.buyer_name)} · ${escapeHtml(reservation.buyer_contact)}</p></div>${statusBadge(reservation.status)}</div>${reservation.buyer_message ? `<p>${escapeHtml(reservation.buyer_message)}</p>` : ""}<p class="muted">${openReservation(reservation.status) && expiry ? `${held ? "Hold" : "Reservation"} expires ${escapeHtml(formatDate(expiry, store.timezone))}` : `Created ${escapeHtml(formatDate(reservation.created_at, store.timezone))}`}</p>${actions ? `<div class="button-row reservation-actions">${actions}</div>` : ""}</article>`;
    }).join("")}</div>`
    : `<div class="empty-state"><h2>No reservations yet</h2><p>Buyer reservations will appear here.</p></div>`;
  const body = `<div class="page-heading"><div><div class="eyebrow">Seller area</div><h1>Reservations</h1></div></div>${errorsBlock(errors)}${markup}`;
  return adminPage("Reservations", body, store, csrf);
}

export function errorPage(title, message, status = 500) {
  const body = `<section class="auth-shell compact"><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(message)}</p><a class="button primary" href="/">Back to storefront</a></section>`;
  return { html: layout({ title, body }), status };
}
