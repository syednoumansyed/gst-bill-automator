import fs from "node:fs";
import path from "node:path";
import { del, put } from "@vercel/blob";
import { configFilePath, isConfigReadOnly, type AppConfig } from "./config";
import { isShareMode } from "./shareMode";
import type { GeneratedInvoice } from "./types";

/**
 * Records an issued invoice in Airtable, with its PDFs on Vercel Blob as attachments. Call it only after the GST PDF
 * has rendered and the response is built: it is the last step of /api/generate that can fail, and it reports
 * failures in its result instead of throwing. It never leaves a partial entry:
 *
 *  1. Upload the Deel PDF, the FIRA PDF (when there is one) and the GST PDF to Blob.
 *     If any upload fails, the ones that succeeded are deleted and Airtable is NOT written: a row without its
 *     attachments would be a partial entry. Status `failed`, code BLOB_UPLOAD_FAILED. Generating again retries both,
 *     and the upsert on "Deel Invoice Number" makes the retry safe.
 *  2. Upsert the Airtable row on "Deel Invoice Number".
 *     - Airtable answered with an error (a definite rejection): the uploads are deleted. `failed`, AIRTABLE_* code.
 *     - No answer (timeout, network error after the request left): the row may or may not exist and may point at
 *       the uploads, so they are KEPT. Airtable is asked whether the row with this run's "Generated At" is there;
 *       if so it's a success, otherwise `failed` with AIRTABLE_UNCERTAIN and the user checks Airtable first.
 *  3. A deletion that fails is recorded in pending-blob-cleanup.json next to business.json (mode 600) and retried at
 *     the start of the next sync. Code BLOB_CLEANUP_FAILED; the message says whether the record could be written.
 *
 * Without a Blob token, attachments are switched off (not failed) and the row is written without them, as before.
 * Logs carry codes and blob pathnames only, never document values or Airtable's error text.
 */

export type SyncCode =
  | "SHARE_MODE"
  | "NOT_CONFIGURED"
  | "BLOB_UPLOAD_FAILED"
  | "BLOB_CLEANUP_FAILED"
  | "AIRTABLE_AUTH"
  | "AIRTABLE_DUPLICATES"
  | "AIRTABLE_SCHEMA"
  | "AIRTABLE_REJECTED"
  | "AIRTABLE_UNCERTAIN";

