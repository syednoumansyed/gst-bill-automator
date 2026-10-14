/**
 * Synthetic review drafts and engine results for the API tests. Every name, number and ID is made up.
 */
import type { InvoiceDraft } from "@/lib/draft";
import type { Issue } from "@/lib/errors";
import type { DeelExtraction, Field, FiraExtraction } from "@/lib/extraction/types";

type DeepPartialDraft = {
  deel?: Partial<InvoiceDraft["deel"]>;
  fira?: Partial<NonNullable<InvoiceDraft["fira"]>> | null;
  options?: Partial<InvoiceDraft["options"]>;
  edited?: string[];
};

/** Matches tests/helpers/fixtures deelLines() + firaLines(): USD 2,000 billed, USD 1,995 / INR 179,955 received. */
export function draft(over: DeepPartialDraft = {}): InvoiceDraft {
  const base: InvoiceDraft = {
    deel: {
      invoiceNumber: "INV-2026-9",
      issueDate: "August 21, 2026",
      dueDate: "August 31, 2026",
      periodStart: "August 1, 2026",
      periodEnd: "August 31, 2026",
      clientName: "Acme Holdings For Testing & Research",
      clientAddress: "1 Main St, Riyadh, 11111",
      clientCountry: "Saudi Arabia",
      clientVatId: "",
      clientRegistrationNumber: "",
      currency: "USD",
      lineItems: [{ description: "Fixed rate: Monthly payment", amount: 2000 }],
      subtotal: 2000,
      vat: 0,
      total: 2000,
      deelRef: "SYNTHETIC",
    },
    fira: { source: "pdf", firaRef: "SYNTHREF0001", processedDate: "25-08-2026", fcyAmount: 1995, inrAmount: 179955 },
    options: { placeOfSupply: "", notes: "", overrideHsnSac: "", overrideInvoiceNumber: "" },
    edited: [],
  };
  return {
    deel: { ...base.deel, ...over.deel },
    fira: over.fira === null ? null : { ...base.fira!, ...over.fira },
    options: { ...base.options, ...over.options },
    edited: over.edited ?? base.edited,
  };
}

const field = <T>(value: T | null): Field<T> => ({ value, confidence: value === null ? "low" : "high", source: "test" });

export function deelExtraction(over: Partial<DeelExtraction> = {}): DeelExtraction {
  const d = draft().deel;
  return {
    kind: "deel-invoice",
    layout: { id: "deel-2026-07", isNew: false },
    fields: {
      invoiceNumber: field(d.invoiceNumber),
      issueDate: field(d.issueDate),
      dueDate: field(d.dueDate),
      periodStart: field(d.periodStart),
      periodEnd: field(d.periodEnd),
      clientName: field(d.clientName),
      clientAddress: field(d.clientAddress),
      clientCountry: field(d.clientCountry),
      clientVatId: field<string>(null),
      clientRegistrationNumber: field<string>(null),
      supplierName: field("Test Supplier"),
      supplierAddress: field("1 Test Road"),
      role: field("UI/UX Designer"),
      currency: field("USD"),
      headerTotal: field(2000),
      summaryTotal: field(2000),
      subtotal: field(2000),
      vat: field(0),
      total: field(2000),
      deelRef: field("SYNTHETIC"),
    },
    lineItems: [{ description: "Fixed rate: Monthly payment", amount: field(2000) }],
    issues: [],
    ...over,
  };
}

export function firaExtraction(over: Partial<FiraExtraction> = {}): FiraExtraction {
  return {
    kind: "fira",
    layout: { id: "fira-bank-2026", isNew: false },
    fields: {
      firaRef: field("SYNTHREF0001"),
      processedDate: field("25-08-2026"),
      fcyAmount: field(1995),
      inrAmount: field(179955),
      currency: field("USD"),
    },
    issues: [],
    ...over,
  };
}

export const codes = (issues: Issue[]) => issues.map((i) => i.code);
