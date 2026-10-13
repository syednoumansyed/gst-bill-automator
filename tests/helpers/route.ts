import { NextRequest } from "next/server";
import { vi } from "vitest";
import { fakeConfigJson } from "./fixtures";

/** Fake business profile in, every outside-service credential out, so a test can never sync anything. */
export function stubRouteEnv(): void {
  vi.stubEnv("BUSINESS_CONFIG_JSON", fakeConfigJson());
  for (const name of ["AIRTABLE_API_KEY", "AIRTABLE_BASE_ID", "AIRTABLE_TABLE_NAME", "BLOB_READ_WRITE_TOKEN", "SHARE_MODE", "VERCEL"]) {
    vi.stubEnv(name, "");
  }
}

/** A multipart POST like the browser form sends, including the Content-Length browsers always set. */
export async function generateRequest(fields: { file?: Buffer; firaFile?: Buffer } & Record<string, string | Buffer | undefined>): Promise<NextRequest> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (typeof value === "string") form.set(key, value);
    else form.set(key, new File([new Uint8Array(value)], `${key}.pdf`, { type: "application/pdf" }));
  }
  const encoded = new Response(form);
  const body = new Uint8Array(await encoded.arrayBuffer());
  return new NextRequest("http://localhost/api/generate", {
    method: "POST",
    body,
    headers: {
      host: "localhost",
      "content-type": encoded.headers.get("content-type") ?? "",
      "content-length": String(body.byteLength),
    },
  });
}
