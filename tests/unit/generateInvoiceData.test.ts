import { describe, expect, it } from "vitest";
import { generateInvoiceData } from "@/lib/generateInvoiceData";
import { InvoiceValidationError } from "@/lib/validateInvoice";
import { deelData, fakeConfig, firaData } from "../helpers/fixtures";

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
const item = (description: string, amount: number) => ({ description, amount });

describe("generateInvoiceData without FIRA", () => {
  it("keeps USD amounts and maps the Fixed rate description", () => {
    const inv = generateInvoiceData(deelData(), fakeConfig());
    expect(inv.currency).toBe("USD");
    expect(inv.grandTotal).toBe(2000);
    expect(inv.subtotal).toBe(2000);
    expect(inv.gstTotal).toBe(0);
    expect(inv.lineItems).toHaveLength(1);
    expect(inv.lineItems[0].description).toBe("Professional Services — Aug 1 – Aug 31, 2026");
    expect(inv.lineItems[0].amount).toBe(2000);
    expect(inv.firaData).toBeUndefined();
  });

  it("numbers the invoice INV-YYYY-MM from the issue date, unless overridden", () => {
    expect(generateInvoiceData(deelData(), fakeConfig()).invoiceNumber).toBe("INV-2026-08");
    expect(generateInvoiceData(deelData(), fakeConfig(), { overrideInvoiceNumber: "INV-X-1" }).invoiceNumber).toBe("INV-X-1");
  });

  it("uses the supplier defaults for SAC code and place of supply, and lets overrides win", () => {
    const base = generateInvoiceData(deelData(), fakeConfig());
    expect(base.lineItems[0].sacCode).toBe("998392");
    expect(base.placeOfSupply).toBe("Outside India (Saudi Arabia)");
    const over = generateInvoiceData(deelData(), fakeConfig(), { overrideHsnSac: "999999", placeOfSupply: "Elsewhere", notes: "custom note" });
    expect(over.lineItems[0].sacCode).toBe("999999");
    expect(over.placeOfSupply).toBe("Elsewhere");
    expect(over.gstNote).toBe("custom note");
  });

  it("fills the client from the Deel invoice, with saved config only as a fallback", () => {
    const cfg = fakeConfig();
    cfg.clientProfile = { clientName: "Saved Name", clientAddress: "Saved Addr", country: "Saved Country" };
    const inv = generateInvoiceData(deelData({ clientName: "", clientAddress: "" }), cfg);
    expect(inv.client.clientName).toBe("Saved Name");
    expect(generateInvoiceData(deelData(), cfg).client.clientName).toBe("Acme Holdings For Testing & Research");
  });

  it("refuses an invalid Deel invoice and a supplier with no GSTIN", () => {
    expect(() => generateInvoiceData(deelData({ vat: 10 }), fakeConfig())).toThrow(InvoiceValidationError);
    expect(() => generateInvoiceData(deelData(), fakeConfig({ gstin: "" }))).toThrow(/GSTIN/);
  });
});

