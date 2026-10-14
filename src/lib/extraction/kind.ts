import { issue, type Issue } from "../errors";
import type { DocKind, LayoutMatch } from "./types";
import type { PdfText } from "./text";

/**
 * What a PDF is, and which known layout it follows. Layouts are recognised by the exact labels they print, as
 * they appear in real documents; a document with renamed or missing labels is a new layout, read by the generic
 * strategies, and can't get "high" confidence until its fingerprint is added here.
 */

interface Fingerprint {
  id: string;
  kind: DocKind;
  /** Every one of these labels must be on the page */
  items: string[];
  /** And every one of these must start some text ("Deel Ref.: …") */
  prefixes?: string[];
  /** None of these may be on the page */
  without?: string[];
}

export const FINGERPRINTS: Fingerprint[] = [
  {
    // Deel before its July 2026 relabelling (every real invoice up to the one for July 2026 work)
    id: "deel-2025",
    kind: "deel-invoice",
    items: ["INVOICE", "Invoice #", "INV", "Issue date", "Due date", "BILL FROM", "BILL TO", "TOTAL DUE", "Description", "Amount", "Fixed contract", "Sub total", "VAT", "Total"],
    prefixes: ["Deel Ref.:"],
  },
  {
    // Deel after the July 2026 relabelling: "TOTAL DUE" → "TOTAL", "Sub total" → "Subtotal", "Invoice #" → "Document",
    // "Issue date" / "Due date" → "Issue Date" / "Due Date"
    id: "deel-2026-07",
    kind: "deel-invoice",
    items: ["INVOICE", "Document", "INV", "Issue Date", "Due Date", "BILL FROM", "BILL TO", "TOTAL", "Description", "Amount", "Fixed contract", "Subtotal", "VAT", "Total"],
    prefixes: ["Deel Ref.:"],
  },
  {
    // The bank's FIRA up to September 2026: the reference label is one item
    id: "fira-bank-2026",
    kind: "fira",
    items: ["Customer Transaction Reference No", "Processed Date", "Currency", "FCY Amount", "INR Amount", "Remitter Name", "Purpose of Remittance", "Remitter Address"],
  },
  {
    // From October 2026 the label wraps: "Customer Transaction Reference" / "No", the value centred beside both lines
    id: "fira-bank-2026-10",
    kind: "fira",
    items: ["Customer Transaction Reference", "No", "Processed Date", "Currency", "FCY Amount", "INR Amount", "Remitter Name", "Purpose of Remittance", "Remitter Address"],
    without: ["Customer Transaction Reference No"],
  },
];

/**
 * A label is present when it appears as whole words in one visual row, in the exact case printed, so a layout
 * still matches if pdf.js happens to merge or split neighbouring cells differently.
 */
export function matchLayout(text: PdfText, kind: DocKind): LayoutMatch {
  const rows = text.rows.map((r) => r.items.map((i) => i.str).join(" "));
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const has = (label: string, prefix = false) => {
    const re = new RegExp(`(?:^|\\s)${esc(label)}${prefix ? "" : "(?:\\s|$)"}`);
    return rows.some((r) => re.test(r));
  };
  const hit = FINGERPRINTS.find(
    (f) =>
      f.kind === kind &&
      f.items.every((s) => has(s)) &&
      (f.prefixes ?? []).every((p) => has(p, true)) &&
      !(f.without ?? []).some((s) => has(s)),
  );
  return hit ? { id: hit.id, isNew: false } : { id: kind === "fira" ? "fira-unknown" : kind === "deel-invoice" ? "deel-unknown" : "unknown", isNew: true };
}

/** Plain-language name of each kind, for "This file looks like …" messages. */
export const KIND_NAMES: Record<DocKind, string> = {
  "deel-invoice": "a Deel contractor invoice",
  fira: "a bank FIRA (inward remittance certificate)",
  "gst-invoice": "a GST tax invoice (an export invoice made by this app)",
  "lut-form": "an LUT form (FORM GST RFD-11)",
  unknown: "an unrecognised document",
};

/**
 * Kind from tell-tale text anywhere in the document. Our own GST invoice prints the Deel reference too, so
 * "Deel Ref" alone doesn't make a Deel invoice; GSTIN and "Export of Services" make a GST invoice.
 */
export function detectKind(text: PdfText): DocKind {
  const all = text.items.map((i) => i.str).join("\n");
  const has = (re: RegExp) => re.test(all);
  const gstInvoice = has(/\bGSTIN\b/i) && (has(/export of services/i) || has(/tax\s*invoice/i) || has(/place of supply/i));
  const lut = has(/RFD\s*-?\s*11/i) || has(/^\s*letter of undertaking\s*$/im);
  if (lut && !gstInvoice) return "lut-form";
  if (gstInvoice) return "gst-invoice";

  const firaSignals = [/FCY Amount/i, /INR Amount/i, /Transaction Reference/i, /Inward Remittance/i, /Processed Date/i, /Remitter/i].filter(has).length;
  const deelSignals = [/^BILL TO$/im, /^BILL FROM$/im, /^Deel Ref/im, /^TOTAL(?: DUE)?$/m, /^Sub[\s-]*total$/im, /^INV$|^INV[\s-]?\d{4}/m, /Invoice for work between/i].filter(has).length;
  if (firaSignals >= 2 && firaSignals > deelSignals) return "fira";
  if (deelSignals >= 2) return "deel-invoice";
  if (firaSignals >= 1) return "fira";
  return "unknown";
}

export function wrongKindIssue(kind: DocKind, expected: "deel" | "fira"): Issue {
  const want = expected === "deel" ? "the Deel invoice" : "the FIRA";
  return issue(
    "DOC_WRONG_KIND",
    expected,
    `The file uploaded as ${want} looks like ${KIND_NAMES[kind]}, not ${expected === "deel" ? KIND_NAMES["deel-invoice"] : KIND_NAMES.fira}.`,
    `Upload ${want} PDF in this slot.`,
  );
}

export const noTextIssue = (document: "deel" | "fira") =>
  issue(
    "PDF_NO_TEXT",
    document,
    `The ${document === "deel" ? "Deel invoice" : "FIRA"} PDF has no readable text; it may be a scan or a photo.`,
    `Download the original PDF from ${document === "deel" ? "Deel" : "the bank"} and upload that instead.`,
  );

export const newLayoutIssue = (document: "deel" | "fira") =>
  issue(
    "DOC_LAYOUT_NEW",
    document,
    `This ${document === "deel" ? "Deel invoice" : "FIRA"} uses a layout the app hasn't seen before, so its values were read with general rules.`,
    "Check every value below against the PDF before generating the invoice.",
    { severity: "warning" },
  );
