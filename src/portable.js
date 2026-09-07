import { randomUUID } from "node:crypto";
import { readFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  getStore,
  listListingImages,
  setSetting,
  transaction
} from "./db.js";
import { isValidTimezone, normalizeCurrency, normalizeStructuredLocation, nowIso } from "./utils.js";

export const EXPORT_FORMAT = "yardsale-export";
export const EXPORT_VERSION = 1;

const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const LISTING_STATUSES = new Set(["available", "held", "reserved", "sold", "hidden"]);
const RESERVATION_STATUSES = new Set(["held", "reserved", "expired", "rejected", "cancelled", "completed"]);
const COMMENT_STATUSES = new Set(["pending", "approved", "hidden"]);

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function archiveName(name) {
  const value = String(name ?? "");
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    throw new Error("The export contains an unsafe file path.");
  }
  return value;
}

function zipLocalHeader(name, data, checksum) {
  const filename = Buffer.from(archiveName(name));
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(filename.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, filename, data]);
}

function zipCentralHeader(name, data, checksum, offset) {
  const filename = Buffer.from(archiveName(name));
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(filename.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, filename]);
}

export function createZip(entries) {
  if (entries.length > 0xffff) throw new Error("The export contains too many files.");
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    if (data.length > 0xffffffff) throw new Error("The export contains a file that is too large.");
    const checksum = crc32(data);
    const local = zipLocalHeader(entry.name, data, checksum);
    localParts.push(local);
    centralParts.push(zipCentralHeader(entry.name, data, checksum, offset));
    offset += local.length;
  }

  const central = Buffer.concat(centralParts);
  if (offset > 0xffffffff || central.length > 0xffffffff) throw new Error("The export is too large.");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function findEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(0, archive.length - 0xffff - 22);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("The export is not a valid ZIP archive.");
}

export function readZip(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 22) throw new Error("The export is not a valid ZIP archive.");
  const end = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(end + 10);
  const centralSize = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);
  if (centralOffset + centralSize > end) throw new Error("The export ZIP directory is invalid.");

  const files = new Map();
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("The export ZIP directory is invalid.");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedChecksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    const next = nameEnd + extraLength + commentLength;
    if (next > archive.length || (flags & 1) || (flags & 8)) throw new Error("The export ZIP entry uses unsupported features.");

    const name = archiveName(archive.subarray(cursor + 46, nameEnd).toString("utf8"));
    if (files.has(name) || localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("The export ZIP entry is invalid.");
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) throw new Error("The export ZIP entry is truncated.");

    let data;
    try {
      data = method === 0 ? Buffer.from(archive.subarray(dataStart, dataEnd)) : method === 8 ? inflateRawSync(archive.subarray(dataStart, dataEnd)) : null;
    } catch {
      data = null;
    }
    if (!data || data.length !== uncompressedSize || crc32(data) !== expectedChecksum) throw new Error("The export ZIP entry could not be read.");
    totalBytes += data.length;
    if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error("The export is too large.");
    files.set(name, data);
    cursor = next;
  }
  return files;
}

function jsonFile(files, name) {
  const data = files.get(name);
  if (!data) throw new Error(`The export is missing ${name}.`);
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
}

function jsonBuffer(value) {
  return Buffer.from(JSON.stringify(value, null, 2));
}

function imageType(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

function archiveUploadName(path) {
  const filename = basename(String(path ?? ""));
  if (!filename || filename !== path || !/^[a-f0-9-]{36}\.(?:jpg|png|webp)$/i.test(filename)) {
    throw new Error("The export contains an unsafe upload path.");
  }
  return `uploads/${filename}`;
}

function requiredString(value, name, maxLength = 5000) {
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`The export contains an invalid ${name}.`);
  return value;
}

function requiredDate(value, name) {
  const result = requiredString(value, name, 80);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`The export contains an invalid ${name}.`);
  return result;
}

function integer(value, name, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`The export contains an invalid ${name}.`);
  return value;
}

