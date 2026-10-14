import { isKnownLabel, LINE_ITEM_PREFIX } from "./labels";
import { isPercent, parseAmount, parseLongDate, parseMoney, parseNumericDate } from "./shapes";
import type { PdfText } from "./text";
import type { LayoutSkeleton } from "./types";

/**
 * Masked layout for bug reports: one line per visual row, cells separated by " | ". Known labels are kept; every
 * other cell is replaced by its shape. Names, addresses and numbers never survive: anything that isn't a known
 * label is masked, and a final pass removes any run of four or more digits that slipped through.
 */

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const count = (n: number) => String(Math.min(n, 99));

/** The shape of one value: <USD>, <MONEY>, <AMOUNT>, <DATE>, <PCT>, <ID n> (n characters) or <TEXT n> (n words). */
export function maskValue(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const money = parseMoney(s);
  if (money) return money.currency === "USD" ? "<USD>" : "<MONEY>";
  if (parseLongDate(s) || parseNumericDate(s)) return "<DATE>";
  if (isPercent(s)) return "<PCT>";
  if (/[.,]/.test(s) && parseAmount(s) !== null) return "<AMOUNT>";
  if (!/\s/.test(s) && /\d/.test(s)) return `<ID ${count(s.length)}>`;
  return `<TEXT ${count(words(s))}>`;
}

/** A label kept as printed, a "Label: value" cell with its value masked, or a masked value. */
export function maskCell(raw: string): string {
  const s = raw.trim();
  if ((isKnownLabel(s) || s === "INV") && !/\d/.test(s)) return s;
  if (s.startsWith(":")) return `: ${maskValue(s.slice(1))}`;
  const period = s.match(/^(Invoice for work between)\s+(.+?)\s+to\s+(.+)$/i);
  if (period) return `${period[1]} ${maskValue(period[2])} to ${maskValue(period[3])}`;
  const item = s.match(LINE_ITEM_PREFIX);
  if (item) return `${item[0]} ${maskValue(s.slice(item[0].length))}`.trim();
  // "Deel Ref.: X", "Registration number: X", "FCY Amount: X": keep a known label before the colon
  const colon = s.indexOf(":");
  if (colon > 0 && isKnownLabel(s.slice(0, colon)) && !/\d/.test(s.slice(0, colon))) {
    return `${s.slice(0, colon + 1)} ${maskValue(s.slice(colon + 1))}`.trim();
  }
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
  return lines.join("\n").replace(/\d{4,}/g, "<N>");
}
