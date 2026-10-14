import { describe, expect, it } from "vitest";
import { draftFromExtractions, extractDeel } from "@/lib/extraction";
import { validateDeelData } from "@/lib/validateInvoice";
import { parseDeelInvoice } from "@/lib/parseDeelInvoice";
import type { DeelExtraction } from "@/lib/extraction/types";
import { cellsToPdf, deelCells, FAKE_DEEL, gstInvoiceCells, lutFormCells, usd, type Cell, type DeelLayoutId } from "./layouts";

const extract = (cells: Cell[]) => extractDeel(cellsToPdf(cells));
const relabel = (cells: Cell[], role: string, text: string) => cells.map((c) => (c.role === role ? { ...c, text } : c));
const drop = (cells: Cell[], role: string) => cells.filter((c) => c.role !== role);
const codes = (d: DeelExtraction) => d.issues.map((i) => i.code);
const values = (d: DeelExtraction) => Object.fromEntries(Object.entries(d.fields).map(([k, f]) => [k, f.value]));

const EXPECTED = {
  invoiceNumber: "INV-2026-9",
  issueDate: "August 21, 2026",
  dueDate: "August 31, 2026",
  periodStart: "August 1, 2026",
  periodEnd: "August 31, 2026",
  clientName: "Acme Research LLC",
  clientAddress: "1 Main St, Riyadh, 11111",
  clientCountry: "Saudi Arabia",
  clientVatId: "300000000000003",
  supplierName: "Test Supplier",
  currency: "USD",
  headerTotal: 2000,
  summaryTotal: 2000,
  subtotal: 2000,
  vat: 0,
  total: 2000,
  deelRef: "DLR7FAKE2Q",
};

describe("extractDeel: known layouts", () => {
  it.each(["deel-2025", "deel-2026-07"] as DeelLayoutId[])("reads %s with high confidence on cross-checked fields", async (layout) => {
    const d = await extract(deelCells(layout));
    expect(d.kind).toBe("deel-invoice");
    expect(d.layout).toEqual({ id: layout, isNew: false });
    expect(values(d)).toMatchObject(EXPECTED);
    expect(d.lineItems).toEqual([{ description: "Fixed rate: Monthly payment", amount: expect.objectContaining({ value: 2000, confidence: "high" }) }]);
    for (const f of ["invoiceNumber", "issueDate", "dueDate", "headerTotal", "summaryTotal", "subtotal", "vat", "total", "currency", "deelRef"] as const) {
      expect(d.fields[f].confidence, f).toBe("high");
    }
    // Free text has no cross-check, so it is never "high"
    expect(d.fields.clientName.confidence).toBe("medium");
    expect(d.issues).toEqual([]);
  });

  it("names the strategy behind each value", async () => {
    const d = await extract(deelCells("deel-2026-07"));
    expect(d.fields.headerTotal.source).toBe("label-below:TOTAL");
    expect(d.fields.summaryTotal.source).toBe("label-right:Total");
    expect(d.fields.total.source).toMatch(/^cross-check:header=summary/);
    expect(d.fields.deelRef.source).toBe("label-inline:Deel Ref.: DLR7FAKE2Q");
  });

  it("reads a multi-item invoice and checks the items add up", async () => {
    const items = [
      { description: "Bonus: Annual bonus", amount: 1602 },
      { description: "Fixed rate: Monthly payment", amount: 2000 },
      { description: "Other: adjustment", amount: 0 },
    ];
    const d = await extract(deelCells("deel-2025", { ...FAKE_DEEL, items }));
    expect(d.lineItems.map((i) => [i.description, i.amount.value, i.amount.confidence])).toEqual(items.map((i) => [i.description, i.amount, "high"]));
    expect(d.fields.total.value).toBe(3602);
    expect(d.issues).toEqual([]);
  });
});

