import { createHash, randomUUID } from "node:crypto";

export const LISTING_STATUSES = ["available", "held", "reserved", "sold", "hidden"];
export const RESERVATION_STATUSES = ["held", "reserved", "expired", "rejected", "cancelled", "completed"];
export const CONTACT_METHOD_OPTIONS = [
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "telegram", label: "Telegram" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "messenger", label: "Messenger" },
  { value: "signal", label: "Signal" },
  { value: "custom", label: "Other" }
];
export const TIMEZONE_OPTIONS = [
  { city: "Phnom Penh", timezone: "Asia/Phnom_Penh", offset: "GMT+7" },
  { city: "Bangkok", timezone: "Asia/Bangkok", offset: "GMT+7" },
  { city: "Ho Chi Minh City", timezone: "Asia/Ho_Chi_Minh", offset: "GMT+7" },
  { city: "Jakarta", timezone: "Asia/Jakarta", offset: "GMT+7" },
  { city: "Singapore", timezone: "Asia/Singapore", offset: "GMT+8" },
  { city: "Kuala Lumpur", timezone: "Asia/Kuala_Lumpur", offset: "GMT+8" },
  { city: "Manila", timezone: "Asia/Manila", offset: "GMT+8" },
  { city: "Hong Kong", timezone: "Asia/Hong_Kong", offset: "GMT+8" },
  { city: "Beijing", timezone: "Asia/Shanghai", offset: "GMT+8" },
  { city: "Tokyo", timezone: "Asia/Tokyo", offset: "GMT+9" },
  { city: "Seoul", timezone: "Asia/Seoul", offset: "GMT+9" },
  { city: "New Delhi", timezone: "Asia/Kolkata", offset: "GMT+5:30" },
  { city: "Dubai", timezone: "Asia/Dubai", offset: "GMT+4" },
  { city: "London", timezone: "Europe/London", offset: "GMT/BST" },
  { city: "Paris", timezone: "Europe/Paris", offset: "GMT+1/+2" },
  { city: "Berlin", timezone: "Europe/Berlin", offset: "GMT+1/+2" },
  { city: "Moscow", timezone: "Europe/Moscow", offset: "GMT+3" },
  { city: "Johannesburg", timezone: "Africa/Johannesburg", offset: "GMT+2" },
  { city: "New York", timezone: "America/New_York", offset: "GMT-5/-4" },
  { city: "Chicago", timezone: "America/Chicago", offset: "GMT-6/-5" },
  { city: "Denver", timezone: "America/Denver", offset: "GMT-7/-6" },
  { city: "Los Angeles", timezone: "America/Los_Angeles", offset: "GMT-8/-7" },
  { city: "Toronto", timezone: "America/Toronto", offset: "GMT-5/-4" },
  { city: "Mexico City", timezone: "America/Mexico_City", offset: "GMT-6" },
  { city: "São Paulo", timezone: "America/Sao_Paulo", offset: "GMT-3" },
  { city: "Sydney", timezone: "Australia/Sydney", offset: "GMT+10/+11" },
  { city: "Auckland", timezone: "Pacific/Auckland", offset: "GMT+12/+13" },
  { city: "UTC", timezone: "UTC", offset: "GMT+0" }
];

export const EMPTY_STRUCTURED_LOCATION = Object.freeze({
  countryCode: "",
  countryName: "",
  region: "",
  city: "",
  area: "",
  displayLocation: "",
  latitude: null,
  longitude: null
});

export function escapeHtml(value = "") {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

export function slugify(value) {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || `item-${randomUUID().slice(0, 8)}`;
}

export function parseMoney(value) {
  const input = String(value ?? "").trim().replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(input)) return null;

  const [whole, fraction = ""] = input.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(minor) && minor <= 999999999999 ? minor : null;
}

export function formatMoney(minor, currency = "USD") {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      currencyDisplay: "symbol"
    }).format(Number(minor) / 100);
  } catch {
    return `${currency} ${(Number(minor) / 100).toFixed(2)}`;
  }
}

export function moneyInput(minor) {
  return minor === undefined || minor === null ? "" : (Number(minor) / 100).toFixed(2);
}

