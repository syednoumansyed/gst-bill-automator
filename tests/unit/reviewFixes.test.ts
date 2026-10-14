import { describe, expect, it } from "vitest";
import { invoiceDraftSchema } from "@/lib/draft";
import { isWholeCents } from "@/lib/draftValidation";
import { extractDeel } from "@/lib/extraction";
import { deelLines } from "./../helpers/fixtures";
import { linesToPdf } from "./../helpers/pdf";

// Regressions from the second review of the extraction branch.

describe("currency detection", () => {
  it.each([
    ["SAC", "998392"],
    ["USA", "10001"],
  ])("doesn't take '%s %s' for a foreign amount", async (a, b) => {
    const lines = deelLines();
    const i = lines.indexOf("UI/UX Designer");
    lines.splice(i, 0, a, b);
    const deel = await extractDeel(linesToPdf(lines));
    expect(deel.issues.map((x) => x.code)).not.toContain("DEEL_CURRENCY_UNSUPPORTED");
    expect(deel.fields.currency.value).toBe("USD");
  });

  it("flags any ISO currency, not just common ones", async () => {
    const lines = deelLines();
    lines.splice(lines.indexOf("UI/UX Designer"), 0, "Conversion fee", "TWD 100.00");
    const deel = await extractDeel(linesToPdf(lines));
    expect(deel.issues.map((x) => x.code)).toContain("DEEL_CURRENCY_UNSUPPORTED");
  });

  it("still flags a real foreign amount", async () => {
    const lines = deelLines().map((l) => (l === "USD $2,000.00" ? "EUR 2,000.00" : l));
    const deel = await extractDeel(linesToPdf(lines));
    expect(deel.issues.map((x) => x.code)).toContain("DEEL_CURRENCY_UNSUPPORTED");
  });
});

describe("two-decimal amounts", () => {
  it("accepts large two-decimal amounts exactly", () => {
    expect(isWholeCents(134217728.02)).toBe(true);
    expect(isWholeCents(1500000)).toBe(true);
  });

  it("refuses sub-cent amounts", () => {
    expect(isWholeCents(100.005)).toBe(false);
    expect(isWholeCents(0.001)).toBe(false);
  });

  it("the draft schema agrees", () => {
    const money = invoiceDraftSchema.shape.deel.shape.total;
    expect(money.safeParse(134217728.02).success).toBe(true);
    expect(money.safeParse(100.005).success).toBe(false);
  });
});

describe("draft schema limits", () => {
  const fira = invoiceDraftSchema.shape.fira;
  const base = { firaRef: "R1", processedDate: "2026-09-25", fcyAmount: 1995, inrAmount: 179550 };

  it("refuses absurd amounts so cents stay exact", () => {
    expect(invoiceDraftSchema.shape.deel.shape.total.safeParse(1e308).success).toBe(false);
    expect(invoiceDraftSchema.shape.deel.shape.total.safeParse(999_999_999.99).success).toBe(true);
  });

  it("defaults the currency to USD only for manual entry", () => {
    expect(fira.parse({ source: "manual", ...base })?.currency).toBe("USD");
    expect(fira.parse({ source: "pdf", ...base })?.currency).toBe("");
  });
});
