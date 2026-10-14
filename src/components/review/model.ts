import type { Issue } from "@/lib/errors";
import type { InvoiceDraft } from "@/lib/draft";
import type { DeelExtraction, FiraExtraction } from "@/lib/extraction/types";

/** Response of POST /api/parse (docs/parsing.md). `skeleton` only comes back when there are issues. */
export type ParseResponse = {
  deel: DeelExtraction;
  fira: FiraExtraction | null;
  draft: InvoiceDraft;
  issues: Issue[];
  skeleton?: { deel: string; fira: string | null } | null;
};

/** Body of a failed request: `{ error, code, action, issues }`. */
export type ApiError = { error: string; code: string; action: string; issues: Issue[] };

export type FieldMeta = { level: "high" | "medium" | "low"; source: string; missing: boolean };
export type FieldState = "edited" | "high" | "medium" | "low" | "none";

/* ---------- draft paths ---------- */

export function getAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Immutable set along a dotted path; numeric segments index arrays. */
export function setAt<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const clone: unknown = Array.isArray(obj) ? [...obj] : { ...(obj as object) };
  const record = clone as Record<string, unknown>;
  record[head] = rest.length ? setAt(record[head], rest.join("."), value) : value;
  return clone as T;
}

export function fieldId(path: string) {
  return `field-${path.replace(/\./g, "-")}`;
}

/** Scalar leaves of the draft, keyed by path. */
function leaves(draft: InvoiceDraft): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(draft.deel)) {
    if (k === "lineItems") continue;
    out[`deel.${k}`] = v as string | number;
  }
  draft.deel.lineItems.forEach((item, i) => {
    out[`deel.lineItems.${i}.description`] = item.description;
    out[`deel.lineItems.${i}.amount`] = item.amount;
  });
  if (draft.fira) for (const [k, v] of Object.entries(draft.fira)) out[`fira.${k}`] = v as string | number;
  for (const [k, v] of Object.entries(draft.options)) out[`options.${k}`] = v;
  return out;
}

const same = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : String(a ?? "").trim() === String(b ?? "").trim();

/**
 * Every path whose value differs from what /api/parse returned; reverting a value removes its path again.
 * Adding or removing a line item is reported as "deel.lineItems".
 */
export function diffEdited(baseline: InvoiceDraft, current: InvoiceDraft): string[] {
  const a = leaves(baseline);
  const b = leaves(current);
  const paths = new Set<string>();
  const countChanged = baseline.deel.lineItems.length !== current.deel.lineItems.length;
  if (countChanged) paths.add("deel.lineItems");
  for (const key of Object.keys(b)) {
    if (countChanged && key.startsWith("deel.lineItems.")) continue;
    if (!(key in a) || !same(a[key], b[key])) paths.add(key);
  }
  return [...paths, ...baseline.edited.filter((p) => !paths.has(p))];
}

/** True when the set holds the path or a child of it. */
export function pathTouched(touched: ReadonlySet<string>, path: string) {
  for (const t of touched) if (t === path || t.startsWith(`${path}.`)) return true;
  return false;
}

/* ---------- confidence ---------- */

export function buildMeta(parsed: ParseResponse): Record<string, FieldMeta> {
  const meta: Record<string, FieldMeta> = {};
  type F = { value: unknown; confidence: FieldMeta["level"]; source: string } | undefined;
  const add = (path: string, f: F) => {
    if (!f) return;
    const missing = f.value === null || f.value === undefined || f.value === "";
    meta[path] = { level: missing ? "low" : f.confidence, source: f.source, missing };
  };
  const df = parsed.deel.fields as unknown as Record<string, F>;
  for (const key of Object.keys(parsed.draft.deel)) if (key !== "lineItems") add(`deel.${key}`, df[key]);
  parsed.deel.lineItems.forEach((item, i) => add(`deel.lineItems.${i}.amount`, item.amount));
  if (parsed.fira && parsed.draft.fira?.source !== "manual") {
    const ff = parsed.fira.fields as unknown as Record<string, F>;
    for (const key of ["firaRef", "processedDate", "fcyAmount", "inrAmount"]) add(`fira.${key}`, ff[key]);
  }
  return meta;
}

export function fieldState(path: string, meta: Record<string, FieldMeta>, edited: ReadonlySet<string>): FieldState {
  if (pathTouched(edited, path)) return "edited";
  // Adding or removing an item shifts the row numbers the extraction confidence was recorded for
  if (path.startsWith("deel.lineItems.") && edited.has("deel.lineItems")) return "edited";
  return meta[path]?.level ?? "none";
}

