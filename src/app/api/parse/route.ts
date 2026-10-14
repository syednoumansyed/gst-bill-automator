import { NextRequest, NextResponse } from "next/server";
import {
  checkUploadRequest,
  DEEL_UPLOAD_ACTION,
  issueResponse,
  readDeelPdf,
  readForm,
  readPdfField,
  routeErrorResponse,
} from "@/lib/apiRequest";
import { getConfig } from "@/lib/config";
import { sortIssues, validateDraft } from "@/lib/draftValidation";
import { issue, type Issue } from "@/lib/errors";
import { draftFromExtractions, extractDeel, extractFira, layoutSkeleton } from "@/lib/extraction";
import type { DeelExtraction, DocKind, FiraExtraction } from "@/lib/extraction/types";

/**
 * Step 1 of parse → review → generate (docs/parsing.md). Reads the Deel invoice and the optional FIRA and returns
 * what was read, a prefilled review draft and every issue found. It writes nothing anywhere: no Airtable, no Blob,
 * no files. Parsing problems come back as `issues` with 200 so the review form can show them next to the fields;
 * only an unusable request (not a PDF, too large, the wrong kind of document, server busy) gets an error status.
 */
export async function POST(req: NextRequest) {
  const rejected = checkUploadRequest(req);
  if (rejected) return rejected;
  try {
    const form = await readForm(req);
    const deelPdf = await readDeelPdf(form);
    const firaPdf = await readPdfField(form, "firaFile", "The FIRA");

    const deel = await extractDeel(deelPdf);
    const fira = firaPdf ? await extractFira(firaPdf) : null;
    const wrongKind = wrongKindIssues(deel, fira);
    if (wrongKind.length > 0) {
      console.warn(`[parse] refused: ${wrongKind.map((i) => i.code).join(",")} deel=${deel.kind} fira=${fira?.kind ?? "none"}`);
      return issueResponse(wrongKind);
    }

    const draft = draftFromExtractions(deel, fira);
    const issues = sortIssues([
      ...deel.issues,
      ...(fira?.issues ?? []),
      ...validateDraft(draft, getConfig().businessProfile),
    ]);
    const skeleton = issues.length > 0 ? await skeletons(deelPdf, firaPdf) : null;

    console.info(
      `[parse] deel=${layoutLabel(deel)} fira=${fira ? layoutLabel(fira) : "none"} issues=${issues.map((i) => i.code).join(",") || "none"}`,
    );
    const response = NextResponse.json({ deel, fira, draft, issues, skeleton });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error: unknown) {
    return routeErrorResponse(error, "parse", "Failed to read the documents.");
  }
}

const layoutLabel = (doc: DeelExtraction | FiraExtraction) => `${doc.layout.id}${doc.layout.isNew ? "(new)" : ""}`;

const KIND_NAMES: Record<DocKind, string> = {
  "deel-invoice": "a Deel invoice",
  fira: "a FIRA",
  "gst-invoice": "a GST invoice",
  "lut-form": "an LUT form",
  unknown: "an unknown document",
};

/** A document in the wrong slot can't be reviewed into an invoice, so it ends the request. */
function wrongKindIssues(deel: DeelExtraction, fira: FiraExtraction | null): Issue[] {
  const reported = [...deel.issues, ...(fira?.issues ?? [])].filter((i) => i.code === "DOC_WRONG_KIND" && i.severity === "error");
  const out = [...reported];
  // "unknown" still goes through the generic strategies; only a recognisably different document is refused here
  if (!reported.some((i) => i.document === "deel") && deel.kind !== "deel-invoice" && deel.kind !== "unknown") {
    out.push(
      issue(
        "DOC_WRONG_KIND",
        "deel",
        `This is ${KIND_NAMES[deel.kind]}, not the Deel invoice.`,
        deel.kind === "fira" ? `Upload it in the FIRA field instead. ${DEEL_UPLOAD_ACTION}` : DEEL_UPLOAD_ACTION,
      ),
    );
  }
  if (fira && !reported.some((i) => i.document === "fira") && fira.kind !== "fira" && fira.kind !== "unknown") {
    out.push(
      issue(
        "DOC_WRONG_KIND",
        "fira",
        `This is ${KIND_NAMES[fira.kind]}, not the FIRA.`,
        "Upload the FIRA PDF your bank sent (Foreign Inward Remittance Certificate), or enter the FIRA details by hand.",
      ),
    );
  }
  return sortIssues(out);
}

/** Masked layouts for bug reports. They are a convenience, so a failure here never fails the parse. */
async function skeletons(deelPdf: Buffer, firaPdf: Buffer | null): Promise<{ deel: string; fira: string | null } | null> {
  try {
    return { deel: await layoutSkeleton(deelPdf), fira: firaPdf ? await layoutSkeleton(firaPdf) : null };
  } catch {
    console.warn("[parse] SKELETON_FAILED");
    return null;
  }
}
