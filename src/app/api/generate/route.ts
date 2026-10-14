import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { checkUploadRequest, readDeelPdf, readForm, readPdfField, routeErrorResponse } from "@/lib/apiRequest";
import { AppConfig, getConfig } from "@/lib/config";
import { invoiceDraftSchema, type InvoiceDraft } from "@/lib/draft";
import { draftFromParsed, draftOptions, type DeelExtras } from "@/lib/draftAdapter";
import { validateDraft } from "@/lib/draftValidation";
import { issue, IssueError, type IssueDocument } from "@/lib/errors";
import { generateInvoiceFromDraft } from "@/lib/generateInvoiceData";
import { generatePdf } from "@/lib/generatePdf";
import { parseDeelInvoice } from "@/lib/parseDeelInvoice";
import { parseFiraPdf } from "@/lib/parseFira";
import { syncInvoice } from "@/lib/sync";
import type { FiraParsedData, ReviewRecord, SourceDocumentSummary } from "@/lib/types";
import { validateDeelData, validateSupplier } from "@/lib/validateInvoice";

/**
 * Step 3 of parse → review → generate (docs/parsing.md). Issues the GST invoice from the confirmed review draft
 * (multipart `draft`, JSON), with `file` / `firaFile` as attachments. A request without `draft` is the legacy
 * one-step form: the PDFs are parsed here and turned into a draft. Either way every cross-check runs on the draft,
 * the PDF renders, and only then are attachments uploaded and Airtable written (src/lib/sync.ts).
 */

type Prepared = {
  draft: InvoiceDraft;
  deelPdf: Buffer;
  /** FIRA PDF to attach: only when the draft's FIRA came from it */
  firaPdf: Buffer | null;
  review: ReviewRecord;
  extras?: DeelExtras;
};

export async function POST(req: NextRequest) {
  // Another site must not be able to submit uploads here from the user's browser
  const rejected = checkUploadRequest(req);
  if (rejected) return rejected;
  try {
    const form = await readForm(req);
    const rawDraft = form.get("draft");
    const prepared = rawDraft !== null ? await fromDraft(form, rawDraft) : await fromLegacyForm(form);

    const config = getConfig();
    const issues = validateDraft(prepared.draft, config.businessProfile);
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length > 0) throw new IssueError(errors);

    const invoice = generateInvoiceFromDraft(prepared.draft, config, { review: prepared.review, extras: prepared.extras });

    // Render first: nothing is uploaded or written for an invoice that didn't render
    const pdfBuffer = await generatePdf(invoice);
    const sync = await syncInvoice(invoice, { deelPdf: prepared.deelPdf, firaPdf: prepared.firaPdf, gstPdf: pdfBuffer }, config);
    console.info(
      `[generate] issued mode=${prepared.review.mode} edited=${prepared.draft.edited.length} sync=${sync.status}${sync.code ? `:${sync.code}` : ""}`,
    );

    const response = new NextResponse(new Uint8Array(pdfBuffer));
    response.headers.set("Content-Type", "application/pdf");
    response.headers.set("Content-Disposition", `attachment; filename="${invoice.invoiceNumber}-GST.pdf"`);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Airtable-Sync-Status", sync.status);
    if (sync.code) response.headers.set("X-Airtable-Sync-Code", sync.code);
    if (sync.message) response.headers.set("X-Airtable-Sync-Message", encodeURIComponent(sync.message));
    // Non-blocking notes (no LUT for this FY, warning-level review issues) as a URI-encoded JSON array of strings
    const warnings = [...(invoice.warnings ?? []), ...issues.filter((i) => i.severity === "warning").map((i) => i.message)];
    if (warnings.length > 0) {
      response.headers.set("X-Invoice-Warnings", encodeURIComponent(JSON.stringify(warnings)));
    }
    return response;
  } catch (error: unknown) {
    return routeErrorResponse(error, "generate", "Failed to generate the invoice.");
  }
}

// ─── Review draft ─────────────────────────────────────────────────────────────

async function fromDraft(form: FormData, rawDraft: FormDataEntryValue): Promise<Prepared> {
  const draft = parseDraft(rawDraft);
  const deelPdf = await readDeelPdf(form);
  const uploadedFira = await readPdfField(form, "firaFile", "The FIRA");
  if (draft.fira?.source === "pdf" && !uploadedFira) {
    throw new IssueError(
      issue(
        "REQUEST_INVALID",
        "fira",
        "The FIRA PDF is missing; it is attached to the invoice record.",
        "Upload the FIRA PDF again, or switch the FIRA to manual entry.",
        { field: "fira" },
      ),
    );
  }
  // A FIRA the draft doesn't use (none, or entered by hand) is not attached to this invoice
  const firaPdf = draft.fira?.source === "pdf" ? uploadedFira : null;
  return {
    draft,
    deelPdf,
    firaPdf,
    review: { mode: "review", edited: draft.edited, sources: sourceSummary(deelPdf, draft.fira?.source ?? null, firaPdf) },
  };
}

function parseDraft(raw: FormDataEntryValue): InvoiceDraft {
  const action = "Correct this field in the review form, then generate again.";
  let json: unknown;
  try {
    json = typeof raw === "string" ? JSON.parse(raw) : undefined;
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    throw new IssueError(
      issue("DRAFT_INVALID", "request", "The review draft couldn't be read.", "Reload the page, upload the PDFs again and review them."),
    );
  }
  const parsed = invoiceDraftSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  throw new IssueError(
    parsed.error.issues.slice(0, 20).map((z) => {
      const field = z.path.map(String).join(".");
      return issue("DRAFT_INVALID", documentOfPath(field), `${field || "draft"}: ${z.message}`, action, field ? { field } : {});
    }),
  );
}

