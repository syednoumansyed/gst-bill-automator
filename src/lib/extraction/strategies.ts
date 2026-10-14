import { fieldsForLabel, isKnownLabel, LABELS, type LabelField, type Synonym } from "./labels";
import { stripColon } from "./shapes";
import type { PdfText, TextItem } from "./text";

/**
 * Generic, layout-independent strategies: find a field's label (whole, split over items or rows, or as the start of
 * an item), then read the value to its right on the same row, or below it within the label's x window.
 */

/** Where a label (or any cell a value is read next to) sits on the page. */
export interface Anchor {
  items: TextItem[];
  page: number;
  x0: number;
  x1: number;
  /** Lowest and highest baseline the anchor covers (two for a label wrapped over two lines) */
  yMin: number;
  yMax: number;
  h: number;
  /** Content-stream position of the first item */
  seq: number;
  /** Split over several text items, e.g. "Customer Transaction Reference" + "No" */
  split: boolean;
  /** "Deel Ref.: ABC123": the value printed in the same item, after the label */
  inlineValue?: string;
}

export interface LabelHit extends Anchor {
  field: LabelField;
  synonym: Synonym;
  /** As printed, items joined with a space */
  text: string;
}

/** A possible value for a field and where it came from. */
export interface Candidate<T> {
  value: T;
  /** e.g. "label-right:TOTAL", "label-below:Processed Date", "pattern:usd", "sequential" */
  source: string;
  kind: "label" | "pattern" | "sequential";
  weak?: boolean;
}

export interface ValueText {
  text: string;
  items: TextItem[];
  how: "right" | "below" | "inline";
}

const MAX_SPAN = 3;
/** Items further apart than this on one row are separate cells, not one label or value */
const MAX_WORD_GAP = 14;

const right = (i: TextItem) => i.x + i.w;
const joinText = (items: TextItem[]) => items.map((i) => i.str).join(" ");

export function anchorOf(items: TextItem[], inlineValue?: string): Anchor {
  return {
    items,
    page: items[0].page,
    x0: Math.min(...items.map((i) => i.x)),
    x1: Math.max(...items.map(right)),
    yMin: Math.min(...items.map((i) => i.y)),
    yMax: Math.max(...items.map((i) => i.y)),
    h: Math.max(...items.map((i) => i.h)),
    seq: Math.min(...items.map((i) => i.seq)),
    split: items.length > 1,
    ...(inlineValue !== undefined ? { inlineValue } : {}),
  };
}

