import { DeelParsedInvoice } from "./types";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { assertPageCount, assertTextItemCount, withParseSlot } from "./limits";

/**
 * Extract text from a PDF buffer using Mozilla PDF.js (pdfjs-dist).
 * Returns a single string with all text items joined by newlines.
 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  return withParseSlot(() => readPdfText(buffer));
}

async function readPdfText(buffer: Buffer): Promise<string> {
  const uint8 = new Uint8Array(buffer);
  const loadingTask = getDocument({ data: uint8 });
  const doc = await loadingTask.promise;
  try {
    assertPageCount(doc.numPages, "The Deel invoice");
    let fullText = "";
    let itemCount = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      itemCount += content.items.length;
      assertTextItemCount(itemCount, "The Deel invoice");
      // Extract text strings from content items (ignoring TextMarkedContent)
      const strings: string[] = [];
      for (const item of content.items) {
        if ("str" in item && typeof item.str === "string") {
          strings.push(item.str);
        }
      }
      const pageText = strings.join("\n");
      fullText += pageText + "\n";
    }
    return fullText;
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Parse a Deel contractor invoice PDF.
 *
 * Confirmed structure across 5 invoices (Oct 2025 – Feb 2026).
 * Fixed rate is always $2,000 USD base. Variable add-ons (Other, Bonus) on top.
 */
