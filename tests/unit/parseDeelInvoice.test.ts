import { describe, expect, it } from "vitest";
import { parseDeelInvoice } from "@/lib/parseDeelInvoice";
import { deelLines, deelLinesV1, MULTI_ITEM } from "../helpers/fixtures";
import { linesToPdf } from "../helpers/pdf";

const parse = (lines: string[]) => parseDeelInvoice(linesToPdf(lines));

describe("parseDeelInvoice: layouts", () => {
  it("reads the v1 layout (TOTAL DUE / Sub total)", async () => {
    const d = await parse(deelLinesV1());
    expect(d.headerTotal).toBe(2000);
    expect(d.summaryTotal).toBe(2000);
    expect(d.total).toBe(2000);
    expect(d.subtotal).toBe(2000);
    expect(d.vat).toBe(0);
    expect(d.currency).toBe("USD");
    expect(d.lineItems).toEqual([{ description: "Fixed rate: Monthly payment", amount: 2000 }]);
  });

  it("reads the v2 layout (TOTAL / Subtotal)", async () => {
    const d = await parse(deelLines());
    expect(d.headerTotal).toBe(2000);
    expect(d.summaryTotal).toBe(2000);
    expect(d.total).toBe(2000);
    expect(d.subtotal).toBe(2000);
    expect(d.vat).toBe(0);
    expect(d.lineItems).toEqual([{ description: "Fixed rate: Monthly payment", amount: 2000 }]);
  });

  it("reads invoice number, dates, period, supplier and reference", async () => {
    const d = await parse(deelLines());
    expect(d.invoiceNumber).toBe("INV-2026-9");
    expect(d.issueDate).toBe("August 21, 2026");
    expect(d.dueDate).toBe("August 31, 2026");
    expect(d.periodStart).toBe("August 1, 2026");
    expect(d.periodEnd).toBe("August 31, 2026");
    expect(d.supplierName).toBe("Test Supplier");
    expect(d.role).toBe("UI/UX Designer");
    expect(d.deelRef).toBe("SYNTHETIC");
  });

  it("reads a multi-item invoice (Bonus + Fixed + zero-value Other)", async () => {
    const d = await parse(deelLines(MULTI_ITEM));
    expect(d.total).toBe(3602);
    expect(d.subtotal).toBe(3602);
    expect(d.lineItems).toEqual([
      { description: "Bonus: CEO Bonus", amount: 1602 },
      { description: "Fixed rate: Monthly payment", amount: 2000 },
      { description: "Other: adjustment", amount: 0 },
    ]);
  });

  it("does not mistake the 'Fixed contract' section header for a line item", async () => {
    const d = await parse(deelLines());
    expect(d.lineItems.map((i) => i.description)).not.toContain("Fixed contract");
  });

  it("keeps the header and summary totals apart so a mismatch can be detected", async () => {
    const d = await parse(deelLines({ header: ["TOTAL", "USD $2,500.00"] }));
    expect(d.headerTotal).toBe(2500);
    expect(d.summaryTotal).toBe(2000);
  });

  it("marks an unreadable amount NaN instead of borrowing the next row's value", async () => {
    const d = await parse(deelLines({ sub: ["Subtotal", "USD $??"] }));
    expect(d.subtotal).toBeNaN();
    const t = await parse(deelLines({ header: ["TOTAL", "USD $UNREADABLE"] }));
    expect(t.headerTotal).toBeNaN();
  });

  it("marks a line item with no USD amount right after it NaN", async () => {
    const d = await parse(deelLines({ items: ["Fixed rate: Monthly payment", "see attachment", "USD $2,000.00"] }));
    expect(d.lineItems).toHaveLength(1);
    expect(d.lineItems[0].amount).toBeNaN();
  });

  it("records a non-USD currency", async () => {
    const d = await parse(deelLines({ total: ["Total", "EUR $2,000.00"] }));
    expect(d.currency).toBe("EUR");
  });

  it("reads the VAT amount after the rate line", async () => {
    const d = await parse(
      deelLines({
        header: ["TOTAL", "USD $2,200.00"],
        vat: ["VAT", "10%", "USD $200.00"],
        total: ["Total", "USD $2,200.00"],
      }),
    );
    expect(d.vat).toBe(200);
  });
});

describe("parseDeelInvoice: client name", () => {
  const billTo = (...rows: string[]) => ({ billTo: ["BILL TO", ...rows] });

  it("joins a name wrapped across lines when the first line ends with '&'", async () => {
    const d = await parse(deelLines());
    expect(d.clientName).toBe("Acme Holdings For Testing & Research");
    expect(d.clientAddress).toBe("1 Main St, Riyadh, 11111");
    expect(d.clientCountry).toBe("Saudi Arabia");
  });

  it("joins a name wrapped across lines when the first line ends with 'For'", async () => {
    const d = await parse(deelLines(billTo("Acme Company For", "Learning & Education", "1 Main St", "Riyadh, 11111", "Saudi Arabia")));
    expect(d.clientName).toBe("Acme Company For Learning & Education");
    expect(d.clientAddress).toBe("1 Main St, Riyadh, 11111");
  });

  it("does NOT join an address line after a trailing comma", async () => {
    const d = await parse(
      deelLines(billTo("International Software Solutions,", "Business Park", "123 Main Street", "United Kingdom")),
    );
    expect(d.clientName).toBe("International Software Solutions,");
    expect(d.clientName).not.toContain("Business Park");
    expect(d.clientAddress).toContain("Business Park");
  });

  // KNOWN BUG: a short name ending in a comma is joined with the next address line
  // ("Acme Inc," + "Business Park" -> "Acme Inc, Business Park") because the fallback joins two lines
  // whenever the first is under 30 characters. `it.fails` flips to a failure once the parser is fixed.
  it.fails("does NOT join an address line after a trailing comma on a SHORT name", async () => {
    const d = await parse(deelLines(billTo("Acme Inc,", "Business Park", "123 Main Street", "United Kingdom")));
    expect(d.clientName).toBe("Acme Inc,");
  });

  it("keeps a single-line name and puts the rest in the address", async () => {
    const d = await parse(deelLines(billTo("Very Long Synthetic Company Name Incorporated", "1 Main St", "Riyadh, 11111", "Saudi Arabia")));
    expect(d.clientName).toBe("Very Long Synthetic Company Name Incorporated");
    expect(d.clientAddress).toBe("1 Main St, Riyadh, 11111");
  });
});
