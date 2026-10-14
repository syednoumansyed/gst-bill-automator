/**
 * Every problem the app can report, as a stable code with a plain-language message and the action the user can take.
 * Codes are part of the API (UI, logs, issue reports), so never rename one; add new codes instead.
 */

export type IssueCode =
  // Upload
  | "PDF_NOT_PDF"
  | "PDF_TOO_LARGE"
  | "PDF_TOO_MANY_PAGES"
  | "PDF_TOO_MUCH_TEXT"
  | "PDF_NO_TEXT"
  | "DOC_WRONG_KIND"
  | "DOC_LAYOUT_NEW"
  // Deel invoice
  | "DEEL_FIELD_UNREADABLE"
  | "DEEL_TOTALS_DISAGREE"
  | "DEEL_ITEMS_DONT_SUM"
  | "DEEL_VAT_UNSUPPORTED"
  | "DEEL_CURRENCY_UNSUPPORTED"
  // FIRA
  | "FIRA_FIELD_UNREADABLE"
  | "FIRA_AMOUNT_MISMATCH"
  | "FIRA_DATE_MISMATCH"
  | "FIRA_RATE_IMPLAUSIBLE"
  | "MANUAL_FIRA_INVALID"
  // Review draft and settings
  | "DRAFT_INVALID"
  | "CONFIG_INCOMPLETE"
  // Request and server
  | "REQUEST_TOO_LARGE"
  | "REQUEST_FORBIDDEN"
  | "SERVER_BUSY"
  | "INTERNAL";

export type IssueDocument = "deel" | "fira" | "config" | "request";

export interface Issue {
  code: IssueCode;
  /** error: blocks issuing until fixed in the review form; warning: shown, the user may proceed */
  severity: "error" | "warning";
  document: IssueDocument;
  /** Draft field path the issue is about, e.g. "deel.total" or "fira.firaRef"; the review form highlights it */
  field?: string;
  message: string;
  /** What the user can do next, e.g. "Enter the reference from the FIRA in the field below." */
  action: string;
}

/** HTTP status for an issue code when it ends a request. */
export const ISSUE_STATUS: Record<IssueCode, number> = {
  PDF_NOT_PDF: 422,
  PDF_TOO_LARGE: 413,
  PDF_TOO_MANY_PAGES: 422,
  PDF_TOO_MUCH_TEXT: 422,
  PDF_NO_TEXT: 422,
  DOC_WRONG_KIND: 422,
  DOC_LAYOUT_NEW: 422,
  DEEL_FIELD_UNREADABLE: 422,
  DEEL_TOTALS_DISAGREE: 422,
  DEEL_ITEMS_DONT_SUM: 422,
  DEEL_VAT_UNSUPPORTED: 422,
  DEEL_CURRENCY_UNSUPPORTED: 422,
  FIRA_FIELD_UNREADABLE: 422,
  FIRA_AMOUNT_MISMATCH: 422,
  FIRA_DATE_MISMATCH: 422,
  FIRA_RATE_IMPLAUSIBLE: 422,
  MANUAL_FIRA_INVALID: 422,
  DRAFT_INVALID: 422,
  CONFIG_INCOMPLETE: 422,
  REQUEST_TOO_LARGE: 413,
  REQUEST_FORBIDDEN: 403,
  SERVER_BUSY: 503,
  INTERNAL: 500,
};

export function issue(
  code: IssueCode,
  document: IssueDocument,
  message: string,
  action: string,
  opts: { field?: string; severity?: Issue["severity"] } = {},
): Issue {
  return { code, document, message, action, severity: opts.severity ?? "error", ...(opts.field ? { field: opts.field } : {}) };
}

/** Thrown to end a request with one or more issues; the route turns it into `{ error, code, action, issues }`. */
export class IssueError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue | Issue[]) {
    const list = Array.isArray(issues) ? issues : [issues];
    super(list[0]?.message ?? "Request failed");
    this.name = "IssueError";
    this.issues = list;
  }
  get code(): IssueCode {
    return this.issues[0]?.code ?? "INTERNAL";
  }
  get status(): number {
    return ISSUE_STATUS[this.code];
  }
}

/** JSON body for a failed request. `error` stays a plain string for older clients. */
export function errorBody(issues: Issue[]) {
  const first = issues[0];
  return { error: first?.message ?? "Request failed", code: first?.code ?? "INTERNAL", action: first?.action ?? "", issues };
}