export async function parseDeelInvoice(buffer: Buffer): Promise<DeelParsedInvoice> {
  const text = await extractPdfText(buffer);
  // Normalize: replace non-breaking spaces (U+00A0), other Unicode whitespace,
  // and Private Use Area icons (e.g., Deel's building icon  \uE000-\uF8FF) with spaces.
  const lines = text
    .split("\n")
    .map((l) => l.replace(/[\u00A0\u200B\u2009\u2003\uE000-\uF8FF]/g, " ").trim())
    .filter((l) => l.length > 0);

  const invoice: DeelParsedInvoice = {
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

  // ─── Helper: find line index ──────────────────────────────────────────────
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
  // A label that is present but whose amount can't be read becomes NaN, which validation rejects.
  const amountAt = (idx: number): number | undefined => {
    if (idx === -1) return undefined;
    const money = readMoneyAfter(idx);
    if (!money) return NaN;
    currencies.push(money.currency);
    return money.amount;
  };

  // ─── 1. Invoice Number ────────────────────────────────────────────────────
  // pdfjs-dist tokenises as "INV", "2025", "10" on separate lines
  // (sometimes with empty/whitespace lines between them that are now filtered)
  const invIdx = lines.findIndex((l) => l === "INV" || l === "INVOICE");
  if (invIdx !== -1) {
    if (lines[invIdx] === "INVOICE") {
      // Find "INV" after "INVOICE" / "Invoice #" labels
      const invNumIdx = lines.findIndex((l, i) => i > invIdx && l === "INV");
      if (invNumIdx !== -1) {
        // Collect the next numeric tokens after "INV"
        const numTokens: string[] = [];
        for (let j = invNumIdx + 1; j < invNumIdx + 5 && j < lines.length; j++) {
          if (/^\d{1,4}$/.test(lines[j])) numTokens.push(lines[j]);
          if (numTokens.length === 2) break;
        }
        if (numTokens.length === 2) {
          invoice.invoiceNumber = `INV-${numTokens[0]}-${numTokens[1]}`;
        }
      }
    } else if (lines[invIdx] === "INV") {
      const numTokens: string[] = [];
      for (let j = invIdx + 1; j < invIdx + 5 && j < lines.length; j++) {
        if (/^\d{1,4}$/.test(lines[j])) numTokens.push(lines[j]);
        if (numTokens.length === 2) break;
      }
      if (numTokens.length === 2) {
        invoice.invoiceNumber = `INV-${numTokens[0]}-${numTokens[1]}`;
      }
    }
  }
  // Fallback: compact format "INV202510"
  if (!invoice.invoiceNumber) {
    const compactLine = lines.find((l) => /^INV\d{5,6}$/.test(l));
    if (compactLine) {
      const m = compactLine.match(/^INV(\d{4})(\d{1,2})$/);
      if (m) invoice.invoiceNumber = `INV-${m[1]}-${m[2]}`;
    }
  }

  // ─── 2. Dates ─────────────────────────────────────────────────────────────
  const datePattern = /^[A-Za-z]+ \d{1,2}, \d{4}$/;
  const dateLines = lines.filter((l) => datePattern.test(l));
  if (dateLines[0]) invoice.issueDate = dateLines[0];
  if (dateLines[1]) invoice.dueDate = dateLines[1];

  // ─── 3. Totals ────────────────────────────────────────────────────────────
  // Header total: "TOTAL DUE" (Deel layout up to June 2026) or "TOTAL" (July 2026+).
  // Uppercase only, so it never matches the mixed-case summary "Total" row.
  // totalDueIdx also bounds the Bill To / Bill From blocks below.
  const totalDueIdx = findIdxRe(/^TOTAL(\s+DUE)?$/);
  invoice.headerTotal = amountAt(totalDueIdx);
  // Summary total: the last "Total" row after the line-item table.
  const descIdxForTotals = findIdx("Description");
  invoice.summaryTotal = descIdxForTotals === -1 ? undefined : amountAt(findLastIdxRe(/^Total$/, descIdxForTotals + 1));
  invoice.total = invoice.summaryTotal ?? invoice.headerTotal ?? 0;
  if (currencies.length > 0) invoice.currency = currencies[currencies.length - 1];

  // ─── 4. Bill To ───────────────────────────────────────────────────────────
  // In pdfjs-dist output, BILL FROM often appears BEFORE BILL TO
  const billToIdx = findIdx("BILL TO");
  const billFromIdx = findIdx("BILL FROM");
  
  if (billToIdx !== -1) {
    // Find the end boundary (TOTAL DUE usually follows)
    const endBillTo = totalDueIdx > billToIdx ? totalDueIdx : lines.length;
    const rawBillTo = lines.slice(billToIdx + 1, endBillTo);
    // Filter out metadata lines
    const filtered = rawBillTo.filter(
      (l) => !l.match(/^Registration number:|^VAT ID|^Group:|^\d{10,}/)
    );
    const countries = [
      "Saudi Arabia", "India", "United States", "United Kingdom",
      "UAE", "Singapore", "Germany", "Australia", "Canada",
    ];
    const countryIdx = filtered.findIndex((l) => countries.includes(l));
    if (countryIdx > 0) {
      // Client name might be split across lines: "Example Company For" + "Research & Education"
      const nameLines: string[] = [];
      for (let i = 0; i < countryIdx; i++) {
        const line = filtered[i];
        if (/^\d/.test(line) || /^[A-Z]{2}\s+\d/.test(line)) break;
        if (countries.includes(line)) break;
        nameLines.push(line);
      }
      // First 1-2 lines are name, rest is address
      // A name wrapped across lines ends with a connector ("For", "&", "of", …): join it.
      let nameLen = 1;
      while (nameLen < nameLines.length && nameLen < 3 &&
             /(?:^|\s)(?:&|and|of|for|the)$/i.test(nameLines[nameLen - 1])) nameLen++;
      if (nameLen > 1) {
        invoice.clientName = nameLines.slice(0, nameLen).join(" ");
        invoice.clientAddress = nameLines.slice(nameLen).join(", ");
      } else if (nameLines.length >= 2 && nameLines[0].length < 30) {
        invoice.clientName = nameLines.slice(0, 2).join(" ");
        invoice.clientAddress = nameLines.slice(2).join(", ");
      } else {
        invoice.clientName = nameLines[0] || "";
        invoice.clientAddress = nameLines.slice(1).join(", ");
      }
      // Remaining lines between name and country are address
      const addrLines = filtered.slice(nameLines.length, countryIdx);
      if (addrLines.length > 0) {
        invoice.clientAddress = (invoice.clientAddress ? invoice.clientAddress + ", " : "") 
          + addrLines.join(", ");
      }
      invoice.clientCountry = filtered[countryIdx];
    } else {
      invoice.clientName = filtered[0] || "";
      invoice.clientAddress = filtered.slice(1).join(", ");
    }
    // VAT ID & Registration
    const vatLine = rawBillTo.find((l) => l.startsWith("VAT ID"));
    if (vatLine) invoice.clientVatId = vatLine.replace("VAT ID", "").trim();
    // VAT ID might be on the next line
    if (!invoice.clientVatId) {
      const vatIdx = rawBillTo.findIndex((l) => l === "VAT ID");
      if (vatIdx !== -1) {
        // Look for a numeric line after "VAT ID"
        for (let i = vatIdx + 1; i < rawBillTo.length; i++) {
          if (/^\d{10,}/.test(rawBillTo[i])) {
            invoice.clientVatId = rawBillTo[i].trim();
            break;
          }
        }
      }
    }
    const regIdx = rawBillTo.findIndex((l) => l.startsWith("Registration number:"));
    if (regIdx !== -1) {
      // Number might be on the same line or the next
      const regVal = rawBillTo[regIdx].replace("Registration number:", "").trim();
      invoice.clientRegistrationNumber = regVal || rawBillTo[regIdx + 1]?.trim() || "";
    }
  }

  // ─── 5. Bill From ─────────────────────────────────────────────────────────
  if (billFromIdx !== -1) {
    const endBillFrom = billToIdx > billFromIdx ? billToIdx : 
                        totalDueIdx > billFromIdx ? totalDueIdx : 
                        billFromIdx + 8;
    const bfLines = lines.slice(billFromIdx + 1, endBillFrom)
      .filter((l) => !l.match(/^\d{10,}$/));
    if (bfLines[0]) invoice.supplierName = bfLines[0];
    // Address lines (skip country if single word like "India")
    const addrParts = bfLines.slice(1).filter((l) => l !== "India" && l.length > 1);
    invoice.supplierAddress = addrParts.join(", ");
  }

  // Role — typically "UI/UX Designer" appearing after TOTAL DUE
  const roleLine = lines.find((l) => /^UI\/UX Designer$/i.test(l));
  if (roleLine) invoice.role = roleLine;

  // ─── 6. Period ────────────────────────────────────────────────────────────
  const periodLine = lines.find((l) => /Invoice for work between/i.test(l));
  if (periodLine) {
    const pm = periodLine.match(
      /between\s+([A-Za-z]+ \d{1,2},?\s+\d{4})\s+to\s+([A-Za-z]+ \d{1,2},?\s+\d{4})/i
    );
    if (pm) {
      invoice.periodStart = pm[1].trim();
      invoice.periodEnd = pm[2].trim();
      invoice.periodText = `${pm[1].trim()} to ${pm[2].trim()}`;
    }
  }

  // ─── 7. Sub Total ─────────────────────────────────────────────────────────
  // "Sub total" (up to June 2026) or "Subtotal" (July 2026+)
  const subTotalIdx = findIdxRe(/^sub\s*-?\s*total$/i);
  invoice.subtotal = amountAt(subTotalIdx) ?? NaN;
  // VAT row ("VAT" → "0%" → "USD $0"); absent means no VAT
  invoice.vat = subTotalIdx === -1 ? 0 : amountAt(findIdxRe(/^VAT$/, subTotalIdx + 1)) ?? 0;
  invoice.sourceCurrencies = currencies;

  // ─── 8. Line Items ────────────────────────────────────────────────────────
  // pdfjs-dist outputs each description label immediately followed by its USD amount:
  //   "Bonus: 2025 CEO Bonus" → "USD $1,602.00"
  //   "Fixed rate: Monthly payment" → "USD $2,000.00"
  // IMPORTANT: "Fixed contract" is a section HEADER, NOT a line item — skip it.
  const descStartIdx = findIdx("Description");
  const stopIdx = subTotalIdx > 0 ? subTotalIdx : lines.length;

  if (descStartIdx !== -1) {
    for (let i = descStartIdx + 1; i < stopIdx; i++) {
      const l = lines[i];
      let desc = "";
      
      if (l === "Fixed rate: Monthly payment") {
        desc = l;
      } else if (/^Other:\s*/i.test(l)) {
        desc = l;
      } else if (/^Bonus:\s*/i.test(l)) {
        desc = l;
      }
      
      if (desc) {
        // The USD amount is on the next line; NaN if it isn't (validation rejects it)
        const am = i + 1 < stopIdx ? lines[i + 1].match(/^USD\s*\$?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)$/) : null;
        const amount = am ? parseFloat(am[1].replace(/,/g, "")) : NaN;
        invoice.lineItems.push({ description: desc, amount });
      }
    }
  }

  // ─── 9. Deel Reference ────────────────────────────────────────────────────
  const deelRefLine = lines.find((l) => l.startsWith("Deel Ref.:"));
  if (deelRefLine) invoice.deelRef = deelRefLine.replace("Deel Ref.:", "").trim();

  return invoice;
}
