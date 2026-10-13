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