function normalizeStore(store, current) {
  if (!store || typeof store !== "object") throw new Error("store.json is invalid.");
  const currency = normalizeCurrency(store.currency);
  if (!currency || !isValidTimezone(store.timezone)) throw new Error("store.json contains invalid currency or timezone settings.");
  const locationSource = store.structuredLocation && typeof store.structuredLocation === "object" ? store.structuredLocation : {};
  for (const [key, maxLength] of [["countryCode", 3], ["countryName", 100], ["region", 100], ["city", 100], ["area", 100], ["displayLocation", 200]]) {
    if (locationSource[key] !== undefined && typeof locationSource[key] !== "string") throw new Error(`The export contains an invalid location ${key}.`);
    if (typeof locationSource[key] === "string" && locationSource[key].length > maxLength) throw new Error(`The export contains an invalid location ${key}.`);
  }
  for (const [key, minimum, maximum] of [["latitude", -90, 90], ["longitude", -180, 180]]) {
    if (locationSource[key] !== undefined && locationSource[key] !== null && (!Number.isFinite(locationSource[key]) || locationSource[key] < minimum || locationSource[key] > maximum)) {
      throw new Error(`The export contains an invalid location ${key}.`);
    }
  }
  const structuredLocation = normalizeStructuredLocation({
    ...locationSource,
    displayLocation: locationSource.displayLocation ?? store.location ?? ""
  });
  const contactMethods = Array.isArray(store.contactMethods)
    ? store.contactMethods.map((method) => ({
      type: requiredString(method?.type ?? "", "contact method", 40),
      label: requiredString(method?.label ?? "", "contact label", 80),
      value: requiredString(method?.value ?? "", "contact details", 200)
    })).filter((method) => method.type && method.value)
    : [];
  return {
    name: requiredString(store.name, "store name", 100),
    description: requiredString(store.description ?? "", "store description", 3000),
    location: requiredString(structuredLocation.displayLocation, "store location", 200),
    structuredLocation,
    currency,
    timezone: store.timezone,
    holdDurationMinutes: integer(store.holdDurationMinutes, "hold duration", { min: 5 }),
    reservationDurationMinutes: integer(store.reservationDurationMinutes, "reservation duration", { min: 5 }),
    commentsEnabled: Boolean(store.commentsEnabled),
    contactMethods,
    federationEnabled: Boolean(store.federationEnabled),
    publicId: requiredString(store.publicId || current.publicId, "store public ID", 100),
    updatedAt: Number.isFinite(Date.parse(store.updatedAt || "")) ? store.updatedAt : nowIso()
  };
}

function normalizeListings(listings) {
  if (!Array.isArray(listings)) throw new Error("listings.json is invalid.");
  const ids = new Set();
  const publicIds = new Set();
  const slugs = new Set();
  return listings.map((listing) => {
    const id = integer(listing?.id, "listing ID", { min: 1 });
    if (ids.has(id) || publicIds.has(listing.public_id) || slugs.has(listing.slug)) throw new Error("The export contains duplicate listings.");
    ids.add(id);
    const publicId = requiredString(listing.public_id, "listing public ID", 100);
    const slug = requiredString(listing.slug, "listing slug", 100);
    publicIds.add(publicId);
    slugs.add(slug);
    if (!LISTING_STATUSES.has(listing.status)) throw new Error("The export contains an invalid listing status.");
    const images = Array.isArray(listing.images) ? listing.images : [];
    if (images.length > 10) throw new Error("The export contains too many images on one listing.");
    return {
      ...listing,
      id,
      public_id: publicId,
      title: requiredString(listing.title, "listing title", 160),
      slug,
      description: requiredString(listing.description ?? "", "listing description", 5000),
      price_minor: integer(listing.price_minor, "listing price"),
      currency: normalizeCurrency(listing.currency) || "USD",
      category: requiredString(listing.category ?? "", "listing category", 80),
      condition: requiredString(listing.condition ?? "", "listing condition", 80),
      status: listing.status,
      quantity: integer(listing.quantity, "listing quantity", { min: 1 }),
      pickup_notes: requiredString(listing.pickup_notes ?? "", "pickup notes", 1000),
      tags: requiredString(listing.tags ?? "", "listing tags", 500),
      sort_order: integer(listing.sort_order ?? 0, "listing sort order"),
      published: listing.published ? 1 : 0,
      comments_enabled: listing.comments_enabled === 0 ? 0 : 1,
      created_at: requiredDate(listing.created_at, "listing creation time"),
      updated_at: requiredDate(listing.updated_at, "listing update time"),
      sold_at: listing.sold_at ? requiredDate(listing.sold_at, "listing sale time") : null,
      images: images.map((image) => ({
        path: archiveUploadName(image.path).slice("uploads/".length),
        alt_text: requiredString(image.alt_text ?? "", "image alt text", 300),
        sort_order: integer(image.sort_order ?? 0, "image sort order"),
        created_at: requiredDate(image.created_at, "image creation time")
      }))
    };
  });
}