describe("extractDeel: layout changes it survives", () => {
  it.each([
    ["label:header", "Amount due"],
    ["label:header", "Balance Due"],
    ["label:subtotal", "Sub-total"],
    ["label:issueDate", "Invoice Date"],
    ["label:invoiceNumber", "Invoice No."],
  ])("a renamed label (%s → %s) still reads, flagged as a new layout", async (role, text) => {
    const d = await extract(relabel(deelCells("deel-2026-07"), role, text));
    expect(values(d)).toMatchObject(EXPECTED);
    expect(d.layout.isNew).toBe(true);
    expect(d.issues).toEqual([expect.objectContaining({ code: "DOC_LAYOUT_NEW", severity: "warning", document: "deel" })]);
    // An unrecognised layout never earns "high"
    expect(Object.values(d.fields).every((f) => f.confidence !== "high")).toBe(true);
  });

  it("a label split across two items on one row", async () => {
    const cells = deelCells("deel-2025").flatMap((c) =>
      c.role === "label:subtotal"
        ? [{ ...c, text: "Sub" }, { ...c, text: "total", x: c.x + 15 }]
        : c.role === "label:header"
          ? [{ ...c, text: "TOTAL", x: 505 }, { ...c, text: "DUE", x: 535 }]
          : [c],
    );
    const d = await extract(cells);
    expect(d.fields.subtotal.value).toBe(2000);
    expect(d.fields.subtotal.source).toBe("label-split-right:Sub total");
    expect(d.fields.headerTotal.value).toBe(2000);
    expect(d.fields.total.value).toBe(2000);
  });

  it("a label wrapped onto a second line", async () => {
    const cells = deelCells("deel-2026-07").flatMap((c) =>
      c.role === "label:issueDate" ? [{ ...c, text: "Issue" }, { ...c, text: "Date", y: c.y - 8 }] : [c],
    );
    const d = await extract(cells);
    expect(d.fields.issueDate.value).toBe("August 21, 2026");
  });

  it("values to the right of their label instead of below, and below instead of right", async () => {
    const cells = deelCells("deel-2026-07").map((c) => {
      if (c.role === "value:header") return { ...c, x: 300, y: 600, size: 8 }; // header label moves down beside it
      if (c.role === "label:header") return { ...c, x: 250, y: 600 };
      if (c.role === "value:issueDate") return { ...c, x: 384, y: 722 }; // under its label
      if (c.role === "label:dueDate" || c.role === "value:dueDate") return { ...c, y: c.y - 6 };
      return c;
    });
    const d = await extract(cells);
    expect(d.fields.headerTotal).toMatchObject({ value: 2000, source: "label-right:TOTAL" });
    expect(d.fields.issueDate).toMatchObject({ value: "August 21, 2026", source: "label-below:Issue Date" });
    expect(d.fields.dueDate.value).toBe("August 31, 2026");
  });

  it("a ':' printed as its own cell between label and value", async () => {
    const cells = deelCells("deel-2026-07").flatMap((c) => (c.role === "label:subtotal" ? [c, { text: ":", x: 90, y: c.y }] : [c]));
    expect((await extract(cells)).fields.subtotal.value).toBe(2000);
  });

  it("reordered blocks: client on the left, supplier on the right, summary rows swapped", async () => {
    const cells = deelCells("deel-2026-07").map((c) => {
      if (c.role === "label:billTo" || c.role === "value:client" || c.role === "label:vatId") return { ...c, x: 45 };
      if (c.role === "value:vatId") return { ...c, x: 73 };
      if (c.role === "label:billFrom" || c.role === "value:supplier") return { ...c, x: 215 };
      if (c.role === "label:subtotal" || c.role === "value:subtotal") return { ...c, y: c.y - 20 };
      if (c.role === "label:vat" || c.role === "value:vat" || c.role === "value:vatRate") return { ...c, y: c.y + 20 };
      return c;
    });
    const d = await extract(cells);
    expect(values(d)).toMatchObject(EXPECTED);
  });

  it("odd case and spacing in labels", async () => {
    let cells = relabel(deelCells("deel-2025"), "label:header", "total  due");
    cells = relabel(cells, "label:subtotal", "SUB TOTAL");
    cells = relabel(cells, "label:summary", "TOTAL");
    const d = await extract(cells);
    expect(d.fields.headerTotal.value).toBe(2000);
    expect(d.fields.subtotal.value).toBe(2000);
    expect(d.fields.summaryTotal.value).toBe(2000);
  });

  it("a client name wrapped over two lines", async () => {
    const d = await extract(
      deelCells("deel-2026-07", { ...FAKE_DEEL, clientLines: ["Acme Research For Testing &", "Education LLC", "1 Main St", "Riyadh, 11111", "Saudi Arabia"] }),
    );
    expect(d.fields.clientName.value).toBe("Acme Research For Testing & Education LLC");
    expect(d.fields.clientAddress.value).toBe("1 Main St, Riyadh, 11111");
  });

  it("text drawn in a different order than it reads: amounts still reconcile", async () => {
    const cells = deelCells("deel-2026-07");
    const shuffled = [...cells.filter((_, i) => i % 2 === 1), ...cells.filter((_, i) => i % 2 === 0)].reverse();
    const d = await extract(shuffled);
    expect(d.fields.total.value).toBe(2000);
    expect(d.fields.subtotal.value).toBe(2000);
    expect(d.lineItems.map((i) => i.amount.value)).toEqual([2000]);
    expect(d.fields.issueDate.value).toBe("August 21, 2026");
    // Free text read two ways that disagree is reported, never guessed
    if (d.fields.clientName.value !== null) expect(d.fields.clientName.value).toBe("Acme Research LLC");
    else expect(d.issues).toContainEqual(expect.objectContaining({ code: "DEEL_FIELD_UNREADABLE", field: "deel.clientName" }));
  });

  it("an unknown layout still extracts, with a DOC_LAYOUT_NEW warning", async () => {
    const cells: Cell[] = [
      { text: "Contractor invoice", x: 40, y: 800, size: 14 },
      { text: "Invoice number", x: 40, y: 770 },
      { text: "INV-2026-11", x: 160, y: 770 },
      { text: "Invoice date", x: 40, y: 755 },
      { text: "October 21, 2026", x: 160, y: 755 },
      { text: "Billed To", x: 300, y: 720 },
      { text: "Acme Research LLC", x: 300, y: 708 },
      { text: "Item", x: 40, y: 600 },
      { text: "Fixed rate: Monthly payment", x: 40, y: 580 },
      { text: usd(2000), x: 400, y: 580 },
      { text: "Subtotal", x: 40, y: 560 },
      { text: usd(2000), x: 400, y: 560 },
      { text: "Amount due", x: 40, y: 540 },
      { text: usd(2000), x: 400, y: 540 },
    ];
    const d = await extract(cells);
    expect(d.kind).toBe("deel-invoice");
    expect(d.layout).toEqual({ id: "deel-unknown", isNew: true });
    expect(codes(d)).toContain("DOC_LAYOUT_NEW");
    expect(d.fields.invoiceNumber.value).toBe("INV-2026-11");
    expect(d.fields.issueDate.value).toBe("October 21, 2026");
    expect(d.fields.summaryTotal.value).toBe(2000);
    expect(d.fields.total.value).toBe(2000);
    expect(d.fields.clientName.value).toBe("Acme Research LLC");
  });
});

