import { z } from "zod";

/**
 * The review draft: values the user has seen (and may have corrected) in the review form. /api/parse returns one,
 * /api/generate only issues invoices from one, and every cross-check runs again on it, so an edit can't skip validation.
 */

// Whole cents/paise only, so what is validated is exactly what gets printed (no per-line rounding drift)
const money = z
  .number()
  .finite()
  .nonnegative()
  // Exact check: n * 100 drifts for large amounts (134217728.02 * 100 = 13421772802.000002)
  .refine((n) => Number(n.toFixed(2)) === n, "Use at most two decimal places.");
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
    /** As printed; validateDraft refuses anything but USD with DEEL_CURRENCY_UNSUPPORTED */
    currency: text.min(1),
    lineItems: z.array(draftLineItemSchema).min(1).max(20),
    subtotal: money,
    vat: money,
    total: money,
    deelRef: text,
  }),
  fira: z
    .object({
      source: z.enum(["pdf", "manual"]),
      /** FCY currency as printed on the FIRA ("USD" for manual entry); validateDraft refuses anything but USD */
      currency: text.min(1).default("USD"),
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
    /** GST Rule 46: at most 16 characters of letters, digits, "-" and "/" (also keeps headers and filenames safe) */
    overrideInvoiceNumber: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9/-]{0,16}$/, "Use up to 16 letters, digits, '-' or '/'."),
  }),
  /** Draft paths the user changed from what was extracted, e.g. ["fira.firaRef"]; kept in the compliance record */
  edited: z.array(z.string().max(100)).max(50),
});

export type InvoiceDraft = z.infer<typeof invoiceDraftSchema>;
