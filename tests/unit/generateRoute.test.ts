import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/generate/route";
import { deelLines, firaLines } from "../helpers/fixtures";
import { linesToPdf } from "../helpers/pdf";
import { generateRequest, stubRouteEnv } from "../helpers/route";

// These requests all fail before a PDF is rendered, so no browser is needed.
// The 200 path lives in tests/chromium/generateRoute.chromium.test.ts.

beforeAll(stubRouteEnv);
afterAll(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function post(fields: Parameters<typeof generateRequest>[0]) {
  const res = await POST(await generateRequest(fields));
  return { res, body: (await res.json()) as { error: string } };
}

describe("POST /api/generate: rejects bad input", () => {
  it("400 when no file is uploaded", async () => {
    const { res, body } = await post({});
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/no file/i);
  });

  it("422 for a PDF that is not a Deel invoice", async () => {
    const { res, body } = await post({ file: linesToPdf(["Grocery list", "Milk", "Eggs"]) });
    expect(res.status).toBe(422);
    expect(body.error).toMatch(/could not read the total/i);
  });

  it("422 when the header total and summary total disagree", async () => {
    const { res, body } = await post({ file: linesToPdf(deelLines({ header: ["TOTAL", "USD $2,500.00"] })) });
    expect(res.status).toBe(422);
    expect(body.error).toMatch(/totals disagree/i);
  });

  it("422 for an invoice with VAT", async () => {
    const lines = deelLines({
      header: ["TOTAL", "USD $2,200.00"],
      vat: ["VAT", "10%", "USD $200.00"],
      total: ["Total", "USD $2,200.00"],
    });
    const { res, body } = await post({ file: linesToPdf(lines) });
    expect(res.status).toBe(422);
    expect(body.error).toMatch(/VAT/);
  });

  it("422 when the business profile has no GSTIN", async () => {
    vi.stubEnv("BUSINESS_CONFIG_JSON", JSON.stringify({ businessProfile: { legalName: "Test Supplier" } }));
    try {
      const { res, body } = await post({ file: linesToPdf(deelLines()) });
      expect(res.status).toBe(422);
      expect(body.error).toMatch(/GSTIN/);
    } finally {
      stubRouteEnv();
    }
  });

  it("400 when the FIRA is more than 90 days from the Deel invoice", async () => {
    const { res, body } = await post({
      file: linesToPdf(deelLines()),
      firaFile: linesToPdf(firaLines({ date: "25-01-2026" })),
    });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/mismatch/i);
  });

  it("400 when the FIRA amount is far from the Deel total", async () => {
    const { res, body } = await post({
      file: linesToPdf(deelLines()),
      firaFile: linesToPdf(firaLines({ fcy: "1500.00", inr: "135000.00" })),
    });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/amount mismatch/i);
  });

  it("400 when the FIRA received more than the Deel total", async () => {
    const { res, body } = await post({
      file: linesToPdf(deelLines()),
      firaFile: linesToPdf(firaLines({ fcy: "2100.00", inr: "189000.00" })),
    });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/amount mismatch/i);
  });
});

describe("POST /api/generate: nothing leaves the machine", () => {
  it("does not call fetch for a rejected invoice", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { res } = await post({ file: linesToPdf(deelLines({ sub: ["Subtotal", "USD $0.00"] })) });
    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/generate: unreadable FIRA", () => {
  it("422 naming the FIRA field it couldn't read", async () => {
    const fira = linesToPdf(firaLines().filter((l) => !l.startsWith(": SYNTHREF")));
    const { res, body } = await post({ file: linesToPdf(deelLines()), firaFile: fira });
    expect(res.status).toBe(422);
    expect(body.error).toMatch(/reference number/);
  });
});
