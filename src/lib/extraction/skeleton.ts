import { canonicalLabel } from "./labels";
import { isPercent, parseAmount, parseLongDate, parseMoney, parseNumericDate } from "./shapes";
import type { PdfText } from "./text";
import type { LayoutSkeleton } from "./types";

/**
 * Masked layout for bug reports: one line per visual row, cells separated by " | ". A known label comes out as
 * the label table spells it (never the text as found); every other cell is replaced by its shape. Names,
 * addresses and numbers in any script never survive: only table labels, shape tokens and punctuation are
 * emitted, and a final pass masks any run of four or more digits that slipped through.
 */

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const count = (n: number) => String(Math.min(n, 99));
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The shape of one value: <USD>, <MONEY>, <AMOUNT>, <DATE>, <PCT>, <NUM n> (n digits, any script),
 * <ID n> (n characters, one token with a digit) or <TEXT n> (n words).
 */
export function maskValue(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (!LETTER_OR_DIGIT.test(s)) return ""; // punctuation only
  const money = parseMoney(s);
  if (money) return money.currency === "USD" ? "<USD>" : "<MONEY>";
  if (parseLongDate(s) || parseNumericDate(s)) return "<DATE>";
  if (isPercent(s)) return "<PCT>";
  if (/[.,]/.test(s) && parseAmount(s) !== null) return "<AMOUNT>";
  if (/^\p{N}+$/u.test(s)) return `<NUM ${count([...s].length)}>`;
  if (!/\s/.test(s) && /\p{N}/u.test(s)) return `<ID ${count([...s].length)}>`;
  return `<TEXT ${count(words(s))}>`;
}

/** Line items Deel prints, as their kind ("Bonus:"), never their description */
const ITEM_KINDS: [RegExp, string][] = [
  [/^Fixed rate\s*:/i, "Fixed rate:"],
  [/^Other\s*:/i, "Other:"],
  [/^Bonus\s*:/i, "Bonus:"],
];

/** A table label, a "Label: value" cell with its value masked, or a masked value. */
export function maskCell(raw: string): string {
  const s = raw.trim();
  const label = canonicalLabel(s);
  if (label) return label;
  if (s === "INV") return "INV";
  if (s.startsWith(":")) return `: ${maskValue(s.slice(1))}`.trim();
  const period = s.match(/^Invoice for work between\s+(.+?)\s+to\s+(.+)$/i);
  if (period) return `Invoice for work between ${maskValue(period[1])} to ${maskValue(period[2])}`;
  for (const [re, kind] of ITEM_KINDS) {
    const m = s.match(re);
    if (m) return `${kind} ${maskValue(s.slice(m[0].length))}`.trim();
  }
  // "Deel Ref.: X", "Registration number: X", "Remitter Name: X": a known label before the colon
  const colon = s.indexOf(":");
  const before = colon > 0 ? canonicalLabel(s.slice(0, colon)) : null;
  if (before) return `${before}: ${maskValue(s.slice(colon + 1))}`.trim();
  return maskValue(s);
}

export function skeletonOf(text: PdfText): LayoutSkeleton {
  if (text.items.length === 0) return "(no text)";
  const lines: string[] = [];
  let page = 0;
  for (const row of text.rows) {
    if (row.page !== page) {
      page = row.page;
      lines.push(`--- page ${page} ---`);
    }
    lines.push(row.items.map((i) => maskCell(i.str)).join(" | "));
  }
  // Belt and braces: nothing that looks like an account, phone, ID or amount leaves, whatever the masks missed
  return lines.join("\n").replace(/\p{N}{4,}/gu, "<N>");
}
