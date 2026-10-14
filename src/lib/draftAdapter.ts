import type { ClientProfile } from "./config";
import type { InvoiceDraft } from "./draft";
import type { DeelParsedInvoice, FiraParsedData } from "./types";

/**
 * Converts between the review draft and the shapes the invoice builder has always used, so the review flow and the
 * legacy one-step form go through the same checks (validateDraft) and the same builder (generateInvoiceData).
 */

export type DraftOptions = InvoiceDraft["options"];

/** Parser-only details the draft doesn't carry; the legacy flow passes them through to the compliance record. */
export type DeelExtras = Pick<DeelParsedInvoice, "supplierName" | "supplierAddress" | "role">;

const text = (value: string | null | undefined) => (value ?? "").trim();
const optional = (value: string | null | undefined) => text(value) || undefined;

/** Legacy form fields → draft options; missing fields are "". */
export function draftOptions(values: Partial<Record<keyof DraftOptions, string | null | undefined>>): DraftOptions {
  return {
    placeOfSupply: text(values.placeOfSupply),
    notes: text(values.notes),
    overrideHsnSac: text(values.overrideHsnSac),
    overrideInvoiceNumber: text(values.overrideInvoiceNumber),
  };
}

/**
 * Legacy request → review draft. The saved client profile fills client fields the parser couldn't read, as the
 * one-step form always did; this is the only place that happens; generation never falls back again.
 */
export function draftFromParsed(
  deel: DeelParsedInvoice,
  fira: { data: FiraParsedData; source: "pdf" | "manual"; currency?: string } | null,
  options: DraftOptions,
  fallbackClient?: Partial<Pick<ClientProfile, "clientName" | "clientAddress" | "country" | "vatId" | "registrationNumber">>,
): InvoiceDraft {
  return {
    deel: {
      invoiceNumber: text(deel.invoiceNumber),
      issueDate: text(deel.issueDate),
      dueDate: text(deel.dueDate),
      periodStart: text(deel.periodStart),
      periodEnd: text(deel.periodEnd),
      clientName: text(deel.clientName) || text(fallbackClient?.clientName),
      clientAddress: text(deel.clientAddress) || text(fallbackClient?.clientAddress),
      clientCountry: text(deel.clientCountry) || text(fallbackClient?.country),
      clientVatId: text(deel.clientVatId) || text(fallbackClient?.vatId),
      clientRegistrationNumber: text(deel.clientRegistrationNumber) || text(fallbackClient?.registrationNumber),
      // As printed; validateDraft refuses anything but USD
      currency: text(deel.currency) || "USD",
      lineItems: deel.lineItems.map((item) => ({ description: text(item.description), amount: item.amount })),
      subtotal: deel.subtotal,
      vat: deel.vat,
      total: deel.total,
      deelRef: text(deel.deelRef),
    },
    fira: fira
      ? {
          source: fira.source,
          // As printed on the FIRA; manual entry is always USD
          currency: text(fira.currency) || "USD",
          firaRef: text(fira.data.firaRef),
          processedDate: text(fira.data.processedDate),
          fcyAmount: fira.data.fcyAmount,
          inrAmount: fira.data.inrAmount,
        }
      : null,
    options,
    edited: [],
  };
}

/** Review draft → the arguments of generateInvoiceData. */
export function invoiceInputFromDraft(draft: InvoiceDraft, extras: DeelExtras = {}) {
  const d = draft.deel;
  const periodStart = optional(d.periodStart);
  const periodEnd = optional(d.periodEnd);
  const deelData: DeelParsedInvoice = {
    invoiceNumber: text(d.invoiceNumber),
    issueDate: text(d.issueDate),
    dueDate: text(d.dueDate),
    periodStart,
    periodEnd,
    periodText: periodStart && periodEnd ? `${periodStart} to ${periodEnd}` : "",
    clientName: text(d.clientName),
    clientAddress: text(d.clientAddress),
    clientCountry: optional(d.clientCountry),
    clientVatId: optional(d.clientVatId),
    clientRegistrationNumber: optional(d.clientRegistrationNumber),
    ...extras,
    currency: d.currency,
    subtotal: d.subtotal,
    vat: d.vat,
    total: d.total,
    lineItems: d.lineItems.map((item) => ({ description: text(item.description), amount: item.amount })),
    deelRef: optional(d.deelRef),
  };
  const firaData: FiraParsedData | undefined = draft.fira
    ? {
        fcyAmount: draft.fira.fcyAmount,
        inrAmount: draft.fira.inrAmount,
        firaRef: text(draft.fira.firaRef),
        processedDate: text(draft.fira.processedDate),
      }
    : undefined;
  return {
    deelData,
    overrides: {
      placeOfSupply: draft.options.placeOfSupply,
      notes: draft.options.notes,
      overrideHsnSac: draft.options.overrideHsnSac,
      overrideInvoiceNumber: draft.options.overrideInvoiceNumber,
      firaData,
      firaSource: draft.fira?.source,
    },
  };
}
