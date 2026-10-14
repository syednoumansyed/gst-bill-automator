import type { InvoiceDraft } from "../draft";
import type { DeelExtraction, FiraExtraction, LayoutSkeleton } from "./types";

/**
 * Extraction engine entry points. Contract only: the engine replaces these bodies.
 * Upload limits (size, pages, text items) still throw IssueError with the PDF_* codes.
 */

export async function extractDeel(_pdf: Buffer): Promise<DeelExtraction> {
  throw new Error("extractDeel: not implemented");
}

export async function extractFira(_pdf: Buffer): Promise<FiraExtraction> {
  throw new Error("extractFira: not implemented");
}

/** Masked labels-only view of a PDF for bug reports; never contains values. */
export async function layoutSkeleton(_pdf: Buffer): Promise<LayoutSkeleton> {
  throw new Error("layoutSkeleton: not implemented");
}

/** First review draft from the extractions: unreadable fields become "" or 0 and are flagged by the issues. */
export function draftFromExtractions(_deel: DeelExtraction, _fira: FiraExtraction | null): InvoiceDraft {
  throw new Error("draftFromExtractions: not implemented");
}