const documentOfPath = (field: string): IssueDocument =>
  field.startsWith("deel") ? "deel" : field.startsWith("fira") ? "fira" : "request";

// ─── Legacy one-step form ─────────────────────────────────────────────────────

async function fromLegacyForm(form: FormData): Promise<Prepared> {
  const manualFiraReceivedUsd = parseFormattedNumber(form.get("manualFiraReceivedUsd"), "USD received", "fira.fcyAmount");
  const manualFiraRate = parseFormattedNumber(form.get("manualFiraRate"), "Exchange rate", "fira.inrAmount");
  const manualFiraBankCharges = parseFormattedNumber(form.get("manualFiraBankCharges"), "Fee", "fira.inrAmount") ?? 0;

  const deelPdf = await readDeelPdf(form);
  const firaPdf = await readPdfField(form, "firaFile", "The FIRA");

  // Fail closed before any FIRA matching: a 0 or unreconciled total stops here
  const deel = await parseDeelInvoice(deelPdf);
  validateDeelData(deel);
  const config: AppConfig = getConfig();
  validateSupplier(config.businessProfile);

  let fira: { data: FiraParsedData; source: "pdf" | "manual" } | null = null;
  if (firaPdf) {
    fira = { data: await parseFiraPdf(firaPdf), source: "pdf" };
  } else if (manualFiraRate !== null || manualFiraReceivedUsd !== null) {
    fira = {
      data: manualFira(deel.total, manualFiraReceivedUsd, manualFiraRate, manualFiraBankCharges, form.get("manualFiraRef"), form.get("manualFiraDate")),
      source: "manual",
    };
  }

  const options = draftOptions({
    placeOfSupply: formText(form, "placeOfSupply"),
    notes: formText(form, "notes"),
    overrideHsnSac: formText(form, "overrideHsnSac"),
    overrideInvoiceNumber: formText(form, "overrideInvoiceNumber"),
  });
  const draft = draftFromParsed(deel, fira, options, config.clientProfile);
  return {
    draft,
    deelPdf,
    firaPdf,
    extras: { supplierName: deel.supplierName, supplierAddress: deel.supplierAddress, role: deel.role },
    review: { mode: "legacy", edited: [], sources: sourceSummary(deelPdf, fira?.source ?? null, firaPdf) },
  };
}

const formText = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

const manualIssue = (message: string, field: string, action: string) =>
  new IssueError(issue("MANUAL_FIRA_INVALID", "fira", message, action, { field }));

// Strict: "90garbage", "-90" or "1e3" are rejected instead of being read as something else
function parseFormattedNumber(val: FormDataEntryValue | null, label: string, field: string): number | null {
  if (val === null || (typeof val === "string" && val.trim() === "")) return null;
  const text = typeof val === "string" ? val.trim() : "";
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(text)) {
    throw manualIssue(`${label} must be a positive number.`, field, `Enter the ${label.toLowerCase()} as a plain number, e.g. 1995.00.`);
  }
  return parseFloat(text.replace(/,/g, ""));
}

/**
 * Manual FIRA from a payment receipt (e.g. Skydo): net INR = USD received × rate − fee, and the realised USD is
 * backed out of it at the same rate. The date defaults to today; validateDraft checks it like any FIRA date.
 */
function manualFira(
  deelTotal: number,
  receivedUsd: number | null,
  rate: number | null,
  feeInr: number,
  ref: FormDataEntryValue | null,
  date: FormDataEntryValue | null,
): FiraParsedData {
  if (!rate || !receivedUsd) {
    throw manualIssue(
      "Manual FIRA entry needs both the USD received and the exchange rate.",
      rate ? "fira.fcyAmount" : "fira.inrAmount",
      "Enter both the USD received and the exchange rate from your payment receipt.",
    );
  }
  // Same pairing rule as an uploaded FIRA: received ≤ billed, and at most $100 lost in transit
  const transitLoss = deelTotal - receivedUsd;
  if (transitLoss < 0 || transitLoss > 100) {
    throw manualIssue(
      `USD received (${receivedUsd}) doesn't match the Deel total (${deelTotal}); it should be at most $100 less.`,
      "fira.fcyAmount",
      "Check the USD received on your payment receipt, and that it is for this Deel invoice.",
    );
  }
  const netInr = receivedUsd * rate - feeInr;
  if (!(netInr > 0)) {
    throw manualIssue("The fee is larger than the converted amount.", "fira.inrAmount", "Check the fee and the exchange rate on your payment receipt.");
  }
  const dateText = typeof date === "string" ? date.trim() : "";
  return {
    fcyAmount: Math.round((netInr / rate) * 100) / 100,
    inrAmount: Math.round(netInr * 100) / 100,
    firaRef: typeof ref === "string" ? ref.trim() : "",
    processedDate: dateText || new Date().toISOString().split("T")[0],
  };
}

// ─── Compliance record ────────────────────────────────────────────────────────

const fingerprint = (bytes: Buffer): SourceDocumentSummary => ({
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});

function sourceSummary(deelPdf: Buffer, firaSource: "pdf" | "manual" | null, firaPdf: Buffer | null): ReviewRecord["sources"] {
  return {
    deel: fingerprint(deelPdf),
    fira: firaSource ? { source: firaSource, ...(firaSource === "pdf" && firaPdf ? fingerprint(firaPdf) : {}) } : null,
  };
}
