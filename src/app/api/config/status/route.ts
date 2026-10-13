import { NextResponse } from "next/server";
import { configExists, getConfig } from "@/lib/config";
import { missingRequiredFields } from "@/lib/configSchema";
import { isShareMode } from "@/lib/shareMode";

export const dynamic = "force-dynamic";

// Whether setup is finished, for the home page's /setup prompt. Field names only, never values.
export async function GET() {
  if (isShareMode()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const missing = missingRequiredFields(getConfig());
    return NextResponse.json(
      { ready: missing.length === 0, configExists: configExists(), missing },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // An unreadable business.json shouldn't hide the prompt
    return NextResponse.json({ ready: false, configExists: true, missing: ["valid config file"] });
  }
}
