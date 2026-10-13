#!/usr/bin/env python3
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional


TABLE_NAME = "GST Invoices"

FIELDS = [
    ("Compliance Key", "singleLineText"),
    ("Compliance Metadata", "multilineText"),
    ("Workflow Version", "singleLineText"),
    ("Generated At", "singleLineText"),
    ("Deel Reference", "singleLineText"),
    ("Deel Issue Date", "singleLineText"),
    ("Deel Due Date", "singleLineText"),
    ("Deel Currency", "singleLineText"),
    ("Deel Subtotal", "singleLineText"),
    ("Deel Total", "singleLineText"),
    ("Client Country", "singleLineText"),
    ("Client VAT ID", "singleLineText"),
    ("Client Registration Number", "singleLineText"),
    ("GST Invoice Number", "singleLineText"),
    ("GST Invoice Date", "singleLineText"),
    ("GST Currency", "singleLineText"),
    ("GST Place Of Supply", "singleLineText"),
    ("GST Note", "multilineText"),
    ("LUT Financial Year", "singleLineText"),
    ("LUT Rule", "singleLineText"),
    ("SAC Code", "singleLineText"),
    ("FIRA Processed Date", "singleLineText"),
    ("FIRA USD Realized", "singleLineText"),
    ("FIRA INR Realized", "singleLineText"),
    ("Exchange Rate", "singleLineText"),
]


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip('"').strip("'")
    return values


def airtable_request(url: str, token: str, method: str = "GET", payload: Optional[dict] = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        body = error.read().decode()
        raise RuntimeError(f"{error.code}: {body}") from error


def main() -> int:
    env = load_env(Path(".env.local"))
    token = env.get("AIRTABLE_API_KEY")
    if not token:
        print("AIRTABLE_API_KEY is missing from .env.local", file=sys.stderr)
        return 1
    base_id = env.get("AIRTABLE_BASE_ID")
    if not base_id:
        print("AIRTABLE_BASE_ID is missing from .env.local", file=sys.stderr)
        return 1

    schema = airtable_request(
        f"https://api.airtable.com/v0/meta/bases/{base_id}/tables",
        token,
    )
    table = next((table for table in schema.get("tables", []) if table.get("name") == TABLE_NAME), None)
    if table is None:
        print(f"Table {TABLE_NAME!r} not found", file=sys.stderr)
        return 1

    existing = {field.get("name") for field in table.get("fields", [])}
    table_id = table["id"]

    created = 0
    for name, field_type in FIELDS:
        if name in existing:
            continue

        airtable_request(
            f"https://api.airtable.com/v0/meta/bases/{base_id}/tables/{table_id}/fields",
            token,
            method="POST",
            payload={"name": name, "type": field_type},
        )
        created += 1
        print(f"Created field: {name}")

    if created == 0:
        print("Schema already up to date.")
    else:
        print(f"Created {created} field(s).")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
