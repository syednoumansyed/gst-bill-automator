import { NextRequest, NextResponse } from "next/server";
import { errorBody, issue, IssueError, ISSUE_STATUS, type Issue } from "./errors";
import { assertPdfUpload, MAX_REQUEST_BYTES } from "./limits";
import { guardGenerateRequest } from "./requestGuards";

/** Request plumbing shared by /api/parse and /api/generate: guards, uploads and error responses. */

export const DEEL_UPLOAD_ACTION = "Upload the invoice PDF from Deel (Invoices → Download), not the GST invoice this app made.";

/** `{ error, code, action, issues }` with the first issue's HTTP status. */
export function issueResponse(issues: Issue[]): NextResponse {
  const body = errorBody(issues);
  return NextResponse.json(body, { status: ISSUE_STATUS[body.code] ?? 500 });
}

/**
 * Same-origin and access rules of /api/generate (share mode included), then the declared upload size, before any
 * byte of the body is read.
 */
export function checkUploadRequest(req: NextRequest): NextResponse | null {
  const rejected = guardGenerateRequest(req);
  if (rejected) return rejected;
  const declaredLength = Number(req.headers.get("content-length"));
  if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
    return issueResponse([
      issue("REQUEST_LENGTH_REQUIRED", "request", "Upload size is missing.", "Upload the PDFs from the app's form, which states the upload size."),
    ]);
  }
  if (declaredLength > MAX_REQUEST_BYTES) {
    const mb = MAX_REQUEST_BYTES / 1024 / 1024;
    return issueResponse([
      issue(
        "REQUEST_TOO_LARGE",
        "request",
        `Uploads are limited to ${mb} MB in total.`,
        `Upload only the Deel invoice and its FIRA; together they must be ${mb} MB or less.`,
      ),
    ]);
  }
  return null;
}

/** The multipart body; a malformed one is the client's fault, not a server error. */
export async function readForm(req: NextRequest): Promise<FormData> {
  try {
    return await req.formData();
  } catch {
    throw new IssueError(
      issue("REQUEST_INVALID", "request", "The upload couldn't be read.", "Reload the page and upload the PDFs again."),
    );
  }
}

/** An uploaded PDF, size- and type-checked; null when the field is absent or empty. */
export async function readPdfField(form: FormData, name: string, label: string): Promise<Buffer | null> {
  const value = form.get(name);
  if (!value || typeof value === "string" || value.size === 0) return null;
  const bytes = Buffer.from(await value.arrayBuffer());
  assertPdfUpload(bytes, label);
  return bytes;
}

/** The Deel invoice upload, which every request needs. */
export async function readDeelPdf(form: FormData): Promise<Buffer> {
  const bytes = await readPdfField(form, "file", "The Deel invoice");
  if (!bytes) {
    throw new IssueError(issue("REQUEST_INVALID", "deel", "No file uploaded: choose the Deel invoice PDF.", DEEL_UPLOAD_ACTION));
  }
  return bytes;
}

/**
 * Error response for anything a route throws. Issues go back as they are; anything else can quote config or document
 * contents, so neither the response nor the log carries its message.
 */
export function routeErrorResponse(error: unknown, route: string, failure: string): NextResponse {
  if (error instanceof IssueError) {
    console.warn(`[${route}] refused: ${error.issues.map((i) => i.code).join(",")}`);
    return issueResponse(error.issues);
  }
  console.error(`[${route}] INTERNAL ${describeError(error)}`);
  return issueResponse([
    issue("INTERNAL", "request", `${failure} Check the server log for details.`, "Try again. If it keeps failing, report it with the time it happened."),
  ]);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const frames = (error.stack || "").split("\n").slice(1, 4).map((line) => line.trim()).join(" ← ");
  return `${error.name} ${frames}`;
}
