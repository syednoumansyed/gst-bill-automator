import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { manualFira, readManualFiraInput } from "@/lib/manualFira";
import { checkUploadRequest, readDeelPdf, readForm, readPdfField, routeErrorResponse } from "@/lib/apiRequest";
import { AppConfig, getConfig } from "@/lib/config";
import { invoiceDraftSchema, type InvoiceDraft } from "@/lib/draft";
import { draftFromParsed, draftOptions, type DeelExtras } from "@/lib/draftAdapter";
import { validateDraft } from "@/lib/draftValidation";
import { issue, IssueError, type IssueDocument } from "@/lib/errors";
import { generateInvoiceFromDraft } from "@/lib/generateInvoiceData";
import { generatePdf } from "@/lib/generatePdf";
import { extractFira, readDeel } from "@/lib/extraction";
import { toDeelParsed, toFiraParsed } from "@/lib/extraction/compat";
import { applySyncHeaders, buildInvoiceResponse } from "@/lib/invoiceResponse";
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
    // The schema is the last gate for both flows (whole cents, a header-safe invoice-number override, lengths)
    const draft = checkDraftSchema(prepared.draft);

    const invoice = generateInvoiceFromDraft(draft, config, { review: prepared.review, extras: prepared.extras });

    // Render first, then build the whole response: nothing is uploaded or written for an invoice that didn't render
    // or can't be sent back. The sync is the last step that can fail, and it reports instead of throwing.
    const pdfBuffer = await generatePdf(invoice);
    const warnings = [...(invoice.warnings ?? []), ...issues.filter((i) => i.severity === "warning").map((i) => i.message)];
    const response = buildInvoiceResponse(invoice, pdfBuffer, warnings);

    const sync = await syncInvoice(invoice, { deelPdf: prepared.deelPdf, firaPdf: prepared.firaPdf, gstPdf: pdfBuffer }, config);
    applySyncHeaders(response, sync);
    console.info(`[generate] issued mode=${prepared.review.mode} edited=${draft.edited.length} sync=${sync.status}${sync.code ? `:${sync.code}` : ""}`);
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
  return checkDraftSchema(json);
}

/** The draft as the schema accepts it, or DRAFT_INVALID with the path of every field it refused. */
function checkDraftSchema(value: unknown): InvoiceDraft {
  const action = "Correct this field in the review form, then generate again.";
  const parsed = invoiceDraftSchema.safeParse(value);
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
  const manualInput = readManualFiraInput(form);

  const deelPdf = await readDeelPdf(form);
  const firaPdf = await readPdfField(form, "firaFile", "The FIRA");

  // Read both documents first, so every currency problem the engine found is reported together
  const reading = await readDeel(deelPdf);
  const firaExtraction = firaPdf ? await extractFira(firaPdf) : null;
  const currencyIssues = [...reading.extraction.issues, ...(firaExtraction?.issues ?? [])].filter(
    (i) => i.severity === "error" && (i.code === "DEEL_CURRENCY_UNSUPPORTED" || i.code === "FIRA_CURRENCY_UNSUPPORTED"),
  );
  if (currencyIssues.length > 0) throw new IssueError(currencyIssues);

  // Fail closed before any FIRA matching: a 0 or unreconciled total stops here
  const deel = toDeelParsed(reading);
  validateDeelData(deel);
  const config: AppConfig = getConfig();
  validateSupplier(config.businessProfile);

  let fira: { data: FiraParsedData; source: "pdf" | "manual"; currency?: string } | null = null;
  if (firaExtraction) {
    fira = { data: toFiraParsed(firaExtraction), source: "pdf", currency: firaExtraction.fields.currency.value ?? undefined };
  } else if (manualInput) {
    fira = { data: manualFira(deel.total, manualInput), source: "manual", currency: "USD" };
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
