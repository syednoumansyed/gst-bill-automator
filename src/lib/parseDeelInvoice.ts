import { DeelParsedInvoice } from "./types";
import { readDeel } from "./extraction";
import { toDeelParsed } from "./extraction/compat";

/**
 * Parse a Deel contractor invoice PDF.
 *
 * A thin wrapper over the extraction engine (src/lib/extraction), kept for the legacy /api/generate path: the
 * engine reads every field with several strategies and cross-checks the totals; this returns its values in the
 * original shape. Unreadable amounts are NaN and missing ones keep the original defaults, so validation fails
 * closed exactly as before. Conflicting values come back unreadable, never as one silently picked.
 */
export async function parseDeelInvoice(buffer: Buffer): Promise<DeelParsedInvoice> {
  return toDeelParsed(await readDeel(buffer));
}
