import { InvoiceValidationError } from "./validateInvoice";

/** Server-side limits: the browser checks are only a convenience, so every request is checked here too. */
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_PAGES = 10;
const MAX_ACTIVE_RENDERS = 2;
const MAX_QUEUED_RENDERS = 8;
const MAX_ACTIVE_PARSES = 2;
const MAX_QUEUED_PARSES = 8;
const MAX_TEXT_ITEMS = 5000;

export class TooBusyError extends Error {
  constructor() {
    super("The server is busy generating other invoices. Try again in a moment.");
    this.name = "TooBusyError";
  }
}

/** Rejects anything that isn't a reasonably sized PDF before it reaches the parser. */
export function assertPdfUpload(bytes: Buffer, label: string): void {
  if (bytes.length > MAX_PDF_BYTES) {
    throw new InvoiceValidationError(`${label} is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB.`);
  }
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new InvoiceValidationError(`${label} is not a PDF file.`);
  }
}

export function assertPageCount(pages: number, label: string): void {
  if (pages > MAX_PDF_PAGES) {
    throw new InvoiceValidationError(`${label} has ${pages} pages; at most ${MAX_PDF_PAGES} are supported.`);
  }
}

/** At most `maxActive` jobs run at once and `maxQueued` wait; beyond that callers get TooBusyError. */
function createLimiter(maxActive: number, maxQueued: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxActive) {
      if (waiting.length >= maxQueued) throw new TooBusyError();
      // The finishing job hands its slot over directly, so `active` never dips and lets a newcomer jump in
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// Each render starts a Chromium; parsing is cheaper but still bounded so a burst can't exhaust memory
export const withRenderSlot = createLimiter(MAX_ACTIVE_RENDERS, MAX_QUEUED_RENDERS);
export const withParseSlot = createLimiter(MAX_ACTIVE_PARSES, MAX_QUEUED_PARSES);

/** Deel invoices and FIRAs have a few hundred text items; far more means a hostile or unsupported file. */
export function assertTextItemCount(count: number, label: string): void {
  if (count > MAX_TEXT_ITEMS) {
    throw new InvoiceValidationError(`${label} contains far more text than an invoice; it isn't supported.`);
  }
}
