import type { DeelParsedInvoice, FiraParsedData } from "../types";

/**
 * Strategy (e): the original sequential parsers, unchanged in what they read. They walk the text items in
 * content-stream order and take the line after an exact label. The engine runs them next to the positional
 * strategies, so a document the old parsers read correctly can't regress.
 *
 * Quirks they encode (all seen in real files):
 * - pdfjs tokenises the invoice number as "INV", "2025", "10" on separate lines.
 * - BILL FROM often comes before BILL TO in the stream.
 * - A client name wrapped across lines ends with a connector ("For", "&", "of", …) and is joined.
 * - The VAT amount follows a rate line ("VAT" → "0%" → "USD $0").
 * - Since Oct 2026 the bank wraps "Customer Transaction Reference No" so "No" is its own line before the value.
 */

export type LegacyDeel = DeelParsedInvoice & {
  /** Currency printed with each amount that was read */
  currencyOf: Partial<Record<"header" | "summary" | "subtotal" | "vat", string>>;
  /** The client name/address split under BILL TO is a guess (see readBillTo) */
  nameAmbiguous?: boolean;
};

/** Sequential Deel read. Amounts: undefined = label absent, NaN = label present but its amount unreadable. */
export function legacyDeel(lines: string[]): LegacyDeel {
  const invoice: LegacyDeel = {
    currencyOf: {},
    invoiceNumber: "",
    issueDate: "",
    dueDate: "",
    clientName: "",
    clientAddress: "",
    clientCountry: "",
    clientVatId: "",
    clientRegistrationNumber: "",
    supplierName: "",
    supplierAddress: "",
    role: "",
    currency: "USD",
    subtotal: 0,
    vat: 0,
    total: 0,
    lineItems: [],
    periodText: "",
    periodStart: "",
    periodEnd: "",
    deelRef: "",
  };

  const findIdx = (label: string) => lines.findIndex((l) => l === label);
  const findIdxRe = (re: RegExp, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l));
  const findLastIdxRe = (re: RegExp, from = 0) => {
    for (let i = lines.length - 1; i >= from; i--) if (re.test(lines[i])) return i;
    return -1;
  };
  // Reads the money token ("USD $2,000.00") on the line right after a label, allowing one
  // rate line in between ("VAT" → "0%" → "USD $0"). It never scans further, so an unreadable
  // amount can't borrow the next row's value. null = not found (never confused with 0).
  const MONEY = /^([A-Z]{3})\s*\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)$/;
  const readMoneyAfter = (idx: number): { currency: string; amount: number } | null => {
    if (idx === -1) return null;
    let i = idx + 1;
    if (/^\d+(?:\.\d+)?\s*%$/.test(lines[i] ?? "")) i++;
    const m = (lines[i] ?? "").match(MONEY);
    return m ? { currency: m[1], amount: parseFloat(m[2].replace(/,/g, "")) } : null;
  };
  const currencies: string[] = [];
  const amountAt = (idx: number, key: keyof LegacyDeel["currencyOf"]): number | undefined => {
    if (idx === -1) return undefined;
    const money = readMoneyAfter(idx);
    if (!money) return NaN;
    currencies.push(money.currency);
    invoice.currencyOf[key] = money.currency;
    return money.amount;
  };

  // ─── Invoice number ───
  const invIdx = lines.findIndex((l) => l === "INV" || l === "INVOICE");
  if (invIdx !== -1) {
    const from = lines[invIdx] === "INVOICE" ? lines.findIndex((l, i) => i > invIdx && l === "INV") : invIdx;
    if (from !== -1) {
      const numTokens: string[] = [];
      for (let j = from + 1; j < from + 5 && j < lines.length; j++) {
        if (/^\d{1,4}$/.test(lines[j])) numTokens.push(lines[j]);
        if (numTokens.length === 2) break;
      }
      if (numTokens.length === 2) invoice.invoiceNumber = `INV-${numTokens[0]}-${numTokens[1]}`;
    }
  }
  if (!invoice.invoiceNumber) {
    const m = lines.find((l) => /^INV\d{5,6}$/.test(l))?.match(/^INV(\d{4})(\d{1,2})$/);
    if (m) invoice.invoiceNumber = `INV-${m[1]}-${m[2]}`;
  }

  // ─── Dates: the first two "Month D, YYYY" lines ───
  const dateLines = lines.filter((l) => /^[A-Za-z]+ \d{1,2}, \d{4}$/.test(l));
  if (dateLines[0]) invoice.issueDate = dateLines[0];
  if (dateLines[1]) invoice.dueDate = dateLines[1];

  // ─── Totals ───
  // Header total: "TOTAL DUE" (up to June 2026) or "TOTAL" (July 2026+); uppercase only, so it never matches
  // the mixed-case summary "Total" row. totalDueIdx also bounds the Bill To / Bill From blocks below.
  const totalDueIdx = findIdxRe(/^TOTAL(\s+DUE)?$/);
  invoice.headerTotal = amountAt(totalDueIdx, "header");
  const descIdx = findIdx("Description");
  invoice.summaryTotal = descIdx === -1 ? undefined : amountAt(findLastIdxRe(/^Total$/, descIdx + 1), "summary");
  invoice.total = invoice.summaryTotal ?? invoice.headerTotal ?? 0;
  if (currencies.length > 0) invoice.currency = currencies[currencies.length - 1];

  // ─── Bill To ───
  const billToIdx = findIdx("BILL TO");
  const billFromIdx = findIdx("BILL FROM");
  if (billToIdx !== -1) {
    const endBillTo = totalDueIdx > billToIdx ? totalDueIdx : lines.length;
    Object.assign(invoice, readBillTo(lines.slice(billToIdx + 1, endBillTo)));
  }

  // ─── Bill From ───
  if (billFromIdx !== -1) {
    const endBillFrom = billToIdx > billFromIdx ? billToIdx : totalDueIdx > billFromIdx ? totalDueIdx : billFromIdx + 8;
    Object.assign(invoice, readBillFrom(lines.slice(billFromIdx + 1, endBillFrom)));
  }

  const roleLine = lines.find((l) => /^UI\/UX Designer$/i.test(l));
  if (roleLine) invoice.role = roleLine;

  // ─── Period ───
  const period = lines.map(readPeriod).find((p) => p !== null);
  if (period) {
    invoice.periodStart = period.start;
    invoice.periodEnd = period.end;
    invoice.periodText = `${period.start} to ${period.end}`;
  }

  // ─── Subtotal and VAT ───
  // "Sub total" (up to June 2026) or "Subtotal" (July 2026+)
  const subTotalIdx = findIdxRe(/^sub\s*-?\s*total$/i);
  invoice.subtotal = amountAt(subTotalIdx, "subtotal") ?? NaN;
  invoice.vat = subTotalIdx === -1 ? 0 : (amountAt(findIdxRe(/^VAT$/, subTotalIdx + 1), "vat") ?? 0);
  invoice.sourceCurrencies = currencies;

  // ─── Line items ───
  // Each description is followed by its USD amount; "Fixed contract" is a section header, not an item.
  const stopIdx = subTotalIdx > 0 ? subTotalIdx : lines.length;
  if (descIdx !== -1) {
    for (let i = descIdx + 1; i < stopIdx; i++) {
      const l = lines[i];
      if (l === "Fixed rate: Monthly payment" || /^Other:\s*/i.test(l) || /^Bonus:\s*/i.test(l)) {
        const am = i + 1 < stopIdx ? lines[i + 1].match(/^USD\s*\$?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)$/) : null;
        invoice.lineItems.push({ description: l, amount: am ? parseFloat(am[1].replace(/,/g, "")) : NaN });
      }
    }
  }

  // ─── Deel reference ───
  const deelRefLine = lines.find((l) => l.startsWith("Deel Ref.:"));
  if (deelRefLine) invoice.deelRef = deelRefLine.replace("Deel Ref.:", "").trim();

  return invoice;
}