describe("extractDeel: never silently empty", () => {
  it.each([
    ["value:deelRef", "deelRef", "warning"],
    ["value:period", "periodStart", "warning"],
    ["value:header", "headerTotal", "warning"],
    ["value:summary", "summaryTotal", "warning"],
  ])("a missing %s is flagged on deel.%s (%s)", async (role, field, severity) => {
    const d = await extract(drop(deelCells("deel-2026-07"), role));
    expect(d.fields[field as "deelRef"].value).toBeNull();
    expect(d.issues).toContainEqual(expect.objectContaining({ code: "DEEL_FIELD_UNREADABLE", field: `deel.${field}`, severity }));
  });

  it("a missing total is an error when the other total is missing too", async () => {
    const d = await extract(drop(drop(deelCells("deel-2026-07"), "value:header"), "value:summary"));
    expect(d.issues).toContainEqual(expect.objectContaining({ field: "deel.headerTotal", severity: "error" }));
    expect(d.issues).toContainEqual(expect.objectContaining({ field: "deel.summaryTotal", severity: "error" }));
  });

  it("finds the summary total when the summary block sits above the items", async () => {
    const cells = deelCells("deel-2026-07").map((c) =>
      /^(label|value):(subtotal|vat|vatRate|summary)$/.test(c.role ?? "") ? { ...c, y: c.y + 120 } : c,
    );
    const d = await extract(cells);
    expect(d.fields.summaryTotal.value).toBe(2000);
    expect(d.fields.headerTotal.value).toBe(2000);
    expect(d.lineItems.map((i) => i.amount.value)).toEqual([2000]);
  });

  it("reads a name wrapped over three lines when a line starts with a connector", async () => {
    const d = await extract(
      deelCells("deel-2026-07", { ...FAKE_DEEL, clientLines: ["Acme Holdings", "For Testing &", "Research", "1 Main St", "Riyadh, 11111", "Saudi Arabia"] }),
    );
    expect(d.fields.clientName).toMatchObject({ value: "Acme Holdings For Testing & Research", confidence: "medium" });
    expect(d.issues).toEqual([]);
  });

  it("flags a client name it can't split from the address with certainty", async () => {
    // No country line: where the name ends is a guess
    const d = await extract(deelCells("deel-2026-07", { ...FAKE_DEEL, clientLines: ["Acme Research For Testing &", "Education LLC", "1 Main St", "Riyadh, 11111"] }));
    expect(d.fields.clientName.confidence).toBe("low");
    expect(d.issues).toContainEqual(
      expect.objectContaining({ code: "DEEL_FIELD_UNREADABLE", field: "deel.clientName", severity: "warning", message: "The client name may be wrapped or incomplete." }),
    );
    expect(d.issues).toContainEqual(expect.objectContaining({ field: "deel.clientCountry", severity: "warning" }));
  });
});

