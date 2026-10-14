import { describe, expect, it } from "vitest";
import { draftFromExtractions, extractDeel, extractFira } from "@/lib/extraction";
import { parseFiraPdf } from "@/lib/parseFira";
import type { FiraExtraction } from "@/lib/extraction/types";
import { cellsToPdf, deelCells, FAKE_FIRA, firaCells, type Cell, type FiraLayoutId } from "./layouts";

const extract = (cells: Cell[]) => extractFira(cellsToPdf(cells));
const relabel = (cells: Cell[], role: string, text: string) => cells.map((c) => (c.role === role ? { ...c, text } : c));
const values = (f: FiraExtraction) => Object.fromEntries(Object.entries(f.fields).map(([k, v]) => [k, v.value]));
const EXPECTED = { firaRef: "SYNTHREF0001", processedDate: "25-08-2026", fcyAmount: 1995, inrAmount: 179955, currency: "USD" };

describe("extractFira: known layouts", () => {
  it.each(["fira-bank-2026", "fira-bank-2026-10"] as FiraLayoutId[])("reads %s with high confidence", async (layout) => {
    const f = await extract(firaCells(layout));
    expect(f.kind).toBe("fira");
    expect(f.layout).toEqual({ id: layout, isNew: false });
    expect(values(f)).toEqual(EXPECTED);
    expect(Object.values(f.fields).map((v) => v.confidence)).toEqual(["high", "high", "high", "high", "high"]);
    expect(f.issues).toEqual([]);
  });

  it("reads the October 2026 reference beside a label wrapped over two lines", async () => {
    const f = await extract(firaCells("fira-bank-2026-10"));
    expect(f.fields.firaRef.source).toBe("label-split-right:Customer Transaction Reference No");
  });
});

describe("extractFira: layout changes it survives", () => {
  it.each([
    ["label:firaRef", "Transaction Reference No."],
    ["label:inrAmount", "Amount in INR"],
    ["label:fcyAmount", "Foreign Currency Amount"],
  ])("a renamed label (%s → %s)", async (role, text) => {
    const f = await extract(relabel(firaCells("fira-bank-2026"), role, text));
    expect(values(f)).toEqual(EXPECTED);
    expect(f.layout.isNew).toBe(true);
    expect(f.issues.map((i) => i.code)).toEqual(["DOC_LAYOUT_NEW"]);
  });

  it("the reference label split across two items on one row", async () => {
    const cells = firaCells("fira-bank-2026").flatMap((c) =>
      c.role === "label:firaRef"
        ? [{ ...c, text: "Customer Transaction Reference" }, { ...c, text: "No", x: c.x + 130 }]
        : [c],
    );
    expect((await extract(cells)).fields.firaRef.value).toBe("SYNTHREF0001");
  });

  it("values below their labels instead of beside them", async () => {
    const cells = firaCells("fira-bank-2026").map((c) => (c.role?.startsWith("value:") ? { ...c, x: 60, y: c.y - 9 } : c));
    expect(values(await extract(cells))).toEqual(EXPECTED);
  });

  it("':' as its own cell and odd case in labels", async () => {
    const cells = firaCells("fira-bank-2026").flatMap((c) =>
      c.role?.startsWith("value:") ? [{ ...c, text: ":" }, { ...c, text: c.text.slice(2), x: c.x + 8 }] : [{ ...c, text: c.role?.startsWith("label:") ? c.text.toUpperCase() : c.text }],
    );
    expect(values(await extract(cells))).toEqual(EXPECTED);
  });

  it("reordered rows", async () => {
    const order = ["inrAmount", "firaRef", "fcyAmount", "currency", "processedDate"];
    const cells = firaCells("fira-bank-2026").map((c) => {
      const field = c.role?.split(":")[1] ?? "";
      const at = order.indexOf(field);
      return at === -1 ? c : { ...c, y: 399 - at * 18 };
    });
    expect(values(await extract(cells))).toEqual(EXPECTED);
  });

  it("only a Value Date: read, but never above medium", async () => {
    const f = await extract(relabel(firaCells("fira-bank-2026"), "label:processedDate", "Value Date"));
    expect(f.fields.processedDate).toMatchObject({ value: "25-08-2026", confidence: "medium" });
  });

  it("a Processed Date wins over a Value Date", async () => {
    const cells = [...firaCells("fira-bank-2026"), { text: "Value Date", x: 300, y: 381 }, { text: ": 26-08-2026", x: 380, y: 381 }];
    expect((await extract(cells)).fields.processedDate.value).toBe("25-08-2026");
  });
});

