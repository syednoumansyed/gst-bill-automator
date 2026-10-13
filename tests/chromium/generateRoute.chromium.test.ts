import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/generate/route";
import { parseDeelInvoice } from "@/lib/parseDeelInvoice";
import { validateDeelData } from "@/lib/validateInvoice";
import { deelLines, deelLinesV1, firaLines, MULTI_ITEM } from "../helpers/fixtures";
import { chromeLinesToPdf, linesToPdf, pdfText } from "../helpers/pdf";
import { generateRequest, stubRouteEnv } from "../helpers/route";

beforeAll(stubRouteEnv);
afterAll(() => vi.unstubAllEnvs());

describe("POST /api/generate: valid input", () => {
  it("200 application/pdf for a v2 Deel invoice, with no outside sync", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(await generateRequest({ file: linesToPdf(deelLines()) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("INV-2026-08-GST.pdf");
    expect(res.headers.get("X-Airtable-Sync-Status")).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();

    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pdfText(pdf)).toContain("USD 2,000.00");
  });

  it("200 for a v1 invoice with a FIRA, billed in INR with a bank charge", async () => {
    const res = await POST(
      await generateRequest({ file: linesToPdf(deelLinesV1()), firaFile: linesToPdf(firaLines()) }),
    );
    expect(res.status).toBe(200);
    const text = await pdfText(Buffer.from(await res.arrayBuffer()));
    expect(text).toContain("INR 179,955.00");
    expect(text).toContain("USD 5.00");
  });

  it("200 for a multi-item invoice with a zero row and FIRA, lines summing to the INR total", async () => {
    const res = await POST(
      await generateRequest({
        file: linesToPdf(deelLines(MULTI_ITEM)),
        firaFile: linesToPdf(firaLines({ fcy: "3597.00", inr: "329713.33" })),
      }),
    );
    expect(res.status).toBe(200);
    expect(await pdfText(Buffer.from(await res.arrayBuffer()))).toContain("INR 329,713.33");
  });

  it("200 with a manual FIRA rate instead of a FIRA PDF", async () => {
    const res = await POST(
      await generateRequest({ file: linesToPdf(deelLines()), manualFiraRate: "90", manualFiraReceivedUsd: "1995" }),
    );
    expect(res.status).toBe(200);
    expect(await pdfText(Buffer.from(await res.arrayBuffer()))).toContain("INR 179,550.00");
  });
});

describe("Deel PDFs made by Chrome", () => {
  // Same layouts as the unit tests, but rendered by a real browser, as Deel's own PDFs are.
  it.each([
    ["v1", deelLinesV1()],
    ["v2", deelLines()],
    ["multi-item", deelLines(MULTI_ITEM)],
  ])("%s parses and validates", async (_name, lines) => {
    const parsed = await parseDeelInvoice(await chromeLinesToPdf(lines));
    expect(() => validateDeelData(parsed)).not.toThrow();
    expect(parsed.total).toBe(parsed.subtotal);
    expect(parsed.clientName).toBe("Acme Holdings For Testing & Research");
  });
});
