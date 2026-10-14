import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { assertPageCount, assertTextItemCount, withParseSlot } from "../limits";

/**
 * Positional text model: every pdf.js text item with where it sits on the page, grouped into visual rows.
 * Strategies read values to the right of or below a label from this, so a layout change that only moves
 * things around (or renders them in a different order) doesn't change what is read.
 */

export interface TextItem {
  /** Normalised text: one space between words, no NBSP, zero-width or Private Use Area icon characters */
  str: string;
  /** Left edge and baseline in PDF points (y grows upwards, as pdf.js reports it) */
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
  /** Position in the content stream, i.e. the order pdf.js read it */
  seq: number;
}

export interface Row {
  page: number;
  y: number;
  /** Left to right */
  items: TextItem[];
}

export interface PdfText {
  pageCount: number;
  /** Content-stream order, empty items dropped */
  items: TextItem[];
  /** Top to bottom, page by page */
  rows: Row[];
}

/** Deel uses a building icon from the Private Use Area; NBSP and thin spaces come from its HTML renderer. */
export function normaliseText(s: string): string {
  return s
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[-]/g, " ")
    .replace(/[\s  -   　]+/g, " ")
    .trim();
}

/** Two items are on one visual row when their baselines are this close (a fraction of the taller line). */
const ROW_TOLERANCE = 0.45;

export function groupRows(items: TextItem[]): Row[] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const rows: Row[] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    const tol = Math.max(2, ROW_TOLERANCE * Math.max(item.h, row?.items[0].h ?? 0));
    if (row && row.page === item.page && Math.abs(row.y - item.y) <= tol) row.items.push(item);
    else rows.push({ page: item.page, y: item.y, items: [item] });
  }
  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  return rows;
}

/**
 * Reads every text item of a PDF with its position. Goes through the parse queue and the page and text-item
 * limits, and always releases the pdf.js document.
 */
export function readPdfText(buffer: Buffer, label: string): Promise<PdfText> {
  return withParseSlot(() => loadPdfText(buffer, label));
}

async function loadPdfText(buffer: Buffer, label: string): Promise<PdfText> {
  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  try {
    const doc = await loadingTask.promise;
    assertPageCount(doc.numPages, label);
    const items: TextItem[] = [];
    let itemCount = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      itemCount += content.items.length;
      assertTextItemCount(itemCount, label);
      for (const raw of content.items) {
        if (!("str" in raw) || typeof raw.str !== "string") continue; // marked-content markers
        const str = normaliseText(raw.str);
        if (!str) continue;
        const [, , , d, e, f] = raw.transform as number[];
        items.push({ str, x: e, y: f, w: raw.width, h: raw.height || Math.abs(d) || 10, page: p, seq: items.length });
      }
    }
    return { pageCount: doc.numPages, items, rows: groupRows(items) };
  } finally {
    await loadingTask.destroy();
  }
}

/** The sequential view the original parsers worked on: one line per text item, in content-stream order. */
export function sequentialLines(text: PdfText): string[] {
  return text.items.map((i) => i.str);
}