describe("extractFira: says so when it can't", () => {
  it("a missing reference is null with FIRA_FIELD_UNREADABLE", async () => {
    const f = await extract(firaCells("fira-bank-2026-10").filter((c) => c.role !== "value:firaRef"));
    expect(f.fields.firaRef).toMatchObject({ value: null, confidence: "low", source: "unreadable:Customer Transaction Reference No" });
    expect(f.issues).toContainEqual(expect.objectContaining({ code: "FIRA_FIELD_UNREADABLE", field: "fira.firaRef", severity: "error" }));
    expect((await parseFiraPdf(cellsToPdf(firaCells("fira-bank-2026-10").filter((c) => c.role !== "value:firaRef")))).firaRef).toBe("");
  });

  it("a reference with no label nearby is a low-confidence guess the legacy wrapper won't use", async () => {
    const f = await extract(relabel(firaCells("fira-bank-2026"), "label:firaRef", "Bank Ref"));
    expect(f.fields.firaRef).toMatchObject({ value: "SYNTHREF0001", confidence: "low", source: "pattern:reference" });
    expect((await parseFiraPdf(cellsToPdf(relabel(firaCells("fira-bank-2026"), "label:firaRef", "Bank Ref")))).firaRef).toBe("");
  });

  it("a FIRA in EUR reads EUR, gives FIRA_CURRENCY_UNSUPPORTED and carries EUR into the draft", async () => {
    const f = await extract(firaCells("fira-bank-2026", { ...FAKE_FIRA, currency: "EUR" }));
    expect(f.fields.currency.value).toBe("EUR");
    expect(f.issues).toContainEqual(expect.objectContaining({ code: "FIRA_CURRENCY_UNSUPPORTED", field: "fira.currency", severity: "error" }));
    const deel = await extractDeel(cellsToPdf(deelCells("deel-2026-07")));
    expect(draftFromExtractions(deel, f).fira?.currency).toBe("EUR");
  });

  it("an implausible INR/USD rate gives FIRA_RATE_IMPLAUSIBLE", async () => {
    const f = await extract(firaCells("fira-bank-2026", { ...FAKE_FIRA, inr: "1799.55" }));
    expect(f.issues).toContainEqual(expect.objectContaining({ code: "FIRA_RATE_IMPLAUSIBLE", field: "fira.inrAmount" }));
    expect(f.fields.inrAmount.confidence).toBe("low");
    expect(f.fields.fcyAmount.confidence).toBe("low");
  });

  it("an invalid date is unreadable, not passed on", async () => {
    const f = await extract(firaCells("fira-bank-2026", { ...FAKE_FIRA, date: "32-13-2026" }));
    expect(f.fields.processedDate.value).toBeNull();
    expect(f.issues).toContainEqual(expect.objectContaining({ code: "FIRA_FIELD_UNREADABLE", field: "fira.processedDate" }));
  });

  it("a Deel invoice uploaded as the FIRA is DOC_WRONG_KIND", async () => {
    const f = await extract(deelCells("deel-2026-07"));
    expect(f.kind).toBe("deel-invoice");
    expect(f.issues).toEqual([expect.objectContaining({ code: "DOC_WRONG_KIND", document: "fira" })]);
    expect(f.issues[0].message).toMatch(/Deel contractor invoice/);
  });

  it("a PDF with no text is PDF_NO_TEXT", async () => {
    expect((await extract([])).issues.map((i) => i.code)).toEqual(["PDF_NO_TEXT"]);
  });
});
