import { NextResponse } from "next/server";
import { isAuthEnabled, SESSION_COOKIE, verifySessionToken } from "./auth";
import { isShareMode } from "./shareMode";

/**
 * Request checks for the config pages and APIs. They run inside each route handler and server component
 * (not only in middleware, which has had bypass bugs), and only read the raw Host/Origin/Cookie headers.
 */

type HeaderSource = { get(name: string): string | null };

export type Access =
  | { ok: true }
  | { ok: false; status: 401 | 403; reason: "login" | "host"; message: string };

// localhost / 127.0.0.1 / [::1], optional port. Anything else (a LAN IP, a domain, a DNS-rebinding name) is remote.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

export const isLocalHost = (host: string | null | undefined) => !!host && LOCAL_HOST.test(host.trim());

/**
 * Who may read or change the business config:
 * with ADMIN_PASSWORD set, anyone holding a valid session cookie; without it, only requests addressed to localhost.
 */
export function configAccess(host: string | null, sessionToken: string | undefined | null): Access {
  if (isAuthEnabled()) {
    return verifySessionToken(sessionToken)
      ? { ok: true }
      : { ok: false, status: 401, reason: "login", message: "Sign in to change settings." };
  }
  return isLocalHost(host)
    ? { ok: true }
    : {
        ok: false,
        status: 403,
        reason: "host",
        message: "Settings can only be opened at http://localhost. To manage them from another address, set ADMIN_PASSWORD.",
      };
}

/** Error message when a state-changing request comes from another site, or null when it's same-origin. */
export function crossOriginProblem(headers: HeaderSource): string | null {
  const host = headers.get("host")?.trim().toLowerCase();
  const origin = headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      // "null" (sandboxed iframes, file://) and garbage both land here
    }
    return host && originHost === host ? null : "Cross-origin request refused.";
  }
  // No Origin: non-browser clients (curl, scripts). Browsers that omit it still send Sec-Fetch-Site.
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return "Cross-origin request refused.";
  return null;
}

export const isJsonRequest = (headers: HeaderSource) =>
  (headers.get("content-type") || "").toLowerCase().split(";")[0].trim() === "application/json";

type RequestLike = { headers: HeaderSource; cookies: { get(name: string): { value: string } | undefined } };

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status });

/** POST guard for every route that changes state: same-origin only. */
export function rejectCrossOrigin(req: RequestLike): NextResponse | null {
  const problem = crossOriginProblem(req.headers);
  return problem ? json(403, { error: problem }) : null;
}

/**
 * Guard for /api/generate. A generated invoice carries the owner's GSTIN and bank details and may sync to their
 * Airtable, so outside share mode it follows the same login/localhost rule as the config (this also stops
 * DNS-rebinding pages from requesting invoices).
 */
export function guardGenerateRequest(req: RequestLike): NextResponse | null {
  const crossOrigin = rejectCrossOrigin(req);
  if (crossOrigin) return crossOrigin;
  if (isShareMode()) return null;
  const access = configAccess(req.headers.get("host"), req.cookies.get(SESSION_COOKIE)?.value);
  if (access.ok) return null;
  const message = access.reason === "login"
    ? "Sign in to generate invoices."
    : "Invoices can only be generated at http://localhost. To use another address, set ADMIN_PASSWORD.";
  return json(access.status, { error: message, reason: access.reason });
}

/**
 * Full guard for /api/config: 404 in share mode, then login/localhost, and for writes also same-origin + JSON.
 * Returns the response to send, or null when the request may proceed.
 */
export function guardConfigRequest(req: RequestLike, { write }: { write: boolean }): NextResponse | null {
  if (isShareMode()) return json(404, { error: "Not found" });
  if (write) {
    const crossOrigin = rejectCrossOrigin(req);
    if (crossOrigin) return crossOrigin;
    if (!isJsonRequest(req.headers)) return json(415, { error: "Send the config as application/json." });
  }
  const access = configAccess(req.headers.get("host"), req.cookies.get(SESSION_COOKIE)?.value);
  if (!access.ok) return json(access.status, { error: access.message, reason: access.reason });
  return null;
}
