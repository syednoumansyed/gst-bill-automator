import { describe, expect, it } from "vitest";
import {
  financialYearOf,
  gstinCheckChar,
  gstinProblem,
  isFinancialYear,
  missingRequiredFields,
  selectLut,
  validateConfigInput,
} from "../../src/lib/configSchema";
import { generateInvoiceData } from "../../src/lib/generateInvoiceData";
import type { AppConfig } from "../../src/lib/config";
import { deelInvoice } from "./fixtures";

const validInput = () => ({
  businessProfile: {
    legalName: "Test Person", tradeName: "", gstin: "29ABCDE1234F1ZW", pan: "ABCDE1234F",
    address: "1 Test Street", city: "Bengaluru", district: "", state: "Karnataka", pincode: "560001",
    country: "India", designation: "Proprietor", phone: "", email: "",
    defaultSacCode: "998392", defaultPlaceOfSupply: "Outside India", defaultGstNote: "Export note",
    defaultServiceDescription: "Consulting Services",
  },
  luts: [{ financialYear: "2026-27", filedDate: "2026-04-02", filedAt: "", arn: "", rule: "96A", formNumber: "FORM GST RFD-11", applicableFor: "" }],
  bankAccounts: [{ id: "a", label: "Main", bankName: "Test Bank", accountNumber: "111122223333", ifsc: "TEST0001234", branch: "", isPrimary: true }],
  clientProfile: { clientName: "Test Client", clientAddress: "", country: "", registrationNumber: "", vatId: "", group: "" },
  airtableIntegration: { baseId: "", tableName: "GST Invoices" },
});

const errorsFor = (mutate: (input: ReturnType<typeof validInput>) => void) => {
  const input = validInput();
  mutate(input);
  const result = validateConfigInput(input);
  return result.ok ? {} : result.errors;
};

describe("GSTIN", () => {
  it("computes the GSTN check character", () => {
    expect(gstinCheckChar("29ABCDE1234F1Z")).toBe("W");
    expect(gstinCheckChar("27AAPFU0939F1Z")).toBe("V");
  });

  it("explains each kind of bad GSTIN", () => {
    expect(gstinProblem("29ABCDE1234F1ZW")).toBeNull();
    expect(gstinProblem("29ABCDE1234F1Z")).toMatch(/15 characters/);
    expect(gstinProblem("29ABCDE1234F1X5")).toMatch(/format/);
    expect(gstinProblem("45ABCDE1234F1ZW")).toMatch(/isn't a GST state code/);
    expect(gstinProblem("29ABCDE1234F1Z5")).toMatch(/checksum/);
  });

  it("must embed the PAN and match the state", () => {
    expect(errorsFor((i) => { i.businessProfile.pan = "ABCDE9999F"; })["businessProfile.pan"]).toMatch(/must match the PAN/);
    expect(errorsFor((i) => { i.businessProfile.state = "Maharashtra"; })["businessProfile.state"]).toMatch(/29 is Karnataka/);
    // Unrecognised state names from older configs aren't rejected
    expect(errorsFor((i) => { i.businessProfile.state = "KA"; })).toEqual({});
  });
});

describe("field formats", () => {
  it("accepts a valid config and normalises case", () => {
    const input = validInput();
    input.businessProfile.gstin = " 29abcde1234f1zw ";
    input.businessProfile.pan = "abcde1234f";
    input.bankAccounts[0].ifsc = "test0001234";
    const result = validateConfigInput(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.businessProfile.gstin).toBe("29ABCDE1234F1ZW");
      expect(result.data.bankAccounts[0].ifsc).toBe("TEST0001234");
    }
  });

  it("rejects bad PAN, IFSC, pincode, FY and account number with readable messages", () => {
    expect(errorsFor((i) => { i.businessProfile.pan = "ABCD1234F"; })["businessProfile.pan"]).toMatch(/PAN is 10 characters/);
    expect(errorsFor((i) => { i.bankAccounts[0].ifsc = "TEST1001234"; })["bankAccounts.0.ifsc"]).toMatch(/IFSC is 11 characters/);
    expect(errorsFor((i) => { i.businessProfile.pincode = "060001"; })["businessProfile.pincode"]).toMatch(/Pincode is 6 digits/);
    expect(errorsFor((i) => { i.luts[0].financialYear = "2026-28"; })["luts.0.financialYear"]).toMatch(/2026-27/);
    expect(errorsFor((i) => { i.bankAccounts[0].accountNumber = "12 34"; })["bankAccounts.0.accountNumber"]).toMatch(/9 to 18 digits/);
    expect(errorsFor((i) => { i.luts[0].arn = "SHORT"; })["luts.0.arn"]).toMatch(/15-character/);
  });

  it("requires one primary bank account, at least one LUT and unique LUT years", () => {
    expect(errorsFor((i) => { i.bankAccounts[0].isPrimary = false; })["bankAccounts"]).toMatch(/exactly one/);
    expect(errorsFor((i) => { i.luts = []; })["luts"]).toMatch(/at least one/);
    expect(errorsFor((i) => { i.luts.push({ ...i.luts[0] }); })["luts.1.financialYear"]).toMatch(/already an LUT/);
  });

  it("drops token fields sent by an old client", () => {
    const input = { ...validInput(), airtableIntegration: { baseId: "", tableName: "T", token: "patFAKE", vercelBlobToken: "x" } };
    const result = validateConfigInput(input);
    expect(result.ok && result.data.airtableIntegration).toEqual({ baseId: "", tableName: "T" });
  });

  it("checks financial year shape", () => {
    expect(isFinancialYear("2026-27")).toBe(true);
    expect(isFinancialYear("2099-00")).toBe(true);
    expect(isFinancialYear("2026-2027")).toBe(false);
  });

  it("lists missing required fields by label", () => {
    expect(missingRequiredFields(validInput())).toEqual([]);
    expect(missingRequiredFields({ businessProfile: {}, luts: [], bankAccounts: [] })).toEqual(
      ["Legal name", "GSTIN", "PAN", "Address", "State", "Pincode", "LUT", "Bank account"],
    );
  });
});

