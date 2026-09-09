import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
export const SESSION_COOKIE = "yardsale_cloud_session";
export const CSRF_COOKIE = "yardsale_cloud_csrf";
const SESSION_DAYS = 30;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function equalDigest(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("hex")}$${Buffer.from(derived).toString("hex")}`;
}

export async function verifyPassword(password, encoded) {
  try {
    const [, n, r, p, saltHex, hashHex] = String(encoded).split("$");
    if (!/^\d+$/.test(n) || !/^\d+$/.test(r) || !/^\d+$/.test(p) || !/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;
    if (Number(n) !== 16384 || Number(r) !== 8 || Number(p) !== 1 || hashHex.length !== 128) return false;
    const derived = await scrypt(password, Buffer.from(saltHex, "hex"), 64, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024
    });
    return equalDigest(Buffer.from(derived).toString("hex"), hashHex);
  } catch {
    return false;
  }
}

export function createEmailVerificationToken(db, userId, days = 2) {
  const token = randomBytes(24).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Number(days) * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ? AND used_at IS NULL").run(userId);
  db.prepare(`
    INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, digest(token), expiresAt, now.toISOString());
  return { token, expiresAt };
}

export function verifyEmailToken(db, token) {
  if (!token || String(token).length > 200) return null;
  const row = db.prepare(`
    SELECT * FROM email_verification_tokens
    WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
  `).get(digest(token), new Date().toISOString());
  if (!row) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE email_verification_tokens SET used_at = ? WHERE id = ?").run(now, row.id);
  db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").run(now, row.user_id);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(row.user_id);
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(24).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (user_id, token_hash, csrf_token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, digest(token), digest(csrfToken), expiresAt, now.toISOString());
  db.prepare(`
    DELETE FROM sessions WHERE user_id = ? AND id NOT IN (
      SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 5
    )
  `).run(userId, userId);
  return { token, csrfToken, expiresAt };
}

export function getSession(db, token) {
  if (!token) return null;
  const session = db.prepare(`
    SELECT sessions.*, users.email, users.status, users.is_admin, users.email_verified_at, users.country_code
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(digest(token));
  if (!session) return null;
  if (Date.parse(session.expires_at) <= Date.now() || session.status !== "active") {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    return null;
  }
  return session;
}

export function sessionCsrfIsValid(session, csrfToken) {
  return Boolean(session && csrfToken && equalDigest(digest(csrfToken), session.csrf_token_hash));
}

export function destroySession(db, token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest(token));
}

export function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    let value = part.slice(index + 1).trim();
    try { value = decodeURIComponent(value); } catch { /* Ignore a malformed cookie value. */ }
    return [part.slice(0, index).trim(), value];
  }).filter(([key]) => key));
}

export function sessionCookie(token, secure = false) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure ? "; Secure" : ""}`;
}

export function csrfCookie(token, secure = false) {
  return `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure = false) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function clearCsrfCookie(secure = false) {
  return `${CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
