# Reading Deel invoices and FIRAs

Deel and the banks change their PDF layouts without notice. The app is built to survive that, and when it can't, to stop and ask instead of issuing a wrong invoice.

## Flow

1. **Parse** (`POST /api/parse`): multipart `file` (Deel invoice) and optional `firaFile`. Reads both PDFs and writes nothing anywhere. Returns `200`:
   ```jsonc
   {
     "deel": DeelExtraction,          // src/lib/extraction/types.ts
     "fira": FiraExtraction | null,
     "draft": InvoiceDraft,           // src/lib/draft.ts, prefilled for the review form
     "issues": Issue[],               // src/lib/errors.ts, all documents, errors first
     "skeleton": { "deel": string, "fira": string | null } // only when there are issues; masked layouts for bug reports
   }
   ```
   Parsing problems are returned as `issues` with `200`, so the form can show them next to the fields. Only an unusable request ends with an error status: not a PDF, too large, the wrong document type, or the server is busy.
2. **Review** (UI): shows each value with its confidence, highlights fields named by `issue.field`, and shows `issue.action`. The user corrects and confirms. Every changed path goes into `draft.edited`.
3. **Generate** (`POST /api/generate`): multipart `draft` (JSON) plus the same `file`/`firaFile`, which are needed only as attachments.
   - Re-validates the draft with every cross-check (totals reconcile, FIRA pairing, date window, rate plausibility). Edits never bypass a check.
   - Renders the PDF. **Only after rendering succeeds** does it upload attachments and write Airtable. If the Airtable write fails, it deletes the attachments it just uploaded.
   - No partial entries.
   - **Legacy:** a request without `draft` is parsed and validated inline, exactly as before.

## Errors

Every failure is `{ error, code, action, issues }`, with the HTTP status from `ISSUE_STATUS`. `error` is the first issue's message, kept for older clients. Logs record codes and layout ids only, never document contents.

## Extraction engine (`src/lib/extraction/`)

- Works on pdf.js text items **with positions**. For each field it tries several strategies: label then value to the right, label then value below, label split over several items, and value-shape search. It keeps candidates that pass the field's shape check.
- **Label synonyms per field**, matched case- and space-insensitively. Examples: `TOTAL DUE` / `TOTAL` / `Amount due`; `Customer Transaction Reference [No]`.
- **Cross-checks choose between candidates:**
  - header total = summary total = Σ items = subtotal + VAT;
  - FIRA USD ≤ Deel total and within $100;
  - INR/USD rate between 60 and 130;
  - the dates are in order.
- **Confidence:**
  - `high`: a known layout plus a passed cross-check;
  - `medium`: one strategy and no conflict;
  - `low`: a pattern guess or conflicting candidates.
- **Layout fingerprints** (`deel-2025`, `deel-2026-07`, `fira-bank-2026`, `fira-bank-2026-10`). An unknown layout still goes through the generic strategies, and the result carries a `DOC_LAYOUT_NEW` warning.
- **Document kind detection:** a GST tax invoice or LUT form uploaded as the Deel invoice gets `DOC_WRONG_KIND`.

## Regression

- `npm test` runs synthetic layouts, including renamed, split, reordered and wrapped labels.
- `npm run test:private` runs every real document in the git-ignored `fixtures-private/` against `fixtures-private/golden.json`. Values are compared, never printed.
