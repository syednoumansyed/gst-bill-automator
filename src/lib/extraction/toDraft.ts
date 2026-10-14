import type { InvoiceDraft } from "../draft";
import type { DeelExtraction, Field, FiraExtraction } from "./types";

/**
 * First review draft from the extractions. Unreadable values become "" or 0; the extraction's issues point the
 * review form at them, and every cross-check runs again on the confirmed draft.
 */
export function draftFromExtractions(deel: DeelExtraction, fira: FiraExtraction | null): InvoiceDraft {
  const s = (f: Field<string>) => f.value ?? "";
  const n = (f: Field<number>) => f.value ?? 0;
  const d = deel.fields;
  return {
    deel: {
      invoiceNumber: s(d.invoiceNumber),
      issueDate: s(d.issueDate),
      dueDate: s(d.dueDate),
      periodStart: s(d.periodStart),
      periodEnd: s(d.periodEnd),
      clientName: s(d.clientName),
      clientAddress: s(d.clientAddress),
      clientCountry: s(d.clientCountry),
      clientVatId: s(d.clientVatId),
      clientRegistrationNumber: s(d.clientRegistrationNumber),
      // Only USD invoices are issued; another currency is flagged by the issues and by validation
      currency: "USD",
      lineItems: deel.lineItems.map((item) => ({ description: item.description, amount: n(item.amount) })),
      subtotal: n(d.subtotal),
      vat: n(d.vat),
      total: n(d.total),
      deelRef: s(d.deelRef),
    },
    fira: fira
      ? {
          source: "pdf",
          currency: "USD", // TODO(engine agent): carry the extracted FIRA currency
          firaRef: s(fira.fields.firaRef),
          processedDate: s(fira.fields.processedDate),
          fcyAmount: n(fira.fields.fcyAmount),
          inrAmount: n(fira.fields.inrAmount),
        }
      : null,
    options: { placeOfSupply: "", notes: "", overrideHsnSac: "", overrideInvoiceNumber: "" },
    edited: [],
  };
}
