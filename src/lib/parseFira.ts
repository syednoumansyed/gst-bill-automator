import { extractFira } from "./extraction";
import { toFiraParsed } from "./extraction/compat";
import { FiraParsedData } from "./types";

/**
 * Parse a FIRA (Bank Inward Remittance Certificate) PDF.
 *
 * A thin wrapper over the extraction engine (src/lib/extraction), kept for the legacy /api/generate path.
 * Values the engine couldn't read, or found more than one of, come back as 0 / "" as before.
 */
export async function parseFiraPdf(buffer: Buffer): Promise<FiraParsedData> {
  return toFiraParsed(await extractFira(buffer));
}
