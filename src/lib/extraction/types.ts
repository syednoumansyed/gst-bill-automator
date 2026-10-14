import type { Issue } from "../errors";

/**
 * What the extraction engine returns for each document. Every field carries how sure the engine is and where the
 * value came from, so the review form can flag doubtful values instead of the app guessing.
 */

export type Confidence = "high" | "medium" | "low";

export type DocKind = "deel-invoice" | "fira" | "gst-invoice" | "lut-form" | "unknown";

export interface Field<T> {
  /** null when the engine couldn't read it (never a made-up 0 or "") */
  value: T | null;
  confidence: Confidence;
  /**
   * Strategy that produced the value, e.g. "label-right:TOTAL", "label-below:Processed Date", "pattern:usd".
   * With no value: "missing" (no label on the page), "unreadable:<label>" (the label is there, with no readable
   * value beside or below it) or "conflict:<sources>" (different values were read and nothing chose between them).
   */
  source: string;
}

/** A recognised document layout, e.g. "deel-2025", "deel-2026-07", "fira-bank-2026", "fira-bank-2026-10". */
export interface LayoutMatch {
  id: string;
  /** true when no known layout matched and the generic strategies were used */
  isNew: boolean;
}

export interface DeelLineItem {
  description: string;
  amount: Field<number>;
}

export interface DeelExtraction {
  kind: DocKind;
  layout: LayoutMatch;
  fields: {
    invoiceNumber: Field<string>;
    issueDate: Field<string>;
    dueDate: Field<string>;
    periodStart: Field<string>;
    periodEnd: Field<string>;
    clientName: Field<string>;
    clientAddress: Field<string>;
    clientCountry: Field<string>;
    clientVatId: Field<string>;
    clientRegistrationNumber: Field<string>;
    supplierName: Field<string>;
    supplierAddress: Field<string>;
    role: Field<string>;
    currency: Field<string>;
    headerTotal: Field<number>;
    summaryTotal: Field<number>;
    subtotal: Field<number>;
    vat: Field<number>;
    total: Field<number>;
    deelRef: Field<string>;
  };
  lineItems: DeelLineItem[];
  issues: Issue[];
}

export interface FiraExtraction {
  kind: DocKind;
  layout: LayoutMatch;
  fields: {
    firaRef: Field<string>;
    /** As printed, e.g. "07-10-2026" */
    processedDate: Field<string>;
    fcyAmount: Field<number>;
    inrAmount: Field<number>;
    currency: Field<string>;
  };
  issues: Issue[];
}

/**
 * Masked layout of a PDF for bug reports: every label kept, every value replaced by its shape
 * (e.g. "Customer Transaction Reference | No | : <ID 11>"). Contains no personal data.
 */
export type LayoutSkeleton = string;
