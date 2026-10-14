import type { BusinessProfile } from "./config";
import type { InvoiceDraft } from "./draft";
import { issue, type Issue } from "./errors";

/**
 * Every cross-check a review draft must pass before an invoice is issued from it. /api/parse runs it to show problems
 * next to the fields, and /api/generate runs it again on whatever the user submits, so an edit can never skip a check.
 */

export const AMOUNT_TOLERANCE = 0.01;
/** Received USD may be at most this much below the Deel total (wire and intermediary bank fees). */
export const MAX_TRANSIT_LOSS_USD = 100;
/** A FIRA more than this many days from the Deel issue date is almost certainly for another invoice. */
export const MAX_FIRA_DAYS = 90;
export const RATE_MIN = 60;
export const RATE_MAX = 130;
/** GST started on 1 July 2017; no export invoice under it can be older. */
export const GST_START = Date.UTC(2017, 6, 1);

const DAY_MS = 24 * 60 * 60 * 1000;
const isNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const usd = (n: number) => n.toFixed(2);
const blank = (s: unknown) => typeof s !== "string" || s.trim() === "";

/**
 * Amounts are reconciled in whole cents/paise, never in floating point, so the figures that pass are exactly the
 * figures printed. An amount with a fraction of a cent is refused (the draft schema refuses it too).
 */
export const isWholeCents = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
export const toCents = (n: number) => Math.round(n * 100);
export const fromCents = (c: number) => c / 100;

const isCurrency = (value: unknown, code: string) => typeof value === "string" && value.trim().toUpperCase() === code;

const fractionOfCent = (field: string) =>
  issue("DRAFT_INVALID", field.startsWith("fira") ? "fira" : "deel", `${field}: Use at most two decimal places.`, "Enter the amount exactly as printed, with at most two decimals.", { field });

// ─── Dates ────────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** UTC midnight of a calendar date, or null when it doesn't exist (e.g. 31 February). */
function utcDate(year: number, month: number, day: number): number | null {
  const t = Date.UTC(year, month - 1, day);
  const d = new Date(t);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? t : null;
}

const monthNumber = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

/** Deel issue date: "August 21, 2026" as Deel prints it, "21 August 2026", or "2026-08-21". */
export function parseDeelDate(text: string): number | null {
  const t = text.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return utcDate(+m[1], +m[2], +m[3]);
  m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && monthNumber(m[1]) > 0) return utcDate(+m[3], monthNumber(m[1]), +m[2]);
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (m && monthNumber(m[2]) > 0) return utcDate(+m[3], monthNumber(m[2]), +m[1]);
  return null;
}

/** FIRA processed date: DD-MM-YYYY as the bank prints it, or YYYY-MM-DD from manual entry. */
export function parseFiraDate(text: string): number | null {
  const t = text.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return utcDate(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{2})[-/.](\d{2})[-/.](\d{4})$/);
  if (m) return utcDate(+m[3], +m[2], +m[1]);
  return null;
}

// ─── Deel issues (shared with the legacy checks in validateInvoice.ts) ────────

const CHECK_DEEL = "Compare it with the Deel invoice and correct it.";

