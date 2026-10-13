import { describe, expect, it } from "vitest";
import { parseFiraPdf } from "@/lib/parseFira";
import { firaLines } from "../helpers/fixtures";
import { linesToPdf } from "../helpers/pdf";

describe("parseFiraPdf", () => {
  it("reads reference, date and amounts from label / ': value' pairs", async () => {
    const f = await parseFiraPdf(linesToPdf(firaLines()));
    expect(f).toEqual({ fcyAmount: 1995, inrAmount: 179955, firaRef: "SYNTHREF0001", processedDate: "25-08-2026" });
  });

  it("strips thousands separators", async () => {
    const f = await parseFiraPdf(linesToPdf(firaLines({ fcy: "5,995.00", inr: "539,990.00" })));
    expect(f.fcyAmount).toBe(5995);
    expect(f.inrAmount).toBe(539990);
  });

  it("falls back to inline 'Label: value' lines", async () => {
    const f = await parseFiraPdf(
      linesToPdf(["FCY Amount: 1995.00", "INR Amount: 179955.00", "Processed Date: 25-08-2026"]),
    );
    expect(f.fcyAmount).toBe(1995);
    expect(f.inrAmount).toBe(179955);
    expect(f.processedDate).toBe("25-08-2026");
  });

  it("returns zeros for a PDF that is not a FIRA", async () => {
    const f = await parseFiraPdf(linesToPdf(["Hello", "World"]));
    expect(f.fcyAmount).toBe(0);
    expect(f.inrAmount).toBe(0);
    expect(f.firaRef).toBe("");
  });
});
