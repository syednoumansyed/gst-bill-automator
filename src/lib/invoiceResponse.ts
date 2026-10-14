import { NextResponse } from "next/server";
import type { SyncResult } from "./sync";
import type { GeneratedInvoice } from "./types";

/**
 * The /api/generate success response. It is built completely before the sync runs, so nothing that can fail
 * happens after attachments are uploaded or Airtable is written; applySyncHeaders, the only step after the sync,
 * cannot throw.
 */

/** "INV-2026/08" → "INV-2026-08-GST.pdf": only letters, digits and "-" reach the header. */
export function invoiceFileName(invoiceNumber: string): string {
  const safe = invoiceNumber.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${safe || "invoice"}-GST.pdf`;
}

/** URI-encoded header value; a string that can't be encoded (lone surrogates) becomes "" instead of throwing. */
export function headerValue(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    return "";
  }
}

export function buildInvoiceResponse(invoice: GeneratedInvoice, pdf: Buffer, warnings: string[]): NextResponse {
  const response = new NextResponse(new Uint8Array(pdf));
  response.headers.set("Content-Type", "application/pdf");
  response.headers.set("Content-Disposition", `attachment; filename="${invoiceFileName(invoice.invoiceNumber)}"`);
  response.headers.set("Cache-Control", "no-store");
  // Until the sync has run; replaced by applySyncHeaders
  response.headers.set("X-Airtable-Sync-Status", "skipped");
  // Non-blocking notes (no LUT for this FY, warning-level review issues) as a URI-encoded JSON array of strings
  if (warnings.length > 0) {
    response.headers.set("X-Invoice-Warnings", headerValue(JSON.stringify(warnings)));
  }
  return response;
}

/** Status and code are fixed ASCII words and the message is URI-encoded, so setting them can't throw. */
export function applySyncHeaders(response: NextResponse, sync: SyncResult): void {
  try {
    response.headers.set("X-Airtable-Sync-Status", sync.status);
    if (sync.code) response.headers.set("X-Airtable-Sync-Code", sync.code);
    if (sync.message) response.headers.set("X-Airtable-Sync-Message", headerValue(sync.message));
  } catch {
    // Belt and braces: the invoice exists and was synced (or not); losing a header must not turn that into a 500
  }
}
