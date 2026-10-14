import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InvoiceDraft } from "@/lib/draft";
import { deelLines, fakeConfigJson, firaLines } from "../../helpers/fixtures";
import { linesToPdf } from "../../helpers/pdf";
import { generateRequest, stubRouteEnv } from "../../helpers/route";
import { codes, draft } from "./fixtures";

// Rendering is stubbed (the real render is covered in tests/chromium); Blob and Airtable are mocked.
const render = vi.hoisted(() => ({ generatePdf: vi.fn() }));
vi.mock("@/lib/generatePdf", () => render);
const blob = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn() }));
vi.mock("@vercel/blob", () => blob);

// Lets a test inject a fault after the render and before the sync
const fault = vi.hoisted(() => ({ beforeSync: false }));
vi.mock("@/lib/invoiceResponse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/invoiceResponse")>();
  return {
    ...actual,
    buildInvoiceResponse: (...args: Parameters<typeof actual.buildInvoiceResponse>) => {
      if (fault.beforeSync) throw new Error("injected fault");
      return actual.buildInvoiceResponse(...args);
    },
  };
});

const { POST } = await import("@/app/api/generate/route");

const FAKE_PDF = Buffer.from("%PDF-1.4 fake gst invoice");
const deelPdf = () => linesToPdf(deelLines());
const firaPdf = () => linesToPdf(firaLines());

let fetchSpy: MockInstance<typeof fetch>;
let airtableStatus = 200;
let airtableBody: unknown = { records: [{ id: "recFAKE" }] };

beforeAll(stubRouteEnv);
afterAll(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.restoreAllMocks();
  for (const level of ["error", "warn", "info"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  render.generatePdf.mockReset().mockResolvedValue(FAKE_PDF);
  fault.beforeSync = false;
  let n = 0;
  blob.put.mockReset().mockImplementation(async (name: string) => ({ url: `https://blob.example/${n++}-${name}` }));
  blob.del.mockReset().mockResolvedValue(undefined);
  airtableStatus = 200;
  airtableBody = { records: [{ id: "recFAKE" }] };
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(JSON.stringify(airtableBody), { status: airtableStatus }));
});

function withSync(blobToken = true) {
  vi.stubEnv("AIRTABLE_API_KEY", "fake-token");
  vi.stubEnv("AIRTABLE_BASE_ID", "appFAKE");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", blobToken ? "fake-blob-token" : "");
}

async function generate(d: InvoiceDraft | string | undefined, files: { file?: Buffer; firaFile?: Buffer } = { file: deelPdf(), firaFile: firaPdf() }) {
  return POST(await generateRequest({ ...files, draft: typeof d === "string" || d === undefined ? d : JSON.stringify(d) }));
}

const airtableFields = (call = 0) => JSON.parse(String(fetchSpy.mock.calls[call][1]?.body)).records[0].fields;

