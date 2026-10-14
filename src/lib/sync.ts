import { del, put } from "@vercel/blob";
import type { AppConfig } from "./config";
import { isShareMode } from "./shareMode";
import type { GeneratedInvoice } from "./types";

/**
 * Records an issued invoice in Airtable, with its PDFs on Vercel Blob as attachments. Call it only after the GST PDF
 * has rendered. It never leaves a partial entry:
 *
 *  1. Upload the Deel PDF, the FIRA PDF (when there is one) and the GST PDF to Blob.
 *     If any upload fails, the ones that succeeded are deleted and Airtable is NOT written: a row without its
 *     attachments would be a partial entry. Status `failed`, code BLOB_UPLOAD_FAILED. Generating again retries both,
 *     and the upsert on "Deel Invoice Number" makes the retry safe.
 *  2. Upsert the Airtable row on "Deel Invoice Number". If that fails (or can't be confirmed), the blobs uploaded in
 *     step 1 are deleted, best effort, so no orphan attachment is left. Status `failed` with an AIRTABLE_* code.
 *
 * Without a Blob token, attachments are switched off (not failed) and the row is written without them, as before.
 * Logs carry codes only, never document values or Airtable's error text.
 */

export type SyncCode =
  | "SHARE_MODE"
  | "NOT_CONFIGURED"
  | "BLOB_UPLOAD_FAILED"
  | "AIRTABLE_AUTH"
  | "AIRTABLE_DUPLICATES"
  | "AIRTABLE_SCHEMA"
  | "AIRTABLE_REJECTED"
  | "AIRTABLE_UNREACHABLE";

export interface SyncResult {
  status: "success" | "skipped" | "failed";
  code?: SyncCode;
  /** Plain-language explanation for the user, set when the status is failed */
  message?: string;
}

export interface SyncDocuments {
  deelPdf: Buffer;
  firaPdf: Buffer | null;
  gstPdf: Buffer;
}

type AirtableFieldValue = string | number | null | undefined | { url: string }[];
type AirtableFields = Record<string, AirtableFieldValue>;
type AirtableSettings = { token: string; url: string };

const AIRTABLE_TIMEOUT_MS = 20_000;

export async function syncInvoice(invoice: GeneratedInvoice, docs: SyncDocuments, config: AppConfig): Promise<SyncResult> {
  // The public share link never writes to the owner's Airtable or Blob
  if (isShareMode()) return { status: "skipped", code: "SHARE_MODE" };
  const airtable = airtableSettings(config);
  if (!airtable) return { status: "skipped", code: "NOT_CONFIGURED" };

  const blobToken = normalizeSecret(process.env.BLOB_READ_WRITE_TOKEN);
  let attachments: AirtableFields = {};
  let uploadedUrls: string[] = [];
  if (blobToken) {
    const upload = await uploadAttachments(invoice, docs, blobToken);
    uploadedUrls = upload.urls;
    if (!upload.ok) {
      await deleteBlobs(uploadedUrls, blobToken);
      console.error("[sync] BLOB_UPLOAD_FAILED; Airtable not written");
      return {
        status: "failed",
        code: "BLOB_UPLOAD_FAILED",
        message:
          "Invoice was generated, but its PDFs couldn't be uploaded, so Airtable was not updated. Generate it again to retry; nothing was half-saved.",
      };
    }
    attachments = upload.fields;
  }

  const written = await writeAirtableRow(airtable, invoice, attachments);
  if (!written.ok) {
    if (blobToken) await deleteBlobs(uploadedUrls, blobToken);
    console.error(`[sync] ${written.code}; uploaded attachments removed`);
    return { status: "failed", code: written.code, message: written.message };
  }
  // Airtable copies attachments from these URLs, so the blobs stay
  console.info(`[sync] success attachments=${uploadedUrls.length}`);
  return { status: "success" };
}

// ─── Blob ─────────────────────────────────────────────────────────────────────

