import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/generate/route";
import { POST as LOGIN } from "@/app/api/auth/login/route";
import { assertPageCount, assertTextItemCount, TooBusyError, withRenderSlot } from "@/lib/limits";
import { deelLines } from "../helpers/fixtures";
import { linesToPdf } from "../helpers/pdf";
import { generateRequest, stubRouteEnv } from "../helpers/route";

// Server-side limits and input checks added after the pre-release security review.

beforeAll(stubRouteEnv);
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function post(fields: Parameters<typeof generateRequest>[0]) {
  const res = await POST(await generateRequest(fields));
  return { res, body: (await res.json()) as { error: string } };
}

const rawRequest = (headers: Record<string, string>) =>
  new NextRequest("http://localhost/api/generate", { method: "POST", body: "x", headers: { host: "localhost", ...headers } });

describe("upload limits", () => {
  it("413 when the declared upload is over 10 MB", async () => {
    const res = await POST(rawRequest({ "content-length": String(11 * 1024 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("411 when the upload size is missing", async () => {
    const res = await POST(rawRequest({}));
    expect(res.status).toBe(411);
  });

  it("422 for a file that isn't a PDF", async () => {
    const { res, body } = await post({ file: Buffer.from("not a pdf at all") });
    expect(res.status).toBe(422);
    expect(body.error).toMatch(/not a PDF/);
  });

  it("refuses PDFs with far more text than an invoice", () => {
    expect(() => assertTextItemCount(5001, "The FIRA")).toThrow(/far more text/);
    expect(() => assertTextItemCount(400, "The FIRA")).not.toThrow();
  });

  it("refuses PDFs with too many pages", () => {
    expect(() => assertPageCount(11, "The Deel invoice")).toThrow(/at most 10/);
    expect(() => assertPageCount(10, "The Deel invoice")).not.toThrow();
  });
});

describe("manual FIRA entry", () => {
  const deel = () => linesToPdf(deelLines());

  it.each([
    ["a rate with trailing text", { manualFiraRate: "90garbage", manualFiraReceivedUsd: "1995" }, /Exchange rate/],
    ["a negative rate", { manualFiraRate: "-90", manualFiraReceivedUsd: "1995" }, /Exchange rate/],
    ["a negative fee", { manualFiraRate: "90", manualFiraReceivedUsd: "1995", manualFiraBankCharges: "-9000" }, /Fee/],
    ["a rate without the USD received", { manualFiraRate: "90" }, /both/],
    ["more USD received than billed", { manualFiraRate: "90", manualFiraReceivedUsd: "2100" }, /at most \$100 less/],
    ["a fee bigger than the converted amount", { manualFiraRate: "90", manualFiraReceivedUsd: "1995", manualFiraBankCharges: "999999" }, /fee is larger/],
    ["a junk FIRA date", { manualFiraRate: "90", manualFiraReceivedUsd: "1995", manualFiraDate: "junk" }, /real date/],
    ["an impossible FIRA date", { manualFiraRate: "90", manualFiraReceivedUsd: "1995", manualFiraDate: "2026-02-31" }, /real date/],
    ["a pre-GST FIRA date", { manualFiraRate: "90", manualFiraReceivedUsd: "1995", manualFiraDate: "1900-01-01" }, /July 2017/],
  ])("rejects %s", async (_label, fields, message) => {
    const { res, body } = await post({ file: deel(), ...fields });
    expect(res.status).toBe(422);
    expect(body.error).toMatch(message);
  });

  it("checks a blank FIRA date (today) against an old Deel invoice too", async () => {
    const oldInvoice = linesToPdf(deelLines().map((l) => (l === "August 21, 2026" ? "January 15, 2020" : l)));
    const { res, body } = await post({ file: oldInvoice, manualFiraRate: "90", manualFiraReceivedUsd: "1995" });
    expect(res.status).toBe(422);
    expect(body.error).toMatch(/90 days/);
  });
});

describe("error messages", () => {
  it("doesn't echo a malformed config's contents", async () => {
    vi.stubEnv("BUSINESS_CONFIG_JSON", '{"businessProfile":{"pan":ABCDE1234F}}');
    const { res, body } = await post({ file: linesToPdf(deelLines()) });
    stubRouteEnv();
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("ABCDE1234F");
  });
});

describe("render queue", () => {
  it("runs at most two renders at once and refuses when the queue is full", async () => {
    let running = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const job = () =>
      withRenderSlot(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => release.push(resolve));
        running--;
      });
    const jobs = Array.from({ length: 10 }, job);
    await expect(job()).rejects.toBeInstanceOf(TooBusyError);
    while (release.length < 10) {
      await new Promise((r) => setTimeout(r, 0));
      release.splice(0).forEach((r) => r());
      if (release.length === 0 && running === 0) break;
    }
    await Promise.all(jobs.map((p) => p.catch(() => {})));
    expect(peak).toBe(2);
  });
});

describe("render queue hand-off", () => {
  // Release one of two running jobs while a third waits, then start a fourth a few microtasks later.
  // Trying several delays lands at least one inside the window between the release and the waiter resuming.
  it.each([0, 1, 2, 3, 4, 5, 6, 8])("never runs a third job (newcomer after %i microtasks)", async (hops) => {
    let running = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const job = () =>
      withRenderSlot(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => gates.push(resolve));
        running--;
      });
    const jobs = [job(), job(), job()];
    await new Promise((r) => setTimeout(r, 0));
    gates.shift()!();
    for (let i = 0; i < hops; i++) await Promise.resolve();
    jobs.push(job());
    for (let i = 0; i < 20 && (gates.length || running); i++) {
      await new Promise((r) => setTimeout(r, 0));
      gates.splice(0).forEach((g) => g());
    }
    await Promise.all(jobs);
    expect(peak).toBe(2);
  });
});

describe("login throttle", () => {
  it("allows five wrong passwords a minute, even sent in parallel, then refuses the right one", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "correct horse battery staple");
    const attempt = (password: string) =>
      LOGIN(
        new NextRequest("http://localhost/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ password }),
          headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
        }),
      );
    const guesses = await Promise.all(Array.from({ length: 8 }, () => attempt("wrong")));
    expect(guesses.filter((r) => r.status === 401)).toHaveLength(5);
    expect(guesses.filter((r) => r.status === 429)).toHaveLength(3);
    expect((await attempt("correct horse battery staple")).status).toBe(429);
  }, 10_000);
});
