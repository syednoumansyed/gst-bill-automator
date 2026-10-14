import { describe, expect, it } from "vitest";
import { layoutSkeleton } from "@/lib/extraction";
import { maskCell } from "@/lib/extraction/skeleton";
import { cellsToPdf, deelCells, FAKE_DEEL, firaCells, gstInvoiceCells, lutFormCells, type Cell } from "./layouts";

// Every made-up personal or business value in the synthetic documents
const SECRETS = ["Acme", "Research", "Test Supplier", "Test Road", "Main St", "Riyadh", "Delhi", "Saudi Arabia", "India", "DLR7FAKE2Q", "SYNTHREF", "Example Bank", "UI/UX", "29ABCDE1234F1ZW", "EXP-2026", "Monthly payment"];

const docs: [string, Cell[]][] = [
  ["deel-2025", deelCells("deel-2025", { ...FAKE_DEEL, items: [{ description: "Bonus: 2026 CEO Bonus", amount: 1602 }, { description: "Fixed rate: Monthly payment", amount: 2000 }] })],
  ["deel-2026-07", deelCells("deel-2026-07")],
  ["fira-bank-2026", firaCells("fira-bank-2026")],
  ["fira-bank-2026-10", firaCells("fira-bank-2026-10")],
  ["gst-invoice", gstInvoiceCells()],
  ["lut-form", lutFormCells()],
];

describe("layoutSkeleton", () => {
  it.each(docs)("%s: never leaks a run of 4+ digits or any name, address or ID", async (_name, cells) => {
    const sk = await layoutSkeleton(cellsToPdf(cells));
    expect(sk).not.toMatch(/\d{4,}/);
    for (const secret of SECRETS) expect(sk).not.toContain(secret);
  });

  it("keeps labels and replaces values by their shape", async () => {
    const sk = (await layoutSkeleton(cellsToPdf(deelCells("deel-2026-07")))).split("\n");
    expect(sk).toContain("Document | INV | <ID 4> | <ID 1>");
    expect(sk).toContain("Issue Date | <DATE>");
    expect(sk).toContain("BILL FROM | BILL TO | TOTAL");
    expect(sk).toContain("Subtotal | <USD>");
    expect(sk).toContain("VAT | <PCT> | <USD>");
    expect(sk).toContain("Invoice for work between <DATE> to <DATE>");
    expect(sk).toContain("Fixed rate: <TEXT 2> | <USD>");
    expect(sk).toContain("Deel Ref.: <ID 10>");
    expect(sk).toContain("<TEXT 3> | <TEXT 3>"); // supplier and client names
  });

  it("shows the October 2026 FIRA's split label", async () => {
    const sk = (await layoutSkeleton(cellsToPdf(firaCells("fira-bank-2026-10")))).split("\n");
    expect(sk).toContain("Customer Transaction Reference");
    expect(sk).toContain(": <ID 12>");
    expect(sk).toContain("No");
    expect(sk).toContain("FCY Amount | : <AMOUNT>");
    expect(sk).toContain("Processed Date | : <DATE>");
  });

  it("masks text that merely contains a label", () => {
    expect(maskCell("Total Synergy Holdings")).toBe("<TEXT 3>");
    expect(maskCell("Registration number: 4030000000")).toBe("Registration number: <ID 10>");
    expect(maskCell("Bonus: 2026 CEO Bonus")).toBe("Bonus: <TEXT 3>");
    expect(maskCell(": Acme Research LLC")).toBe(": <TEXT 3>");
  });

  it("says so for a PDF without text", async () => {
    expect(await layoutSkeleton(cellsToPdf([]))).toBe("(no text)");
  });
});
