import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { issue } from "@/lib/errors";
import { linesToPdf } from "../../helpers/pdf";
import { generateRequest, stubRouteEnv } from "../../helpers/route";
import { codes, deelExtraction, draft, firaExtraction } from "./fixtures";

// The engine is developed separately; these tests pin the route's contract around it.
const engine = vi.hoisted(() => ({
  extractDeel: vi.fn(),
  extractFira: vi.fn(),
  draftFromExtractions: vi.fn(),
  layoutSkeleton: vi.fn(),
}));
vi.mock("@/lib/extraction", () => engine);
const blob = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn() }));
vi.mock("@vercel/blob", () => blob);

const { POST } = await import("@/app/api/parse/route");

const pdf = () => linesToPdf(["synthetic"]);

beforeAll(stubRouteEnv);
afterAll(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  engine.extractDeel.mockReset().mockResolvedValue(deelExtraction());
  engine.extractFira.mockReset().mockResolvedValue(firaExtraction());
  engine.draftFromExtractions.mockReset().mockImplementation((_d, f) => draft(f ? {} : { fira: null }));
  engine.layoutSkeleton.mockReset().mockResolvedValue("Customer Transaction Reference | : <ID 12>");
  blob.put.mockReset();
  blob.del.mockReset();
});

async function parse(fields: Parameters<typeof generateRequest>[0]) {
  const res = await POST(await generateRequest(fields));
  return { res, body: await res.json() };
}

describe("POST /api/parse: reads, never writes", () => {
  it("200 with deel, fira, draft and no issues for a clean pair; nothing leaves the machine", async () => {
    // Even with every outside service configured, parsing must not touch them
    vi.stubEnv("AIRTABLE_API_KEY", "fake-token");
    vi.stubEnv("AIRTABLE_BASE_ID", "appFAKE");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "fake-blob-token");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const { res, body } = await parse({ file: pdf(), firaFile: pdf() });
      expect(res.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(["deel", "draft", "fira", "issues", "skeleton"]);
      expect(body.issues).toEqual([]);
      expect(body.skeleton).toBeNull();
      expect(body.deel.layout.id).toBe("deel-2026-07");
      expect(body.draft).toEqual(draft());
      expect(engine.extractFira).toHaveBeenCalledOnce();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(blob.put).not.toHaveBeenCalled();
      expect(blob.del).not.toHaveBeenCalled();
    } finally {
      stubRouteEnv();
    }
  });

  it("works without a FIRA", async () => {
    const { res, body } = await parse({ file: pdf() });
    expect(res.status).toBe(200);
    expect(body.fira).toBeNull();
    expect(engine.extractFira).not.toHaveBeenCalled();
  });

  it("returns parsing problems as issues with 200, engine issues and cross-checks together, errors first", async () => {
    const layoutWarning = issue("DOC_LAYOUT_NEW", "deel", "New Deel layout.", "Check every value below.", { severity: "warning" });
    const unreadable = issue("FIRA_FIELD_UNREADABLE", "fira", "Couldn't read the FIRA's reference number.", "Enter the reference shown on your FIRA in the Reference field.", { field: "fira.firaRef" });
    engine.extractDeel.mockResolvedValue(deelExtraction({ layout: { id: "generic", isNew: true }, issues: [layoutWarning] }));
    engine.extractFira.mockResolvedValue(firaExtraction({ issues: [unreadable] }));
    engine.draftFromExtractions.mockReturnValue(draft({ fira: { firaRef: "", fcyAmount: 2100, inrAmount: 189000 } }));

    const { res, body } = await parse({ file: pdf(), firaFile: pdf() });
    expect(res.status).toBe(200);
    // the engine's unreadable-reference issue and the draft check's are the same issue, reported once
    expect(codes(body.issues)).toEqual(["FIRA_FIELD_UNREADABLE", "FIRA_AMOUNT_MISMATCH", "DOC_LAYOUT_NEW"]);
    expect(body.issues[0]).toMatchObject({ field: "fira.firaRef", action: expect.stringMatching(/Reference field/) });
    expect(body.skeleton).toEqual({ deel: expect.any(String), fira: expect.any(String) });
  });

  it("flags missing supplier settings as an issue, not an error status", async () => {
    vi.stubEnv("BUSINESS_CONFIG_JSON", JSON.stringify({ businessProfile: { legalName: "Test Supplier" } }));
    try {
      const { res, body } = await parse({ file: pdf() });
      expect(res.status).toBe(200);
      expect(codes(body.issues)).toEqual(["CONFIG_INCOMPLETE"]);
    } finally {
      stubRouteEnv();
    }
  });

  it("still answers when the bug-report skeleton fails", async () => {
    engine.layoutSkeleton.mockRejectedValue(new Error("boom"));
    engine.draftFromExtractions.mockReturnValue(draft({ deel: { total: 0 }, fira: null }));
    const { res, body } = await parse({ file: pdf() });
    expect(res.status).toBe(200);
    expect(body.skeleton).toBeNull();
  });
});

