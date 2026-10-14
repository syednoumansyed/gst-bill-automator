/**
 * Synthetic documents for the extraction engine, placed cell by cell at chosen x/y like the real PDFs.
 * Coordinates copy the masked skeletons of real Deel invoices and bank FIRAs; every value here is made up.
 */

export interface Cell {
  text: string;
  x: number;
  y: number;
  size?: number;
  page?: number;
  /** What the cell is, so a test can rename, move or drop it: "label:total", "value:total", "item:0", … */
  role?: string;
  /**
   * 1 or 2 (Helvetica, Helvetica-Oblique). pdf.js merges neighbouring cells drawn in one font into one text item ("VAT 0%");
   * by default cells alternate fonts so each stays its own item, as in Deel's and the bank's PDFs.
   */
  font?: 1 | 2;
}

/**
 * A PDF with each cell as its own text object at (x, y), in array order (which is the order pdf.js reads them).
 * Standard Helvetica, WinAnsi: Latin-1 text only.
 */
export function cellsToPdf(cells: Cell[]): Buffer {
  const pageCount = Math.max(1, ...cells.map((c) => c.page ?? 1));
  const esc = (s: string) => s.replace(/[\\()]/g, "\\$&");
  const objects: string[] = [];
  const fontId = 3 + pageCount * 2; // and fontId + 1
  const pageIds = Array.from({ length: pageCount }, (_, i) => 3 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  pageIds.forEach((pageId, i) => {
    const content = cells
      .filter((c) => (c.page ?? 1) === i + 1)
      .map((c, n) => `BT /F${c.font ?? (n % 2) + 1} ${c.size ?? 8} Tf ${c.x} ${c.y} Td (${esc(c.text)}) Tj ET`)
      .join("\n");
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${fontId + 1} 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });
  objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[fontId + 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>";
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export const usd = (n: number, currency = "USD") =>
  `${currency} $${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface DeelValues {
  invoiceYear: string;
  invoiceSeq: string;
  issueDate: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  /** Name (possibly wrapped over two lines), address lines, country */
  clientLines: string[];
  supplierLines: string[];
  items: { description: string; amount: number }[];
  /** Printed amounts; default to the sum of the items */
  header?: number;
  summary?: number;
  subtotal?: number;
  vat: number;
  deelRef: string;
}

export const FAKE_DEEL: DeelValues = {
  invoiceYear: "2026",
  invoiceSeq: "9",
  issueDate: "August 21, 2026",
  dueDate: "August 31, 2026",
  periodStart: "August 1, 2026",
  periodEnd: "August 31, 2026",
  clientLines: ["Acme Research LLC", "1 Main St", "Riyadh, 11111", "Saudi Arabia"],
  supplierLines: ["Test Supplier", "1 Test Road", "Delhi, DL 110001", "India"],
  items: [{ description: "Fixed rate: Monthly payment", amount: 2000 }],
  vat: 0,
  deelRef: "DLR7FAKE2Q",
};

export type DeelLayoutId = "deel-2025" | "deel-2026-07";

/** A Deel invoice laid out like the real ones (coordinates from their masked skeletons), in Chrome's stream order. */
export function deelCells(layout: DeelLayoutId, v: DeelValues = FAKE_DEEL): Cell[] {
  const v25 = layout === "deel-2025";
  const sum = v.items.reduce((a, i) => a + i.amount, 0);
  const subtotal = v.subtotal ?? sum;
  const header = v.header ?? subtotal + v.vat;
  const summary = v.summary ?? subtotal + v.vat;
  const bf = 45;
  const bt = v25 ? 173 : 215;
  const cells: Cell[] = [
    { text: "INVOICE", x: 460, y: 767, size: 20 },
    { text: v25 ? "Invoice #" : "Document", x: 384, y: 748, role: "label:invoiceNumber" },
    { text: "INV", x: 509, y: 748, role: "value:invoiceNumber" },
    { text: v.invoiceYear, x: 525, y: 748, role: "value:invoiceNumber" },
    { text: v.invoiceSeq, x: 548, y: 748, role: "value:invoiceNumber" },
    { text: v25 ? "Issue date" : "Issue Date", x: 384, y: 730, role: "label:issueDate" },
    { text: v.issueDate, x: 490, y: 730, role: "value:issueDate" },
    { text: v25 ? "Due date" : "Due Date", x: 384, y: 713, role: "label:dueDate" },
    { text: v.dueDate, x: 490, y: 713, role: "value:dueDate" },
    { text: "BILL FROM", x: bf, y: 664, size: 7, role: "label:billFrom" },
    ...v.supplierLines.map((text, i) => ({ text, x: bf, y: 652 - i * 11, size: 7, role: "value:supplier" })),
    { text: "BILL TO", x: bt, y: 664, size: 7, role: "label:billTo" },
    ...v.clientLines.map((text, i) => ({ text, x: bt, y: 652 - i * 11, size: 7, role: "value:client" })),
    { text: "VAT ID", x: bt, y: 652 - v.clientLines.length * 11 - 4, size: 7, role: "label:vatId" },
    { text: "300000000000003", x: bt + 28, y: 652 - v.clientLines.length * 11 - 4, size: 7, role: "value:vatId" },
    { text: v25 ? "TOTAL DUE" : "TOTAL", x: v25 ? 510 : 527, y: 664, role: "label:header" },
    { text: usd(header), x: 449, y: 645, size: 16, role: "value:header" },
    { text: "UI/UX Designer", x: 42, y: 526, role: "value:role" },
    { text: "Description", x: 51, y: 466, role: "label:table" },
    { text: "Amount", x: 517, y: 466 },
    { text: "Fixed contract", x: 51, y: 446 },
    { text: `Invoice for work between ${v.periodStart} to ${v.periodEnd}`, x: 51, y: 426, role: "value:period" },
  ];
  let y = 406;
  v.items.forEach((item, i) => {
    cells.push({ text: item.description, x: 51, y, role: `item:${i}` });
    cells.push({ text: usd(item.amount), x: 491, y, role: `value:item:${i}` });
    y -= 20;
  });
  cells.push(
    { text: v25 ? "Sub total" : "Subtotal", x: 51, y, role: "label:subtotal" },
    { text: usd(subtotal), x: 491, y, role: "value:subtotal" },
    { text: "VAT", x: 51, y: y - 20, role: "label:vat" },
    { text: `${v.vat > 0 ? 10 : 0}%`, x: 70, y: y - 20, role: "value:vatRate" },
    { text: usd(v.vat), x: 518, y: y - 20, role: "value:vat" },
    { text: "Total", x: 51, y: y - 40, role: "label:summary" },
    { text: usd(summary), x: 489, y: y - 40, role: "value:summary" },
    { text: "Page 1/1", x: 550, y: 33, size: 6 },
    { text: `Deel Ref.: ${v.deelRef}`, x: 481, y: 25, size: 6, role: "value:deelRef" },
  );
  return cells;
}

export interface FiraValues {
  ref: string;
  date: string;
  currency: string;
  fcy: string;
  inr: string;
}

export const FAKE_FIRA: FiraValues = { ref: "SYNTHREF0001", date: "25-08-2026", currency: "USD", fcy: "1995.00", inr: "179955.00" };

export type FiraLayoutId = "fira-bank-2026" | "fira-bank-2026-10";

/** A bank FIRA laid out like the real ones: labels at x 57, ": value" cells to their right. */
export function firaCells(layout: FiraLayoutId, v: FiraValues = FAKE_FIRA): Cell[] {
  const vx = layout === "fira-bank-2026" ? 248 : 195;
  const row = (label: string, value: string, y: number, field: string): Cell[] => [
    { text: label, x: 57, y, role: `label:${field}` },
    { text: `: ${value}`, x: vx, y, role: `value:${field}` },
  ];
  const ref: Cell[] =
    layout === "fira-bank-2026"
      ? row("Customer Transaction Reference No", v.ref, 399, "firaRef")
      : [
          { text: "Customer Transaction Reference", x: 57, y: 410, role: "label:firaRef" },
          { text: "No", x: 57, y: 399, role: "label:firaRef" },
          { text: `: ${v.ref}`, x: vx, y: 404, role: "value:firaRef" },
        ];
  return [
    { text: "FOREIGN INWARD REMITTANCE CERTIFICATE", x: 187, y: 655, size: 12 },
    { text: "Example Bank Limited", x: 55, y: 622 },
    { text: "This is to certify that the remittance below was received for the account of Test Supplier.", x: 55, y: 578 },
    ...ref,
    ...row("Processed Date", v.date, 381, "processedDate"),
    ...row("Currency", v.currency, 362, "currency"),
    ...row("FCY Amount", v.fcy, 344, "fcyAmount"),
    ...row("INR Amount", v.inr, 326, "inrAmount"),
    ...row("Remitter Address", "1 Main St, Riyadh", 308, "remitterAddress"),
    ...row("Remitter Name", "Acme Research LLC", 289, "remitterName"),
    ...row("Purpose of Remittance", "Software services", 253, "purpose"),
    { text: "This is a computer generated certificate and needs no signature.", x: 55, y: 180 },
  ];
}

/** Our own export invoice (what the app generates), uploaded by mistake. */
export function gstInvoiceCells(): Cell[] {
  return [
    { text: "TAX INVOICE", x: 40, y: 784, size: 14 },
    { text: "Test Supplier", x: 40, y: 770 },
    { text: "GSTIN: 29ABCDE1234F1ZW", x: 40, y: 735 },
    { text: "Invoice #", x: 400, y: 688 },
    { text: "EXP-2026-09", x: 450, y: 688 },
    { text: "Bill To", x: 40, y: 640 },
    { text: "Acme Research LLC", x: 40, y: 628 },
    { text: "Place of Supply", x: 40, y: 594 },
    { text: "Outside India (Saudi Arabia)", x: 120, y: 594 },
    { text: "Subtotal", x: 380, y: 406 },
    { text: usd(2000), x: 480, y: 406 },
    { text: "Export of Services under Letter of Undertaking without payment of integrated tax", x: 40, y: 312 },
    { text: "Deel Ref.: DLR7FAKE2Q", x: 40, y: 726, page: 2 },
  ];
}

export function lutFormCells(): Cell[] {
  return [
    { text: "FORM GST RFD-11", x: 220, y: 756, size: 12 },
    { text: "[See rule 96A]", x: 240, y: 738 },
    { text: "Furnishing of Bond or Letter of Undertaking for Export of Goods or Services", x: 80, y: 721 },
    { text: "Test Supplier", x: 80, y: 610 },
    { text: "Letter of Undertaking", x: 220, y: 758, page: 2 },
    { text: "Signature of the authorised signatory", x: 80, y: 147, page: 2 },
  ];
}

/** Small seeded PRNG (mulberry32) so property tests are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}
