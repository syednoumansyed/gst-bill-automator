import { extractDeelFromText, type DeelReading } from "./deel";
import { extractFiraFromText } from "./fira";
import { skeletonOf } from "./skeleton";
import { readPdfText } from "./text";
import type { DeelExtraction, FiraExtraction, LayoutSkeleton } from "./types";

export { draftFromExtractions } from "./toDraft";

/**
 * Extraction engine entry points. Each PDF is read once, with positions, through the parse queue; upload limits
 * (pages, text items) throw from limits.ts. Reading problems come back as `issues`, never as a made-up value.
 */

export async function extractDeel(pdf: Buffer): Promise<DeelExtraction> {
  return (await readDeel(pdf)).extraction;
}

/** extractDeel plus what the legacy parseDeelInvoice wrapper needs (the currency printed with each amount). */
export async function readDeel(pdf: Buffer): Promise<DeelReading> {
  return extractDeelFromText(await readPdfText(pdf, "The Deel invoice"));
}

export async function extractFira(pdf: Buffer): Promise<FiraExtraction> {
  return extractFiraFromText(await readPdfText(pdf, "The FIRA"));
}

/** Masked labels-only view of a PDF for bug reports; never contains values. */
export async function layoutSkeleton(pdf: Buffer): Promise<LayoutSkeleton> {
  return skeletonOf(await readPdfText(pdf, "The PDF"));
}
