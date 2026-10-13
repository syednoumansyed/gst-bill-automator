import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SESSION_COOKIE } from "./auth";
import { Access, configAccess } from "./requestGuards";
import { isShareMode } from "./shareMode";

/**
 * Server-component guard for /setup and /settings: 404 on the share link, login redirect when
 * ADMIN_PASSWORD is set, and a refusal (returned for the layout to render) for non-localhost hosts.
 */
export async function configPageAccess(path: "/setup" | "/settings"): Promise<Access> {
  if (isShareMode()) notFound();
  const [h, c] = await Promise.all([headers(), cookies()]);
  const access = configAccess(h.get("host"), c.get(SESSION_COOKIE)?.value);
  if (!access.ok && access.reason === "login") redirect(`/login?next=${encodeURIComponent(path)}`);
  return access;
}
