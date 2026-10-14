import type { DeelParsedInvoice, FiraParsedData } from "../types";
import type { DeelReading } from "./deel";
import { labelWasFound } from "./fields";
import type { FiraExtraction, Field } from "./types";

/**
 * The engine's result in the shape the original parsers returned, so the legacy /api/generate path and its
 * validation keep working unchanged:
 * - a missing text field is "", a missing FIRA amount 0;
 * - a header or summary total whose label is there but whose amount can't be read is NaN (validation rejects it),
 *   and undefined when the label is absent;
 * - the subtotal is NaN when missing; VAT is 0 when there is no VAT row and NaN when it can't be read;
 * - a guess from value shape alone (no label) is never passed on: it needs the review form;
 * - `sourceCurrencies` carries the currency of every amount read, items included, and any other currency printed
 *   on the page, so validation never misses a currency the engine flagged.
 */

const usable = <T>(f: Field<T>): T | null => (f.value !== null && !f.source.startsWith("pattern:") ? f.value : null);
const str = (f: Field<string>) => usable(f) ?? "";

function amount(f: Field<number>, whenAbsent: number | undefined): number | undefined {
  const v = usable(f);
  if (v !== null) return v;
  return labelWasFound(f) ? NaN : whenAbsent;
}

/** Every currency the engine saw, so validation refuses a foreign amount even where no field was read from it. */
const withForeign = (read: string[], foreign: string[]) => [...read, ...foreign.filter((c) => !read.includes(c))];

export function toDeelParsed({ extraction, currencyOf, itemCurrencies = [], foreignCurrencies = [] }: DeelReading): DeelParsedInvoice {
  const f = extraction.fields;
  const headerTotal = amount(f.headerTotal, undefined);
  const summaryTotal = amount(f.summaryTotal, undefined);
  const periodStart = str(f.periodStart);
  const periodEnd = str(f.periodEnd);
  return {
    invoiceNumber: str(f.invoiceNumber),
    issueDate: str(f.issueDate),
    dueDate: str(f.dueDate),
    periodStart,
    periodEnd,
    periodText: periodStart && periodEnd ? `${periodStart} to ${periodEnd}` : "",
    clientName: str(f.clientName),
    clientAddress: str(f.clientAddress),
    clientCountry: str(f.clientCountry),
    clientVatId: str(f.clientVatId),
    clientRegistrationNumber: str(f.clientRegistrationNumber),
    supplierName: str(f.supplierName),
    supplierAddress: str(f.supplierAddress),
    role: str(f.role),
    // As before: the summary's currency, else the header's, else USD
    currency: currencyOf.summary ?? currencyOf.header ?? "USD",
    subtotal: amount(f.subtotal, NaN)!,
    vat: amount(f.vat, 0)!,
    total: summaryTotal ?? headerTotal ?? 0,
    headerTotal,
    summaryTotal,
    sourceCurrencies: withForeign(
      [
        ...(["header", "summary", "subtotal", "vat"] as const).flatMap((k) => (currencyOf[k] ? [currencyOf[k]!] : [])),
        ...itemCurrencies.filter((c): c is string => c !== null),
      ],
      foreignCurrencies,
    ),
    lineItems: extraction.lineItems.map((item) => ({ description: item.description, amount: usable(item.amount) ?? NaN })),
    deelRef: str(f.deelRef),
  };
}

export function toFiraParsed(extraction: FiraExtraction): FiraParsedData {
  const f = extraction.fields;
  return {
    fcyAmount: usable(f.fcyAmount) ?? 0,
    inrAmount: usable(f.inrAmount) ?? 0,
    firaRef: str(f.firaRef),
    processedDate: str(f.processedDate),
  };
}
