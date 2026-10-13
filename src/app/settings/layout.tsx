import { configPageAccess } from "@/lib/pageAccess";
import { AccessDenied } from "./_components/access-denied";

export const dynamic = "force-dynamic";

// 404 on the share link, login when ADMIN_PASSWORD is set, otherwise localhost only. /api/config checks again.
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const access = await configPageAccess("/settings");
  if (!access.ok) return <AccessDenied message={access.message} />;
  return children;
}
