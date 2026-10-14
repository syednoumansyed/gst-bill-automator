/**
 * Layout-mutation corpus generator. Starts from the FAKE synthetic Deel (v1/v2) and FIRA line arrays in
 * ./fixtures.ts and produces variants a bank or Deel might plausibly ship tomorrow: renamed labels, labels split
 * over two items, values on the label's row, blank items, case / whitespace changes, reordered blocks, wrapped
 * client names, and one removed value per field.
 *
 * Every variant knows the truth of the document it was derived from, so a test can ask one question of any
 * extractor: did it ever return a wrong value?
 */
import { deelData, deelLines, deelLinesV1, firaData, firaLines, type DeelLayoutOptions } from "./fixtures";
import { itemsToPdf, type PdfItem } from "./pdf";

export type DocType = "deel" | "fira";

export type MutationCategory =
  | "baseline"
  | "rename"
  | "split"
  | "same-row"
  | "blank-items"
  | "case-whitespace"
  | "reorder"
  | "wrapped-name"
  | "removed-value";

export interface Variant {
  /** Unique, readable id, e.g. "deel/rename/header=Amount due,sub=Sub-total" */
  name: string;
  doc: DocType;
  category: MutationCategory;
  lines: string[];
  /** Labels (matched case- and space-insensitively) whose following item is placed on the same row, to the right */
  sameRowLabels?: string[];
  /** Emit the content stream in reverse order while every item keeps its position on the page */
  reverseStream?: boolean;
  /** Truth field names whose value was taken out of the document */
  removed: string[];
  /** true when nothing was taken away: a good extractor should still read the key fields */
  benign: boolean;
}

/** What the unmodified synthetic documents say. Fields not listed here are not asserted on. */
export const DEEL_TRUTH = (() => {
  const d = deelData();
  return {
    invoiceNumber: d.invoiceNumber,
    issueDate: d.issueDate,
    dueDate: d.dueDate,
    periodStart: d.periodStart as string,
    periodEnd: d.periodEnd as string,
    clientName: d.clientName,
    clientCountry: d.clientCountry as string,
    currency: d.currency,
    headerTotal: d.headerTotal as number,
    summaryTotal: d.summaryTotal as number,
    subtotal: d.subtotal,
    vat: d.vat,
    total: d.total,
    deelRef: d.deelRef as string,
  };
})();

export const FIRA_TRUTH = (() => {
  const f = firaData();
  return { firaRef: f.firaRef, processedDate: f.processedDate, fcyAmount: f.fcyAmount, inrAmount: f.inrAmount };
})();

/** Fields a good extractor must still read on a variant that only changed the layout. */
export const DEEL_KEY_FIELDS = ["headerTotal", "subtotal", "total", "issueDate"] as const;
export const FIRA_KEY_FIELDS = ["firaRef", "processedDate", "fcyAmount", "inrAmount"] as const;

// ---------------------------------------------------------------------------------------------------------------
// Rendering

const LEFT = 40;
const RIGHT = 320;
const ROWS_PER_PAGE = 48;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function variantItems(v: Variant): PdfItem[] {
  const sameRow = new Set((v.sameRowLabels ?? []).map(norm));
  const items: PdfItem[] = [];
  let row = 0;
  const place = (text: string, x: number) =>
    items.push({ text, x, y: 800 - (row % ROWS_PER_PAGE) * 16, page: Math.floor(row / ROWS_PER_PAGE) });
  for (let i = 0; i < v.lines.length; i++) {
    const line = v.lines[i];
    place(line, LEFT);
    if (sameRow.has(norm(line)) && i + 1 < v.lines.length) {
      // the value joins the label's row
      place(v.lines[i + 1], RIGHT);
      i++;
    }
    row++;
  }
  return v.reverseStream ? items.reverse() : items;
}

export function renderVariant(v: Variant): Buffer {
  return itemsToPdf(variantItems(v));
}

// ---------------------------------------------------------------------------------------------------------------
// Line-array helpers

