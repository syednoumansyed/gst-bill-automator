import { describe, expect, it } from "vitest";
import { draftFromExtractions, extractDeel, extractFira } from "@/lib/extraction";
import { invoiceDraftSchema } from "@/lib/draft";
import { parseDeelInvoice } from "@/lib/parseDeelInvoice";
import { cellsToPdf, deelCells, FAKE_DEEL, firaCells } from "./layouts";

describe("draftFromExtractions", () => {
  it("fills a valid review draft from both documents", async () => {
    const deel = await extractDeel(cellsToPdf(deelCells("deel-2026-07")));
    const fira = await extractFira(cellsToPdf(firaCells("fira-bank-2026-10")));
    const draft = draftFromExtractions(deel, fira);
    expect(invoiceDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.deel).toMatchObject({
      invoiceNumber: "INV-2026-9",
      clientName: "Acme Research LLC",
      currency: "USD",
      lineItems: [{ description: "Fixed rate: Monthly payment", amount: 2000 }],
      subtotal: 2000,
      vat: 0,
      total: 2000,
      deelRef: "DLR7FAKE2Q",
    });
    expect(draft.fira).toEqual({ source: "pdf", currency: "USD", firaRef: "SYNTHREF0001", processedDate: "25-08-2026", fcyAmount: 1995, inrAmount: 179955 });
    expect(draft.options).toEqual({ placeOfSupply: "", notes: "", overrideHsnSac: "", overrideInvoiceNumber: "" });
    expect(draft.edited).toEqual([]);
  });

  it("turns unreadable values into empty fields the issues point at", async () => {
    const deel = await extractDeel(cellsToPdf(deelCells("deel-2026-07", { ...FAKE_DEEL, header: 2500 })));
    const draft = draftFromExtractions(deel, null);
    expect(draft.deel.total).toBe(0);
    expect(draft.fira).toBeNull();
    expect(deel.issues.find((i) => i.field === "deel.total")?.code).toBe("DEEL_TOTALS_DISAGREE");
  });
});

describe("legacy wrappers over the engine", () => {
  it("parseDeelInvoice keeps the original output shape", async () => {
    const d = await parseDeelInvoice(cellsToPdf(deelCells("deel-2025")));
    expect(d).toMatchObject({
      invoiceNumber: "INV-2026-9",
      periodText: "August 1, 2026 to August 31, 2026",
      clientVatId: "300000000000003",
      supplierName: "Test Supplier",
      supplierAddress: "1 Test Road, Delhi, DL 110001",
      role: "UI/UX Designer",
      currency: "USD",
      sourceCurrencies: ["USD", "USD", "USD", "USD", "USD"], // header, summary, subtotal, VAT and the item
      headerTotal: 2000,
      summaryTotal: 2000,
      total: 2000,
    });
  });

  it("reads layouts the original parser couldn't", async () => {
    // pdf.js merges cells drawn in one font: "VAT 0%" arrives as one item and "Amount due" replaces "TOTAL"
    const cells = deelCells("deel-2026-07").map((c) => {
      if (c.role === "label:vat" || c.role === "value:vatRate") return { ...c, font: 1 as const };
      if (c.role === "label:header") return { ...c, text: "Amount due", x: 505 };
      return c;
    });
    const d = await parseDeelInvoice(cellsToPdf(cells));
    expect(d.headerTotal).toBe(2000);
    expect(d.vat).toBe(0);
    expect(d.sourceCurrencies).toEqual(["USD", "USD", "USD", "USD", "USD"]);
  });
});