describe("POST /api/generate with a review draft", () => {
  it("issues the invoice from the draft, recording the edits and source documents", async () => {
    withSync();
    try {
      const edited = draft({ deel: { clientName: "Acme Corrected Name" }, edited: ["deel.clientName"] });
      const res = await generate(edited);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("X-Airtable-Sync-Status")).toBe("success");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(FAKE_PDF);

      const invoice = render.generatePdf.mock.calls[0][0];
      expect(invoice.client.clientName).toBe("Acme Corrected Name");
      expect(invoice.currency).toBe("INR");
      expect(invoice.grandTotal).toBe(179955);
      expect(invoice.complianceMetadata.review).toMatchObject({
        mode: "review",
        edited: ["deel.clientName"],
        sources: { deel: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }, fira: { source: "pdf", sha256: expect.any(String) } },
      });

      // Render, then uploads, then Airtable
      expect(render.generatePdf.mock.invocationCallOrder[0]).toBeLessThan(blob.put.mock.invocationCallOrder[0]);
      expect(Math.max(...blob.put.mock.invocationCallOrder)).toBeLessThan(fetchSpy.mock.invocationCallOrder[0]);
      expect(blob.put).toHaveBeenCalledTimes(3);
      const fields = airtableFields();
      expect(fields["Deel Invoice Number"]).toBe("INV-2026-9");
      expect(fields["Client"]).toBe("Acme Corrected Name");
      expect(fields["GST Invoice PDF"]).toEqual([{ url: expect.stringContaining("gst-INV-2026-08") }]);
      expect(JSON.parse(fields["Compliance Metadata"]).review.edited).toEqual(["deel.clientName"]);
      expect(blob.del).not.toHaveBeenCalled();
    } finally {
      stubRouteEnv();
    }
  });

  it("422 DRAFT_INVALID with field paths when the draft doesn't match the schema", async () => {
    const bad = draft() as unknown as { deel: Record<string, unknown> };
    bad.deel.total = "lots";
    bad.deel.invoiceNumber = "";
    const res = await generate(bad as unknown as InvoiceDraft);
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.code).toBe("DRAFT_INVALID");
    expect(body.issues.map((i: { field: string }) => i.field).sort()).toEqual(["deel.invoiceNumber", "deel.total"]);
    expect(render.generatePdf).not.toHaveBeenCalled();
  });

  it("422 DRAFT_INVALID for a draft that isn't JSON", async () => {
    const res = await generate("{not json");
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("DRAFT_INVALID");
  });

  it("re-runs every cross-check: an edited draft that doesn't reconcile is refused with all its issues", async () => {
    withSync();
    try {
      const res = await generate(
        draft({ deel: { subtotal: 2500, total: 2500 }, fira: { processedDate: "25-01-2026" }, edited: ["deel.subtotal", "deel.total"] }),
      );
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(codes(body.issues)).toEqual(["DEEL_ITEMS_DONT_SUM", "FIRA_DATE_MISMATCH", "FIRA_AMOUNT_MISMATCH"]);
      expect(body).toMatchObject({ error: body.issues[0].message, code: "DEEL_ITEMS_DONT_SUM", action: body.issues[0].action });
      expect(render.generatePdf).not.toHaveBeenCalled();
      expect(blob.put).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      stubRouteEnv();
    }
  });

  it("needs the FIRA PDF when the draft's FIRA came from one, and doesn't attach an unused one", async () => {
    const missing = await generate(draft(), { file: deelPdf() });
    expect(missing.status).toBe(400);
    expect((await missing.json()).issues[0]).toMatchObject({ code: "REQUEST_INVALID", document: "fira" });

    withSync();
    try {
      const res = await generate(draft({ fira: null }));
      expect(res.status).toBe(200);
      expect(blob.put).toHaveBeenCalledTimes(2);
      expect(airtableFields()["FIRA PDF"]).toBeUndefined();
    } finally {
      stubRouteEnv();
    }
  });

  it("passes LUT warnings through in X-Invoice-Warnings", async () => {
    const res = await generate(draft({ deel: { issueDate: "2020-01-15" }, fira: null }));
    expect(res.status).toBe(200);
    const warnings = JSON.parse(decodeURIComponent(res.headers.get("X-Invoice-Warnings") ?? "[]"));
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("sync never leaves a partial entry", () => {
  it("Airtable failure: the uploaded blobs are deleted, status failed with a code, and the PDF is still returned", async () => {
    withSync();
    airtableStatus = 422;
    airtableBody = { error: { type: "INVALID_VALUE_FOR_COLUMN", message: "Field Date cannot accept this value" } };
    try {
      const res = await generate(draft());
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(FAKE_PDF);
      expect(res.headers.get("X-Airtable-Sync-Status")).toBe("failed");
      expect(res.headers.get("X-Airtable-Sync-Code")).toBe("AIRTABLE_REJECTED");
      expect(decodeURIComponent(res.headers.get("X-Airtable-Sync-Message")!)).toMatch(/Airtable sync failed/);
      const uploaded = await Promise.all(blob.put.mock.results.map((r) => r.value));
      expect(blob.del).toHaveBeenCalledOnce();
      expect([...blob.del.mock.calls[0][0]].sort()).toEqual(uploaded.map((u: { url: string }) => u.url).sort());
    } finally {
      stubRouteEnv();
    }
  });

  it("no answer from Airtable: the uploads are KEPT and the user is told to check Airtable (AIRTABLE_UNCERTAIN)", async () => {
    withSync();
    fetchSpy.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    try {
      const res = await generate(draft());
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Airtable-Sync-Status")).toBe("failed");
      expect(res.headers.get("X-Airtable-Sync-Code")).toBe("AIRTABLE_UNCERTAIN");
      expect(decodeURIComponent(res.headers.get("X-Airtable-Sync-Message")!)).toMatch(/check whether .* row is there/i);
      expect(blob.del).not.toHaveBeenCalled();
      // the write, then the follow-up query that couldn't confirm it either
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      stubRouteEnv();
    }
  });

  it("no answer, but the follow-up query finds this run's row: success", async () => {
    withSync();
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed")).mockImplementationOnce(async (input) => {
      expect(String(input)).toContain("filterByFormula");
      const generatedAt = (render.generatePdf.mock.calls[0][0] as { complianceMetadata: { generatedAt: string } }).complianceMetadata.generatedAt;
      const urls = await Promise.all(blob.put.mock.results.map((r) => r.value as Promise<{ url: string }>));
      const gstUrl = urls.map((u) => u.url).find((u) => u.includes("/") && u.split("/").pop()!.includes("gst-"))!;
      const gstPdf = [{ filename: gstUrl.split("/").pop() }];
      return new Response(JSON.stringify({ records: [{ fields: { "Generated At": generatedAt, "GST Invoice PDF": gstPdf } }] }), { status: 200 });
    });
    try {
      const res = await generate(draft());
      expect(res.headers.get("X-Airtable-Sync-Status")).toBe("success");
      expect(blob.del).not.toHaveBeenCalled();
    } finally {
      stubRouteEnv();
    }
  });

  it("a row with the same timestamp but another run's PDF doesn't count: still unsure, uploads kept", async () => {
    withSync();
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed")).mockImplementationOnce(async () => {
      const generatedAt = (render.generatePdf.mock.calls[0][0] as { complianceMetadata: { generatedAt: string } }).complianceMetadata.generatedAt;
      const otherRun = [{ filename: "gst-INV-2026-08-OTHERRUN.pdf" }];
      return new Response(JSON.stringify({ records: [{ fields: { "Generated At": generatedAt, "GST Invoice PDF": otherRun } }] }), { status: 200 });
    });
    try {
      const res = await generate(draft());
      expect(res.headers.get("X-Airtable-Sync-Code")).toBe("AIRTABLE_UNCERTAIN");
      expect(blob.del).not.toHaveBeenCalled();
    } finally {
      stubRouteEnv();
    }
  });

  it("a 4xx with an unreadable body is still a definite rejection: uploads deleted", async () => {
    withSync();
    fetchSpy.mockResolvedValue(new Response("<html>bad request", { status: 400 }));
    try {
      const res = await generate(draft());
      expect(res.headers.get("X-Airtable-Sync-Code")).toBe("AIRTABLE_REJECTED");
      expect(blob.del).toHaveBeenCalledOnce();
    } finally {
      stubRouteEnv();
    }
  });

  it("a 5xx doesn't prove nothing was saved: Airtable is checked, and the uploads are kept while unsure", async () => {
    withSync();
    fetchSpy.mockResolvedValue(new Response("<html>bad gateway", { status: 502 }));
    try {
      const res = await generate(draft());
      expect(res.headers.get("X-Airtable-Sync-Code")).toBe("AIRTABLE_UNCERTAIN");
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1); // the write, then the check
      expect(blob.del).not.toHaveBeenCalled();
    } finally {
      stubRouteEnv();
    }
  });

  it("Blob failure: Airtable is not written, the uploads that worked are deleted, status failed", async () => {
    withSync();
    blob.put.mockImplementation(async (name: string) => {
      if (name.startsWith("fira-")) throw new Error("blob store down");
      return { url: `https://blob.example/${name}` };
    });
    try {
      const res = await generate(draft());
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Airtable-Sync-Status")).toBe("failed");
      expect(res.headers.get("X-Airtable-Sync-Code")).toBe("BLOB_UPLOAD_FAILED");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect([...blob.del.mock.calls[0][0]].sort()).toEqual([
        "https://blob.example/deel-INV-2026-9.pdf",
        "https://blob.example/gst-INV-2026-08.pdf",
      ]);
    } finally {
      stubRouteEnv();
    }
  });

  it("a failed clean-up with read-only config: BLOB_CLEANUP_FAILED, recorded in GST_DATA_DIR, logged by code and pathname", async () => {
    withSync();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gst-data-"));
    vi.stubEnv("GST_DATA_DIR", dataDir);
    airtableStatus = 401;
    airtableBody = { error: { type: "AUTHENTICATION_REQUIRED", message: "Authentication required" } };
    blob.del.mockRejectedValue(new Error("cannot delete"));
    try {
      const res = await generate(draft());
      expect(res.headers.get("X-Airtable-Sync-Status")).toBe("failed");
      expect(res.headers.get("X-Airtable-Sync-Code")).toBe("BLOB_CLEANUP_FAILED");
      const message = decodeURIComponent(res.headers.get("X-Airtable-Sync-Message")!);
      expect(message).toMatch(/rejected the token/);
      expect(fs.statSync(path.join(dataDir, "pending-blob-cleanup.json")).mode & 0o777).toBe(0o600);
      const errors = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(" ");
      expect(errors).toContain("BLOB_CLEANUP_FAILED");
      expect(errors).toContain("/0-deel-INV-2026-9.pdf");
      expect(errors).not.toContain("blob.example");
      const infos = (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(" ");
      expect(infos).not.toMatch(/removed/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      stubRouteEnv();
    }
  });

  it("a failed clean-up is recorded (mode 600) and finished at the start of the next sync", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gst-sync-"));
    const configFile = path.join(dir, "business.json");
    const pendingFile = path.join(dir, "pending-blob-cleanup.json");
    fs.writeFileSync(configFile, fakeConfigJson());
    withSync();
    vi.stubEnv("BUSINESS_CONFIG_JSON", "");
    vi.stubEnv("BUSINESS_CONFIG_PATH", configFile);
    airtableStatus = 422;
    airtableBody = { error: { type: "INVALID_VALUE_FOR_COLUMN", message: "bad value" } };
    blob.del.mockRejectedValueOnce(new Error("cannot delete"));
    try {
      const first = await generate(draft());
      expect(first.headers.get("X-Airtable-Sync-Code")).toBe("BLOB_CLEANUP_FAILED");
      expect(decodeURIComponent(first.headers.get("X-Airtable-Sync-Message")!)).toMatch(/next sync/);
      const uploaded = (await Promise.all(blob.put.mock.results.map((r) => r.value))).map((u: { url: string }) => u.url);
      expect(fs.statSync(pendingFile).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(pendingFile, "utf8")).blobs.map((b: { url: string }) => b.url).sort()).toEqual([...uploaded].sort());

      // Next sync: the recorded blobs are deleted first, and the record is cleared
      airtableStatus = 200;
      airtableBody = { records: [{ id: "recFAKE" }] };
      const second = await generate(draft());
      expect(second.headers.get("X-Airtable-Sync-Status")).toBe("success");
      expect([...blob.del.mock.calls[1][0]].sort()).toEqual([...uploaded].sort());
      expect(fs.existsSync(pendingFile)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      stubRouteEnv();
      vi.stubEnv("BUSINESS_CONFIG_PATH", "");
    }
  });

  it("retries without the compliance fields when the table lacks them, like before", async () => {
    withSync();
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "UNKNOWN_FIELD_NAME", message: 'Unknown field name: "Compliance Key"' } }), { status: 422 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    try {
      const res = await generate(draft());
      expect(res.headers.get("X-Airtable-Sync-Status")).toBe("success");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(airtableFields(1)["Compliance Key"]).toBeUndefined();
      expect(airtableFields(1)["Deel PDF"]).toBeDefined();
      expect(blob.del).not.toHaveBeenCalled();
    } finally {
      stubRouteEnv();
    }
  });

  it("without a Blob token the row is written without attachments, as before", async () => {
    withSync(false);
    try {
      const res = await generate(draft());
      expect(res.headers.get("X-Airtable-Sync-Status")).toBe("success");
      expect(blob.put).not.toHaveBeenCalled();
      expect(airtableFields()["Deel PDF"]).toBeUndefined();
    } finally {
      stubRouteEnv();
    }
  });

  it("share mode never syncs", async () => {
    withSync();
    vi.stubEnv("SHARE_MODE", "1");
    try {
      const res = await generate(draft());
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Airtable-Sync-Status")).toBe("skipped");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(blob.put).not.toHaveBeenCalled();
    } finally {
      stubRouteEnv();
    }
  });

  it("a render failure uploads and writes nothing", async () => {
    withSync();
    render.generatePdf.mockRejectedValue(new Error("chromium crashed"));
    try {
      const res = await generate(draft());
      expect(res.status).toBe(500);
      expect((await res.json()).code).toBe("INTERNAL");
      expect(blob.put).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      stubRouteEnv();
    }
  });
});