export const deelIssues = {
  totalUnreadable: () =>
    issue(
      "DEEL_FIELD_UNREADABLE",
      "deel",
      "Could not read the total from the Deel invoice. Check that you uploaded a Deel invoice PDF; if you did, Deel may have changed its layout.",
      "Upload the invoice PDF from Deel (Invoices → Download), not the GST invoice this app made, or enter the Total shown on it.",
      { field: "deel.total" },
    ),
  subtotalUnreadable: () =>
    issue(
      "DEEL_FIELD_UNREADABLE",
      "deel",
      "The Deel invoice subtotal is zero or could not be read.",
      "Enter the Subtotal shown on the Deel invoice.",
      { field: "deel.subtotal" },
    ),
  vatUnreadable: () =>
    issue(
      "DEEL_FIELD_UNREADABLE",
      "deel",
      "Could not read the VAT amount from the Deel invoice.",
      "Enter the VAT amount shown on the Deel invoice (0 when it shows none).",
      { field: "deel.vat" },
    ),
  vatUnsupported: (vat: number) =>
    issue(
      "DEEL_VAT_UNSUPPORTED",
      "deel",
      `The Deel invoice includes VAT of USD ${usd(vat)}; invoices with VAT aren't supported yet.`,
      "Check the VAT row on the Deel invoice. If it shows 0, enter 0; if it really charges VAT, make this invoice by hand.",
      { field: "deel.vat" },
    ),
  currencyUnsupported: (currencies: string[]) =>
    issue(
      "DEEL_CURRENCY_UNSUPPORTED",
      "deel",
      `Only USD Deel invoices are supported; this one shows ${[...new Set(currencies)].join(", ") || "no currency"}.`,
      "Check the currency on the Deel invoice. If it isn't billed in USD, make this invoice by hand.",
      { field: "deel.currency" },
    ),
  headerSummaryDisagree: (header: number, summary: number) =>
    issue(
      "DEEL_TOTALS_DISAGREE",
      "deel",
      `Deel invoice totals disagree: header shows ${usd(header)} but the summary shows ${usd(summary)}.`,
      "Check the TOTAL at the top and the Total under the line items on the Deel invoice, then enter the right total.",
      { field: "deel.total" },
    ),
  totalsDisagree: (subtotal: number, vat: number, total: number) =>
    issue(
      "DEEL_TOTALS_DISAGREE",
      "deel",
      `Deel invoice subtotal (${usd(subtotal)}) plus VAT (${usd(vat)}) does not match its total (${usd(total)}).`,
      "Check the Subtotal, VAT and Total against the Deel invoice; Subtotal plus VAT must equal Total.",
      { field: "deel.total" },
    ),
  noLineItems: () =>
    issue(
      "DEEL_FIELD_UNREADABLE",
      "deel",
      "No recognised line items (Fixed rate, Bonus, Other) were found on the Deel invoice.",
      "Add each line of the Deel invoice with its description and amount.",
      { field: "deel.lineItems" },
    ),
  itemAmountUnreadable: (index?: number) =>
    issue(
      "DEEL_FIELD_UNREADABLE",
      "deel",
      index === undefined ? "Could not read every line-item amount from the Deel invoice." : `Could not read the amount of line item ${index + 1}.`,
      `Enter the line-item amount as the Deel invoice shows it. ${CHECK_DEEL}`,
      { field: index === undefined ? "deel.lineItems" : `deel.lineItems.${index}.amount` },
    ),
  itemsDontSum: (sum: number, subtotal: number) =>
    issue(
      "DEEL_ITEMS_DONT_SUM",
      "deel",
      `Deel line items add up to ${usd(sum)}, but the invoice subtotal is ${usd(subtotal)}.`,
      "Check each line amount and the Subtotal against the Deel invoice; the lines must add up to the Subtotal.",
      { field: "deel.subtotal" },
    ),
};

function draftDeelIssues(deel: InvoiceDraft["deel"]): Issue[] {
  const out: Issue[] = [];
  const missing = (field: string, message: string, action: string) =>
    out.push(issue("DEEL_FIELD_UNREADABLE", "deel", message, action, { field }));

  if (blank(deel.invoiceNumber)) {
    missing("deel.invoiceNumber", "The Deel invoice number is missing.", "Enter the invoice number printed at the top of the Deel invoice.");
  }
  if (blank(deel.issueDate)) {
    missing("deel.issueDate", "The Deel issue date is missing.", "Enter the Issue Date printed on the Deel invoice.");
  } else if (parseDeelDate(deel.issueDate) === null) {
    missing("deel.issueDate", "The Deel issue date isn't a real date.", "Enter the Issue Date as the Deel invoice prints it, e.g. August 21, 2026.");
  }
  if (blank(deel.clientName)) {
    missing("deel.clientName", "The client name is missing.", "Enter the client's name from the BILL TO block of the Deel invoice.");
  }
  if (!isCurrency(deel.currency, "USD")) out.push(deelIssues.currencyUnsupported([String(deel.currency ?? "").trim()]));

  /** A readable amount in whole cents, or null (with its issue recorded) */
  const cents = (value: unknown, field: string, ok: (n: number) => boolean, unreadable: () => void): number | null => {
    if (!isNumber(value) || !ok(value)) {
      unreadable();
      return null;
    }
    if (!isWholeCents(value)) {
      out.push(fractionOfCent(field));
      return null;
    }
    return toCents(value);
  };

  const total = cents(deel.total, "deel.total", (n) => n > 0, () =>
    missing("deel.total", "The Deel invoice total is zero or could not be read.", "Enter the Total shown on the Deel invoice."),
  );
  const subtotal = cents(deel.subtotal, "deel.subtotal", (n) => n > 0, () => out.push(deelIssues.subtotalUnreadable()));
  const vat = cents(deel.vat, "deel.vat", (n) => n >= 0, () => out.push(deelIssues.vatUnreadable()));
  if (vat !== null && vat !== 0) out.push(deelIssues.vatUnsupported(deel.vat));

  const items = Array.isArray(deel.lineItems) ? deel.lineItems : [];
  if (items.length === 0) out.push(deelIssues.noLineItems());
  let itemsSum: number | null = items.length > 0 ? 0 : null;
  items.forEach((item, i) => {
    if (blank(item.description)) {
      missing(`deel.lineItems.${i}.description`, `Line item ${i + 1} has no description.`, "Enter the description the Deel invoice shows for this line.");
    }
    const amount = cents(item.amount, `deel.lineItems.${i}.amount`, (n) => n >= 0, () => out.push(deelIssues.itemAmountUnreadable(i)));
    itemsSum = amount === null || itemsSum === null ? null : itemsSum + amount;
  });

  if (itemsSum !== null && subtotal !== null && itemsSum !== subtotal) {
    out.push(deelIssues.itemsDontSum(fromCents(itemsSum), deel.subtotal));
  }
  if (total !== null && subtotal !== null && vat !== null && subtotal + vat !== total) {
    out.push(deelIssues.totalsDisagree(deel.subtotal, deel.vat, deel.total));
  }
  return out;
}

