import { NextRequest, NextResponse } from "next/server";
import { ConfigError, configExists, getConfig, hasLegacySecrets, isConfigReadOnly, saveConfig } from "@/lib/config";
import { missingRequiredFields, validateConfigInput } from "@/lib/configSchema";
import { isAuthEnabled } from "@/lib/auth";
import { guardConfigRequest } from "@/lib/requestGuards";

// Bank details live here: share mode 404s, and access needs a login (ADMIN_PASSWORD) or a localhost request
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

// Read config. Never includes a token: integrations only report whether their env vars are set.
export async function GET(req: NextRequest) {
  const blocked = guardConfigRequest(req, { write: false });
  if (blocked) return blocked;
  try {
    const config = getConfig();
    return NextResponse.json({
      ...config,
      integrations: {
        airtable: Boolean(process.env.AIRTABLE_API_KEY?.trim()),
        blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim()),
        airtableBaseFromEnv: Boolean(process.env.AIRTABLE_BASE_ID?.trim()),
        airtableTableFromEnv: Boolean(process.env.AIRTABLE_TABLE_NAME?.trim()),
      },
      status: {
        configExists: configExists(),
        readOnly: isConfigReadOnly(),
        authEnabled: isAuthEnabled(),
        legacySecretsIgnored: hasLegacySecrets(),
        missing: missingRequiredFields(config),
      },
    }, { headers: noStore });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeMessage(error, "Failed to read config") }, { status: 500 });
  }
}

// Update config: validated with the same schema as the form; unknown keys (incl. legacy tokens) are dropped
export async function POST(req: NextRequest) {
  const blocked = guardConfigRequest(req, { write: true });
  if (blocked) return blocked;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body isn't valid JSON." }, { status: 400 });
  }
  const result = validateConfigInput(body);
  if (!result.ok) {
    return NextResponse.json({ error: "Some fields need fixing.", fieldErrors: result.errors }, { status: 400 });
  }
  try {
    saveConfig(result.data);
    return NextResponse.json({ success: true, message: "Configuration saved." });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeMessage(error, "Failed to save config") }, { status: 500 });
  }
}

// Only ConfigError messages are written to be shown; anything else may quote file contents or paths
function safeMessage(error: unknown, fallback: string): string {
  if (error instanceof ConfigError) return error.message;
  console.error(fallback, error instanceof Error ? error.name : "unknown error");
  return fallback;
}
