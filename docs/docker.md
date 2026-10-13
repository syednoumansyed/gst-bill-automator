# Running with Docker

The image bundles the app and a system Chromium (used to render the invoice PDF). One command builds and starts it.

## Quick start

```bash
cp config/business.example.json config/business.json   # then edit it, or fill it in on the Settings page
docker compose up -d --build
```

Open <http://localhost:3002>. Change the port with `GST_PORT`, for example `GST_PORT=3010 docker compose up -d`.

`config/business.json` holds your business, bank and client details. It lives in `./config` on the host, which is mounted into the container, so the Settings page saves straight to it.

### Optional environment (`.env.local`)

Create `.env.local` next to `docker-compose.yml` if you want any of these. Compose reads it only if it exists. Leave it out and Airtable sync stays off.

| Variable | Purpose |
| --- | --- |
| `AIRTABLE_API_KEY` | Airtable token for invoice sync |
| `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE_NAME` | Override the base and table from `business.json` |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token for uploading the PDFs |
| `ADMIN_PASSWORD` | Optional. Required before the app is reachable from anywhere but this machine; protects setup, settings, the config API and invoice generation |

Edits to `.env.local` need `docker compose up -d` again to take effect.

## Updating

```bash
git pull && docker compose up -d --build
```

`./config` and `.env.local` are not part of the image, so nothing is lost.

## Backup

Everything worth keeping is in `./config`:

```bash
tar czf gst-config-$(date +%F).tgz config .env.local
```

Keep that archive private: it contains your GSTIN, bank details and tokens.

## Logs and status

```bash
docker compose logs -f
docker compose ps          # shows "healthy" once the app answers
docker compose down        # stop and remove the container (config is kept)
```

## Security notes

- The port is published on `127.0.0.1` only, so only this machine can reach it. Without `ADMIN_PASSWORD`, settings and invoice generation answer only requests addressed to `localhost`; that blocks DNS-rebinding pages but is not proof a request is local, so don't change the bind to `0.0.0.0`, forward the port, or put it behind a tunnel or reverse proxy without setting `ADMIN_PASSWORD`. Tokens are read from `.env.local` only and never returned by the API.
- The container runs as the non-root `node` user (uid 1000) with:
  - `cap_drop: [ALL]` and `no-new-privileges`, so the process has no Linux capabilities and cannot gain any.
  - A read-only root filesystem. The only writable places are `./config` (bind mount), and tmpfs mounts for `/tmp` and `/app/.next/cache`. Nothing written there survives a restart.
  - Limits of 1.5 GB memory, 2 CPUs and 256 processes, so a runaway PDF render cannot starve the host.
- Chromium is launched with `--no-sandbox` because its own sandbox needs privileges that the container drops. The container boundary and the restrictions above are what contain it. Only upload PDFs you trust.
- No secrets are baked into the image: `.dockerignore` keeps `.env*`, `config/*.json` (except the example), PDFs and local backups out of the build context.
- On Linux, if `./config` is owned by a user other than uid 1000, either `sudo chown -R 1000:1000 config` or set `GST_UID` and `GST_GID` to your own ids before `docker compose up`. Docker Desktop on macOS needs neither.

## Migrating from the old container

If you previously ran the app as a plain `docker run` container named `gst-bill-automator-app` on port 3002, switch like this. Run these yourself, in order. Stopping (not removing) the old container keeps it for rollback.

```bash
# 1. stop the old container but keep it and its image
docker stop gst-bill-automator-app

# 2. copy your existing business.json (and .env.local, if you used one) into this folder
#    cp /path/to/old/config/business.json config/business.json

# 3. start the new setup (it uses the same port, 3002, and your ./config)
docker compose up -d --build
docker compose ps
```

To roll back:

```bash
docker compose down
docker start gst-bill-automator-app
```

Once you are happy with the new setup, remove the old container with `docker rm gst-bill-automator-app`. Old images such as `gst-bill-automator:latest` can stay until you want the disk space back.
