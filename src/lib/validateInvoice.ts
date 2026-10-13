import { BusinessProfile } from "./config";
import { DeelParsedInvoice, GeneratedInvoice } from "./types";

/** A problem with the uploaded documents or settings; the route returns it as HTTP 422. */
export class InvoiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceValidationError";
  }
}

const TOLERANCE = 0.01;
const isPositive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const isNonNegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;
const usd = (n: number) => n.toFixed(2);

/** Fail closed: never build a tax invoice from Deel figures that don't reconcile. */
export function validateDeelData(deel: DeelParsedInvoice): void {
  const unreadable = [
    ["header total", deel.headerTotal],
    ["summary total", deel.summaryTotal],
  ].filter(([, v]) => v !== undefined && !Number.isFinite(v)).map(([label]) => label);
  if (unreadable.length > 0 || !isPositive(deel.total)) {
    throw new InvoiceValidationError(
      "Could not read the total from the Deel invoice. Check that you uploaded a Deel invoice PDF; if you did, Deel may have changed its layout.",
    );
  }
  if (deel.headerTotal !== undefined && deel.summaryTotal !== undefined && !near(deel.headerTotal, deel.summaryTotal)) {
    throw new InvoiceValidationError(
      `Deel invoice totals disagree: header shows ${usd(deel.headerTotal)} but the summary shows ${usd(deel.summaryTotal)}.`,
    );
  }
  const currencies = [deel.currency, ...(deel.sourceCurrencies ?? [])];
  if (currencies.some((c) => c !== "USD")) {
    throw new InvoiceValidationError(`Only USD Deel invoices are supported; this one shows ${[...new Set(currencies)].join(", ")}.`);
  }
  if (!isPositive(deel.subtotal)) {
    throw new InvoiceValidationError("The Deel invoice subtotal is zero or could not be read.");
  }
  if (!isNonNegative(deel.vat)) {
    throw new InvoiceValidationError("Could not read the VAT amount from the Deel invoice.");
  }
  if (deel.vat !== 0) {
    throw new InvoiceValidationError(`The Deel invoice includes VAT of USD ${usd(deel.vat)}; invoices with VAT aren't supported yet.`);
  }
  if (!near(deel.subtotal + deel.vat, deel.total)) {
    throw new InvoiceValidationError(
      `Deel invoice subtotal (${usd(deel.subtotal)}) plus VAT (${usd(deel.vat)}) does not match its total (${usd(deel.total)}).`,
    );
  }
  if (deel.lineItems.length === 0) {
    throw new InvoiceValidationError("No recognised line items (Fixed rate, Bonus, Other) were found on the Deel invoice.");
  }
  if (deel.lineItems.some((item) => !isNonNegative(item.amount))) {
    throw new InvoiceValidationError("Could not read every line-item amount from the Deel invoice.");
  }
  const itemsSum = deel.lineItems.reduce((acc, item) => acc + item.amount, 0);
  if (!near(itemsSum, deel.subtotal)) {
    throw new InvoiceValidationError(
      `Deel line items add up to ${usd(itemsSum)}, but the invoice subtotal is ${usd(deel.subtotal)}.`,
    );
  }
}

/** The invoice must carry the supplier's tax and bank identity. */
export function validateSupplier(supplier: BusinessProfile): void {
  const missing = [
    ["GSTIN", supplier.gstin],
    ["PAN", supplier.pan],
    ["bank account number", supplier.accountNumber],
  ]
    .filter(([, value]) => !value || !String(value).trim())
    .map(([label]) => label);
  if (missing.length > 0) {
    throw new InvoiceValidationError(`Business profile is missing: ${missing.join(", ")}. Fill it in under Settings.`);
  }
}

/** Last check before rendering: totals are real positive numbers and the lines add up. */
export function validateGeneratedInvoice(invoice: GeneratedInvoice): void {
  const lineAmounts = invoice.lineItems.flatMap((item) => [item.rate, item.amount]);
  if (!isPositive(invoice.subtotal) || !isPositive(invoice.grandTotal) || lineAmounts.some((n) => !isNonNegative(n))) {
    throw new InvoiceValidationError("The invoice has an amount that is zero or not a number; it was not generated.");
  }
  const linesSum = invoice.lineItems.reduce((acc, item) => acc + item.amount, 0);
  if (!near(linesSum, invoice.grandTotal)) {
    throw new InvoiceValidationError("Invoice line items do not add up to the grand total; it was not generated.");
  }
  if (invoice.firaData) {
    const f = invoice.firaData;
    if (!isPositive(f.originalUsdBilled) || !isPositive(f.exchangeRate) || !isNonNegative(f.bankChargesUsd)) {
      throw new InvoiceValidationError("FIRA figures are incomplete; the invoice was not generated.");
    }
  }
}
