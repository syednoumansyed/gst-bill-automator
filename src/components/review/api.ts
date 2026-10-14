import type { ApiError, ParseResponse } from "./model";
import { parseWarningsHeader } from "./model";

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** Turn a non-2xx response into `{ error, code, action, issues }`, even when the body isn't the expected JSON. */
export async function readApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as Partial<ApiError>;
    if (body && typeof body === "object" && (body.error || body.code)) {
      return {
        error: body.error || `The server rejected the request (HTTP ${res.status}).`,
        code: body.code || "INTERNAL",
        action: body.action || "Check the files and try again. If it keeps failing, copy the diagnostics and report it.",
        issues: Array.isArray(body.issues) ? body.issues : [],
      };
    }
  } catch {
    /* fall through */
  }
  return {
    error: `The server returned an unexpected response (HTTP ${res.status}).`,
    code: "INTERNAL",
    action: "Try again in a moment. If it keeps failing, report it with the code shown here.",
    issues: [],
  };
}

const networkError = (): ApiError => ({
  error: "Could not reach the server.",
  code: "INTERNAL",
  action: "Check that the app is running and your connection is up, then try again.",
  issues: [],
});

export async function parseDocuments(form: FormData): Promise<Result<ParseResponse>> {
  try {
    const res = await fetch("/api/parse", { method: "POST", body: form });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    return { ok: true, data: (await res.json()) as ParseResponse };
  } catch {
    return { ok: false, error: networkError() };
  }
}

export type GenerateOutcome = {
  blob: Blob;
  fileName: string;
  syncStatus: "success" | "skipped" | "warning" | "failed";
  syncMessage: string;
  warnings: string[];
};

function decode(value: string | null) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function generateInvoice(form: FormData): Promise<Result<GenerateOutcome>> {
  try {
    const res = await fetch("/api/generate", { method: "POST", body: form });
    if (!res.ok) return { ok: false, error: await readApiError(res) };

    const raw = (res.headers.get("X-Airtable-Sync-Status") || "skipped").toLowerCase();
    const syncStatus = (["success", "skipped", "warning", "failed"].includes(raw) ? raw : "warning") as GenerateOutcome["syncStatus"];
    const fileName = /filename="?([^";]+)"?/i.exec(res.headers.get("Content-Disposition") || "")?.[1] || "Generated-GST-Invoice.pdf";
    const message = decode(res.headers.get("X-Airtable-Sync-Message"));
    const syncMessage =
      message ||
      (syncStatus === "success"
        ? "Airtable sync completed with document links and compliance metadata."
        : syncStatus === "skipped"
          ? "Airtable sync was skipped because the integration is not configured."
          : "The invoice was generated, but the Airtable sync needs attention.");

    return {
      ok: true,
      data: {
        blob: await res.blob(),
        fileName,
        syncStatus,
        syncMessage,
        warnings: parseWarningsHeader(res.headers.get("X-Invoice-Warnings")),
      },
    };
  } catch {
    return { ok: false, error: networkError() };
  }
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}
