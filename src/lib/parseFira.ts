import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { assertPageCount, assertTextItemCount, withParseSlot } from "./limits";
import { FiraParsedData } from "./types";

/**
 * Extract text from a FIRA PDF buffer using Mozilla PDF.js.
 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  return withParseSlot(() => readPdfText(buffer));
}

async function readPdfText(buffer: Buffer): Promise<string> {
  const uint8 = new Uint8Array(buffer);
  const loadingTask = getDocument({ data: uint8 });
  const doc = await loadingTask.promise;
  try {
    assertPageCount(doc.numPages, "The FIRA");
    let fullText = "";
    let itemCount = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      itemCount += content.items.length;
      assertTextItemCount(itemCount, "The FIRA");
      const strings: string[] = [];
      for (const item of content.items) {
        if ("str" in item && typeof item.str === "string") {
          strings.push(item.str);
        }
      }
      fullText += strings.join("\n") + "\n";
    }
    return fullText;
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Parse a FIRA (Bank Inward Remittance Certificate) PDF.
 */
export async function parseFiraPdf(buffer: Buffer): Promise<FiraParsedData> {
  const text = await extractPdfText(buffer);
  
  // Normalize invisible characters and split by lines
  const lines = text
    .split("\n")
    .map((l) => l.replace(/[\u00A0\u200B\u2009\u2003]/g, " ").trim())
    .filter((l) => l.length > 0);

  const data: FiraParsedData = {
    fcyAmount: 0,
    inrAmount: 0,
    firaRef: "",
    processedDate: "",
  };

  // The lines array usually has key-value pairs formatted like:
  // "Customer Transaction Reference No"
  // ": 2VIQDKJUUPELY1KHGBFH"
  // "Processed Date"
  // ": 05-02-2026"
  // "FCY Amount"
  // ": 1995.00"
  // "INR Amount"
  // ": 180174.04"

  // The value is the next ": …" line. Since Oct 2026 the bank wraps "Customer Transaction Reference No"
  // so "No" arrives as its own line before the value; skip it.
  const valueAfter = (i: number): string => {
    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      if (/^No\.?$/i.test(lines[j])) continue;
      return lines[j].startsWith(":") ? lines[j].replace(/^:/, "").trim() : "";
    }
    return "";
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    if (/Transaction Reference( No\.?)?$/i.test(l)) {
      const val = valueAfter(i);
      if (val) data.firaRef = val;
    }
    else if (l.includes("Processed Date")) {
      const val = valueAfter(i);
      if (val) data.processedDate = val;
    }
    else if (l.includes("FCY Amount")) {
      const val = valueAfter(i);
      if (val) data.fcyAmount = parseFloat(val.replace(/,/g, ""));
    }
    else if (l.includes("INR Amount")) {
      const val = valueAfter(i);
      if (val) data.inrAmount = parseFloat(val.replace(/,/g, ""));
    }
  }

  // Fallbacks if structured exactly inline (e.g., "FCY Amount: 1995.00")
  if (!data.fcyAmount) {
    const fcyLine = lines.find((l) => /FCY Amount.*?:?\s*([\d,]+\.?\d*)/i.test(l));
    if (fcyLine) {
      const m = fcyLine.match(/FCY Amount.*?:?\s*([\d,]+\.?\d*)/i);
      if (m) data.fcyAmount = parseFloat(m[1].replace(/,/g, ""));
    }
  }
  if (!data.inrAmount) {
    const inrLine = lines.find((l) => /INR Amount.*?:?\s*([\d,]+\.?\d*)/i.test(l));
    if (inrLine) {
      const m = inrLine.match(/INR Amount.*?:?\s*([\d,]+\.?\d*)/i);
      if (m) data.inrAmount = parseFloat(m[1].replace(/,/g, ""));
    }
  }
  if (!data.processedDate) {
    const dateLine = lines.find((l) => /Processed Date.*?:?\s*([\d-]+)/i.test(l));
    if (dateLine) {
      const m = dateLine.match(/Processed Date.*?:?\s*([\d-]+)/i);
      if (m) data.processedDate = m[1];
    }
  }

  return data;
}
