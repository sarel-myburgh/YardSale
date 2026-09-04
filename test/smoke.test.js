import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addListingImage, adminCommentAction, adminReservationAction, createComment, createListing, createSetup, expireReservations, getActiveReservationForListing, getListingById, getStore, isSetupComplete, listApprovedComments, listComments, listListingImages, openDatabase, reserveListing, setListingStatus, updateListing, updateStore } from "../src/db.js";
import { hashPassword, verifyPassword } from "../src/auth.js";
import { createSlidingWindowLimiter, dateTimeLocalToIso, parseMoney, slugify, timezoneForInput } from "../src/utils.js";
import { adminCommentsPage, adminListingsPage, dashboardPage, homePage, itemPage, listingFormPage, reservationPage, reservationsPage, storeSettingsPage } from "../src/html.js";

test("first-run setup creates a usable store and password hash", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yardsale-"));
  const db = openDatabase(dataDir);

  try {
    assert.equal(isSetupComplete(db), false);
    assert.equal(parseMoney("1,250.50"), 125050);
    assert.equal(slugify(" Brass Lamp! "), "brass-lamp");
    assert.equal(timezoneForInput("Phnom Penh"), "Asia/Phnom_Penh");
    assert.equal(timezoneForInput("Phnom Penh (GMT+7)"), "Asia/Phnom_Penh");
    assert.equal(dateTimeLocalToIso("2099-01-02T12:30", "Asia/Phnom_Penh"), "2099-01-02T05:30:00.000Z");
    assert.equal(dateTimeLocalToIso("2099-02-29T12:30", "Asia/Phnom_Penh"), null);
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1000 });
    assert.equal(limiter.allow("buyer", 0), true);
    assert.equal(limiter.allow("buyer", 500), true);
    assert.equal(limiter.allow("buyer", 750), false);
    assert.equal(limiter.allow("buyer", 1001), true);

    const passwordHash = await hashPassword("abcdefghij");
    assert.equal(await verifyPassword("abcdefghij", passwordHash), true);
    assert.equal(await verifyPassword("wrong-password", passwordHash), false);

    createSetup(db, {
      login: "owner@example.com",
      passwordHash,
      storeName: "Saturday Sale",
      currency: "USD",
      timezone: "UTC"
    });

    assert.equal(isSetupComplete(db), true);
    assert.equal(getStore(db).name, "Saturday Sale");
    assert.deepEqual(getStore(db).contactMethods, []);

    const listing = createListing(db, {
      title: "Brass lamp",
      slug: "brass-lamp",
      description: "A warm little lamp.",
      priceMinor: 2500,
      currency: "USD",
      category: "Home",
      condition: "Good",
      pickupNotes: "Pickup nearby.",
      tags: "lamp",
      published: true,
      quantity: 1
    });
    const image = addListingImage(db, {
      listingId: listing.id,
      path: "test-image.jpg",
      altText: "Brass lamp",
      sortOrder: 0
    });
    assert.deepEqual(listListingImages(db, listing.id).map((item) => item.path), ["test-image.jpg"]);

    updateStore(db, {
      ...getStore(db),
      contactMethods: [{ type: "telegram", label: "Telegram", value: "+855123123123" }]
    });
    const store = getStore(db);
    assert.equal(store.contactMethods[0].value, "+855123123123");
    assert.match(homePage({ store, listings: [{ ...listing, images: [image] }] }), /Telegram/);
    assert.match(homePage({ store, listings: [{ ...listing, images: [image] }] }), /\+855123123123/);
    assert.match(itemPage({ store, listing: { ...listing, images: [image] } }), /\/uploads\/test-image.jpg/);
    assert.match(itemPage({ store, listing: { ...listing, images: [image] } }), /Post comment/);
    assert.match(itemPage({ store, listing: { ...listing, images: [image] } }), /name="website"/);
    assert.match(listingFormPage({ store, csrf: "token" }), /multipart\/form-data/);
    assert.match(adminListingsPage({ store, listings: [listing], csrf: "token" }), /Mark as reserved/);
    const privateEditForm = listingFormPage({ store, listing: { ...listing, published: 0 }, values: { published: false }, csrf: "token" });
    assert.ok(privateEditForm.indexOf('name="published"') < privateEditForm.indexOf("data-image-input"));
    assert.doesNotMatch(privateEditForm, /name="published" value="1" checked/);
    assert.match(listingFormPage({ store, listing, values: { published: true }, csrf: "token" }), /name="published" value="1" checked/);
    assert.match(listingFormPage({ store, listing, values: { commentsEnabled: true }, csrf: "token" }), /name="commentsEnabled" value="1" checked/);
    assert.match(storeSettingsPage({ store, csrf: "token" }), /name="contactMethod1"/);

    const pendingComment = createComment(db, { listingId: listing.id, displayName: "A <buyer>", body: "<script>alert(1)</script>" });
    assert.equal(listApprovedComments(db, listing.id).length, 0);
    assert.match(adminCommentsPage({ store, comments: listComments(db), csrf: "token" }), /Pending/);
    assert.equal(adminCommentAction(db, pendingComment.id, "approve"), true);
    const approvedComments = listApprovedComments(db, listing.id);
    assert.equal(approvedComments.length, 1);
    const publicCommentsPage = itemPage({ store, listing: { ...listing, images: [image] }, comments: approvedComments });
    assert.match(publicCommentsPage, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(publicCommentsPage, /<script>alert\(1\)/);
    assert.equal(adminCommentAction(db, pendingComment.id, "hide"), true);
    assert.equal(listApprovedComments(db, listing.id).length, 0);
    assert.equal(updateListing(db, listing.id, {
      title: listing.title,
      slug: listing.slug,
      description: listing.description,
      priceMinor: listing.price_minor,
      currency: listing.currency,
      category: listing.category,
      condition: listing.condition,
      quantity: listing.quantity,
      pickupNotes: listing.pickup_notes,
      tags: listing.tags,
      published: Boolean(listing.published),
      commentsEnabled: false
    }).comments_enabled, 0);
    assert.doesNotMatch(itemPage({ store, listing: { ...listing, comments_enabled: 0 } }), /Post comment/);

    assert.equal(setListingStatus(db, listing.id, "reserved").status, "reserved");
    assert.equal(setListingStatus(db, listing.id, "available").status, "available");
    const firstHold = reserveListing(db, listing.id, { buyerName: "Buyer One", buyerContact: "Telegram", buyerMessage: "Please hold", holdMinutes: 60 });
    assert.equal(firstHold.ok, true);
    assert.equal(getListingById(db, listing.id).status, "held");
    const firstReservation = getActiveReservationForListing(db, listing.id);
    assert.equal(firstReservation.status, "held");
    assert.match(itemPage({ store, listing: { ...listing, status: "held" }, reservation: firstReservation }), /Hold requested until/);
    const reservationAdminPage = reservationsPage({ store: { ...store, timezone: "Asia/Phnom_Penh" }, reservations: [firstReservation], csrf: "token" });
    assert.match(reservationAdminPage, /Approve/);
    assert.match(reservationAdminPage, /type="datetime-local"/);
    assert.match(reservationAdminPage, /Local time: Phnom Penh \(GMT\+7\)/);
    assert.match(reservationPage({ store, reservation: firstReservation, secret: "secret" }), /Your hold request/);
    assert.equal(adminReservationAction(db, firstReservation.id, "approve", { reservationDurationMinutes: 1440 }), true);
    assert.equal(getListingById(db, listing.id).status, "reserved");
    assert.equal(getActiveReservationForListing(db, listing.id).status, "reserved");
    assert.match(dashboardPage({ store, stats: { available: 0, held: 0, reserved: 1, sold: 0, activeReservations: 1 }, reservations: [getActiveReservationForListing(db, listing.id)], csrf: "token" }), /Open requests/);
    assert.equal(adminReservationAction(db, getActiveReservationForListing(db, listing.id).id, "complete"), true);
    assert.equal(getListingById(db, listing.id).status, "sold");

    const secondListing = createListing(db, {
      title: "Second lamp", slug: "second-lamp", description: "", priceMinor: 1000, currency: "USD",
      category: "", condition: "", pickupNotes: "", tags: "", published: true, quantity: 1
    });
    const secondHold = reserveListing(db, secondListing.id, { buyerName: "Buyer Two", buyerContact: "Email", holdMinutes: 60 });
    assert.equal(secondHold.ok, true);
    assert.equal(reserveListing(db, secondListing.id, { buyerName: "Buyer Three", buyerContact: "Email", holdMinutes: 60 }).ok, false);
    const secondReservation = getActiveReservationForListing(db, secondListing.id);
    db.prepare("UPDATE reservations SET hold_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), secondReservation.id);
    assert.equal(expireReservations(db), 1);
    assert.equal(getListingById(db, secondListing.id).status, "available");

    const thirdListing = createListing(db, {
      title: "Third lamp", slug: "third-lamp", description: "", priceMinor: 1500, currency: "USD",
      category: "", condition: "", pickupNotes: "", tags: "", published: true, quantity: 1
    });
    const thirdHold = reserveListing(db, thirdListing.id, { buyerName: "Buyer Four", buyerContact: "Email", holdMinutes: 60 });
    const thirdReservation = getActiveReservationForListing(db, thirdListing.id);
    const explicitExpiry = dateTimeLocalToIso("2099-01-02T12:30", "Asia/Phnom_Penh");
    assert.equal(explicitExpiry, "2099-01-02T05:30:00.000Z");
    assert.equal(thirdHold.ok, true);
    assert.equal(adminReservationAction(db, thirdReservation.id, "approve", { reservationExpiresAt: explicitExpiry }), true);
    assert.equal(getActiveReservationForListing(db, thirdListing.id).reservation_expires_at, explicitExpiry);
  } finally {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