describe("extractDeel: says so when it can't", () => {
  it("header and summary totals that disagree give an issue, not a pick", async () => {
    const d = await extract(deelCells("deel-2026-07", { ...FAKE_DEEL, header: 2500 }));
    expect(d.fields.total).toMatchObject({ value: null, confidence: "low" });
    expect(d.fields.headerTotal).toMatchObject({ value: 2500, confidence: "low" });
    expect(d.fields.summaryTotal).toMatchObject({ value: 2000, confidence: "low" });
    expect(d.issues).toContainEqual(expect.objectContaining({ code: "DEEL_TOTALS_DISAGREE", field: "deel.total", severity: "error" }));
    // The legacy wrapper still returns both, so validation rejects the invoice as before
    const w = await parseDeelInvoice(cellsToPdf(deelCells("deel-2026-07", { ...FAKE_DEEL, header: 2500 })));
    expect([w.headerTotal, w.summaryTotal]).toEqual([2500, 2000]);
  });

  it("a missing total is null with DEEL_FIELD_UNREADABLE, never 0", async () => {
    const d = await extract(drop(drop(deelCells("deel-2026-07"), "value:header"), "value:summary"));
    expect(d.fields.total).toMatchObject({ value: null, confidence: "low" });
    expect(d.fields.headerTotal.source).toBe("unreadable:TOTAL");
    expect(d.issues).toContainEqual(expect.objectContaining({ code: "DEEL_FIELD_UNREADABLE", field: "deel.total" }));
  });

  it("an unreadable amount doesn't borrow the next row's value", async () => {
    const d = await extract(relabel(deelCells("deel-2026-07"), "value:subtotal", "USD $2,0O0.00"));
    expect(d.fields.subtotal).toMatchObject({ value: null, source: "unreadable:Subtotal" });
    expect(d.issues).toContainEqual(expect.objectContaining({ code: "DEEL_FIELD_UNREADABLE", field: "deel.subtotal" }));
  });

  it("two readings of one amount: the cross-check picks the one that reconciles", async () => {
    // The stream puts a footer amount right after "Subtotal", so the sequential reader sees 9.99; the row says 2,000
    const cells = deelCells("deel-2026-07").flatMap((c) => (c.role === "label:subtotal" ? [c, { text: usd(9.99), x: 300, y: 60 }] : [c]));
    const d = await extract(cells);
    expect(d.fields.subtotal).toMatchObject({ value: 2000, confidence: "medium", source: "label-right:Subtotal" });
    expect(d.issues).toEqual([]);
  });

  it("line items that don't add up give DEEL_ITEMS_DONT_SUM", async () => {
    const d = await extract(deelCells("deel-2026-07", { ...FAKE_DEEL, items: [{ description: "Fixed rate: Monthly payment", amount: 1500 }], subtotal: 2000 }));
    expect(d.issues).toContainEqual(expect.objectContaining({ code: "DEEL_ITEMS_DONT_SUM", field: "deel.lineItems" }));
    expect(d.lineItems[0].amount.confidence).toBe("low");
  });

  it("a line item without an amount names the item", async () => {
    const d = await extract(drop(deelCells("deel-2026-07"), "value:item:0"));
    expect(d.lineItems[0].amount.value).toBeNull();
    expect(d.issues).toContainEqual(expect.objectContaining({ code: "DEEL_FIELD_UNREADABLE", field: "deel.lineItems.0.amount" }));
  });

  it("amounts in two currencies give DEEL_CURRENCY_UNSUPPORTED", async () => {
    const d = await extract(relabel(deelCells("deel-2026-07"), "value:summary", usd(2000, "EUR")));
    expect(d.fields.currency.value).toBeNull();
    expect(codes(d)).toContain("DEEL_CURRENCY_UNSUPPORTED");
  });

  it("an invoice entirely in EUR reads EUR and gives a DEEL_CURRENCY_UNSUPPORTED error", async () => {
    const cells = deelCells("deel-2026-07").map((c) => ({ ...c, text: c.text.replace(/^USD \$/, "EUR ") }));
    const d = await extract(cells);
    expect(d.fields.currency.value).toBe("EUR");
    expect(d.fields.total.value).toBe(2000);
    expect(d.issues).toContainEqual(expect.objectContaining({ code: "DEEL_CURRENCY_UNSUPPORTED", field: "deel.currency", severity: "error" }));
    const draft = draftFromExtractions(d, null);
    expect(draft.deel.currency).toBe("EUR");
  });

  it("a foreign line item under USD totals is flagged, and the legacy wrapper passes it on to validation", async () => {
    const cells = deelCells("deel-2026-07", { ...FAKE_DEEL, items: [{ description: "Fixed rate: Hourly payment", amount: 2000 }] }).map((c) =>
      c.role === "value:item:0" ? { ...c, text: "EUR 2,000" } : c,
    );
    const d = await extract(cells);
    expect(d.issues).toContainEqual(expect.objectContaining({ code: "DEEL_CURRENCY_UNSUPPORTED", field: "deel.currency" }));
    const w = await parseDeelInvoice(cellsToPdf(cells));
    expect(w.sourceCurrencies).toContain("EUR");
    expect(() => validateDeelData(w)).toThrow(/Only USD/);
  });

  it("our own GST invoice uploaded as the Deel invoice is DOC_WRONG_KIND", async () => {
    const d = await extract(gstInvoiceCells());
    expect(d.kind).toBe("gst-invoice");
    expect(d.issues).toEqual([expect.objectContaining({ code: "DOC_WRONG_KIND", severity: "error", document: "deel" })]);
    expect(d.issues[0].message).toMatch(/GST tax invoice/);
    expect(Object.values(d.fields).every((f) => f.value === null)).toBe(true);
  });

  it("an LUT form uploaded as the Deel invoice is DOC_WRONG_KIND", async () => {
    const d = await extract(lutFormCells());
    expect(d.kind).toBe("lut-form");
    expect(d.issues[0]).toMatchObject({ code: "DOC_WRONG_KIND" });
    expect(d.issues[0].message).toMatch(/LUT form/);
  });

  it("a PDF that isn't an invoice at all is DOC_WRONG_KIND", async () => {
    const d = await extract([{ text: "Grocery list", x: 40, y: 800 }, { text: "Milk", x: 40, y: 780 }]);
    expect(d.kind).toBe("unknown");
    expect(codes(d)).toEqual(["DOC_WRONG_KIND"]);
  });

  it("a PDF with no text is PDF_NO_TEXT", async () => {
    const d = await extract([]);
    expect(codes(d)).toEqual(["PDF_NO_TEXT"]);
  });
});
