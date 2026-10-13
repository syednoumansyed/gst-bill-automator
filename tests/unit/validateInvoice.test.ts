import { describe, expect, it } from "vitest";
import { parseDeelInvoice } from "@/lib/parseDeelInvoice";
import {
  InvoiceValidationError,
  validateDeelData,
  validateGeneratedInvoice,
  validateSupplier,
} from "@/lib/validateInvoice";
import type { GeneratedInvoice } from "@/lib/types";
import { deelData, deelLines, deelLinesV1, fakeConfig, MULTI_ITEM, type DeelLayoutOptions } from "../helpers/fixtures";
import { linesToPdf } from "../helpers/pdf";

/** Parse a synthetic PDF and run the Deel validation on it, like the route does. */
async function check(lines: string[]): Promise<void> {
  validateDeelData(await parseDeelInvoice(linesToPdf(lines)));
}

describe("validateDeelData: accepts", () => {
  it("a valid v2 invoice", async () => {
    await expect(check(deelLines())).resolves.toBeUndefined();
  });

  it("a valid v1 invoice", async () => {
    await expect(check(deelLinesV1())).resolves.toBeUndefined();
  });

  it("a multi-item invoice with a zero-value row", async () => {
    await expect(check(deelLines(MULTI_ITEM))).resolves.toBeUndefined();
  });

  it("a zero-value Bonus row next to a real Fixed row", () => {
    expect(() =>
      validateDeelData(
        deelData({
          lineItems: [
            { description: "Fixed rate: Monthly payment", amount: 2000 },
            { description: "Bonus: nothing this month", amount: 0 },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("totals that differ by one cent of rounding", () => {
    expect(() => validateDeelData(deelData({ headerTotal: 2000.01 }))).not.toThrow();
  });
});

describe("validateDeelData: rejects", () => {
  const rejects: [string, DeelLayoutOptions, RegExp][] = [
    ["an unreadable total", { header: ["TOTAL", "USD $UNREADABLE"], total: ["Total", "USD $UNREADABLE"] }, /could not read the total/i],
    ["an unreadable summary total only", { total: ["Total", "USD $??"] }, /could not read the total/i],
    ["a zero total", { header: ["TOTAL", "USD $0.00"], total: ["Total", "USD $0.00"] }, /could not read the total/i],
    [
      "a header that disagrees with the summary",
      { header: ["TOTAL", "USD $2,500.00"] },
      /totals disagree.*2500\.00.*2000\.00/i,
    ],
    ["an unreadable subtotal", { sub: ["Subtotal", "USD $??"] }, /subtotal is zero or could not be read/i],
    ["a zero subtotal", { sub: ["Subtotal", "USD $0.00"] }, /subtotal is zero/i],
    ["line items nobody recognises", { items: ["Monthly retainer", "USD $2,000.00"] }, /no recognised line items/i],
    [
      "non-zero VAT",
      { header: ["TOTAL", "USD $2,200.00"], vat: ["VAT", "10%", "USD $200.00"], total: ["Total", "USD $2,200.00"] },
      /includes VAT of USD 200\.00/i,
    ],
    ["a non-USD summary", { total: ["Total", "EUR $2,000.00"] }, /only USD/i],
    ["a non-USD header", { header: ["TOTAL", "GBP $2,000.00"] }, /only USD/i],
    [
      "a line item with no amount",
      { items: ["Fixed rate: Monthly payment", "see attachment", "USD $2,000.00"] },
      /every line-item amount/i,
    ],
    [
      "line items that don't add up to the subtotal",
      { items: ["Fixed rate: Monthly payment", "USD $1,500.00"] },
      /line items add up to 1500\.00/i,
    ],
  ];

  it.each(rejects)("%s", async (_name, layout, message) => {
    const err = await check(deelLines(layout)).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceValidationError);
    expect(err.message).toMatch(message);
  });

  it("subtotal + VAT that doesn't match the total", () => {
    expect(() => validateDeelData(deelData({ subtotal: 1900, lineItems: [{ description: "Fixed rate: x", amount: 1900 }] }))).toThrow(
      /does not match its total/i,
    );
  });

  it("an invoice with no line items at all", () => {
    expect(() => validateDeelData(deelData({ lineItems: [] }))).toThrow(/no recognised line items/i);
  });

  it("a negative line item", () => {
    expect(() =>
      validateDeelData(
        deelData({
          lineItems: [
            { description: "Fixed rate: Monthly payment", amount: 2100 },
            { description: "Other: refund", amount: -100 },
          ],
        }),
      ),
    ).toThrow(/line-item amount/i);
  });
});

describe("validateSupplier", () => {
  it("accepts the fake profile", () => {
    expect(() => validateSupplier(fakeConfig().businessProfile)).not.toThrow();
  });

  it.each([
    ["GSTIN", { gstin: "" }],
    ["PAN", { pan: "" }],
    ["bank account number", { accountNumber: "" }],
    ["GSTIN", { gstin: "   " }],
  ] as const)("rejects an empty %s", (label, over) => {
    expect(() => validateSupplier(fakeConfig(over).businessProfile)).toThrow(
      new RegExp(`missing:.*${label}`, "i"),
    );
  });

  it("names every missing field at once", () => {
    expect(() => validateSupplier(fakeConfig({ gstin: "", pan: "", accountNumber: "" }).businessProfile)).toThrow(
      /GSTIN, PAN, bank account number/,
    );
  });
});

describe("validateGeneratedInvoice", () => {
  const line = (amount: number) => ({ description: "x", sacCode: "998392", qty: 1, rate: amount, amount, sgst: 0, cgst: 0, igst: 0, cess: 0 });
  const invoice = (over: Partial<GeneratedInvoice> = {}): GeneratedInvoice =>
    ({ lineItems: [line(2000)], subtotal: 2000, grandTotal: 2000, ...over }) as GeneratedInvoice;

  it("accepts consistent totals", () => {
    expect(() => validateGeneratedInvoice(invoice())).not.toThrow();
  });

  it("rejects a zero grand total", () => {
    expect(() => validateGeneratedInvoice(invoice({ grandTotal: 0 }))).toThrow(InvoiceValidationError);
  });

  it("rejects a negative line", () => {
    expect(() => validateGeneratedInvoice(invoice({ lineItems: [line(2100), line(-100)] }))).toThrow(/zero or not a number/);
  });

  it("rejects lines that don't add up", () => {
    expect(() => validateGeneratedInvoice(invoice({ lineItems: [line(1999)] }))).toThrow(/do not add up/);
  });

  it("rejects incomplete FIRA figures", () => {
    const firaData = { originalUsdBilled: 2000, fundsRealizedUsd: 1995, fundsRealizedInr: 179955, bankChargesUsd: 5, exchangeRate: 0, firaRef: "R", firaDate: "d" };
    expect(() => validateGeneratedInvoice(invoice({ firaData }))).toThrow(/FIRA figures are incomplete/);
  });
});
