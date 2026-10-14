import { BusinessProfile, ClientProfile } from "./config";

export interface DeelParsedInvoice {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  periodStart?: string;
  periodEnd?: string;
  periodText?: string;
  clientName: string;
  clientAddress: string;
  clientCountry?: string;
  clientVatId?: string;
  clientRegistrationNumber?: string;
  supplierName?: string;
  supplierAddress?: string;
  role?: string;
  currency: string;
  subtotal: number;
  vat: number;
  total: number;
  /** Amount after the "TOTAL DUE" / "TOTAL" header label */
  headerTotal?: number;
  /** Amount in the "Total" row below the line items */
  summaryTotal?: number;
  /** Currency codes read from the header, summary, subtotal and VAT rows */
  sourceCurrencies?: string[];
  lineItems: {
    description: string;
    amount: number;
  }[];
  deelRef?: string;
}

export interface FiraParsedData {
  fcyAmount: number;
  inrAmount: number;
  firaRef: string;
  processedDate: string;
}

export interface ComplianceMetadata {
  complianceKey: string;
  workflowVersion: string;
  generatedAt: string;
  sourceDocuments: {
    deelInvoiceNumber: string;
    deelReference: string;
    firaReference?: string;
  };
  deel: {
    invoiceNumber: string;
    issueDate: string;
    dueDate: string;
    periodStart?: string;
    periodEnd?: string;
    servicePeriod?: string;
    currency: string;
    subtotal: number;
    total: number;
    clientName: string;
    clientAddress: string;
    clientCountry?: string;
    clientVatId?: string;
    clientRegistrationNumber?: string;
    supplierName?: string;
    supplierAddress?: string;
    role?: string;
    lineItems: {
      description: string;
      amount: number;
    }[];
  };
  gst: {
    invoiceNumber: string;
    invoiceDate: string;
    dueDate: string;
    currency: string;
    subtotal: number;
    grandTotal: number;
    placeOfSupply: string;
    sacCode: string;
    gstNote: string;
    servicePeriod?: string;
    lutFinancialYear?: string;
    lutRule?: string;
    lutArn?: string;
  };
  fira?: {
    source: "pdf" | "manual";
    reference: string;
    processedDate: string;
    realizedUsd: number;
    realizedInr: number;
    bankChargesUsd: number;
    exchangeRate: number;
  };
  /** How the figures reached the invoice: the review draft (and what the user changed) or the legacy one-step form */
  review?: ReviewRecord;
}

/** Fingerprint of an uploaded document, so the compliance record names exactly which file the figures came from. */
export interface SourceDocumentSummary {
  sha256: string;
  bytes: number;
}

export interface ReviewRecord {
  /** "review": issued from a confirmed review draft; "legacy": parsed and issued in one request */
  mode: "review" | "legacy";
  /** Draft paths the user changed from what was extracted, e.g. ["fira.firaRef"] */
  edited: string[];
  sources: {
    deel: SourceDocumentSummary;
    fira: (Partial<SourceDocumentSummary> & { source: "pdf" | "manual" }) | null;
  };
}

export interface GeneratedInvoice {
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  placeOfSupply: string;
  exportType: string;
  lutNumber: string;
  supplier: BusinessProfile;
  client: ClientProfile;
  currency: string;
  lineItems: {
    description: string;
    sacCode: string;
    qty: number;
    rate: number;
    amount: number;
    sgst: number;
    cgst: number;
    igst: number;
    cess: number;
  }[];
  subtotal: number;
  gstTotal: number;
  grandTotal: number;
  gstNote: string;
  terms?: string;
  servicePeriod?: string;
  deelRef?: string;
  complianceMetadata: ComplianceMetadata;
  /** Non-blocking notes for the user, e.g. no LUT saved for the invoice's financial year */
  warnings?: string[];
  // Optional FIRA / Realization Details
  firaData?: {
    originalUsdBilled: number;
    fundsRealizedUsd: number;
    fundsRealizedInr: number;
    bankChargesUsd: number;
    exchangeRate: number;
    firaRef: string;
    firaDate: string;
  };
}