describe("what is printed is what was reviewed", () => {
  it("whole cents: 100.01 + 100.00 = 200.01 issues with exactly those figures; 100.005 twice is DRAFT_INVALID", async () => {
    const ok = await generate(
      draft({
        deel: { lineItems: [{ description: "Fixed rate: x", amount: 100.01 }, { description: "Bonus: y", amount: 100 }], subtotal: 200.01, total: 200.01 },
        fira: null,
      }),
    );
    expect(ok.status).toBe(200);
    const invoice = render.generatePdf.mock.calls[0][0];
    expect(invoice.lineItems.map((l: { amount: number }) => l.amount)).toEqual([100.01, 100]);
    expect(invoice.grandTotal).toBe(200.01);

    const bad = await generate(
      draft({
        deel: { lineItems: [{ description: "a", amount: 100.005 }, { description: "b", amount: 100.005 }], subtotal: 200.01, total: 200.01 },
        fira: null,
      }),
    );
    const body = await bad.json();
    expect(bad.status).toBe(422);
    expect(body.code).toBe("DRAFT_INVALID");
    expect(render.generatePdf).toHaveBeenCalledOnce();
  });

  it("splits the FIRA's INR across lines in whole paise, the residual on the largest line", async () => {
    const res = await generate(
      draft({
        deel: {
          lineItems: [
            { description: "Fixed rate: x", amount: 1000 },
            { description: "Bonus: y", amount: 1000 },
            { description: "Other: z", amount: 1000 },
          ],
          subtotal: 3000,
          total: 3000,
        },
        fira: { fcyAmount: 2999.99, inrAmount: 270000.01 },
      }),
    );
    expect(res.status).toBe(200);
    const amounts: number[] = render.generatePdf.mock.calls[0][0].lineItems.map((l: { amount: number }) => l.amount);
    expect(amounts).toEqual([90000.01, 90000, 90000]);
    for (const a of amounts) expect(Math.round(a * 100) / 100).toBe(a);
  });

  it("the reviewed client is authoritative: saved client data never fills a blank", async () => {
    const config = JSON.parse(fakeConfigJson());
    config.clientProfile = { clientName: "Alpha Saved Client", clientAddress: "9 Alpha Road", country: "Alphaland", vatId: "ALPHA-VAT-1" };
    vi.stubEnv("BUSINESS_CONFIG_JSON", JSON.stringify(config));
    try {
      const res = await generate(
        draft({ deel: { clientName: "Beta Reviewed Client", clientAddress: "", clientCountry: "", clientVatId: "", clientRegistrationNumber: "" }, fira: null }),
      );
      expect(res.status).toBe(200);
      const invoice = render.generatePdf.mock.calls[0][0];
      expect(invoice.client).toEqual({ clientName: "Beta Reviewed Client", clientAddress: "", country: "", vatId: "", registrationNumber: "" });
      expect(JSON.stringify(invoice)).not.toMatch(/Alpha/);
    } finally {
      stubRouteEnv();
    }
  });

  it("an invoice-number override with CR/LF is refused by the schema, in both flows", async () => {
    const res = await generate(draft({ options: { overrideInvoiceNumber: "INV\r\nX-Evil: 1" } }));
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.issues[0]).toMatchObject({ code: "DRAFT_INVALID", field: "options.overrideInvoiceNumber" });

    const legacy = await POST(await generateRequest({ file: deelPdf(), overrideInvoiceNumber: "INV\r\nX-Evil: 1" }));
    expect(legacy.status).toBe(422);
    expect((await legacy.json()).code).toBe("DRAFT_INVALID");
    expect(render.generatePdf).not.toHaveBeenCalled();
  });

  it("a slash in the invoice number never reaches the filename", async () => {
    const res = await generate(draft({ options: { overrideInvoiceNumber: "INV/2026/08" } }));
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="INV-2026-08-GST.pdf"');
  });

  it("a fault after the render but before the sync writes nothing", async () => {
    withSync();
    fault.beforeSync = true;
    try {
      const res = await generate(draft());
      expect(res.status).toBe(500);
      expect(render.generatePdf).toHaveBeenCalledOnce();
      expect(blob.put).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      stubRouteEnv();
    }
  });
});

