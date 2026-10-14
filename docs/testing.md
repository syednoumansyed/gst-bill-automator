# Testing

## Commands

| Command | What it runs |
| --- | --- |
| `npm test` | Default suite: `unit` + `chromium` projects. Synthetic data only; safe for public CI. |
| `npm run test:fast` | `unit` only (no browser). |
| `npm run test:chromium` | Renders real PDFs through Puppeteer and checks the parsers read Chrome-made PDFs. |
| `npm run test:regression` | Layout-mutation corpus (synthetic): about 140 bent Deel and FIRA layouts, run through the engine. |
| `npm run test:private` | Golden run over the real documents in `fixtures-private/`. Skips itself when that folder is absent. |

`test:regression` and `test:private` are not part of `npm test`.

Filter the private run with `npx vitest run --project private -t legacy` (the old parsers, which must always match golden) or `-t engine` (the extraction engine).

## Never wrong

The app may fail to read a field. It must never read it **wrongly** and say nothing.

- A field is either equal to the document's real value, or `null` with an issue (`DEEL_FIELD_UNREADABLE` / `FIRA_FIELD_UNREADABLE`) whose `field` is that exact path, e.g. `deel.total` or `fira.firaRef`.
- A wrong non-null value is a failure at any confidence (`high`, `medium` or `low`).
- Layout changes that remove nothing should also keep the key fields readable. That is the point of the engine.

`tests/regression/mutations.test.ts` asserts this for every variant. The same file has a report-only block that logs, per variant, what the old parser returned and what the engine returned (`ok`, `WRONG(...)`, `empty(...)`, `flagged(...)`).

## Private golden (`fixtures-private/`)

Real invoices and FIRAs. The folder is git-ignored and **never committed**.

- Lookup order: `$FIXTURES_PRIVATE_DIR`, `./fixtures-private/`, then the owner's checkout.
- `golden.json` maps each file name to its expected values, plus a `kind` (`deel-invoice`, `fira`, `lut-form`, `gst-invoice`).
- Each file runs through the legacy wrappers (`parseDeelInvoice` / `parseFiraPdf`) and the engine (`extractDeel` / `extractFira`). Non-Deel files must come back with the right `kind` and a `DOC_WRONG_KIND` issue.
- Failure messages name the file and the field only. Do not print values and do not use `toEqual` diffs here.

## When a layout changes

1. Save the new real PDF in `fixtures-private/` with a name like `deel-2026-11-deelno.pdf`.
2. Add its entry to `golden.json` with the values you checked by eye against the PDF. Do not generate it from the parser's output without checking it.
3. Run `npm run test:private`. If the engine reads it wrong or flags it, fix the engine and keep the file.
4. Add a **synthetic** mutation of the same change to `tests/helpers/mutations.ts` (fake data only), so public CI covers it. For example a new label spelling goes in the synonym lists, a new split goes in the `split` variants.
5. Run `npm run test:regression`.

## Synthetic data rules

Committed fixtures use fake data only. Any new fake identifier (GSTIN, PAN, IFSC, account number) must be added to the allowlist in `scripts/scan-pii.mjs`, and `npm run scan:pii` must pass.

## Writing a layout test

`itemsToPdf(items)` in `tests/helpers/pdf.ts` places each text item at an x/y, so label and value can share a row. The order of the array is the content-stream order that pdf.js reports, independent of position.
