// FAKE identifiers only. GSTIN 29ABCDE1234F1ZW has a valid check character for PAN ABCDE1234F.

/** The exact shape of business.json written by saveConfig before per-FY LUTs (legacy single `lut`). */
export const legacyBusinessJson = {
  businessProfile: {
    legalName: "Test Person",
    tradeName: "Test Studio",
    gstin: "29ABCDE1234F1ZW",
    pan: "ABCDE1234F",
    address: "1 Test Street",
    city: "Bengaluru",
    district: "Bengaluru Urban",
    state: "Karnataka",
    pincode: "560001",
    country: "India",
    designation: "Proprietor",
    phone: "+91 90000 00000",
    email: "test@example.com",
  },
  lut: {
    formNumber: "FORM GST RFD-11",
    rule: "96A",
    filedAt: "Bengaluru",
    filedDate: "2026-04-02",
    financialYear: "2026-27",
    applicableFor: "Export of services without payment of integrated tax",
  },
  bankDetails: {
    bankName: "Test Bank",
    accountNumber: "111122223333",
    ifscCode: "TEST0001234",
    branch: "Test Branch",
  },
  bankAccounts: [
    { id: "default", label: "Primary Account", bankName: "Test Bank", accountNumber: "111122223333", ifsc: "TEST0001234", branch: "Test Branch", isPrimary: true },
    { id: "acc-2", label: "Savings", bankName: "Other Bank", accountNumber: "444455556666", ifsc: "OTHR0005678", branch: "Other Branch", isPrimary: false },
  ],
  invoiceDefaults: {
    sacCode: "998392",
    placeOfSupply: "Outside India (Saudi Arabia)",
    gstNote: "Export of Services — Supply made under Letter of Undertaking without payment of Integrated Tax as per Rule 96A of the CGST Rules, 2017.",
  },
  clientProfile: {
    clientName: "Test Client LLC",
    clientAddress: "1 Client Road, Riyadh",
    country: "Saudi Arabia",
    registrationNumber: "REG-0001",
    vatId: "300000000000003",
    group: "",
  },
  airtableIntegration: {
    baseId: "appAAAAAAAAAAAAAA",
    tableName: "GST Invoices",
  },
};

/** A Deel invoice that passes validateDeelData. */
export function deelInvoice(issueDate: string) {
  return {
    invoiceNumber: "DEEL-TEST-1",
    issueDate,
    dueDate: issueDate,
    periodStart: "September 1, 2026",
    periodEnd: "September 30, 2026",
    periodText: "Sep 1, 2026 - Sep 30, 2026",
    clientName: "Test Client LLC",
    clientAddress: "1 Client Road, Riyadh",
    clientCountry: "Saudi Arabia",
    currency: "USD",
    subtotal: 1000,
    vat: 0,
    total: 1000,
    headerTotal: 1000,
    summaryTotal: 1000,
    sourceCurrencies: ["USD"],
    lineItems: [{ description: "Fixed rate: Monthly payment", amount: 1000 }],
    deelRef: "REF-TEST",
  };
}