function indexOfExact(lines: string[], text: string, occurrence = 0): number {
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === text) {
      if (seen === occurrence) return i;
      seen++;
    }
  }
  throw new Error(`mutations: label not found in synthetic fixture: ${text}`);
}

/** Replaces the nth exact occurrence of `label` with the given items. */
function replaceLabel(lines: string[], label: string, replacement: string[], occurrence = 0): string[] {
  const i = indexOfExact(lines, label, occurrence);
  return [...lines.slice(0, i), ...replacement, ...lines.slice(i + 1)];
}

function removeIndexes(lines: string[], idx: number[]): string[] {
  const drop = new Set(idx);
  return lines.filter((_, i) => !drop.has(i));
}

function mapLabels(lines: string[], labels: string[], fn: (s: string) => string): string[] {
  const set = new Set(labels.map(norm));
  return lines.map((l) => (set.has(norm(l)) ? fn(l) : l));
}

/** Inserts a blank-ish item after every `every`th item. */
function withBlankItems(lines: string[], every: number, blank: string): string[] {
  const out: string[] = [];
  lines.forEach((l, i) => {
    out.push(l);
    if ((i + 1) % every === 0) out.push(blank);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Deel

const DEEL_HEADER_LABELS = ["TOTAL DUE", "TOTAL", "Amount due", "Balance due"] as const;
const DEEL_SUB_LABELS = ["Sub total", "Subtotal", "Sub-total"] as const;
const DEEL_ALL_LABELS = [
  "Issue Date", "Due Date", "BILL FROM", "BILL TO", "Description", "Amount", "VAT", "Total",
  ...DEEL_HEADER_LABELS, ...DEEL_SUB_LABELS,
];
const USD = "USD $2,000.00";

function deelOpts(header: string, sub: string): DeelLayoutOptions {
  return { header: [header, USD], sub: [sub, USD] };
}

/** Labels the value of which belongs on the same row in a side-by-side layout. */
const deelSameRowLabels = (header: string, sub: string) => ["Issue Date", "Due Date", header, sub, "Total", "VAT"];

export function deelVariants(): Variant[] {
  const out: Variant[] = [];
  const add = (v: Omit<Variant, "doc" | "removed" | "benign"> & { removed?: string[]; benign?: boolean }) =>
    out.push({ doc: "deel", removed: [], benign: !(v.removed && v.removed.length), ...v });

  add({ name: "deel/baseline/v2", category: "baseline", lines: deelLines() });
  add({ name: "deel/baseline/v1", category: "baseline", lines: deelLinesV1() });

  // Label synonyms, every header x subtotal combination
  for (const h of DEEL_HEADER_LABELS) {
    for (const s of DEEL_SUB_LABELS) {
      const o = deelOpts(h, s);
      const tag = `header=${h},sub=${s}`;
      add({ name: `deel/rename/${tag}`, category: "rename", lines: deelLines(o) });
      // the same renamed layouts with labels split over two items
      let split = replaceLabel(deelLines(o), h, h.split(/[ ]/).length > 1 ? h.split(" ") : [h]);
      split = replaceLabel(split, s, s.includes(" ") ? s.split(" ") : [s.slice(0, 3), s.slice(3)]);
      add({ name: `deel/split/${tag}`, category: "split", lines: split });
      add({
        name: `deel/same-row/${tag}`,
        category: "same-row",
        lines: deelLines(o),
        sameRowLabels: deelSameRowLabels(h, s),
      });
      add({ name: `deel/blank-items/${tag}`, category: "blank-items", lines: withBlankItems(deelLines(o), 2, " ") });
    }
  }
  // "TOTAL" header whose word "TOTAL" is split from a trailing word, and other split labels
  add({
    name: "deel/split/issue-and-due-date",
    category: "split",
    lines: replaceLabel(replaceLabel(deelLines(), "Issue Date", ["Issue", "Date"]), "Due Date", ["Due", "Date"]),
  });
  add({
    name: "deel/split/bill-to-and-from",
    category: "split",
    lines: replaceLabel(replaceLabel(deelLines(), "BILL TO", ["BILL", "TO"]), "BILL FROM", ["BILL", "FROM"]),
  });
  add({ name: "deel/blank-items/empty-strings", category: "blank-items", lines: withBlankItems(deelLines(), 3, "") });
  add({ name: "deel/blank-items/many-spaces", category: "blank-items", lines: withBlankItems(deelLinesV1(), 1, "   ") });

  // Case and whitespace
  for (const [base, lines] of [["v2", deelLines()], ["v1", deelLinesV1()]] as const) {
    add({ name: `deel/case/${base}/upper`, category: "case-whitespace", lines: mapLabels(lines, DEEL_ALL_LABELS, (s) => s.toUpperCase()) });
    add({ name: `deel/case/${base}/lower`, category: "case-whitespace", lines: mapLabels(lines, DEEL_ALL_LABELS, (s) => s.toLowerCase()) });
    add({ name: `deel/case/${base}/inner-spaces`, category: "case-whitespace", lines: mapLabels(lines, DEEL_ALL_LABELS, (s) => s.replace(/ /g, "   ")) });
    add({ name: `deel/case/${base}/padded`, category: "case-whitespace", lines: mapLabels(lines, DEEL_ALL_LABELS, (s) => `  ${s}  `) });
  }

  // Reordered blocks
  {
    const lines = deelLines();
    const iFrom = indexOfExact(lines, "BILL FROM");
    const iTo = indexOfExact(lines, "BILL TO");
    const iHeader = indexOfExact(lines, "TOTAL");
    const swapped = [...lines.slice(0, iFrom), ...lines.slice(iTo, iHeader), ...lines.slice(iFrom, iTo), ...lines.slice(iHeader)];
    add({ name: "deel/reorder/parties-swapped", category: "reorder", lines: swapped });
    const ref = lines[lines.length - 1];
    add({ name: "deel/reorder/ref-first", category: "reorder", lines: [ref, ...lines.slice(0, -1)] });
    const header = lines.slice(iHeader, iHeader + 2);
    const rest = removeIndexes(lines, [iHeader, iHeader + 1]);
    add({ name: "deel/reorder/header-total-last", category: "reorder", lines: [...rest, ...header] });
    const iSub = indexOfExact(lines, "Subtotal");
    const iRef = lines.length - 1;
    add({
      name: "deel/reorder/summary-block-above-items",
      category: "reorder",
      lines: [...lines.slice(0, indexOfExact(lines, "UI/UX Designer")), ...lines.slice(iSub, iRef), ...lines.slice(indexOfExact(lines, "UI/UX Designer"), iSub), lines[iRef]],
    });
    add({ name: "deel/reorder/stream-reversed", category: "reorder", lines, reverseStream: true });
    add({ name: "deel/reorder/stream-reversed-v1", category: "reorder", lines: deelLinesV1(), reverseStream: true });
  }

  // Wrapped client names
  const billTo = (...rows: string[]) => ({ billTo: ["BILL TO", ...rows] });
  add({
    name: "deel/wrapped-name/two-lines-long",
    category: "wrapped-name",
    lines: deelLines(billTo("Acme Holdings For", "Testing & Research", "1 Main St", "Riyadh, 11111", "Saudi Arabia")),
  });
  add({
    name: "deel/wrapped-name/three-lines",
    category: "wrapped-name",
    lines: deelLines(billTo("Acme Holdings", "For Testing &", "Research", "1 Main St", "Riyadh, 11111", "Saudi Arabia")),
  });
  add({
    name: "deel/wrapped-name/trailing-ampersand-then-address",
    category: "wrapped-name",
    lines: deelLines(billTo("Acme Holdings For Testing &", "Research", "Tower 4, Business Park", "1 Main St", "Riyadh, 11111", "Saudi Arabia")),
  });

  // One removed value per field (on both layouts)
  for (const [base, mk] of [["v2", deelLines], ["v1", deelLinesV1]] as const) {
    const L = mk();
    const after = (label: string, occurrence = 0) => indexOfExact(L, label, occurrence) + 1;
    const rm = (field: string, name: string, lines: string[], extra: string[] = []) =>
      add({ name: `deel/removed/${base}/${name}`, category: "removed-value", lines, removed: [field, ...extra] });
    const headerLabel = base === "v2" ? "TOTAL" : "TOTAL DUE";
    const subLabel = base === "v2" ? "Subtotal" : "Sub total";

    rm("issueDate", "issueDate", removeIndexes(L, [after("Issue Date")]));
    rm("dueDate", "dueDate", removeIndexes(L, [after("Due Date")]));
    rm("invoiceNumber", "invoiceNumber", removeIndexes(L, [indexOfExact(L, "INV"), indexOfExact(L, "INV") + 1, indexOfExact(L, "INV") + 2]));
    const period = "Invoice for work between August 1, 2026 to August 31, 2026";
    rm("periodStart", "periodStart", replaceLabel(L, period, ["Invoice for work between to August 31, 2026"]));
    rm("periodEnd", "periodEnd", replaceLabel(L, period, ["Invoice for work between August 1, 2026 to"]));
    rm("clientName", "clientName", removeIndexes(L, [indexOfExact(L, "Acme Holdings For Testing &"), indexOfExact(L, "Research")]));
    rm("clientCountry", "clientCountry", removeIndexes(L, [indexOfExact(L, "Saudi Arabia")]));
    rm("headerTotal", "headerTotal", removeIndexes(L, [after(headerLabel)]));
    rm("subtotal", "subtotal", removeIndexes(L, [after(subLabel)]));
    rm("vat", "vat", removeIndexes(L, [after("VAT", 0) + 1]));
    rm("summaryTotal", "total-row", removeIndexes(L, [after("Total")]), ["total"]);
    rm("deelRef", "deelRef", replaceLabel(L, "Deel Ref.: SYNTHETIC", ["Deel Ref.:"]));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// FIRA

const FIRA_REF_LABELS = ["Customer Transaction Reference No", "Customer Transaction Reference", "Transaction Reference No"] as const;
const FIRA_DATE_LABELS = ["Processed Date", "Value Date"] as const;
const FIRA_ALL_LABELS = ["FOREIGN INWARD REMITTANCE CERTIFICATE", "FCY Amount", "INR Amount", ...FIRA_REF_LABELS, ...FIRA_DATE_LABELS];

/** The base FIRA with the reference and date labels swapped for synonyms. */
function firaWith(refLabel: string, dateLabel: string, o: Parameters<typeof firaLines>[0] = {}): string[] {
  let l = firaLines(o);
  l = replaceLabel(l, "Customer Transaction Reference No", [refLabel]);
  l = replaceLabel(l, "Processed Date", [dateLabel]);
  return l;
}

export function firaVariants(): Variant[] {
  const out: Variant[] = [];
  const add = (v: Omit<Variant, "doc" | "removed" | "benign"> & { removed?: string[] }) =>
    out.push({ doc: "fira", removed: [], benign: !(v.removed && v.removed.length), ...v });
  const sameRow = (r: string, d: string) => [r, d, "FCY Amount", "INR Amount"];

  add({ name: "fira/baseline", category: "baseline", lines: firaLines() });

  for (const r of FIRA_REF_LABELS) {
    for (const d of FIRA_DATE_LABELS) {
      const tag = `ref=${r},date=${d}`;
      add({ name: `fira/rename/${tag}`, category: "rename", lines: firaWith(r, d) });
      add({ name: `fira/same-row/${tag}`, category: "same-row", lines: firaWith(r, d), sameRowLabels: sameRow(r, d) });
      add({ name: `fira/blank-items/${tag}`, category: "blank-items", lines: withBlankItems(firaWith(r, d), 2, " ") });
    }
  }

  // The October 2026 break and its relatives
  const base = firaLines();
  add({ name: "fira/split/ref-two-items", category: "split", lines: replaceLabel(base, "Customer Transaction Reference No", ["Customer Transaction Reference", "No"]) });
  add({ name: "fira/split/ref-three-items", category: "split", lines: replaceLabel(base, "Customer Transaction Reference No", ["Customer", "Transaction Reference", "No"]) });
  add({ name: "fira/split/ref-two-items-same-row", category: "split", lines: replaceLabel(base, "Customer Transaction Reference No", ["Customer Transaction Reference", "No"]), sameRowLabels: ["Processed Date", "FCY Amount", "INR Amount"] });
  add({ name: "fira/split/amount-labels", category: "split", lines: replaceLabel(replaceLabel(base, "FCY Amount", ["FCY", "Amount"]), "INR Amount", ["INR", "Amount"]) });
  add({ name: "fira/split/processed-date", category: "split", lines: replaceLabel(base, "Processed Date", ["Processed", "Date"]) });
  add({ name: "fira/split/all-labels-wrapped", category: "split", lines: replaceLabel(replaceLabel(replaceLabel(base, "Customer Transaction Reference No", ["Customer Transaction Reference", "No"]), "Processed Date", ["Processed", "Date"]), "FCY Amount", ["FCY", "Amount"]) });

  add({ name: "fira/blank-items/empty-strings", category: "blank-items", lines: withBlankItems(base, 1, "") });

  add({ name: "fira/case/upper", category: "case-whitespace", lines: mapLabels(base, FIRA_ALL_LABELS, (s) => s.toUpperCase()) });
  add({ name: "fira/case/lower", category: "case-whitespace", lines: mapLabels(base, FIRA_ALL_LABELS, (s) => s.toLowerCase()) });
  add({ name: "fira/case/inner-spaces", category: "case-whitespace", lines: mapLabels(base, FIRA_ALL_LABELS, (s) => s.replace(/ /g, "   ")) });
  add({ name: "fira/case/padded", category: "case-whitespace", lines: mapLabels(base, FIRA_ALL_LABELS, (s) => `  ${s}  `) });
  add({ name: "fira/case/colon-spacing", category: "case-whitespace", lines: base.map((l) => (l.startsWith(": ") ? `:${l.slice(2)}` : l)) });

  // Reordered blocks: amounts above the identifiers; certificate title last
  {
    const [title, ...pairs] = base;
    const [refL, refV, dateL, dateV, fcyL, fcyV, inrL, inrV] = pairs;
    add({ name: "fira/reorder/amounts-first", category: "reorder", lines: [title, fcyL, fcyV, inrL, inrV, refL, refV, dateL, dateV] });
    add({ name: "fira/reorder/date-before-ref", category: "reorder", lines: [title, dateL, dateV, refL, refV, fcyL, fcyV, inrL, inrV] });
    add({ name: "fira/reorder/inr-before-fcy", category: "reorder", lines: [title, refL, refV, dateL, dateV, inrL, inrV, fcyL, fcyV] });
    add({ name: "fira/reorder/stream-reversed", category: "reorder", lines: base, reverseStream: true });
  }

  // One removed value per field (and on the October layout)
  const oct = replaceLabel(base, "Customer Transaction Reference No", ["Customer Transaction Reference", "No"]);
  for (const [tag, L] of [["standard", base], ["split-ref", oct]] as const) {
    const val = (label: string) => indexOfExact(L, label) + 1;
    const refLabel = tag === "standard" ? "Customer Transaction Reference No" : "No";
    const rm = (field: string, labelForValue: string) =>
      add({ name: `fira/removed/${tag}/${field}`, category: "removed-value", lines: removeIndexes(L, [val(labelForValue)]), removed: [field] });
    rm("firaRef", refLabel);
    rm("processedDate", "Processed Date");
    rm("fcyAmount", "FCY Amount");
    rm("inrAmount", "INR Amount");
  }
  return out;
}

export function allVariants(): Variant[] {
  return [...deelVariants(), ...firaVariants()];
}

// ---------------------------------------------------------------------------------------------------------------
// Judging results (names only; the data here is synthetic, but the same code shape is reused for real files)

export type Truth = Record<string, string | number>;

export function truthFor(doc: DocType): Truth {
  return doc === "deel" ? DEEL_TRUTH : FIRA_TRUTH;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 0.005;
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return a === b;
}

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "" || v === 0;
}

export interface EngineLike {
  fields: Record<string, { value: unknown; confidence: string } | undefined>;
  issues: { code: string; field?: string }[];
}

/**
 * The "never wrong" property for an engine result. Returns one message per violated field; empty means it holds.
 *  - a non-null value must equal the truth, whatever its confidence;
 *  - a null value (or a missing field) must come with the UNREADABLE issue for that exact field path.
 */
export function neverWrongViolations(doc: DocType, res: EngineLike): string[] {
  const code = doc === "deel" ? "DEEL_FIELD_UNREADABLE" : "FIRA_FIELD_UNREADABLE";
  const bad: string[] = [];
  for (const [name, truth] of Object.entries(truthFor(doc))) {
    const f = res.fields[name];
    const value = f?.value ?? null;
    if (value !== null) {
      if (!sameValue(value, truth)) bad.push(`${doc}.${name}: wrong ${f?.confidence ?? "?"}-confidence value`);
    } else if (!res.issues.some((i) => i.code === code && i.field === `${doc}.${name}`)) {
      bad.push(`${doc}.${name}: null without a ${code} issue`);
    }
  }
  return bad;
}

/** Key fields a good extractor must read on a layout-only variant. Returns the field names it missed. */
export function missedKeyFields(doc: DocType, res: EngineLike): string[] {
  const truth = truthFor(doc);
  const keys = doc === "deel" ? DEEL_KEY_FIELDS : FIRA_KEY_FIELDS;
  return keys.filter((k) => !sameValue(res.fields[k]?.value ?? null, truth[k]));
}

/** Legacy parser result vs truth: "ok", or the names of fields that are WRONG (non-empty and different) or EMPTY. */
export function legacyOutcome(doc: DocType, parsed: Record<string, unknown>, removed: string[]): string {
  const wrong: string[] = [];
  const empty: string[] = [];
  for (const [name, truth] of Object.entries(truthFor(doc))) {
    const v = parsed[name];
    if (sameValue(v, truth)) continue;
    if (removed.includes(name) || (name === "total" && removed.includes("summaryTotal"))) {
      if (!isEmptyValue(v)) wrong.push(name);
      continue; // an empty value where the document has none is expected
    }
    (isEmptyValue(v) ? empty : wrong).push(name);
  }
  if (!wrong.length && !empty.length) return "ok";
  return [wrong.length ? `WRONG(${wrong.join(",")})` : "", empty.length ? `empty(${empty.join(",")})` : ""].filter(Boolean).join(" ");
}

/** Engine result vs truth, for the report table. */
export function engineOutcome(doc: DocType, res: EngineLike): string {
  const bad = neverWrongViolations(doc, res);
  const wrong = bad.filter((b) => b.includes(": wrong")).map((b) => b.split(":")[0].replace(`${doc}.`, ""));
  const silent = bad.filter((b) => b.includes("null without")).map((b) => b.split(":")[0].replace(`${doc}.`, ""));
  if (wrong.length || silent.length) {
    return [wrong.length ? `WRONG(${wrong.join(",")})` : "", silent.length ? `SILENT-NULL(${silent.join(",")})` : ""].filter(Boolean).join(" ");
  }
  const flagged = Object.keys(truthFor(doc)).filter((k) => res.fields[k]?.value == null);
  return flagged.length ? `ok, flagged(${flagged.join(",")})` : "ok";
}