const COUNTRIES = ["Saudi Arabia", "India", "United States", "United Kingdom", "UAE", "Singapore", "Germany", "Australia", "Canada"];

const CONNECTOR_END = /(?:^|\s)(?:&|and|of|for|the)$/i;
const CONNECTOR_START = /^(?:&|and|of|for|the)\s/i;
/** An address line starts with a number ("1 Main St") or a region code and number ("DL 110001") */
const ADDRESS_START = (l: string) => /^\d/.test(l) || /^[A-Z]{2}\s+\d/.test(l);

/**
 * How the client name was told apart from the address. Names can't be cross-checked, so anything but a clear
 * reading is reported as ambiguous and the review form asks the user to check it.
 * - "connector": lines joined because one ends with, or the next starts with, "&", "and", "of", "for" or "the";
 * - "short-first-line": two lines joined only because the first is short (the original parser's guess);
 * - "single": a one-line name.
 */
export type NameRule = "connector" | "short-first-line" | "single";

/** Client name, address, country, VAT ID and registration number from the lines under BILL TO. */
export function readBillTo(rawBillTo: string[]) {
  const out = {
    clientName: "",
    clientAddress: "",
    clientCountry: "",
    clientVatId: "",
    clientRegistrationNumber: "",
    nameRule: "single" as NameRule,
    /** The name/address split is a guess (see the rules at the end) */
    nameAmbiguous: false,
  };
  const filtered = rawBillTo.filter((l) => !l.match(/^Registration number:|^VAT ID|^Group:|^\d{10,}/));
  const countryIdx = filtered.findIndex((l) => COUNTRIES.includes(l));
  // Name lines: everything before the first address-like line (and before the country)
  const nameLines: string[] = [];
  for (let i = 0; i < (countryIdx > 0 ? countryIdx : filtered.length); i++) {
    if (ADDRESS_START(filtered[i])) break;
    nameLines.push(filtered[i]);
  }
  // A name wrapped across lines ends with a connector ("For", "&", …) or the next line starts with one: join it
  let nameLen = 1;
  while (
    nameLen < nameLines.length &&
    nameLen < 3 &&
    (CONNECTOR_END.test(nameLines[nameLen - 1]) || CONNECTOR_START.test(nameLines[nameLen]))
  ) {
    nameLen++;
  }
  if (countryIdx > 0) {
    // KNOWN BUG kept for compatibility (tests/unit/parseDeelInvoice.test.ts): a short name ending in a comma is
    // joined with the next address line, because two lines are joined whenever the first is under 30 characters.
    // It is reported as ambiguous, so the review form flags it.
    if (nameLen > 1) {
      out.nameRule = "connector";
    } else if (nameLines.length >= 2 && nameLines[0].length < 30) {
      out.nameRule = "short-first-line";
      nameLen = 2;
    }
    out.clientName = nameLines.slice(0, nameLen).join(" ");
    out.clientAddress = [...nameLines.slice(nameLen), ...filtered.slice(nameLines.length, countryIdx)].join(", ");
    out.clientCountry = filtered[countryIdx];
  } else if (filtered.length > 0) {
    // No country line: the block's end is unknown, so only the connector rule joins lines
    if (nameLen > 1) out.nameRule = "connector";
    out.clientName = filtered.slice(0, nameLen).join(" ");
    out.clientAddress = filtered.slice(nameLen).join(", ");
  }
  // A street line without a number after a name the connector rule closed is normal; these are not:
  out.nameAmbiguous =
    filtered.length > 0 &&
    (countryIdx <= 0 || // no country line, so the block's end is a guess
      out.nameRule === "short-first-line" || // joined only because the first line is short
      (out.nameRule === "connector" && CONNECTOR_END.test(nameLines[nameLen - 1])) || // still ends in "&" after 3 lines
      (out.nameRule === "single" && nameLines.length > 1)); // a long first line followed by more text: maybe wrapped
  const vatLine = rawBillTo.find((l) => l.startsWith("VAT ID"));
  if (vatLine) out.clientVatId = vatLine.replace("VAT ID", "").trim();
  if (!out.clientVatId) {
    const vatIdx = rawBillTo.findIndex((l) => l === "VAT ID");
    if (vatIdx !== -1) {
      for (let i = vatIdx + 1; i < rawBillTo.length; i++) {
        if (/^\d{10,}/.test(rawBillTo[i])) {
          out.clientVatId = rawBillTo[i].trim();
          break;
        }
      }
    }
  }
  const regIdx = rawBillTo.findIndex((l) => l.startsWith("Registration number:"));
  if (regIdx !== -1) {
    const regVal = rawBillTo[regIdx].replace("Registration number:", "").trim();
    out.clientRegistrationNumber = regVal || rawBillTo[regIdx + 1]?.trim() || "";
  }
  return out;
}

