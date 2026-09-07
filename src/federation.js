import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { listListingImages, listListings } from "./db.js";

export const FEDERATION_VERSION = 1;
export const FEDERATION_SIGNATURE_TOLERANCE_SECONDS = 300;

function publicOrigin(request, secure) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = secure ? "https" : forwardedProto || "http";
  return `${protocol}://${request.headers.host || "localhost"}`;
}

function maxUpdatedAt(store, listings) {
  const dates = [Date.parse(store.updatedAt || "")]
    .concat(listings.flatMap((listing) => [Date.parse(listing.created_at), Date.parse(listing.updated_at)]))
    .filter(Number.isFinite);
  return new Date(Math.max(...dates, 0)).toISOString();
}

function publicLocation(store) {
  const location = store.structuredLocation ?? {};
  const hasStructuredValue = [
    location.countryCode,
    location.countryName,
    location.region,
    location.city,
    location.area,
    location.displayLocation,
    location.latitude,
    location.longitude
  ].some((value) => value !== "" && value !== null && value !== undefined);
  if (!hasStructuredValue) return store.location || null;
  return {
    country_code: location.countryCode || null,
    country_name: location.countryName || null,
    region: location.region || null,
    city: location.city || null,
    area: location.area || null,
    display_location: location.displayLocation || store.location || null,
    latitude: location.latitude,
    longitude: location.longitude
  };
}

export function federationManifest(store, origin) {
  return {
    protocol: "yardsale-federation",
    version: FEDERATION_VERSION,
    store_id: store.publicId,
    name: store.name,
    location: publicLocation(store),
    enabled: Boolean(store.federationEnabled),
    feed_url: `${origin}/api/federation/v1/listings`,
    updated_at: store.updatedAt
  };
}

export function federationControlSignature(secret, timestamp, body) {
  return `sha256=${createHmac("sha256", String(secret)).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifyFederationControlSignature(secret, timestamp, body, signature, now = Date.now()) {
  if (!secret || !/^\d+$/.test(String(timestamp ?? ""))) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return false;
  if (Math.abs(Math.floor(now / 1000) - timestampSeconds) > FEDERATION_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(federationControlSignature(secret, timestampSeconds, body));
  const actual = Buffer.from(String(signature ?? ""));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function federationFeed(db, store, origin) {
  const source = store.federationEnabled ? listListings(db, { sort: "newest" }) : [];
  const listings = source.map((listing) => {
    const image = listListingImages(db, listing.id)[0];
    return {
      listing_id: listing.public_id,
      store_id: store.publicId,
      title: listing.title,
      description: listing.description.slice(0, 280),
      price_minor: listing.price_minor,
      currency: listing.currency,
      category: listing.category || null,
      condition: listing.condition || null,
      tags: listing.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      status: listing.status,
      location: publicLocation(store),
      canonical_url: `${origin}/item/${encodeURIComponent(listing.slug)}`,
      thumbnail_url: image ? `${origin}/uploads/${encodeURIComponent(image.path)}` : null,
      created_at: listing.created_at,
      updated_at: listing.updated_at
    };
  });

  return {
    protocol: "yardsale-federation",
    version: FEDERATION_VERSION,
    store_id: store.publicId,
    enabled: Boolean(store.federationEnabled),
    updated_at: maxUpdatedAt(store, source),
    listings
  };
}

export function federationCacheHeaders(payload) {
  const body = JSON.stringify(payload);
  const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
  const lastModified = new Date(Date.parse(payload.updated_at) || 0).toUTCString();
  return { body, etag, lastModified };
}

export { publicOrigin };
