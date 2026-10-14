/**
 * Synthetic fixtures. Every name, number and ID here is made up.
 * The GSTIN / PAN / account number below are the allowlisted fakes in scripts/scan-pii.mjs.
 */
import type { AppConfig } from "@/lib/config";
import type { DeelParsedInvoice, FiraParsedData } from "@/lib/types";

export const FAKE_GSTIN = "29ABCDE1234F1Z5";
export const FAKE_PAN = "ABCDE1234F";
export const FAKE_ACCOUNT = "000111222333";

export function fakeConfig(overrides: Partial<AppConfig["businessProfile"]> = {}): AppConfig {
  return {
    businessProfile: {
      legalName: "Test Supplier",
      tradeName: "Test Studio",
      gstin: FAKE_GSTIN,
      pan: FAKE_PAN,
      address: "1 Test Road",
      city: "Delhi",
      state: "Delhi",
      pincode: "110001",
      country: "India",
      designation: "Proprietor",
      lut: {
        formNumber: "FORM GST RFD-11",
        rule: "96A",
        filedAt: "Delhi",
        filedDate: "2026-04-01",
        financialYear: "2026-27",
        applicableFor: "Export of services without payment of integrated tax",
      },
      bankName: "Example Bank",
      accountNumber: FAKE_ACCOUNT,
      ifsc: "EXMP0000001",
      branch: "Example Branch",
      defaultSacCode: "998392",
      defaultPlaceOfSupply: "Outside India (Saudi Arabia)",
      defaultGstNote:
        "Export of Services — Supply made under Letter of Undertaking without payment of Integrated Tax as per Rule 96A of the CGST Rules, 2017.",
      ...overrides,
    },
    clientProfile: { clientName: "", clientAddress: "", country: "" },
    bankAccounts: [],
  };
}

/** What `BUSINESS_CONFIG_JSON` should contain so `getConfig()` returns the fake profile. */
export function fakeConfigJson(): string {
  const bp = fakeConfig().businessProfile;
  return JSON.stringify({
    businessProfile: {
      legalName: bp.legalName,
      tradeName: bp.tradeName,
      gstin: bp.gstin,
      pan: bp.pan,
      address: bp.address,
      city: bp.city,
      state: bp.state,
      pincode: bp.pincode,
      country: bp.country,
    },
    lut: bp.lut,
    bankDetails: {
      bankName: bp.bankName,
      accountNumber: bp.accountNumber,
      ifscCode: bp.ifsc,
      branch: bp.branch,
    },
  });
}

export interface DeelLayoutOptions {
  header?: string[];
  items?: string[];
  sub?: string[];
  vat?: string[];
  total?: string[];
  billTo?: string[];
}

/**
 * Text lines of a synthetic Deel contractor invoice, in the order pdfjs reads them.
 * Defaults to the July 2026+ layout (v2): `TOTAL` header and `Subtotal` row.
 */
export function deelLines(o: DeelLayoutOptions = {}): string[] {
  return [
    "INVOICE", "Document", "INV", "2026", "9", "Issue Date", "August 21, 2026", "Due Date", "August 31, 2026",
    "BILL FROM", "Test Supplier", "1 Test Road", "Delhi, DL 110001", "India",
    ...(o.billTo ?? ["BILL TO", "Acme Holdings For Testing &", "Research", "1 Main St", "Riyadh, 11111", "Saudi Arabia"]),
    ...(o.header ?? ["TOTAL", "USD $2,000.00"]),
    "UI/UX Designer", "Description", "Amount", "Fixed contract",
    "Invoice for work between August 1, 2026 to August 31, 2026",
    ...(o.items ?? ["Fixed rate: Monthly payment", "USD $2,000.00"]),
    ...(o.sub ?? ["Subtotal", "USD $2,000.00"]),
    ...(o.vat ?? ["VAT", "0%", "USD $0"]),
    ...(o.total ?? ["Total", "USD $2,000.00"]),
    "Deel Ref.: SYNTHETIC",
  ];
}

/** Layout used up to June 2026 (v1): `TOTAL DUE` header and `Sub total` row. */
export function deelLinesV1(o: DeelLayoutOptions = {}): string[] {
  return deelLines({
    header: ["TOTAL DUE", "USD $2,000.00"],
    sub: ["Sub total", "USD $2,000.00"],
    ...o,
  });
}

/** Bonus 1,602.00 + Fixed 2,000.00 + a zero-value Other row. */
export const MULTI_ITEM: DeelLayoutOptions = {
  header: ["TOTAL", "USD $3,602.00"],
  items: [
    "Bonus: CEO Bonus", "USD $1,602.00",
    "Fixed rate: Monthly payment", "USD $2,000.00",
    "Other: adjustment", "USD $0.00",
  ],
  sub: ["Subtotal", "USD $3,602.00"],
  total: ["Total", "USD $3,602.00"],
};

/** Labels as the bank prints them: label line, then ": value" line. */
export function firaLines(o: { fcy?: string; inr?: string; ref?: string; date?: string } = {}): string[] {
  return [
    "FOREIGN INWARD REMITTANCE CERTIFICATE",
    "Customer Transaction Reference No", `: ${o.ref ?? "SYNTHREF0001"}`,
    "Currency", ": USD",
    "Processed Date", `: ${o.date ?? "25-08-2026"}`,
    "FCY Amount", `: ${o.fcy ?? "1995.00"}`,
    "INR Amount", `: ${o.inr ?? "179955.00"}`,
  ];
}

/** A parsed Deel invoice built directly, for tests that skip the PDF step. */
export function deelData(over: Partial<DeelParsedInvoice> = {}): DeelParsedInvoice {
  return {
    invoiceNumber: "INV-2026-9",
    issueDate: "August 21, 2026",
    dueDate: "August 31, 2026",
    periodStart: "August 1, 2026",
    periodEnd: "August 31, 2026",
    periodText: "August 1, 2026 to August 31, 2026",
    clientName: "Acme Holdings For Testing & Research",
    clientAddress: "1 Main St, Riyadh, 11111",
    clientCountry: "Saudi Arabia",
    currency: "USD",
    subtotal: 2000,
    vat: 0,
    total: 2000,
    headerTotal: 2000,
    summaryTotal: 2000,
    sourceCurrencies: ["USD", "USD", "USD", "USD"],
    lineItems: [{ description: "Fixed rate: Monthly payment", amount: 2000 }],
    deelRef: "SYNTHETIC",
    ...over,
  };
}

export function firaData(over: Partial<FiraParsedData> = {}): FiraParsedData {
  return { fcyAmount: 1995, inrAmount: 179955, firaRef: "SYNTHREF0001", processedDate: "25-08-2026", ...over };
}