export function normalizeCurrency(value) {
  const currency = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

export function isValidTimezone(value) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return Boolean(value);
  } catch {
    return false;
  }
}

function normalizedTimezoneSearch(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function timezoneForInput(value) {
  const input = String(value ?? "").trim();
  const normalized = normalizedTimezoneSearch(input);
  const option = TIMEZONE_OPTIONS.find((item) => [
    item.city,
    item.timezone,
    `${item.city} ${item.offset}`,
    `${item.city} (${item.offset})`
  ].some((candidate) => normalized === normalizedTimezoneSearch(candidate)));
  return option?.timezone ?? (isValidTimezone(input) ? input : null);
}

export function timezoneDisplay(value) {
  const option = TIMEZONE_OPTIONS.find((item) => item.timezone === value);
  return option ? `${option.city} (${option.offset})` : String(value ?? "");
}

function coordinate(value, minimum, maximum) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? Number(number.toFixed(6))
    : null;
}

export function isValidCoordinate(value, minimum, maximum) {
  if (String(value ?? "").trim() === "") return true;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum;
}

export function normalizeStructuredLocation(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const countryCode = text(source.countryCode ?? source.country_code, 3).toUpperCase();
  const countryName = text(source.countryName ?? source.country_name, 100);
  const region = text(source.region, 100);
  const city = text(source.city, 100);
  const area = text(source.area, 100);
  const parts = [area, city, region, countryName].filter(Boolean);
  const displayLocation = text(source.displayLocation ?? source.display_location, 200) || parts.join(", ").slice(0, 200);
  return {
    countryCode,
    countryName,
    region,
    city,
    area,
    displayLocation,
    latitude: coordinate(source.latitude, -90, 90),
    longitude: coordinate(source.longitude, -180, 180)
  };
}

export function formatDate(value, timezone = "UTC") {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

function localDateTimeParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts[3] > 23 || parts[4] > 59) return null;
  return { year: parts[0], month: parts[1], day: parts[2], hour: parts[3], minute: parts[4] };
}

function timezoneDateParts(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    calendar: "iso8601",
    numberingSystem: "latn",
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value);
  const result = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: result.year, month: result.month, day: result.day, hour: result.hour, minute: result.minute, second: result.second };
}

function wallClockTimestamp(parts) {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second ?? 0, 0);
  return date.getTime();
}

function sameLocalMinute(left, right) {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && (right.second ?? 0) === 0;
}

export function dateTimeLocalToIso(value, timezone = "UTC") {
  const local = localDateTimeParts(value);
  if (!local || !isValidTimezone(timezone)) return null;

  const wallTimestamp = wallClockTimestamp(local);
  let candidate = wallTimestamp;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = timezoneDateParts(new Date(candidate), timezone);
    const offset = wallClockTimestamp(actual) - candidate;
    candidate = wallTimestamp - offset;
  }

  try {
    return sameLocalMinute(local, timezoneDateParts(new Date(candidate), timezone))
      ? new Date(candidate).toISOString()
      : null;
  } catch {
    return null;
  }
}

export function createSlidingWindowLimiter({ limit = 1, windowMs = 60_000 } = {}) {
  const maxAttempts = Math.max(1, Number(limit) || 1);
  const window = Math.max(1, Number(windowMs) || 1);
  const attempts = new Map();

  return {
    allow(key, now = Date.now()) {
      const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      const cutoff = current - window;
      for (const [storedKey, timestamps] of attempts) {
        const recent = timestamps.filter((timestamp) => timestamp > cutoff);
        if (recent.length) attempts.set(storedKey, recent);
        else attempts.delete(storedKey);
      }

      const storedKey = String(key ?? "");
      const recent = attempts.get(storedKey) ?? [];
      if (recent.length >= maxAttempts) {
        attempts.set(storedKey, recent);
        return false;
      }
      recent.push(current);
      attempts.set(storedKey, recent);
      return true;
    },
    clear() {
      attempts.clear();
    }
  };
}

export function nowIso() {
  return new Date().toISOString();
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function safeNext(value) {
  const next = String(value ?? "");
  return next.startsWith("/") && !next.startsWith("//") ? next : "/admin";
}

export function text(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}
