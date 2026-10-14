# GST Bill Automator

Turn a Deel contractor invoice and a bank FIRA into an Indian GST export-of-services invoice PDF, in a few clicks.

> **Disclaimer: not tax or legal advice.** This software is provided "as is", without warranty of any kind (see [LICENSE](LICENSE)). GST rules, LUT conditions and bank/Deel document formats change. You are responsible for the invoices you issue. Always have every generated invoice reviewed by a Chartered Accountant before you rely on it or file anything.

## Who it is for

Indian freelancers and contractors who are paid by foreign clients through Deel and export services under a Letter of Undertaking (LUT), and who need a GST-compliant export invoice each month that matches the Deel invoice and the bank's foreign inward remittance advice (FIRA).

## Features

- Parses a Deel invoice PDF: reference, dates, client details, service period, billed amount.
- Parses a bank FIRA PDF to get the realised USD, INR credited and exchange rate. Or enter FIRA / Skydo details by hand.
- **Review before issuing:** shows every value it read with a confidence mark, flags anything doubtful with a code and what to do, and lets you correct it. Nothing is issued or synced until you confirm, and every check runs again on what you confirm.
- Generates a GST export-of-services invoice PDF under LUT (zero-rated, no IGST).
- Optional Airtable sync of invoice metadata and PDF links, to keep a compliance trail (Deel invoice, FIRA, GST invoice).
- Optional hosted "share mode" for a public demo link (see below).
- Your business profile stays on your machine in `config/business.json`.

## Supported inputs

- Deel invoice PDFs, layouts seen in 2025 to 2026.
- FIRA PDFs from banks (parsed text layouts).
- Manual FIRA or Skydo entry when you have no parseable PDF.

## Limitations

- USD invoices only.
- No VAT handling.
- LUT zero-rated exports of services only. No IGST-paying invoices, no domestic supply.
- Deel and banks change their PDF layouts from time to time. The reader is built to survive renamed, split and moved labels (see [docs/parsing.md](docs/parsing.md)); when it still can't read something, it flags the field for you to fill in rather than guessing, and when the numbers don't reconcile it refuses to issue. Use **Copy diagnostics** on the review screen (labels only, every value masked) to open an issue.
- Always compare the output with your Deel invoice and bank credit.

## Quick start with Docker

```bash
docker compose up -d
```

Then open http://localhost:3002/setup on first run to enter your business profile. Full instructions, including volumes, env vars and updates, are in [docs/docker.md](docs/docker.md).

## Local development

Requires Node (version in `.nvmrc`) and npm.

```bash
npm ci
npm run dev
```

Open http://localhost:3002/setup on first run (or the port printed by `npm run dev`).

## Configuration

1. **First run:** open http://localhost:3002/setup and fill in your business profile (legal name, GSTIN, PAN, address, bank details, LUT details, client, defaults). It is saved to `config/business.json`, which is git-ignored.
2. **Manual option:** `cp config/business.example.json config/business.json` and edit it. Keep your real values out of version control.
3. **Environment variables:** copy `.env.example` to `.env.local` (dev) or pass them to Docker. All are optional.

| Variable | Purpose |
| --- | --- |
| `AIRTABLE_API_KEY` | Airtable personal access token (records and schema read/write) |
| `AIRTABLE_BASE_ID` | Airtable base to sync into |
| `AIRTABLE_TABLE_NAME` | Airtable table name (default `GST Invoices`) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token for PDF attachments in Airtable |
| `ADMIN_PASSWORD` | Password protecting settings and the config API |
| `BUSINESS_CONFIG_JSON` | Business profile as JSON, for hosts without a writable disk |
| `SHARE_MODE` | `1` enables hosted share mode (server side) |
| `NEXT_PUBLIC_SHARE_MODE` | `1` tells the browser UI share mode is on; set with `SHARE_MODE` |
| `PUPPETEER_EXECUTABLE_PATH` | Chromium/Chrome binary used to render PDFs (preset in Docker) |
| `GST_PORT` | Host port for the Docker container (default `3002`) |

### Airtable (optional)

Create a PAT with `data.records:read`, `data.records:write`, `schema.bases:read`, `schema.bases:write`. The script `scripts/ensure_airtable_schema.py` adds the metadata columns to your table; it reads `AIRTABLE_API_KEY` and `AIRTABLE_BASE_ID` from `.env.local`.

**Attachments are public links.** With `BLOB_READ_WRITE_TOKEN` set, the Deel, FIRA and GST PDFs are uploaded to Vercel Blob with public URLs so Airtable can fetch them. Anyone who gets a URL can download the file. Leave the token unset if that's not acceptable; records still sync without attachments.

## Hosted share mode on Vercel (optional)

Set `SHARE_MODE=1` and `NEXT_PUBLIC_SHARE_MODE=1` on a Vercel project to expose the generator without login. In this mode settings and the config API are switched off, and nothing is synced to Airtable or Blob. Provide the business profile through `BUSINESS_CONFIG_JSON`.

> **Warning:** every invoice generated through a share link carries the configured business identity (GSTIN, PAN, address and bank account), and anyone with the link can generate one. Use share mode only for your own personal link, or with a demo profile containing no real data.

## Security notes

- The app handles tax IDs, bank details and invoice PDFs. Run it locally or on a private network.
- Without `ADMIN_PASSWORD`, settings and invoice generation answer only requests addressed to `localhost`. That check guards against DNS rebinding; it is **not** proof that a request came from your machine, so keep the port bound to `127.0.0.1` (the default in `docker-compose.yml`).
- Before exposing the app beyond localhost (LAN, VPN, reverse proxy, internet), set `ADMIN_PASSWORD`. A reverse proxy must pass the original `Host` header through.
- Uploads are limited to 5 MB per PDF and 10 pages, and at most two invoices render at once.
- Wrong-password throttling (5 per minute) is kept in memory, so it holds for the single-container setup this project ships. If you run several instances behind a load balancer, add rate limiting at the proxy.
- Never commit `.env*`, `config/business.json` or real PDFs. Do not attach them to issues.
- Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## Verification

```bash
npm run lint
npx tsc --noEmit
npm run build
```

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). Released under the [MIT License](LICENSE).