describe("legacy request without a draft", () => {
  it("surfaces the currency problem of a non-USD Deel invoice", async () => {
    const res = await POST(await generateRequest({ file: linesToPdf(deelLines({ total: ["Total", "EUR $2,000.00"] })) }));
    expect(res.status).toBe(422);
    expect(codes((await res.json()).issues)).toContain("DEEL_CURRENCY_UNSUPPORTED");
  });

  it("fills blank client fields from the saved client once, in the adapter", async () => {
    const config = JSON.parse(fakeConfigJson());
    config.clientProfile = { clientName: "Alpha Saved Client", clientAddress: "9 Alpha Road", country: "Alphaland", vatId: "ALPHA-VAT-1" };
    vi.stubEnv("BUSINESS_CONFIG_JSON", JSON.stringify(config));
    try {
      const res = await POST(await generateRequest({ file: deelPdf() }));
      expect(res.status).toBe(200);
      const client = render.generatePdf.mock.calls[0][0].client;
      expect(client.clientName).toBe("Acme Holdings For Testing & Research");
      expect(client.vatId).toBe("ALPHA-VAT-1");
    } finally {
      stubRouteEnv();
    }
  });

  it("parses inline, goes through the same draft checks and records mode legacy", async () => {
    withSync();
    try {
      const res = await POST(await generateRequest({ file: deelPdf(), firaFile: firaPdf() }));
      expect(res.status).toBe(200);
      const invoice = render.generatePdf.mock.calls[0][0];
      expect(invoice.complianceMetadata.review).toMatchObject({ mode: "legacy", edited: [] });
      expect(invoice.complianceMetadata.deel.role).toBe("UI/UX Designer");
      expect(invoice.firaData.bankChargesUsd).toBe(5);
      expect(airtableFields()["FIRA Reference"]).toBe("SYNTHREF0001");
    } finally {
      stubRouteEnv();
    }
  });

  it("refuses an implausible manual exchange rate it used to accept", async () => {
    const res = await POST(await generateRequest({ file: deelPdf(), manualFiraRate: "9", manualFiraReceivedUsd: "1995" }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("FIRA_RATE_IMPLAUSIBLE");
  });

  it("answers every refusal with code and action", async () => {
    const res = await POST(await generateRequest({ file: deelPdf(), manualFiraRate: "90garbage", manualFiraReceivedUsd: "1995" }));
    expect(await res.json()).toMatchObject({
      error: "Exchange rate must be a positive number.",
      code: "MANUAL_FIRA_INVALID",
      action: expect.stringMatching(/plain number/),
      issues: [expect.objectContaining({ document: "fira" })],
    });
  });
});