export interface SyncResult {
  status: "success" | "skipped" | "failed";
  code?: SyncCode;
  /** With BLOB_CLEANUP_FAILED: the failure that made the clean-up necessary */
  cause?: SyncCode;
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
type Failure = { code: SyncCode; message: string };

const AIRTABLE_TIMEOUT_MS = 20_000;
export const PENDING_CLEANUP_FILE = "pending-blob-cleanup.json";

const UNCERTAIN_MESSAGE =
  "Invoice was generated, but Airtable didn't confirm the write (the connection failed or timed out). Open Airtable and check whether this Deel invoice's row is there with its PDFs before generating again.";

export async function syncInvoice(invoice: GeneratedInvoice, docs: SyncDocuments, config: AppConfig): Promise<SyncResult> {
  // The public share link never writes to the owner's Airtable or Blob
  if (isShareMode()) return { status: "skipped", code: "SHARE_MODE" };
  const airtable = airtableSettings(config);
  if (!airtable) return { status: "skipped", code: "NOT_CONFIGURED" };
  const blobToken = normalizeSecret(process.env.BLOB_READ_WRITE_TOKEN);

  try {
    if (blobToken) await retryPendingCleanup(blobToken);

    let attachments: AirtableFields = {};
    let uploadedUrls: string[] = [];
    if (blobToken) {
      const upload = await uploadAttachments(invoice, docs, blobToken);
      uploadedUrls = upload.urls;
      if (!upload.ok) {
        console.error("[sync] BLOB_UPLOAD_FAILED; Airtable not written");
        return withCleanup(uploadedUrls, blobToken, {
          code: "BLOB_UPLOAD_FAILED",
          message:
            "Invoice was generated, but its PDFs couldn't be uploaded, so Airtable was not updated. Generate it again to retry; nothing was half-saved.",
        });
      }
      attachments = upload.fields;
    }

    const written = await writeAirtableRow(airtable, invoice, attachments);
    if (written === "uncertain") {
      // The row may exist and point at the uploads: keep them, and let the user check
      console.error(`[sync] AIRTABLE_UNCERTAIN; ${uploadedUrls.length} attachments kept`);
      return { status: "failed", code: "AIRTABLE_UNCERTAIN", message: UNCERTAIN_MESSAGE };
    }
    if (written !== "written") {
      console.error(`[sync] ${written.code}`);
      return blobToken ? withCleanup(uploadedUrls, blobToken, written) : { status: "failed", ...written };
    }
    // Airtable copies attachments from these URLs, so the blobs stay
    console.info(`[sync] success attachments=${uploadedUrls.length}`);
    return { status: "success" };
  } catch {
    // Nothing above should throw; if something did, the state is unknown, and saying so is the safe answer
    console.error("[sync] AIRTABLE_UNCERTAIN unexpected error");
    return { status: "failed", code: "AIRTABLE_UNCERTAIN", message: UNCERTAIN_MESSAGE };
  }
}

/** Deletes this run's uploads after a definite failure; a failed deletion becomes BLOB_CLEANUP_FAILED. */
async function withCleanup(urls: string[], token: string, failure: Failure): Promise<SyncResult> {
  const cleanup = await deleteBlobs(urls, token);
  if (cleanup === "deleted") {
    if (urls.length > 0) console.info(`[sync] ${failure.code}; ${urls.length} uploaded attachments removed`);
    return { status: "failed", ...failure };
  }
  const followUp =
    cleanup === "recorded"
      ? `The PDFs uploaded for it couldn't be removed; they are listed in config/${PENDING_CLEANUP_FILE} and will be removed on the next sync.`
      : "The PDFs uploaded for it couldn't be removed or recorded for a later retry; delete them from the Blob store by hand.";
  return { status: "failed", code: "BLOB_CLEANUP_FAILED", cause: failure.code, message: `${failure.message} ${followUp}` };
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
    uploads.map(async ([, name, body]) => put(name, body, { access: "public", addRandomSuffix: true, token })),
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

/** "deleted" (or nothing to delete), "recorded" for a later retry, or "lost" when even that failed. */
async function deleteBlobs(urls: string[], token: string): Promise<"deleted" | "recorded" | "lost"> {
  if (urls.length === 0) return "deleted";
  try {
    await del(urls, { token });
    return "deleted";
  } catch {
    const recorded = recordPendingCleanup(urls);
    console.error(`[sync] BLOB_CLEANUP_FAILED recorded=${recorded} pathnames=${urls.map(pathnameOf).join(",")}`);
    return recorded ? "recorded" : "lost";
  }
}

const pathnameOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return "(invalid url)";
  }
};

// Deletions that failed, kept next to business.json so the next sync can finish them

type PendingCleanup = { blobs: { url: string; recordedAt: string }[] };

const pendingCleanupPath = () => path.join(path.dirname(configFilePath()), PENDING_CLEANUP_FILE);

function readPendingCleanup(): PendingCleanup {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingCleanupPath(), "utf8"));
    const blobs = Array.isArray(parsed?.blobs) ? parsed.blobs.filter((b: { url?: unknown }) => typeof b?.url === "string") : [];
    return { blobs };
  } catch {
    return { blobs: [] };
  }
}

