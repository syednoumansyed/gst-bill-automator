import Link from "next/link";
import { notFound } from "next/navigation";
import { isAuthEnabled } from "@/lib/auth";
import { isShareMode } from "@/lib/shareMode";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

// Only these pages are worth returning to; anything else (absolute URLs, //host) goes to /settings
const RETURN_PATHS = new Set(["/settings", "/setup", "/"]);

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  if (isShareMode()) notFound();
  const { next } = await searchParams;
  const returnTo = typeof next === "string" && RETURN_PATHS.has(next) ? next : "/settings";

  return (
    <div className="min-h-screen bg-[#FAF8F3] flex items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-4 rounded-lg border-2 border-black bg-white px-6 py-6 shadow-[4px_4px_0_0_black]">
        <h1 className="text-xl font-extrabold">Sign in to settings</h1>
        {isAuthEnabled() ? (
          <LoginForm returnTo={returnTo} />
        ) : (
          <>
            <p className="text-sm">
              No <code>ADMIN_PASSWORD</code> is set, so there&apos;s nothing to sign in to. Settings open without a password at http://localhost.
            </p>
            <Link href={returnTo} className="inline-block text-sm font-semibold underline">Continue</Link>
          </>
        )}
      </div>
    </div>
  );
}
