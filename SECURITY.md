# Security Policy

## Reporting a vulnerability

Please report security issues privately. Use GitHub's "Report a vulnerability"
button under the Security tab of this repository (private vulnerability
reporting). Do not open a public issue, and do not include real invoices,
GSTINs, PANs, bank details or API tokens in a report.

You can expect an acknowledgement within a few days. This is a volunteer
project with no SLA.

## Supported versions

Only the latest release on the `main` branch receives fixes.

## Self-hosting guidance

This app handles tax identifiers, bank details and invoice PDFs. Treat it as
sensitive.

- Run it on your own machine or a private network. Do not expose it to the
  internet without authentication in front of it (reverse proxy auth, VPN, or
  `ADMIN_PASSWORD`).
- Never commit `.env*`, `config/business.json` or real PDFs. They are
  git-ignored; keep it that way.
- Use a least-privilege Airtable token limited to the one base, and rotate it
  if it leaks.
- Share mode (`SHARE_MODE=1`) disables settings and syncing, but anything a
  visitor uploads is processed by your server. Only enable it deliberately.
- Keep dependencies and the Docker image up to date.