describe("POST /api/parse: unusable requests", () => {
  it("422 DOC_WRONG_KIND for the GST invoice this app made, with the action to take", async () => {
    engine.extractDeel.mockResolvedValue(deelExtraction({ kind: "gst-invoice" }));
    const { res, body } = await parse({ file: pdf() });
    expect(res.status).toBe(422);
    expect(body.code).toBe("DOC_WRONG_KIND");
    expect(body.action).toBe("Upload the invoice PDF from Deel (Invoices → Download), not the GST invoice this app made.");
    expect(body.error).toMatch(/GST invoice/);
    expect(engine.draftFromExtractions).not.toHaveBeenCalled();
  });

  it("422 DOC_WRONG_KIND when a Deel invoice is uploaded as the FIRA", async () => {
    engine.extractFira.mockResolvedValue(firaExtraction({ kind: "deel-invoice" }));
    const { res, body } = await parse({ file: pdf(), firaFile: pdf() });
    expect(res.status).toBe(422);
    expect(body.issues[0]).toMatchObject({ code: "DOC_WRONG_KIND", document: "fira" });
  });

  it("422 PDF_NOT_PDF before the engine runs", async () => {
    const { res, body } = await parse({ file: Buffer.from("not a pdf at all") });
    expect(res.status).toBe(422);
    expect(body).toMatchObject({ code: "PDF_NOT_PDF", error: expect.stringMatching(/not a PDF/) });
    expect(engine.extractDeel).not.toHaveBeenCalled();
  });

  it("400 REQUEST_INVALID without a file", async () => {
    const { res, body } = await parse({});
    expect(res.status).toBe(400);
    expect(body.code).toBe("REQUEST_INVALID");
  });

  it("passes the engine's own limits through (too many pages, server busy)", async () => {
    const { IssueError } = await import("@/lib/errors");
    const { TooBusyError } = await import("@/lib/limits");
    engine.extractDeel.mockRejectedValueOnce(new IssueError(issue("PDF_TOO_MANY_PAGES", "deel", "Too many pages.", "Upload the Deel invoice.")));
    expect((await parse({ file: pdf() })).res.status).toBe(422);
    engine.extractDeel.mockRejectedValueOnce(new TooBusyError());
    const busy = await parse({ file: pdf() });
    expect(busy.res.status).toBe(503);
    expect(busy.body.code).toBe("SERVER_BUSY");
  });

  it("500 INTERNAL without echoing the engine's error", async () => {
    engine.extractDeel.mockRejectedValue(new Error("ABCDE1234F leaked"));
    const { res, body } = await parse({ file: pdf() });
    expect(res.status).toBe(500);
    expect(body.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("ABCDE1234F");
  });

  it("keeps the generate guards: size, cross-origin and remote host", async () => {
    const raw = (headers: Record<string, string>) =>
      new NextRequest("http://localhost/api/parse", { method: "POST", body: "x", headers: { host: "localhost", ...headers } });
    expect((await POST(raw({ "content-length": String(11 * 1024 * 1024) }))).status).toBe(413);
    expect((await POST(raw({}))).status).toBe(411);
    expect((await POST(raw({ "content-length": "1", origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(raw({ "content-length": "1", host: "evil.example" }))).status).toBe(403);
  });
});