function normalizeReservations(reservations, listingIds) {
  if (!Array.isArray(reservations)) throw new Error("reservations.json is invalid.");
  return reservations.map((reservation) => {
    if (!RESERVATION_STATUSES.has(reservation.status) || !listingIds.has(reservation.listing_id)) throw new Error("The export contains an invalid reservation.");
    if (!/^[a-f0-9]{64}$/i.test(String(reservation.manage_token_hash ?? ""))) throw new Error("The export contains an invalid reservation token hash.");
    return {
      public_id: requiredString(reservation.public_id, "reservation public ID", 100),
      listing_id: reservation.listing_id,
      buyer_name: requiredString(reservation.buyer_name, "buyer name", 120),
      buyer_contact: requiredString(reservation.buyer_contact, "buyer contact", 240),
      buyer_message: requiredString(reservation.buyer_message ?? "", "buyer message", 2000),
      status: reservation.status,
      manage_token_hash: reservation.manage_token_hash,
      requested_at: requiredDate(reservation.requested_at, "reservation request time"),
      hold_expires_at: reservation.hold_expires_at ? requiredDate(reservation.hold_expires_at, "hold expiry") : null,
      approved_at: reservation.approved_at ? requiredDate(reservation.approved_at, "approval time") : null,
      reservation_expires_at: reservation.reservation_expires_at ? requiredDate(reservation.reservation_expires_at, "reservation expiry") : null,
      completed_at: reservation.completed_at ? requiredDate(reservation.completed_at, "completion time") : null,
      rejected_at: reservation.rejected_at ? requiredDate(reservation.rejected_at, "rejection time") : null,
      cancelled_at: reservation.cancelled_at ? requiredDate(reservation.cancelled_at, "cancellation time") : null,
      created_at: requiredDate(reservation.created_at, "reservation creation time"),
      updated_at: requiredDate(reservation.updated_at, "reservation update time")
    };
  });
}

function normalizeComments(comments, listingIds) {
  if (!Array.isArray(comments)) throw new Error("comments.json is invalid.");
  return comments.map((comment) => {
    if (!listingIds.has(comment.listing_id) || !COMMENT_STATUSES.has(comment.status)) throw new Error("The export contains an invalid comment.");
    return {
      listing_id: comment.listing_id,
      display_name: requiredString(comment.display_name, "comment display name", 80),
      body: requiredString(comment.body, "comment body", 2000),
      status: comment.status,
      created_at: requiredDate(comment.created_at, "comment creation time"),
      updated_at: requiredDate(comment.updated_at, "comment update time"),
      moderated_at: comment.moderated_at ? requiredDate(comment.moderated_at, "comment moderation time") : null
    };
  });
}

export async function createStoreExport(db, dataDir) {
  const store = getStore(db);
  const listings = db.prepare("SELECT * FROM listings ORDER BY id ASC").all().map((listing) => ({
    ...listing,
    images: listListingImages(db, listing.id)
  }));
  const reservations = db.prepare("SELECT * FROM reservations ORDER BY id ASC").all();
  const comments = db.prepare("SELECT * FROM comments ORDER BY id ASC").all();
  const uploads = [];

  for (const listing of listings) {
    for (const image of listing.images) {
      const filename = basename(image.path);
      if (filename !== image.path) throw new Error("A listing contains an unsafe upload path.");
      try {
        uploads.push({ name: `uploads/${filename}`, data: await readFile(join(dataDir, "uploads", filename)) });
      } catch (error) {
        if (error.code === "ENOENT") throw new Error(`Missing upload file: ${filename}`);
        throw error;
      }
    }
  }

  const manifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: nowIso(),
    counts: { listings: listings.length, reservations: reservations.length, comments: comments.length, uploads: uploads.length }
  };
  return createZip([
    { name: "manifest.json", data: jsonBuffer(manifest) },
    { name: "store.json", data: jsonBuffer(store) },
    { name: "listings.json", data: jsonBuffer(listings) },
    { name: "reservations.json", data: jsonBuffer(reservations) },
    { name: "comments.json", data: jsonBuffer(comments) },
    ...uploads
  ]);
}