describe("LUT per financial year", () => {
  const luts = [
    { financialYear: "2025-26", filedDate: "2025-04-03", arn: "" },
    { financialYear: "2026-27", filedDate: "2026-04-02", arn: "AD290426000123X" },
  ];

  it("maps dates to the April-March financial year", () => {
    expect(financialYearOf("2026-03-31")).toBe("2025-26");
    expect(financialYearOf("2026-04-01")).toBe("2026-27");
    expect(financialYearOf("1999-12-01")).toBe("1999-00");
    expect(financialYearOf("not a date")).toBeNull();
  });

  it("picks the LUT for the invoice's year", () => {
    expect(selectLut(luts, "2026-03-15")).toEqual({ lut: luts[0] });
    expect(selectLut(luts, "2026-05-01")).toEqual({ lut: luts[1] });
  });

  it("falls back to the most recent LUT with a warning", () => {
    const choice = selectLut(luts, "2027-06-01");
    expect(choice.lut).toBe(luts[1]);
    expect(choice.warning).toMatch(/No LUT is saved for FY 2027-28/);
    expect(selectLut([], "2027-06-01").warning).toMatch(/No LUT is saved/);
  });

  const config = (): AppConfig => ({
    businessProfile: {
      legalName: "Test Person", tradeName: "", gstin: "29ABCDE1234F1ZW", pan: "ABCDE1234F", address: "1 Test Street",
      city: "Bengaluru", state: "Karnataka", pincode: "560001", country: "India",
      lut: { formNumber: "FORM GST RFD-11", rule: "96A", filedAt: "", filedDate: "2026-04-02", financialYear: "2026-27", applicableFor: "" },
      bankName: "Test Bank", accountNumber: "111122223333", ifsc: "TEST0001234", branch: "",
      defaultSacCode: "998392", defaultPlaceOfSupply: "Outside India", defaultGstNote: "Export note",
      defaultServiceDescription: "Consulting Services",
    },
    luts: luts.map((l) => ({ formNumber: "FORM GST RFD-11", rule: "96A", filedAt: "", applicableFor: "", ...l })),
    bankAccounts: [],
    clientProfile: { clientName: "Test Client", clientAddress: "", country: "" },
  });

  it("uses the matching LUT, its ARN and the configured description in the generated invoice", () => {
    const invoice = generateInvoiceData(deelInvoice("2026-05-10"), config());
    expect(invoice.supplier.lut.financialYear).toBe("2026-27");
    expect(invoice.complianceMetadata.gst.lutArn).toBe("AD290426000123X");
    expect(invoice.lineItems[0].description).toMatch(/^Consulting Services/);
    expect(invoice.warnings).toBeUndefined();

    const older = generateInvoiceData(deelInvoice("2026-02-10"), config());
    expect(older.supplier.lut.financialYear).toBe("2025-26");
    expect(older.complianceMetadata.gst).not.toHaveProperty("lutArn");
  });

  it("still generates, with a warning, when no LUT covers the invoice date", () => {
    const invoice = generateInvoiceData(deelInvoice("2027-07-01"), config());
    expect(invoice.supplier.lut.financialYear).toBe("2026-27");
    expect(invoice.warnings).toEqual([expect.stringMatching(/FY 2027-28/)]);
  });
});