async function uploadAttachments(
  invoice: GeneratedInvoice,
  docs: SyncDocuments,
  token: string,
): Promise<{ ok: boolean; urls: string[]; fields: AirtableFields }> {
  const deelInvoiceNumber = invoice.complianceMetadata.deel.invoiceNumber;
  const uploads: [field: string, name: string, body: Buffer][] = [
    ["Deel PDF", createBlobName("deel", deelInvoiceNumber), docs.deelPdf],
    ...(docs.firaPdf ? [["FIRA PDF", createBlobName("fira", invoice.invoiceNumber), docs.firaPdf] as [string, string, Buffer]] : []),
    ["GST Invoice PDF", createBlobName("gst", invoice.invoiceNumber), docs.gstPdf],
  ];
  const results = await Promise.allSettled(
    uploads.map(([, name, body]) => put(name, body, { access: "public", addRandomSuffix: true, token })),
  );
  const fields: AirtableFields = {};
  const urls: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled" && result.value?.url) {
      urls.push(result.value.url);
      fields[uploads[i][0]] = [{ url: result.value.url }];
    }
  });
  return { ok: urls.length === uploads.length, urls, fields };
}

async function deleteBlobs(urls: string[], token: string): Promise<void> {
  if (urls.length === 0) return;
  try {
    await del(urls, { token });
  } catch {
    console.error(`[sync] BLOB_CLEANUP_FAILED count=${urls.length}`);
  }
}

function createBlobName(prefix: string, invoiceNumber: string): string {
  const safeInvoiceNumber = invoiceNumber.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/-+/g, "-");
  return `${prefix}-${safeInvoiceNumber || "invoice"}.pdf`;
}

// ─── Airtable ─────────────────────────────────────────────────────────────────

/** Tokens only come from env; business.json holds the non-secret base and table. */
function airtableSettings(config: AppConfig): AirtableSettings | null {
  const token = normalizeSecret(process.env.AIRTABLE_API_KEY);
  const baseId = normalizeSecret(process.env.AIRTABLE_BASE_ID) || normalizeSecret(config.airtableIntegration?.baseId);
  const tableName =
    normalizeSecret(process.env.AIRTABLE_TABLE_NAME) || normalizeSecret(config.airtableIntegration?.tableName) || "GST Invoices";
  if (!token || !baseId || !tableName) return null;
  return { token, url: `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}` };
}

async function writeAirtableRow(
  airtable: AirtableSettings,
  invoice: GeneratedInvoice,
  attachments: AirtableFields,
): Promise<{ ok: true } | { ok: false; code: SyncCode; message: string }> {
  const legacyFields = buildLegacyAirtableFields(invoice);
  const complianceFields = buildComplianceAirtableFields(invoice);
  try {
    let res = await upsert(airtable, { ...legacyFields, ...complianceFields, ...attachments });
    let error: unknown = null;
    if (!res.ok) {
      error = await readJsonSafely(res);
      if (hasUnknownFieldError(error)) {
        console.warn("[sync] AIRTABLE_SCHEMA; retrying with the legacy fields only");
        res = await upsert(airtable, { ...legacyFields, ...attachments });
        error = res.ok ? null : await readJsonSafely(res);
      }
    }
    if (res.ok) return { ok: true };
    return { ok: false, ...describeAirtableFailure(error) };
  } catch {
    // Network failure or timeout: the write may or may not have landed. Reporting failed (and removing the uploads)
    // is the safe answer; generating again upserts the same row with fresh attachments.
    return {
      ok: false,
      code: "AIRTABLE_UNREACHABLE",
      message: "Invoice was generated, but Airtable couldn't be reached. Check the connection and generate it again to sync.",
    };
  }
}

function upsert(airtable: AirtableSettings, fields: AirtableFields): Promise<Response> {
  return fetch(airtable.url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${airtable.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      performUpsert: { fieldsToMergeOn: ["Deel Invoice Number"] },
      records: [{ fields }],
    }),
    signal: AbortSignal.timeout(AIRTABLE_TIMEOUT_MS),
  });
}

