/**
 * Value shapes: each parser takes the text found where a value should be and returns the value, or null when the
 * text isn't that kind of value. A null here is what stops a strategy from borrowing the next row's text.
 */

export interface Money {
  currency: string;
  amount: number;
}

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const MONEY_RE = new RegExp(String.raw`^([A-Z]{3})\s*\$?\s*${NUMBER}$`);
const AMOUNT_RE = new RegExp(String.raw`^${NUMBER}$`);

const toNumber = (s: string) => parseFloat(s.replace(/,/g, ""));

/** Deel's money cells: "USD $2,000.00", "USD 2000", "EUR $0". */
export function parseMoney(text: string): Money | null {
  const m = text.trim().match(MONEY_RE);
  return m ? { currency: m[1], amount: toNumber(m[2]) } : null;
}

/** A bare amount, as on the FIRA ("1995.00", "1,80,174.04" in Indian grouping is accepted too). */
export function parseAmount(text: string): number | null {
  const t = text.trim();
  if (AMOUNT_RE.test(t)) return toNumber(t);
  if (/^\d{1,2}(?:,\d{2})*,\d{3}(?:\.\d{1,2})?$/.test(t)) return toNumber(t); // lakh grouping
  return null;
}

/** "10%", "0 %": the VAT rate printed between the label and the amount. */
export const isPercent = (text: string) => /^\d+(?:\.\d+)?\s*%$/.test(text.trim());

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function validYmd(y: number, m: number, d: number): boolean {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "August 21, 2026" (Deel). Returned as printed. */
export function parseLongDate(text: string): string | null {
  const t = text.trim();
  const m = t.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
  if (!m) return null;
  const month = MONTHS.findIndex((name) => name === m[1].toLowerCase() || (m[1].length >= 3 && name.startsWith(m[1].toLowerCase())));
  return month !== -1 && validYmd(+m[3], month + 1, +m[2]) ? t : null;
}

/** "07-10-2026" (DD-MM-YYYY, the bank's format), "07/10/2026" or "2026-10-07". Returned as printed. */
export function parseNumericDate(text: string): string | null {
  const t = text.trim();
  let m = t.match(/^(\d{2})[-/.](\d{2})[-/.](\d{4})$/);
  if (m) return validYmd(+m[3], +m[2], +m[1]) ? t : null;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validYmd(+m[1], +m[2], +m[3]) ? t : null;
  return null;
}

/** Milliseconds since the epoch for either date shape, for ordering checks. */
export function dateValue(text: string): number | null {
  const long = parseLongDate(text);
  if (long) {
    const m = long.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/)!;
    const month = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase()));
    return Date.UTC(+m[3], month, +m[2]);
  }
  const num = parseNumericDate(text);
  if (!num) return null;
  const dmy = num.match(/^(\d{2})[-/.](\d{2})[-/.](\d{4})$/);
  if (dmy) return Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]);
  const ymd = num.match(/^(\d{4})-(\d{2})-(\d{2})$/)!;
  return Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3]);
}

/** Deel invoice number from its printed tokens: "INV 2026 9", "INV-2026-9" or the compact "INV202609". */
export function parseInvoiceNumber(text: string): string | null {
  const t = text.trim();
  let m = t.match(/^INV[\s-]*(\d{4})[\s-]+(\d{1,4})$/);
  if (m) return `INV-${m[1]}-${m[2]}`;
  m = t.match(/^INV(\d{4})(\d{1,2})$/);
  return m ? `INV-${m[1]}-${m[2]}` : null;
}

/** A reference printed after its label: one token of letters and digits (and - / _ .). */
export function parseReference(text: string): string | null {
  const t = text.trim();
  return /^[A-Za-z0-9][A-Za-z0-9\-/_.]{3,39}$/.test(t) && (/\d/.test(t) || /^[A-Z]{8,}$/.test(t)) ? t : null;
}

/** A reference found with no label nearby: stricter, so a pattern guess can't pick up an ordinary word. */
export const REFERENCE_PATTERN = /^[A-Z0-9]{8,24}$/;

export function parseCurrencyCode(text: string): string | null {
  const t = text.trim();
  return /^[A-Z]{3}$/.test(t) ? t : null;
}

/** Strips the ": " the bank prints before every value. */
export const stripColon = (text: string) => text.replace(/^\s*:\s*/, "");