/** Supplier name (first line) and address (the rest, without the country) from the lines under BILL FROM. */
export function readBillFrom(lines: string[]) {
  const bfLines = lines.filter((l) => !l.match(/^\d{10,}$/));
  return {
    supplierName: bfLines[0] ?? "",
    supplierAddress: bfLines.slice(1).filter((l) => l !== "India" && l.length > 1).join(", "),
  };
}

/** "Invoice for work between August 1, 2026 to August 31, 2026" */
export function readPeriod(line: string): { start: string; end: string } | null {
  if (!/Invoice for work between/i.test(line)) return null;
  const pm = line.match(/between\s+([A-Za-z]+ \d{1,2},?\s+\d{4})\s+to\s+([A-Za-z]+ \d{1,2},?\s+\d{4})/i);
  return pm ? { start: pm[1].trim(), end: pm[2].trim() } : null;
}

export type LegacyFira = FiraParsedData & {
  /** The amount text as read, so the engine can shape-check it (parseFloat reads "24-12-2026" as 24) */
  raw: { fcyAmount?: string; inrAmount?: string };
};

/** Sequential FIRA read: each label's value is the next ": …" line. Missing values stay 0 / "". */
export function legacyFira(lines: string[]): LegacyFira {
  const data: LegacyFira = { fcyAmount: 0, inrAmount: 0, firaRef: "", processedDate: "", raw: {} };
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
    } else if (l.includes("Processed Date")) {
      const val = valueAfter(i);
      if (val) data.processedDate = val;
    } else if (l.includes("FCY Amount")) {
      const val = valueAfter(i);
      if (val) {
        data.fcyAmount = parseFloat(val.replace(/,/g, ""));
        data.raw.fcyAmount = val;
      }
    } else if (l.includes("INR Amount")) {
      const val = valueAfter(i);
      if (val) {
        data.inrAmount = parseFloat(val.replace(/,/g, ""));
        data.raw.inrAmount = val;
      }
    }
  }
  // Inline "FCY Amount: 1995.00"
  const inline = (re: RegExp) => lines.map((l) => l.match(re)).find((m) => m)?.[1];
  if (!data.fcyAmount) {
    const v = inline(/FCY Amount.*?:?\s*([\d,]+\.?\d*)/i);
    if (v) {
      data.fcyAmount = parseFloat(v.replace(/,/g, ""));
      data.raw.fcyAmount = v;
    }
  }
  if (!data.inrAmount) {
    const v = inline(/INR Amount.*?:?\s*([\d,]+\.?\d*)/i);
    if (v) {
      data.inrAmount = parseFloat(v.replace(/,/g, ""));
      data.raw.inrAmount = v;
    }
  }
  if (!data.processedDate) {
    const v = inline(/Processed Date.*?:?\s*([\d-]+)/i);
    if (v) data.processedDate = v;
  }
  return data;
}