export async function importStoreExport(db, dataDir, archive) {
  const files = readZip(archive);
  const manifest = jsonFile(files, "manifest.json");
  if (manifest.format !== EXPORT_FORMAT || manifest.version !== EXPORT_VERSION) throw new Error("This export version is not supported.");

  const currentStore = getStore(db);
  const store = normalizeStore(jsonFile(files, "store.json"), currentStore);
  const listings = normalizeListings(jsonFile(files, "listings.json"));
  const sourceListingIds = new Set(listings.map((listing) => listing.id));
  const reservations = normalizeReservations(jsonFile(files, "reservations.json"), sourceListingIds);
  const comments = normalizeComments(jsonFile(files, "comments.json"), sourceListingIds);
  const imageWrites = [];

  for (const listing of listings) {
    for (const image of listing.images) {
      const sourceName = `uploads/${image.path}`;
      const data = files.get(sourceName);
      if (!data) throw new Error(`The export is missing ${sourceName}.`);
      const extension = imageType(data);
      if (!extension) throw new Error(`The export contains an invalid image: ${sourceName}.`);
      const filename = `${randomUUID()}.${extension}`;
      imageWrites.push({ sourcePath: image.path, filename, data });
      image.path = filename;
    }
  }

  const uploadDir = join(dataDir, "uploads");
  const writtenPaths = [];
  try {
    await mkdir(uploadDir, { recursive: true });
    for (const image of imageWrites) {
      const path = join(uploadDir, image.filename);
      await writeFile(path, image.data, { flag: "wx", mode: 0o600 });
      writtenPaths.push(path);
    }

    transaction(db, () => {
      db.prepare("DELETE FROM reservations").run();
      db.prepare("DELETE FROM comments").run();
      db.prepare("DELETE FROM listing_images").run();
      db.prepare("DELETE FROM listings").run();

      setSetting(db, "store.public_id", store.publicId);
      setSetting(db, "store.name", store.name);
      setSetting(db, "store.description", store.description);
      setSetting(db, "store.location", store.location);
      setSetting(db, "store.location_structured", JSON.stringify(store.structuredLocation));
      setSetting(db, "store.currency", store.currency);
      setSetting(db, "store.timezone", store.timezone);
      setSetting(db, "store.hold_duration_minutes", store.holdDurationMinutes);
      setSetting(db, "store.reservation_duration_minutes", store.reservationDurationMinutes);
      setSetting(db, "store.comments_enabled", store.commentsEnabled ? "true" : "false");
      setSetting(db, "store.contact_methods", JSON.stringify(store.contactMethods));
      setSetting(db, "store.federation_enabled", store.federationEnabled ? "true" : "false");
      setSetting(db, "store.updated_at", store.updatedAt);

      const listingIds = new Map();
      const listingInsert = db.prepare(`
        INSERT INTO listings (
          public_id, title, slug, description, price_minor, currency, category, condition,
          status, quantity, pickup_notes, tags, sort_order, published, comments_enabled,
          created_at, updated_at, sold_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const listing of listings) {
        const result = listingInsert.run(
          listing.public_id, listing.title, listing.slug, listing.description, listing.price_minor,
          listing.currency, listing.category, listing.condition, listing.status, listing.quantity,
          listing.pickup_notes, listing.tags, listing.sort_order, listing.published, listing.comments_enabled,
          listing.created_at, listing.updated_at, listing.sold_at
        );
        listingIds.set(listing.id, Number(result.lastInsertRowid));
      }

      const imageInsert = db.prepare(`
        INSERT INTO listing_images (listing_id, path, alt_text, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const listing of listings) {
        for (const image of listing.images) imageInsert.run(listingIds.get(listing.id), image.path, image.alt_text, image.sort_order, image.created_at);
      }

      const reservationInsert = db.prepare(`
        INSERT INTO reservations (
          public_id, listing_id, buyer_name, buyer_contact, buyer_message, status, manage_token_hash,
          requested_at, hold_expires_at, approved_at, reservation_expires_at, completed_at,
          rejected_at, cancelled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const reservation of reservations) reservationInsert.run(
        reservation.public_id, listingIds.get(reservation.listing_id), reservation.buyer_name,
        reservation.buyer_contact, reservation.buyer_message, reservation.status, reservation.manage_token_hash,
        reservation.requested_at, reservation.hold_expires_at, reservation.approved_at,
        reservation.reservation_expires_at, reservation.completed_at, reservation.rejected_at,
        reservation.cancelled_at, reservation.created_at, reservation.updated_at
      );

      const commentInsert = db.prepare(`
        INSERT INTO comments (listing_id, display_name, body, status, created_at, updated_at, moderated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const comment of comments) commentInsert.run(
        listingIds.get(comment.listing_id), comment.display_name, comment.body, comment.status,
        comment.created_at, comment.updated_at, comment.moderated_at
      );
    });
  } catch (error) {
    await Promise.all(writtenPaths.map((path) => unlink(path).catch(() => {})));
    throw error;
  }

  return { listings: listings.length, reservations: reservations.length, comments: comments.length, uploads: imageWrites.length };
}