describe("generateInvoiceData with FIRA", () => {
  it("regression: [2000, 2000, 2000, 0] with FIRA 5995 USD / 539990.00 INR succeeds with no negative line", () => {
    const deel = deelData({
      subtotal: 6000,
      total: 6000,
      headerTotal: 6000,
      summaryTotal: 6000,
      lineItems: [
        item("Fixed rate: Monthly payment", 2000),
        item("Bonus: one", 2000),
        item("Bonus: two", 2000),
        item("Other: zero", 0),
      ],
    });
    const inv = generateInvoiceData(deel, fakeConfig(), {
      firaData: firaData({ fcyAmount: 5995, inrAmount: 539990 }),
    });
    const amounts = inv.lineItems.map((l) => l.amount);
    expect(amounts.every((a) => a >= 0)).toBe(true);
    expect(amounts[3]).toBe(0);
    expect(sum(amounts)).toBe(539990);
    expect(inv.grandTotal).toBe(539990);
    expect(inv.currency).toBe("INR");
    // rate follows amount on every line, including the one that absorbed the paisa residual
    expect(inv.lineItems.map((l) => l.rate)).toEqual(amounts);
  });

  it("splits the INR total in proportion to the USD amounts and sums exactly", () => {
    const deel = deelData({
      subtotal: 3602,
      total: 3602,
      headerTotal: 3602,
      summaryTotal: 3602,
      lineItems: [item("Bonus: CEO Bonus", 1602), item("Fixed rate: Monthly payment", 2000)],
    });
    const inv = generateInvoiceData(deel, fakeConfig(), { firaData: firaData({ fcyAmount: 3597, inrAmount: 329713.33 }) });
    const [bonus, fixed] = inv.lineItems.map((l) => l.amount);
    expect(sum([bonus, fixed])).toBe(329713.33);
    expect(bonus / fixed).toBeCloseTo(1602 / 2000, 3);
  });

  it("puts rounding residue on the largest line, never on a zero row", () => {
    const deel = deelData({
      subtotal: 3,
      total: 3,
      headerTotal: 3,
      summaryTotal: 3,
      lineItems: [item("Other: a", 1), item("Other: b", 1), item("Other: c", 1), item("Other: z", 0)],
    });
    const inv = generateInvoiceData(deel, fakeConfig(), { firaData: firaData({ fcyAmount: 3, inrAmount: 100 }) });
    const amounts = inv.lineItems.map((l) => l.amount);
    expect(sum(amounts)).toBe(100);
    expect(amounts[3]).toBe(0);
    expect(amounts.every((a) => a >= 0)).toBe(true);
  });

  it("computes bank charges as Deel total minus FIRA USD, and the exchange rate", () => {
    const inv = generateInvoiceData(deelData(), fakeConfig(), { firaData: firaData({ fcyAmount: 1995, inrAmount: 179955 }) });
    expect(inv.firaData?.originalUsdBilled).toBe(2000);
    expect(inv.firaData?.fundsRealizedUsd).toBe(1995);
    expect(inv.firaData?.bankChargesUsd).toBe(5);
    expect(inv.firaData?.exchangeRate).toBeCloseTo(90.2030, 3);
    expect(inv.firaData?.firaRef).toBe("SYNTHREF0001");
  });

  it("never reports negative bank charges when FIRA USD exceeds the Deel total", () => {
    const inv = generateInvoiceData(deelData(), fakeConfig(), { firaData: firaData({ fcyAmount: 2000.5, inrAmount: 180000 }) });
    expect(inv.firaData?.bankChargesUsd).toBe(0);
  });

  it("appends the original USD value to each description", () => {
    const inv = generateInvoiceData(deelData(), fakeConfig(), { firaData: firaData() });
    expect(inv.lineItems[0].description).toContain("(Original Value: USD 2,000.00)");
  });

  it("records the FIRA reference in the compliance key", () => {
    const inv = generateInvoiceData(deelData(), fakeConfig(), { firaData: firaData() });
    expect(inv.complianceMetadata.complianceKey).toBe("INV-2026-08__INV-2026-9__SYNTHREF0001");
    expect(inv.complianceMetadata.fira?.source).toBe("pdf");
  });

  it("rejects incomplete FIRA data", () => {
    expect(() => generateInvoiceData(deelData(), fakeConfig(), { firaData: firaData({ inrAmount: 0 }) })).toThrow(/FIRA data is incomplete/);
    expect(() => generateInvoiceData(deelData(), fakeConfig(), { firaData: firaData({ firaRef: "" }) })).toThrow(/FIRA data is incomplete/);
  });

  it("allows a manual FIRA with no reference or date", () => {
    const inv = generateInvoiceData(deelData(), fakeConfig(), {
      firaData: firaData({ firaRef: "", processedDate: "" }),
      firaSource: "manual",
    });
    expect(inv.complianceMetadata.fira?.source).toBe("manual");
  });
});