function writePendingCleanup(pending: PendingCleanup): boolean {
  const file = pendingCleanupPath();
  try {
    if (pending.blobs.length === 0) {
      fs.rmSync(file, { force: true });
      return true;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pending, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Adds URLs to the recovery file. Not possible in share mode or with a read-only (env-supplied) config. */
function recordPendingCleanup(urls: string[]): boolean {
  if (isShareMode() || isConfigReadOnly()) return false;
  const pending = readPendingCleanup();
  const known = new Set(pending.blobs.map((b) => b.url));
  const recordedAt = new Date().toISOString();
  for (const url of urls) if (!known.has(url)) pending.blobs.push({ url, recordedAt });
  return writePendingCleanup(pending);
}

/** Finishes deletions an earlier sync couldn't; on failure they stay recorded for the next one. */
async function retryPendingCleanup(token: string): Promise<void> {
  if (isConfigReadOnly()) return;
  const urls = readPendingCleanup().blobs.map((b) => b.url);
  if (urls.length === 0) return;
  try {
    await del(urls, { token });
  } catch {
    console.error(`[sync] BLOB_CLEANUP_FAILED retry pathnames=${urls.map(pathnameOf).join(",")}`);
    return;
  }
  // Re-read so URLs recorded meanwhile by another request are kept
  const done = new Set(urls);
  writePendingCleanup({ blobs: readPendingCleanup().blobs.filter((b) => !done.has(b.url)) });
  console.info(`[sync] pending clean-up finished count=${urls.length}`);
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

/**
 * "written"; a Failure when Airtable answered with an error status (a definite rejection, whatever its body);
 * "uncertain" when no answer arrived and a follow-up query couldn't confirm the row either.
 */
async function writeAirtableRow(
  airtable: AirtableSettings,
  invoice: GeneratedInvoice,
  attachments: AirtableFields,
): Promise<"written" | "uncertain" | Failure> {
  const legacyFields = buildLegacyAirtableFields(invoice);
  const complianceFields = buildComplianceAirtableFields(invoice);
  let res = await upsert(airtable, { ...legacyFields, ...complianceFields, ...attachments });
  if (res === null) return (await rowWasWritten(airtable, invoice)) ? "written" : "uncertain";
  if (res.ok) return "written";

  let error = await readJsonSafely(res);
  if (hasUnknownFieldError(error)) {
    console.warn("[sync] AIRTABLE_SCHEMA; retrying with the legacy fields only");
    // The legacy fields carry no "Generated At", so an unanswered retry can't be confirmed: it stays uncertain
    res = await upsert(airtable, { ...legacyFields, ...attachments });
    if (res === null) return "uncertain";
    if (res.ok) return "written";
    error = await readJsonSafely(res);
  }
  return describeAirtableFailure(error);
}

/** The HTTP response, or null when none arrived (network error, timeout): the write may still have happened. */
async function upsert(airtable: AirtableSettings, fields: AirtableFields): Promise<Response | null> {
  try {
    return await fetch(airtable.url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${airtable.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        performUpsert: { fieldsToMergeOn: ["Deel Invoice Number"] },
        records: [{ fields }],
      }),
      signal: AbortSignal.timeout(AIRTABLE_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/** After an unanswered write: is this run's row (same "Generated At") in Airtable? Any doubt answers false. */
async function rowWasWritten(airtable: AirtableSettings, invoice: GeneratedInvoice): Promise<boolean> {
  const metadata = invoice.complianceMetadata;
  const quoted = metadata.deel.invoiceNumber.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = new URLSearchParams({ filterByFormula: `{Deel Invoice Number}='${quoted}'`, maxRecords: "5" });
  query.append("fields[]", "Generated At");
  try {
    const res = await fetch(`${airtable.url}?${query}`, {
      headers: { Authorization: `Bearer ${airtable.token}` },
      signal: AbortSignal.timeout(AIRTABLE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { records?: { fields?: Record<string, unknown> }[] };
    return (body.records ?? []).some((r) => r.fields?.["Generated At"] === metadata.generatedAt);
  } catch {
    return false;
  }
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

/** The error body; an unreadable one is null (the status alone already says Airtable refused). */
async function readJsonSafely(response: Response): Promise<unknown> {
  let rawBody = "";
  try {
    rawBody = await response.text();
  } catch {
    return null;
  }
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
