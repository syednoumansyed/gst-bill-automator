import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Builds a tiny text PDF, one text object per line, with no browser involved.
 * pdfjs hands each line back as its own text item, which is how the parsers read Deel and FIRA files.
 * ASCII only (standard Helvetica); use `chromeLinesToPdf` for anything else.
 */
export function linesToPdf(lines: string[]): Buffer {
  const perPage = 48;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (pages.length === 0) pages.push([]);

  const esc = (s: string) => s.replace(/[\\()]/g, "\\$&");
  const objects: string[] = [];
  const fontId = 3 + pages.length * 2;
  const pageIds = pages.map((_, i) => 3 + i * 2);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  pages.forEach((pageLines, i) => {
    const pageId = pageIds[i];
    const content = pageLines.map((l, n) => `BT /F1 11 Tf 40 ${800 - n * 16} Td (${esc(l)}) Tj ET`).join("\n");
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  });
  objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** All text of a PDF, one text item per line (the same view the parsers get). */
export async function pdfTextLines(buffer: Buffer): Promise<string[]> {
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    for (const item of content.items) if ("str" in item && item.str.trim()) out.push(item.str.trim());
  }
  return out;
}

/** The whole PDF text as one string (items joined by a space, so wrapped cells stay searchable). */
export async function pdfText(buffer: Buffer): Promise<string> {
  return (await pdfTextLines(buffer)).join(" ");
}

const cacheDir = path.join(os.tmpdir(), "gst-bill-automator-test-pdfs");

/**
 * Renders lines to a PDF with Puppeteer (one <div> per line), cached on disk by content hash.
 * Used by the chromium project to prove the parsers also read Chrome-made PDFs.
 */
export async function chromeLinesToPdf(lines: string[]): Promise<Buffer> {
  const key = createHash("sha1").update(JSON.stringify(lines)).digest("hex");
  const file = path.join(cacheDir, `${key}.pdf`);
  try {
    return fs.readFileSync(file);
  } catch {
    // not cached yet
  }
  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    await page.setContent(
      `<html><body style="font:12px sans-serif">${lines.map((l) => `<div style="margin:6px 0">${esc(l)}</div>`).join("")}</body></html>`,
    );
    const pdf = Buffer.from(await page.pdf({ format: "A4" }));
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, pdf);
    return pdf;
  } finally {
    await browser.close();
  }
}
