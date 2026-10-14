import { describe, expect, it } from "vitest";
import { groupRows, normaliseText, readPdfText, type TextItem } from "@/lib/extraction/text";
import { fieldsForLabel, isKnownLabel, labelKey } from "@/lib/extraction/labels";
import { parseAmount, parseInvoiceNumber, parseLongDate, parseMoney, parseNumericDate, parseReference } from "@/lib/extraction/shapes";
import { cellsToPdf } from "./layouts";

const item = (str: string, x: number, y: number, h = 8): TextItem => ({ str, x, y, w: str.length * 4, h, page: 1, seq: 0 });

describe("text model", () => {
  it("normalises NBSP, thin spaces, zero-width and Private Use Area characters", () => {
    expect(normaliseText("USD $2,000.00")).toBe("USD $2,000.00");
    expect(normaliseText("Sub total")).toBe("Sub total");
    expect(normaliseText("SYNTH​REF‍0001")).toBe("SYNTHREF0001");
    expect(normaliseText(" Acme  Research \n LLC ")).toBe("Acme Research LLC");
  });

  it("groups items into rows by baseline and orders each row by x", () => {
    const rows = groupRows([item("USD $2,000.00", 400, 300.5), item("Total", 50, 301), item("VAT", 50, 320)]);
    expect(rows.map((r) => r.items.map((i) => i.str))).toEqual([["VAT"], ["Total", "USD $2,000.00"]]);
  });

  it("keeps lines a little over half a line height apart as separate rows", () => {
    expect(groupRows([item("a", 0, 100), item("b", 0, 94)])).toHaveLength(2);
  });

  it("reads positions from a PDF", async () => {
    const text = await readPdfText(cellsToPdf([{ text: "TOTAL", x: 527, y: 664 }, { text: "USD $1.00", x: 449, y: 645 }]), "Test");
    expect(text.rows).toHaveLength(2);
    expect(text.items[0]).toMatchObject({ str: "TOTAL", x: 527, y: 664, page: 1 });
    expect(text.items[1].w).toBeGreaterThan(0);
  });
});

describe("label synonyms", () => {
  it("matches case- and space-insensitively, with a trailing No / No. / # / :", () => {
    for (const s of ["TOTAL DUE", "total due", "Total   Due", "TOTAL", "Amount due", "Balance Due:"]) {
      expect(fieldsForLabel(s).map((f) => f.field)).toContain("deel.total");
    }
    for (const s of ["Subtotal", "Sub total", "Sub-total", "SUB TOTAL"]) expect(fieldsForLabel(s).map((f) => f.field)).toEqual(["deel.subtotal"]);
    for (const s of ["Customer Transaction Reference No", "Customer Transaction Reference No.", "Transaction Reference #", "Customer Transaction Reference:"]) {
      expect(fieldsForLabel(s).map((f) => f.field)).toEqual(["fira.firaRef"]);
    }
    expect(labelKey("Deel Ref.:")).toBe("deelref");
  });

  it("marks Value Date as a weak synonym of the processed date", () => {
    expect(fieldsForLabel("Value Date")).toEqual([{ field: "fira.processedDate", synonym: { text: "Value Date", weak: true } }]);
  });

  it("knows structural labels but not values", () => {
    expect(isKnownLabel("BILL TO")).toBe(true);
    expect(isKnownLabel("Remitter Name")).toBe(true);
    expect(isKnownLabel("Acme Research LLC")).toBe(false);
  });
});

describe("value shapes", () => {
  it("reads money, amounts and percentages", () => {
    expect(parseMoney("USD $2,000.00")).toEqual({ currency: "USD", amount: 2000 });
    expect(parseMoney("EUR 15")).toEqual({ currency: "EUR", amount: 15 });
    expect(parseMoney("USD $??")).toBeNull();
    expect(parseAmount("1,80,174.04")).toBe(180174.04);
    expect(parseAmount("1995.00")).toBe(1995);
    expect(parseAmount("12 apples")).toBeNull();
  });

  it("accepts only real dates", () => {
    expect(parseLongDate("August 21, 2026")).toBe("August 21, 2026");
    expect(parseLongDate("February 30, 2026")).toBeNull();
    expect(parseNumericDate("07-10-2026")).toBe("07-10-2026");
    expect(parseNumericDate("2026-10-07")).toBe("2026-10-07");
    expect(parseNumericDate("32-10-2026")).toBeNull();
  });

  it("reads invoice numbers and references", () => {
    expect(parseInvoiceNumber("INV 2026 9")).toBe("INV-2026-9");
    expect(parseInvoiceNumber("INV-2026-10")).toBe("INV-2026-10");
    expect(parseInvoiceNumber("INV202610")).toBe("INV-2026-10");
    expect(parseInvoiceNumber("Invoice")).toBeNull();
    expect(parseReference("SYNTHREF0001")).toBe("SYNTHREF0001");
    expect(parseReference("Processed Date")).toBeNull();
  });
});
