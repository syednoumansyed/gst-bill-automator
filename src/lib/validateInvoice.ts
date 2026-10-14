import { BusinessProfile } from "./config";
import { deelIssues, supplierIssues } from "./draftValidation";
import { issue, IssueError, type Issue } from "./errors";
import { DeelParsedInvoice, GeneratedInvoice } from "./types";

/**
 * A problem with the uploaded documents, the review draft or settings. It is an IssueError, so it carries a stable
 * code, document, field and action; the route answers with `errorBody(issues)` and the code's HTTP status.
 * A bare message (older call sites) becomes a DRAFT_INVALID issue.
 */
export class InvoiceValidationError extends IssueError {
  constructor(issues: Issue | Issue[] | string) {
    super(
      typeof issues === "string"
        ? issue("DRAFT_INVALID", "request", issues, "Check the values in the form and try again.")
        : issues,
    );
    this.name = "InvoiceValidationError";
  }
}

const TOLERANCE = 0.01;
const isPositive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const isNonNegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;

const fail = (i: Issue): never => {
  throw new InvoiceValidationError(i);
};

/**
 * Fail closed: never build a tax invoice from parsed Deel figures that don't reconcile. Covers what only the parser
 * sees (header vs summary total, the currency of every row); validateDraft repeats the rest on the draft.
 */
export function validateDeelData(deel: DeelParsedInvoice): void {
  const unreadable = [deel.headerTotal, deel.summaryTotal].some((v) => v !== undefined && !Number.isFinite(v));
  if (unreadable || !isPositive(deel.total)) fail(deelIssues.totalUnreadable());
  if (deel.headerTotal !== undefined && deel.summaryTotal !== undefined && !near(deel.headerTotal, deel.summaryTotal)) {
    fail(deelIssues.headerSummaryDisagree(deel.headerTotal, deel.summaryTotal));
  }
  const currencies = [deel.currency, ...(deel.sourceCurrencies ?? [])];
  if (currencies.some((c) => c !== "USD")) fail(deelIssues.currencyUnsupported(currencies));
  if (!isPositive(deel.subtotal)) fail(deelIssues.subtotalUnreadable());
  if (!isNonNegative(deel.vat)) fail(deelIssues.vatUnreadable());
  if (deel.vat !== 0) fail(deelIssues.vatUnsupported(deel.vat));
  if (!near(deel.subtotal + deel.vat, deel.total)) fail(deelIssues.totalsDisagree(deel.subtotal, deel.vat, deel.total));
  if (deel.lineItems.length === 0) fail(deelIssues.noLineItems());
  if (deel.lineItems.some((item) => !isNonNegative(item.amount))) fail(deelIssues.itemAmountUnreadable());
  const itemsSum = deel.lineItems.reduce((acc, item) => acc + item.amount, 0);
  if (!near(itemsSum, deel.subtotal)) fail(deelIssues.itemsDontSum(itemsSum, deel.subtotal));
}

/** The invoice must carry the supplier's tax and bank identity. */
export function validateSupplier(supplier: BusinessProfile): void {
  const issues = supplierIssues(supplier);
  if (issues.length > 0) throw new InvoiceValidationError(issues);
}

/** Last check before rendering: totals are real positive numbers and the lines add up. */
export function validateGeneratedInvoice(invoice: GeneratedInvoice): void {
  const recheck = "Check the amounts in the review form against the Deel invoice and FIRA, then generate again.";
  const lineAmounts = invoice.lineItems.flatMap((item) => [item.rate, item.amount]);
  if (!isPositive(invoice.subtotal) || !isPositive(invoice.grandTotal) || lineAmounts.some((n) => !isNonNegative(n))) {
    fail(issue("DEEL_FIELD_UNREADABLE", "deel", "The invoice has an amount that is zero or not a number; it was not generated.", recheck, { field: "deel.total" }));
  }
  const linesSum = invoice.lineItems.reduce((acc, item) => acc + item.amount, 0);
  if (!near(linesSum, invoice.grandTotal)) {
    fail(issue("DEEL_ITEMS_DONT_SUM", "deel", "Invoice line items do not add up to the grand total; it was not generated.", recheck, { field: "deel.lineItems" }));
  }
  if (invoice.firaData) {
    const f = invoice.firaData;
    if (!isPositive(f.originalUsdBilled) || !isPositive(f.exchangeRate) || !isNonNegative(f.bankChargesUsd)) {
      fail(issue("FIRA_FIELD_UNREADABLE", "fira", "FIRA figures are incomplete; the invoice was not generated.", recheck, { field: "fira.fcyAmount" }));
    }
  }
}
