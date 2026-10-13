import crypto from "crypto";

/**
 * Optional admin login for self-hosting. Set ADMIN_PASSWORD to require it for /setup, /settings and /api/config.
 * Sessions are a stateless HMAC-signed cookie; changing the password signs everyone out.
 */
export const SESSION_COOKIE = "gst_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const adminPassword = () => process.env.ADMIN_PASSWORD || "";

export const isAuthEnabled = () => adminPassword().length > 0;

// Key derived from the password so no second secret has to be configured
const sessionKey = () => crypto.createHash("sha256").update(`gst-bill-automator/session/v1\0${adminPassword()}`).digest();

const sign = (payload: string) => crypto.createHmac("sha256", sessionKey()).update(payload).digest("base64url");

/** Constant-time string compare: hash both sides so lengths can't leak either. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function checkPassword(candidate: unknown): boolean {
  if (!isAuthEnabled() || typeof candidate !== "string") return false;
  return safeEqual(candidate, adminPassword());
}

export function createSessionToken(now = Date.now()): { value: string; maxAgeSeconds: number } {
  const payload = `v1.${now + SESSION_TTL_MS}`;
  return { value: `${payload}.${sign(payload)}`, maxAgeSeconds: SESSION_TTL_MS / 1000 };
}

export function verifySessionToken(token: string | undefined | null, now = Date.now()): boolean {
  if (!isAuthEnabled() || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires <= now) return false;
  return safeEqual(parts[2], sign(`${parts[0]}.${parts[1]}`));
}
