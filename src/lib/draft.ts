import { z } from "zod";

/**
 * The review draft: values the user has seen (and may have corrected) in the review form. /api/parse returns one,
 * /api/generate only issues invoices from one, and every cross-check runs again on it, so an edit can't skip validation.
 */

const money = z.number().finite().nonnegative();
const text = z.string().trim().max(500);

export const draftLineItemSchema = z.object({
  description: text.min(1),
  amount: money,
});

export const invoiceDraftSchema = z.object({
  deel: z.object({
    invoiceNumber: text.min(1),
    issueDate: text.min(1),
    dueDate: text,
    periodStart: text,
    periodEnd: text,
    clientName: text.min(1),
    clientAddress: text,
    clientCountry: text,
    clientVatId: text,
    clientRegistrationNumber: text,
    currency: z.literal("USD"),
    lineItems: z.array(draftLineItemSchema).min(1).max(20),
    subtotal: money,
    vat: money,
    total: money,
    deelRef: text,
  }),
  fira: z
    .object({
      source: z.enum(["pdf", "manual"]),
      firaRef: text,
      /** YYYY-MM-DD or DD-MM-YYYY as printed on the FIRA */
      processedDate: text.min(1),
      fcyAmount: money,
      inrAmount: money,
    })
    .nullable(),
  options: z.object({
    placeOfSupply: text,
    notes: text,
    overrideHsnSac: text,
    overrideInvoiceNumber: z.string().trim().max(16),
  }),
  /** Draft paths the user changed from what was extracted, e.g. ["fira.firaRef"]; kept in the compliance record */
  edited: z.array(z.string().max(100)).max(50),
});

export type InvoiceDraft = z.infer<typeof invoiceDraftSchema>;
