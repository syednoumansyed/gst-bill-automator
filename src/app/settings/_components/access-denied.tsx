import Link from "next/link";

/** Shown instead of /setup or /settings when the request isn't from localhost and no ADMIN_PASSWORD is set. */
export function AccessDenied({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-[#FAF8F3] flex items-center justify-center px-6">
      <div className="max-w-lg space-y-3 rounded-lg border-2 border-black bg-white px-6 py-5 text-sm shadow-[4px_4px_0_0_black]">
        <h1 className="text-lg font-extrabold">Settings are locked</h1>
        <p>{message}</p>
        <p className="text-muted-foreground">
          This protects your bank and tax details when the app is reachable from other machines.
        </p>
        <Link href="/" className="inline-block font-semibold underline">Back to the generator</Link>
      </div>
    </div>
  );
}
