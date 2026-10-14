import { issue, IssueError } from "./errors";
import type { FiraParsedData } from "./types";

/**
 * Manual FIRA entry (e.g. from a Skydo receipt) shared by /api/parse and the legacy /api/generate form.
 * Numbers are strict: "90garbage", "-90" or "1e3" are rejected instead of being read as something else.
 */

export interface ManualFiraInput {
  receivedUsd: number | null;
  rate: number | null;
  feeInr: number;
  ref: string;
  date: string;
}

const manualIssue = (message: string, field: string, action: string) =>
  new IssueError(issue("MANUAL_FIRA_INVALID", "fira", message, action, { field }));

function parseFormattedNumber(val: FormDataEntryValue | null, label: string, field: string): number | null {
  if (val === null || (typeof val === "string" && val.trim() === "")) return null;
  const text = typeof val === "string" ? val.trim() : "";
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(text)) {
    throw manualIssue(`${label} must be a positive number.`, field, `Enter the ${label.toLowerCase()} as a plain number, e.g. 1995.00.`);
  }
  return parseFloat(text.replace(/,/g, ""));
}

const formText = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** The manual FIRA fields from a form, or null when none of the amounts were entered. Throws on malformed numbers. */
export function readManualFiraInput(form: FormData): ManualFiraInput | null {
  const receivedUsd = parseFormattedNumber(form.get("manualFiraReceivedUsd"), "USD received", "fira.fcyAmount");
  const rate = parseFormattedNumber(form.get("manualFiraRate"), "Exchange rate", "fira.inrAmount");
  const feeInr = parseFormattedNumber(form.get("manualFiraBankCharges"), "Fee", "fira.inrAmount") ?? 0;
  if (receivedUsd === null && rate === null) return null;
  return { receivedUsd, rate, feeInr, ref: formText(form, "manualFiraRef"), date: formText(form, "manualFiraDate") };
}

/**
 * Net INR = USD received × rate − fee, and the realised USD is backed out of it at the same rate.
 * The date defaults to today; validateDraft checks it like any FIRA date.
 */
export function manualFira(deelTotal: number, input: ManualFiraInput): FiraParsedData {
  const { receivedUsd, rate, feeInr } = input;
  if (!rate || !receivedUsd) {
    throw manualIssue(
      "Manual FIRA entry needs both the USD received and the exchange rate.",
      rate ? "fira.fcyAmount" : "fira.inrAmount",
      "Enter both the USD received and the exchange rate from your payment receipt.",
    );
  }
  // Same pairing rule as an uploaded FIRA: received ≤ billed, and at most $100 lost in transit
  const transitLoss = deelTotal - receivedUsd;
  if (transitLoss < 0 || transitLoss > 100) {
    throw manualIssue(
      `USD received (${receivedUsd}) doesn't match the Deel total (${deelTotal}); it should be at most $100 less.`,
      "fira.fcyAmount",
      "Check the USD received on your payment receipt, and that it is for this Deel invoice.",
    );
  }
  const netInr = receivedUsd * rate - feeInr;
  if (!(netInr > 0)) {
    throw manualIssue("The fee is larger than the converted amount.", "fira.inrAmount", "Check the fee and the exchange rate on your payment receipt.");
  }
  return {
    fcyAmount: Math.round((netInr / rate) * 100) / 100,
    inrAmount: Math.round(netInr * 100) / 100,
    firaRef: input.ref,
    processedDate: input.date || new Date().toISOString().split("T")[0],
  };
}
