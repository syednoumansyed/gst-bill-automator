import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateInvoiceData } from "@/lib/generateInvoiceData";
import { generatePdf } from "@/lib/generatePdf";
import { deelData, fakeConfig, firaData, FAKE_ACCOUNT, FAKE_GSTIN, FAKE_PAN } from "../helpers/fixtures";
import { pdfText } from "../helpers/pdf";

/** A local server that records every request; the invoice must never reach it. */
let canary: http.Server;
let hits: string[] = [];
let origin = "";

beforeAll(async () => {
  canary = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html></html>");
  });
  await new Promise<void>((resolve) => canary.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(canary.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => canary.close(resolve));
});

describe("generatePdf: injected markup", () => {
  it("control: the canary does see a request from an unprotected page", async () => {
    // Proves the canary is reachable from Chrome, so "0 hits" below means something.
    hits = [];
    const { default: puppeteer } = await import("puppeteer");
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(`<img src="${origin}/control">`, { waitUntil: "load" });
    } finally {
      await browser.close();
    }
    expect(hits).toContain("GET /control");
  });

  it("makes no network request for HTML in the invoice number and notes", async () => {
    hits = [];
    const attack = (tag: string) =>
      `</title></div><img src="${origin}/img-${tag}"><script>fetch("${origin}/fetch-${tag}")</script>` +
      `<iframe src="${origin}/iframe-${tag}"></iframe><link rel="stylesheet" href="${origin}/css-${tag}">` +
      `<style>body{background:url(${origin}/bg-${tag})}</style>`;
    const invoice = generateInvoiceData(deelData(), fakeConfig(), {
      overrideInvoiceNumber: attack("number"),
      notes: attack("notes"),
    });
    const pdf = await generatePdf(invoice);
    // give a straggling request time to land before counting
    await new Promise((r) => setTimeout(r, 500));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(hits).toEqual([]);
  });

  it("shows the injected markup as plain text instead of rendering it", async () => {
    const invoice = generateInvoiceData(deelData(), fakeConfig(), {
      overrideInvoiceNumber: "INV-<b>BOLD</b>",
      notes: `<script>alert(1)</script>`,
    });
    const text = await pdfText(await generatePdf(invoice));
    expect(text).toContain("INV-<b>BOLD</b>");
    expect(text).toContain("<script>alert(1)</script>");
  });
});

describe("generatePdf: content", () => {
  it("prints the rupee sign and the right totals for a FIRA invoice", async () => {
    const invoice = generateInvoiceData(deelData(), fakeConfig(), { firaData: firaData({ fcyAmount: 1995, inrAmount: 179955 }) });
    const text = await pdfText(await generatePdf(invoice));
    expect(text).toContain("₹");
    expect(text).toContain("INR 179,955.00");
    expect(text).toContain("USD 2,000.00");
    expect(text).toContain("USD 1,995.00");
    expect(text).toContain("USD 5.00"); // bank charges
    expect(text).toContain("SYNTHREF0001");
    expect(text).toContain("1 USD = ₹ 90.203");
  });

  it("prints USD totals and the supplier identity for a non-FIRA invoice", async () => {
    const invoice = generateInvoiceData(deelData(), fakeConfig());
    const text = await pdfText(await generatePdf(invoice));
    expect(text).toContain("USD 2,000.00");
    expect(text).toContain("Total Due");
    expect(text).toContain(FAKE_GSTIN);
    expect(text).toContain(FAKE_PAN);
    expect(text).toContain(FAKE_ACCOUNT);
    expect(text).toContain("Rule 96A");
  });
});
