import { randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { hashToken, nowIso } from "./utils.js";

const SESSION_DAYS = 7;
const loginAttempts = new Map();

export async function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });
}

export async function verifyPassword(password, encoded) {
  try {
    return await argon2.verify(encoded, password);
  } catch {
    return false;
  }
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (user_id, token_hash, csrf_token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, hashToken(token), hashToken(csrfToken), expiresAt, nowIso());
  return { token, csrfToken, expiresAt };
}

export function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([key]) => key));
}

export function getSession(db, cookieHeader) {
  const token = parseCookies(cookieHeader).yardsale_session;
  if (!token) return null;
  const session = db.prepare(`
    SELECT sessions.*, admin_users.login
    FROM sessions JOIN admin_users ON admin_users.id = sessions.user_id
    WHERE token_hash = ?
  `).get(hashToken(token));
  if (!session) return null;
  if (Date.parse(session.expires_at) <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    return null;
  }
  return session;
}

export function sessionCsrfIsValid(session, token) {
  if (!session || !token) return false;
  const expected = Buffer.from(session.csrf_token_hash);
  const actual = Buffer.from(hashToken(token));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function sessionCookie(token, secure = false) {
  return `yardsale_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure ? "; Secure" : ""}`;
}

export function csrfCookie(token, secure = false) {
  return `yardsale_csrf=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure ? "; Secure" : ""}`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export function loginKey(request, login) {
  return `${request.socket.remoteAddress ?? "unknown"}:${String(login).toLowerCase()}`;
}

export function loginBlocked(key) {
  const attempt = loginAttempts.get(key);
  if (!attempt) return false;
  if (attempt.resetAt <= Date.now()) {
    loginAttempts.delete(key);
    return false;
  }
  return attempt.failures >= 5;
}

export function noteLoginFailure(key) {
  const current = loginAttempts.get(key);
  const attempt = current && current.resetAt > Date.now()
    ? current
    : { failures: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  attempt.failures += 1;
  loginAttempts.set(key, attempt);
}

export function clearLoginFailures(key) {
  loginAttempts.delete(key);
}
