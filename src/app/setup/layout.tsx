import { configPageAccess } from "@/lib/pageAccess";
import { AccessDenied } from "../settings/_components/access-denied";

export const dynamic = "force-dynamic";

// Same gate as /settings: 404 on the share link, login when ADMIN_PASSWORD is set, otherwise localhost only
export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const access = await configPageAccess("/setup");
  if (!access.ok) return <AccessDenied message={access.message} />;
  return children;
}
