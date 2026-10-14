import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { InvoiceDraft } from "@/lib/draft";
import { deelLines, firaLines } from "../../helpers/fixtures";
import { linesToPdf } from "../../helpers/pdf";
import { generateRequest, stubRouteEnv } from "../../helpers/route";
import { codes, draft } from "./fixtures";

// Rendering is stubbed (the real render is covered in tests/chromium); Blob and Airtable are mocked.
const render = vi.hoisted(() => ({ generatePdf: vi.fn() }));
vi.mock("@/lib/generatePdf", () => render);
const blob = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn() }));
vi.mock("@vercel/blob", () => blob);

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

  it("Airtable unreachable: blobs deleted, AIRTABLE_UNREACHABLE", async () => {
    withSync();
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    try {
      const res = await generate(draft());
      expect(res.headers.get("X-Airtable-Sync-Status")).toBe("failed");
      expect(res.headers.get("X-Airtable-Sync-Code")).toBe("AIRTABLE_UNREACHABLE");
      expect(blob.del).toHaveBeenCalledOnce();
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

  it("a failed clean-up is logged by code only and still reports failed", async () => {
    withSync();
    airtableStatus = 401;
    airtableBody = { error: { type: "AUTHENTICATION_REQUIRED", message: "Authentication required" } };
    blob.del.mockRejectedValue(new Error("cannot delete"));
    try {
      const res = await generate(draft());
      expect(res.headers.get("X-Airtable-Sync-Status")).toBe("failed");
      expect(res.headers.get("X-Airtable-Sync-Code")).toBe("AIRTABLE_AUTH");
      const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(" ");
      expect(logged).toContain("BLOB_CLEANUP_FAILED");
      expect(logged).not.toContain("blob.example");
    } finally {
      stubRouteEnv();
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

describe("legacy request without a draft", () => {
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