function hitFrom(field: LabelField, synonym: Synonym, items: TextItem[], inlineValue?: string): LabelHit {
  return { ...anchorOf(items, inlineValue), field, synonym, text: joinText(items) };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inlinePatterns = new Map<string, RegExp>();
/** "Label: value" or "Label value" in one item; the label part is matched like a whole label (any case and spacing). */
function inlinePattern(synonym: Synonym): RegExp {
  let re = inlinePatterns.get(synonym.text);
  if (!re) {
    const words = synonym.text.replace(/[.:#]+$/, "").trim().split(/[\s-]+/).map(escapeRe);
    re = new RegExp(`^${words.join("[\\s-]*")}\\.?(?:\\s*(?:No\\.?|#))?\\s*(?::\\s*|\\s+)(.+)$`, "i");
    inlinePatterns.set(synonym.text, re);
  }
  return re;
}

/**
 * Every place a label of one of `fields` appears. Tries each item, runs of up to three neighbouring items on a row,
 * an item joined with the one right below it (a label the PDF wrapped), and "Label: value" items.
 * Where hits overlap, the longest label wins, so "Customer Transaction Reference" + "No" is one label.
 */
export function findLabels(text: PdfText, fields: LabelField[]): LabelHit[] {
  const wanted = new Set(fields);
  const hits: LabelHit[] = [];
  const consider = (items: TextItem[]) => {
    for (const { field, synonym } of fieldsForLabel(joinText(items))) if (wanted.has(field)) hits.push(hitFrom(field, synonym, items));
  };

  for (const row of text.rows) {
    for (let i = 0; i < row.items.length; i++) {
      const span: TextItem[] = [];
      for (let j = i; j < row.items.length && j < i + MAX_SPAN; j++) {
        if (span.length > 0 && row.items[j].x - right(span[span.length - 1]) > MAX_WORD_GAP) break;
        span.push(row.items[j]);
        consider([...span]);
      }
    }
  }

  // A label wrapped onto the next line or two ("Customer" / "Transaction Reference" / "No"): each lower part
  // starts at the same x, within about a line and a half of the part above
  const below = (a: TextItem) =>
    text.items.filter(
      (b) => b !== a && b.page === a.page && b.y < a.y - 1 && Math.abs(b.x - a.x) <= 4 && a.y - b.y <= 1.6 * Math.max(a.h, b.h),
    );
  for (const a of text.items) {
    for (const b of below(a)) {
      consider([a, b]);
      for (const c of below(b)) consider([a, b, c]);
    }
  }

  for (const item of text.items) {
    for (const field of fields) {
      for (const synonym of LABELS[field]) {
        const m = item.str.match(inlinePattern(synonym));
        if (m && m[1].trim()) hits.push(hitFrom(field, synonym, [item], stripColon(m[1]).trim()));
      }
    }
  }

  // Longest label first; drop a hit that shares an item with a longer one (an inline hit only yields to another inline hit)
  hits.sort((a, b) => b.text.length - a.text.length || a.seq - b.seq);
  const kept: LabelHit[] = [];
  for (const hit of hits) {
    const inline = hit.inlineValue !== undefined;
    const overlaps = kept.some(
      (k) => (k.inlineValue !== undefined) === inline && k.items.some((i) => hit.items.includes(i)),
    );
    if (!overlaps) kept.push(hit);
  }
  return kept.sort((a, b) => a.page - b.page || b.yMax - a.yMax || a.x0 - b.x0);
}

/** Joins a value's first item with the cells right after it on the same line ("INV" "2026" "9"). */
function joinRightwards(start: TextItem, sameLine: TextItem[]): TextItem[] {
  const out = [start];
  const rest = sameLine.filter((i) => i !== start && i.x > start.x && Math.abs(i.y - start.y) <= 2).sort((a, b) => a.x - b.x);
  for (const next of rest) {
    if (next.x - right(out[out.length - 1]) > MAX_WORD_GAP || isKnownLabel(next.str)) break;
    out.push(next);
  }
  return out;
}

const isSeparator = (i: TextItem) => stripColon(i.str) === "";

export interface ReadOptions {
  /** Cells to step over before the value, e.g. the VAT rate "0%" between "VAT" and its amount */
  skip?: (text: string) => boolean;
}

/** Strategy (a): the first cell to the right of the label, on the label's line(s). A ":" cell is stepped over. */
export function readRight(text: PdfText, hit: Anchor, opts: ReadOptions = {}): ValueText | null {
  const tol = 0.75 * hit.h;
  const onLine = text.items.filter(
    (i) => i.page === hit.page && !hit.items.includes(i) && i.y >= hit.yMin - tol && i.y <= hit.yMax + tol,
  );
  const toRight = onLine.filter((i) => i.x >= hit.x1 - 1).sort((a, b) => a.x - b.x || b.y - a.y);
  for (const item of toRight) {
    if (isSeparator(item) || opts.skip?.(stripColon(item.str))) continue;
    if (isKnownLabel(item.str)) return null;
    const items = joinRightwards(item, onLine);
    return { text: stripColon(joinText(items)).trim(), items, how: "right" };
  }
  return null;
}

/**
 * Strategy (b): the first cell below the label that overlaps its x range, within about three lines.
 * One skippable row (a rate) may sit in between; anything else there is the value or nothing, never the row after.
 */
export function readBelow(text: PdfText, hit: Anchor, opts: ReadOptions = {}): ValueText | null {
  const maxGap = 3 * hit.h;
  const x0 = hit.x0 - 8;
  const x1 = hit.x1 + 8;
  let skipped = 0;
  for (const row of text.rows) {
    if (row.page !== hit.page || row.y >= hit.yMin - 1) continue;
    if (hit.yMin - row.y > maxGap * (1 + skipped)) break;
    const under = row.items.find((i) => !hit.items.includes(i) && i.x <= x1 && right(i) >= x0 && !isSeparator(i));
    if (!under) continue;
    if (opts.skip?.(stripColon(under.str)) && skipped === 0) {
      skipped++;
      continue;
    }
    if (isKnownLabel(under.str)) return null;
    const items = joinRightwards(under, row.items);
    return { text: stripColon(joinText(items)).trim(), items, how: "below" };
  }
  return null;
}

/** The value for a label: inline, else to the right, else below. */
export function readValue(text: PdfText, hit: Anchor, opts: ReadOptions = {}): ValueText | null {
  if (hit.inlineValue !== undefined) return { text: hit.inlineValue, items: hit.items, how: "inline" };
  return readRight(text, hit, opts) ?? readBelow(text, hit, opts);
}

/** Source string for a value read at a label, e.g. "label-right:TOTAL" or "label-split-right:Customer Transaction Reference No". */
export const labelSource = (hit: LabelHit, how: ValueText["how"]) =>
  `label-${hit.split ? "split-" : ""}${how}:${hit.text}`;

/** Reads each hit with `parse`; hits whose value can't be parsed are reported so "unreadable" differs from "absent". */
export function readAtLabels<T>(
  text: PdfText,
  hits: LabelHit[],
  parse: (raw: string) => T | null,
  opts: ReadOptions = {},
): { candidates: (Candidate<T> & { hit: LabelHit })[]; unreadable: LabelHit[] } {
  const candidates: (Candidate<T> & { hit: LabelHit })[] = [];
  const unreadable: LabelHit[] = [];
  for (const hit of hits) {
    // "VAT 0%" in one item: the rate is skipped and the amount is read beside the item, as for a plain label
    const rateOnly = hit.inlineValue !== undefined && !!opts.skip?.(hit.inlineValue);
    const raw = rateOnly ? (readRight(text, hit, opts) ?? readBelow(text, hit, opts)) : readValue(text, hit, opts);
    const value = raw ? parse(raw.text) : null;
    if (value === null) {
      // An inline hit whose remainder isn't a value is just text that starts with a label word ("Total hours")
      if (hit.inlineValue === undefined || rateOnly) unreadable.push(hit);
      continue;
    }
    candidates.push({ value, source: labelSource(hit, raw!.how), kind: "label", weak: hit.synonym.weak, hit });
  }
  return { candidates, unreadable };
}

export interface Resolved<T> {
  value: T | null;
  source: string;
  /** Different values were found and nothing chose between them */
  conflict: boolean;
  /** Every candidate came from a value-shape search, with no label */
  patternOnly: boolean;
  /** Only a weak synonym (e.g. "Value Date") was found */
  weakOnly: boolean;
  /** Distinct kinds of strategy that agree on the value (label, sequential, pattern) */
  agreeing: number;
  /** Distinct values found */
  distinct: T[];
}

/**
 * Picks a field's value from its candidates. Weak synonyms count only when nothing stronger was found, and
 * pattern guesses only when no label was. Different values are a conflict: value null unless `choose` (a
 * cross-check) picks one.
 */
export function resolve<T>(
  all: Candidate<T>[],
  eq: (a: T, b: T) => boolean = (a, b) => a === b,
  choose?: (values: T[]) => T | null,
): Resolved<T> {
  let cands = all;
  if (cands.some((c) => c.kind !== "pattern")) cands = cands.filter((c) => c.kind !== "pattern");
  if (cands.some((c) => c.kind === "label" && !c.weak)) cands = cands.filter((c) => !c.weak);
  const distinct: T[] = [];
  for (const c of cands) if (!distinct.some((d) => eq(d, c.value))) distinct.push(c.value);
  const empty = { value: null, source: "missing", conflict: false, patternOnly: false, weakOnly: false, agreeing: 0, distinct };
  if (distinct.length === 0) return empty;
  let value: T | null = distinct[0];
  if (distinct.length > 1) {
    value = choose ? choose(distinct) : null;
    if (value === null) return { ...empty, source: `conflict:${cands.map((c) => c.source).join("|")}`, conflict: true };
  }
  const agreeingCands = cands.filter((c) => eq(c.value, value as T));
  return {
    value,
    source: agreeingCands[0].source,
    conflict: false,
    patternOnly: agreeingCands.every((c) => c.kind === "pattern"),
    weakOnly: agreeingCands.every((c) => c.weak),
    agreeing: new Set(agreeingCands.map((c) => c.kind)).size,
    distinct,
  };
}
