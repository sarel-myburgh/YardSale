import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSession } from "../src/auth.js";
import { createListing, createSetup, getReservationByToken, openDatabase, reserveListing } from "../src/db.js";
import { federationControlSignature, verifyFederationControlSignature } from "../src/federation.js";
import { itemPage } from "../src/html.js";
import { detectImageType, validateImageFiles } from "../src/server.js";
import { createSlidingWindowLimiter, escapeHtml } from "../src/utils.js";

test("public HTML escapes user content", () => {
  const malicious = "<script>alert('xss')</script>";
  const html = itemPage({
    store: {
      name: malicious,
      description: malicious,
      location: malicious,
      currency: "USD",
      timezone: "UTC",
      commentsEnabled: true,
      contactMethods: [{ label: malicious, value: malicious }]
    },
    listing: {
      title: malicious,
      slug: "safe-item",
      price_minor: 100,
      currency: "USD",
      status: "available",
      description: malicious,
      pickup_notes: malicious,
      comments_enabled: 1,
      images: []
    }
  });

  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.equal(escapeHtml(malicious), "&lt;script&gt;alert(&#39;xss&#39;)&lt;\/script&gt;");
});

test("session CSRF tokens and reservation secrets are scoped", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yardsale-security-"));
  const db = openDatabase(dataDir);
  try {
    const userId = createSetup(db, { login: "owner", passwordHash: "hash", storeName: "Store", currency: "USD", timezone: "UTC" });
    const session = createSession(db, userId);
    const sessionRow = db.prepare("SELECT * FROM sessions WHERE user_id = ?").get(userId);
    const { sessionCsrfIsValid } = await import("../src/auth.js");
    assert.equal(sessionCsrfIsValid(sessionRow, session.csrfToken), true);
    assert.equal(sessionCsrfIsValid(sessionRow, "wrong-token"), false);

    const listing = createListing(db, {
      title: "Lamp", slug: "lamp", description: "", priceMinor: 100, currency: "USD",
      category: "", condition: "", pickupNotes: "", tags: "", published: true, quantity: 1
    });
    const reservation = reserveListing(db, listing.id, { buyerName: "Buyer", buyerContact: "Email", holdMinutes: 60 });
    assert.equal(reservation.ok, true);
    assert.ok(getReservationByToken(db, reservation.publicId, reservation.secret));
    assert.equal(getReservationByToken(db, reservation.publicId, "wrong-secret"), undefined);
  } finally {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("image validation checks magic bytes, size, and count", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  assert.equal(detectImageType(jpeg).extension, "jpg");
  assert.equal(detectImageType(Buffer.from("not an image")), null);
  assert.deepEqual(validateImageFiles([{ name: "images", filename: "photo.svg", data: Buffer.from("<svg>") }]).errors, ["Photos must be JPG, PNG, or WebP images."]);
  assert.match(validateImageFiles(Array.from({ length: 2 }, (_, index) => ({ name: "images", filename: `${index}.jpg`, data: jpeg })), 9).errors[0], /10 photos/);
  const tooLarge = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
  assert.match(validateImageFiles([{ name: "images", filename: "photo.jpg", data: tooLarge }]).errors[0], /10 MB/);
});

test("federation control signatures reject tampering and replay", () => {
  const secret = "test-secret";
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ federation_enabled: true });
  const signature = federationControlSignature(secret, timestamp, body);
  assert.equal(verifyFederationControlSignature(secret, timestamp, body, signature), true);
  assert.equal(verifyFederationControlSignature(secret, timestamp, JSON.stringify({ federation_enabled: false }), signature), false);
  assert.equal(verifyFederationControlSignature(secret, timestamp - 301, body, signature), false);
  assert.equal(verifyFederationControlSignature("wrong-secret", timestamp, body, signature), false);
});

test("sliding-window limiter blocks repeated abuse", () => {
  const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.allow("client", 0), true);
  assert.equal(limiter.allow("client", 1), true);
  assert.equal(limiter.allow("client", 2), false);
  assert.equal(limiter.allow("client", 1001), true);
});