// ─── FIRA issues ──────────────────────────────────────────────────────────────

const FIRA_PAIR_ACTION = "Check that this FIRA is for this Deel invoice and upload the matching pair; if a value was misread, correct it.";

function draftFiraIssues(draft: InvoiceDraft): Issue[] {
  const fira = draft.fira;
  if (!fira) return [];
  const out: Issue[] = [];
  const manual = fira.source === "manual";
  const unreadable = (field: string, what: string, pdfAction: string, manualAction: string) =>
    out.push(
      manual
        ? issue("MANUAL_FIRA_INVALID", "fira", `Enter the FIRA's ${what}.`, manualAction, { field })
        : issue("FIRA_FIELD_UNREADABLE", "fira", `Couldn't read the FIRA's ${what}.`, pdfAction, { field }),
    );

  // The draft schema defaults the FIRA currency to USD; anything else can't be paired with a USD Deel invoice
  const firaCurrency = fira.currency ?? "USD";
  if (!isCurrency(firaCurrency, "USD")) {
    out.push(
      issue(
        "FIRA_CURRENCY_UNSUPPORTED",
        "fira",
        `Only FIRAs for USD remittances are supported; this one shows ${String(firaCurrency).trim() || "no currency"}.`,
        "Check the FCY currency on your FIRA. If the money arrived in another currency, make this invoice by hand.",
        { field: "fira.currency" },
      ),
    );
  }

  let fcyOk = isNumber(fira.fcyAmount) && fira.fcyAmount > 0;
  let inrOk = isNumber(fira.inrAmount) && fira.inrAmount > 0;
  if (!fcyOk) {
    unreadable("fira.fcyAmount", "USD amount", "Enter the FCY (USD) amount shown on your FIRA.", "Enter the USD amount you received.");
  } else if (!isWholeCents(fira.fcyAmount)) {
    out.push(fractionOfCent("fira.fcyAmount"));
    fcyOk = false;
  }
  if (!inrOk) {
    unreadable("fira.inrAmount", "INR amount", "Enter the INR amount shown on your FIRA.", "Enter the USD received and the exchange rate so the INR amount can be worked out.");
  } else if (!isWholeCents(fira.inrAmount)) {
    out.push(fractionOfCent("fira.inrAmount"));
    inrOk = false;
  }
  // A bank FIRA always carries its reference; manual entries may not have one
  if (!manual && blank(fira.firaRef)) {
    out.push(
      issue("FIRA_FIELD_UNREADABLE", "fira", "Couldn't read the FIRA's reference number.", "Enter the reference shown on your FIRA in the Reference field.", {
        field: "fira.firaRef",
      }),
    );
  }

  let firaDate: number | null = null;
  if (blank(fira.processedDate)) {
    unreadable("fira.processedDate", "processed date", "Enter the Processed Date shown on your FIRA (DD-MM-YYYY).", "Enter the date the money reached you (YYYY-MM-DD).");
  } else {
    firaDate = parseFiraDate(fira.processedDate);
    if (firaDate === null) {
      out.push(
        manual
          ? issue("MANUAL_FIRA_INVALID", "fira", "FIRA date must be a real date in YYYY-MM-DD format.", "Enter the date the money reached you as YYYY-MM-DD.", { field: "fira.processedDate" })
          : issue("FIRA_FIELD_UNREADABLE", "fira", "The FIRA's processed date isn't a real date.", "Enter the Processed Date shown on your FIRA as DD-MM-YYYY.", { field: "fira.processedDate" }),
      );
    } else if (firaDate < GST_START || firaDate > Date.now() + DAY_MS) {
      out.push(
        issue(
          manual ? "MANUAL_FIRA_INVALID" : "FIRA_DATE_MISMATCH",
          "fira",
          "FIRA date must be between July 2017 and today.",
          "Check the FIRA date: it can't be before GST began (July 2017) or in the future.",
          { field: "fira.processedDate" },
        ),
      );
      firaDate = null;
    }
  }

  const deelDate = blank(draft.deel.issueDate) ? null : parseDeelDate(draft.deel.issueDate);
  if (firaDate !== null && deelDate !== null && Math.abs(firaDate - deelDate) > MAX_FIRA_DAYS * DAY_MS) {
    out.push(
      issue(
        "FIRA_DATE_MISMATCH",
        "fira",
        `Date mismatch: the FIRA is dated ${fira.processedDate.trim()}, more than ${MAX_FIRA_DAYS} days from the Deel invoice dated ${draft.deel.issueDate.trim()}.`,
        FIRA_PAIR_ACTION,
        { field: "fira.processedDate" },
      ),
    );
  }

  const total = draft.deel.total;
  if (fcyOk && isNumber(total) && total > 0 && isWholeCents(total)) {
    const lossCents = toCents(total) - toCents(fira.fcyAmount);
    if (lossCents < 0 || lossCents > MAX_TRANSIT_LOSS_USD * 100) {
      const message = lossCents < 0
        ? `Amount mismatch: the FIRA shows USD ${usd(fira.fcyAmount)} received, more than the USD ${usd(total)} Deel billed.`
        : `Amount mismatch: Deel billed USD ${usd(total)}, but the FIRA shows USD ${usd(fira.fcyAmount)} received, a gap of $${usd(fromCents(lossCents))}; bank fees are at most $${MAX_TRANSIT_LOSS_USD}.`;
      out.push(issue("FIRA_AMOUNT_MISMATCH", "fira", message, FIRA_PAIR_ACTION, { field: "fira.fcyAmount" }));
    }
  }

  if (fcyOk && inrOk) {
    const rate = fira.inrAmount / fira.fcyAmount;
    if (rate < RATE_MIN || rate > RATE_MAX) {
      out.push(
        issue(
          "FIRA_RATE_IMPLAUSIBLE",
          "fira",
          `The FIRA's amounts give an exchange rate of ${rate.toFixed(2)} INR per USD, outside the plausible ${RATE_MIN}–${RATE_MAX}.`,
          "Check the INR and USD amounts against your FIRA; one of them is probably misread.",
          { field: "fira.inrAmount" },
        ),
      );
    }
  }
  return out;
}