/** True when the user must tick the confirm box: any medium/low field, or any edit. */
export function needsConfirmation(meta: Record<string, FieldMeta>, edited: ReadonlySet<string>, draft: InvoiceDraft) {
  if (edited.size > 0) return true;
  return Object.keys(meta).some((p) => meta[p].level !== "high" && getAt(draft, p) !== undefined);
}

/* ---------- numbers ---------- */

export const r2 = (n: number) => Math.round(n * 100) / 100;
const n0 = (n: number) => (Number.isFinite(n) ? n : 0);

export const usd = (n: number) => `$${n0(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const inr = (n: number) => `₹${n0(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function parseAmount(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Only digits and one decimal point may be typed in an amount field; returns null for anything else. */
export function cleanAmountText(text: string): string | null {
  const t = text.replace(/,/g, "").trim();
  return /^\d*\.?\d*$/.test(t) ? t : null;
}

/* ---------- derived values and cross-checks ---------- */

export type CheckResult = { id: string; label: string; ok: boolean; detail: string; paths: string[] };

export function derive(draft: InvoiceDraft) {
  const { deel, fira } = draft;
  const itemsSum = r2(deel.lineItems.reduce((s, i) => s + i.amount, 0));
  const rate = fira && fira.fcyAmount > 0 ? fira.inrAmount / fira.fcyAmount : null;
  const bankChargesUsd = fira ? r2(deel.total - fira.fcyAmount) : null;
  return { itemsSum, rate, bankChargesUsd };
}

export function crossChecks(draft: InvoiceDraft): CheckResult[] {
  const { deel, fira } = draft;
  const { itemsSum, rate, bankChargesUsd } = derive(draft);
  const checks: CheckResult[] = [];
  const blank = (s: string) => !s.trim();

  const missing = [
    ["deel.invoiceNumber", deel.invoiceNumber],
    ["deel.issueDate", deel.issueDate],
    ["deel.clientName", deel.clientName],
  ].filter(([, v]) => blank(v));
  checks.push({
    id: "required",
    label: "Invoice number, issue date and client are filled in",
    ok: missing.length === 0,
    detail: missing.length ? `${missing.length} missing` : "",
    paths: missing.map(([p]) => p),
  });

  const noDescription = deel.lineItems
    .map((it, i) => (blank(it.description) ? `deel.lineItems.${i}.description` : ""))
    .filter(Boolean);
  checks.push({
    id: "items",
    label: "Every line item has a description",
    ok: deel.lineItems.length > 0 && noDescription.length === 0,
    detail: deel.lineItems.length === 0 ? "No line items" : "",
    paths: noDescription,
  });

  checks.push({
    id: "items-subtotal",
    label: "Line items add up to the subtotal",
    ok: Math.abs(itemsSum - r2(deel.subtotal)) < 0.005,
    detail: `${usd(itemsSum)} vs ${usd(deel.subtotal)}`,
    paths: ["deel.subtotal"],
  });
  checks.push({
    id: "subtotal-total",
    label: "Subtotal plus VAT equals the total",
    ok: deel.total > 0 && Math.abs(r2(deel.subtotal + deel.vat) - r2(deel.total)) < 0.005,
    detail: `${usd(deel.subtotal + deel.vat)} vs ${usd(deel.total)}`,
    paths: ["deel.total"],
  });

  if (fira) {
    const firaMissing = [
      ["fira.fcyAmount", fira.fcyAmount <= 0],
      ["fira.inrAmount", fira.inrAmount <= 0],
      ["fira.firaRef", fira.source === "pdf" && blank(fira.firaRef)],
      ["fira.processedDate", fira.source === "pdf" && blank(fira.processedDate)],
    ].filter(([, bad]) => bad);
    checks.push({
      id: "fira-complete",
      label: "FIRA reference, date and both amounts are filled in",
      ok: firaMissing.length === 0,
      detail: firaMissing.length ? `${firaMissing.length} missing` : "",
      paths: firaMissing.map(([p]) => p as string),
    });
    const diff = bankChargesUsd ?? 0;
    checks.push({
      id: "fira-amount",
      label: "FIRA USD is at most the Deel total, and within $100",
      ok: diff >= -0.005 && diff <= 100,
      detail: `Difference ${usd(diff)}`,
      paths: ["fira.fcyAmount"],
    });
    checks.push({
      id: "fira-rate",
      label: "Exchange rate is plausible (60 to 130 INR per USD)",
      ok: rate !== null && rate >= 60 && rate <= 130,
      detail: rate === null ? "No rate" : rate.toFixed(4),
      paths: ["fira.inrAmount"],
    });
  }
  return checks;
}

/** INR amount of each line item: proportional to the total, residual paise on the largest line (same as the server). */
export function inrSplit(draft: InvoiceDraft): number[] | null {
  const { deel, fira } = draft;
  if (!fira || fira.inrAmount <= 0 || deel.total <= 0 || deel.lineItems.length === 0) return null;
  const amounts = deel.lineItems.map((it) => Math.round(fira.inrAmount * (it.amount / deel.total) * 100) / 100);
  const diff = Math.round((fira.inrAmount - amounts.reduce((a, b) => a + b, 0)) * 100) / 100;
  if (diff !== 0) {
    let target = 0;
    amounts.forEach((a, i) => {
      if (a > amounts[target]) target = i;
    });
    amounts[target] = Math.round((amounts[target] + diff) * 100) / 100;
  }
  return amounts;
}

/* ---------- issues ---------- */

const ALIASES: Record<string, string> = {
  "deel.headerTotal": "deel.total",
  "deel.summaryTotal": "deel.total",
  "deel.lineItems": "deel.lineItems.0.description",
};

/** Draft path to focus for an issue's `field`; extraction-only names fall back to the closest draft field. */
export function issueTarget(field: string | undefined): string | null {
  if (!field) return null;
  return ALIASES[field] ?? field;
}

const TOTALS_CODES = new Set(["DEEL_TOTALS_DISAGREE", "DEEL_ITEMS_DONT_SUM", "FIRA_AMOUNT_MISMATCH", "FIRA_RATE_IMPLAUSIBLE"]);

/**
 * An error issue is resolved once the user changed the field it names. Field-less totals/FIRA issues resolve when the
 * client cross-checks pass; any other field-less error resolves after any edit. /api/generate re-checks everything.
 */
export function isErrorUnresolved(issue: Issue, touched: ReadonlySet<string>, checksOk: boolean) {
  if (issue.severity !== "error") return false;
  const target = issueTarget(issue.field);
  if (target && issue.field) return !pathTouched(touched, target) && !pathTouched(touched, issue.field);
  if (TOTALS_CODES.has(issue.code)) return !checksOk;
  return touched.size === 0;
}

export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"));
}

/** Issues from a failed request; falls back to a single issue built from `{ error, code, action }`. */
export function issuesFromError(err: ApiError): Issue[] {
  if (err.issues?.length) return err.issues;
  return [{ code: err.code as Issue["code"], severity: "error", document: "request", message: err.error, action: err.action }];
}

/* ---------- diagnostics (never includes field values or issue messages) ---------- */

export function buildDiagnostics(parsed: ParseResponse, issues: Issue[]): string {
  const codes = [...new Set(issues.map((i) => i.code))];
  const located = issues.filter((i) => i.field).map((i) => `${i.code}@${i.field}`);
  const lines = [
    "GST Bill Automator diagnostics",
    `Issue codes: ${codes.length ? codes.join(", ") : "none"}`,
    `Issue fields: ${located.length ? located.join(", ") : "none"}`,
    `Deel layout: ${parsed.deel.layout.id}${parsed.deel.layout.isNew ? " (new)" : ""}`,
    `FIRA layout: ${parsed.fira ? `${parsed.fira.layout.id}${parsed.fira.layout.isNew ? " (new)" : ""}` : "none"}`,
  ];
  if (parsed.skeleton?.deel) lines.push("", "--- Deel skeleton ---", parsed.skeleton.deel);
  if (parsed.skeleton?.fira) lines.push("", "--- FIRA skeleton ---", parsed.skeleton.fira);
  return lines.join("\n");
}

/* ---------- /api/generate response headers ---------- */

/** X-Invoice-Warnings: URI-encoded JSON array, or `|`-separated text; accept both. */
export function parseWarningsHeader(header: string | null): string[] {
  if (!header) return [];
  let text = header;
  try {
    text = decodeURIComponent(header);
  } catch {
    /* keep the raw value */
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((w): w is string => typeof w === "string" && w.length > 0);
    if (typeof parsed === "string") return [parsed];
  } catch {
    /* not JSON, fall through */
  }
  return text.split("|").map((w) => w.trim()).filter(Boolean);
}