function buildLegacyAirtableFields(invoice: GeneratedInvoice): AirtableFields {
  return {
    "Invoice Number": invoice.invoiceNumber,
    "Date": invoice.invoiceDate,
    "Client": invoice.client.clientName,
    "USD Billed": invoice.firaData ? invoice.firaData.originalUsdBilled : invoice.subtotal,
    "INR Realized": invoice.firaData ? invoice.firaData.fundsRealizedInr : null,
    "Bank Charges (USD)": invoice.firaData ? invoice.firaData.bankChargesUsd : null,
    "FIRA Reference": invoice.firaData ? invoice.firaData.firaRef : null,
    "Deel Invoice Number": invoice.complianceMetadata.deel.invoiceNumber,
    "Service Period": invoice.servicePeriod || null,
  };
}

function buildComplianceAirtableFields(invoice: GeneratedInvoice): AirtableFields {
  const metadata = invoice.complianceMetadata;
  const deel = metadata.deel;
  return {
    "Compliance Key": metadata.complianceKey,
    "Compliance Metadata": JSON.stringify(metadata, null, 2),
    "Workflow Version": metadata.workflowVersion,
    "Generated At": metadata.generatedAt,
    "Deel Reference": metadata.sourceDocuments.deelReference || null,
    "Deel Issue Date": deel.issueDate || null,
    "Deel Due Date": deel.dueDate || null,
    "Deel Currency": deel.currency || null,
    "Deel Subtotal": stringifyField(deel.subtotal),
    "Deel Total": stringifyField(deel.total),
    "Client Country": invoice.client.country || null,
    "Client VAT ID": invoice.client.vatId || null,
    "Client Registration Number": invoice.client.registrationNumber || null,
    "GST Invoice Number": invoice.invoiceNumber,
    "GST Invoice Date": invoice.invoiceDate,
    "GST Currency": invoice.currency,
    "GST Place Of Supply": invoice.placeOfSupply,
    "GST Note": invoice.gstNote,
    "LUT Financial Year": invoice.supplier.lut.financialYear || null,
    "LUT Rule": invoice.supplier.lut.rule || null,
    "SAC Code": invoice.lineItems[0]?.sacCode || null,
    "FIRA Processed Date": invoice.firaData?.firaDate || null,
    "FIRA USD Realized": stringifyField(invoice.firaData?.fundsRealizedUsd),
    "FIRA INR Realized": stringifyField(invoice.firaData?.fundsRealizedInr),
    "Exchange Rate": stringifyField(invoice.firaData?.exchangeRate),
  };
}

function airtableErrorDetails(error: unknown): { type: string; message: string } {
  if (!error || typeof error !== "object") return { type: "", message: "" };
  const details = "error" in error && error.error && typeof error.error === "object" ? error.error : error;
  return {
    type: "type" in details ? String(details.type) : "",
    message: "message" in details ? String(details.message) : "",
  };
}

function hasUnknownFieldError(error: unknown): boolean {
  const { type, message } = airtableErrorDetails(error);
  return type === "UNKNOWN_FIELD_NAME" || /unknown field name/i.test(message);
}

function describeAirtableFailure(error: unknown): { code: SyncCode; message: string } {
  const { type, message } = airtableErrorDetails(error);
  if (type === "AUTHENTICATION_REQUIRED") {
    return {
      code: "AIRTABLE_AUTH",
      message:
        "Invoice was generated, but Airtable sync failed because Airtable rejected the token. If you pasted the value shown in the token list, replace it with the full PAT secret from Create/Regenerate token.",
    };
  }
  if (message.includes("Cannot update more than one record")) {
    return {
      code: "AIRTABLE_DUPLICATES",
      message:
        "Invoice was generated, but Airtable sync failed: There are existing duplicate rows for this Deel Invoice Number in Airtable. Please delete the duplicates in Airtable so the update can succeed.",
    };
  }
  if (hasUnknownFieldError(error)) {
    return {
      code: "AIRTABLE_SCHEMA",
      message: "Invoice was generated, but Airtable is missing one or more compliance fields. Update the table schema and try again.",
    };
  }
  return {
    code: "AIRTABLE_REJECTED",
    message: message ? `Invoice was generated, but Airtable sync failed: ${message}` : "Invoice was generated, but Airtable sync failed.",
  };
}

async function readJsonSafely(response: Response): Promise<unknown> {
  const rawBody = await response.text();
  if (!rawBody) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return { rawBody };
  }
}

function stringifyField(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function normalizeSecret(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim() || undefined;
  }
  return trimmed;
}