// ─── Supplier ─────────────────────────────────────────────────────────────────

/** The invoice must carry the supplier's tax and bank identity. */
export function supplierIssues(supplier: Partial<BusinessProfile> | undefined): Issue[] {
  const missing = [
    ["GSTIN", supplier?.gstin],
    ["PAN", supplier?.pan],
    ["bank account number", supplier?.accountNumber],
  ]
    .filter(([, value]) => !value || !String(value).trim())
    .map(([label]) => label as string);
  if (missing.length === 0) return [];
  return [
    issue(
      "CONFIG_INCOMPLETE",
      "config",
      `Business profile is missing: ${missing.join(", ")}. Fill it in under Settings.`,
      `Open Settings, fill in the ${missing.join(", ")} and save, then generate again.`,
    ),
  ];
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Errors first, otherwise in order; a repeat of the same code on the same document and field is dropped. */
export function sortIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const unique = issues.filter((i) => {
    const key = `${i.code}|${i.document}|${i.field ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...unique.filter((i) => i.severity === "error"), ...unique.filter((i) => i.severity !== "error")];
}

/** All cross-checks on a review draft: Deel totals, FIRA pairing, date window, rate plausibility, supplier settings. */
export function validateDraft(draft: InvoiceDraft, supplier: Partial<BusinessProfile> | undefined): Issue[] {
  return sortIssues([...draftDeelIssues(draft.deel), ...draftFiraIssues(draft), ...supplierIssues(supplier)]);
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === "error");
