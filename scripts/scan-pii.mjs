#!/usr/bin/env node
/**
 * PII guard: fails if any tracked text file contains something shaped like a real Indian
 * GSTIN, PAN, IFSC code or bank account number, other than the fake values allowlisted below.
 *
 * Run: node scripts/scan-pii.mjs   (CI runs it on every push)
 * To add a new fake example to a fixture or the docs, add it to ALLOWED below.
 * Matches are printed masked, never in full.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ALLOWED = new Set([
  // fixtures used by tests/** and examples in the docs
  "29ABCDE1234F1Z5", // GSTIN
  "ABCDE1234F", // PAN
  "EXMP0000001", // IFSC
  "000111222333", // bank account
  "29ABCDE1234F1ZW", // GSTIN with a valid checksum (config example)
  "EXMP0001234", // IFSC (config example)
  "TEST0001234", // IFSC (config tests)
  "OTHR0005678", // IFSC (config tests)
  "111122223333", // bank account (config tests)
  "444455556666", // bank account (config tests)
  "HDFC0001234", // IFSC placeholder in the settings form
  "45ABCDE1234F1ZW", // GSTIN with a wrong state code (config tests)
  "ABCDE9999F", // PAN (config tests)
  // obvious placeholders
  "22AAAAA0000A1Z5",
  "27AAAAA0000A1Z5",
  "AAAAA0000A",
  "XXXX0000000",
  "ABCD0123456",
  "123456789012",
  "000000000000",
  "1234567890",
]);

const PATTERNS = [
  { kind: "GSTIN", re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g },
  { kind: "PAN", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { kind: "IFSC", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  // 9 to 18 digits that follow an account keyword on the same line
  { kind: "bank account", re: /(?:account|a\/c|acct)[^\n\d]{0,40}(\d{9,18})\b/gi, group: 1 },
];

const SKIP_FILES = new Set(["package-lock.json"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|pdf|woff2?|ttf|otf|eot|zip|gz|mp4|mov)$/i;

const mask = (v) => `${v.slice(0, 2)}${"*".repeat(Math.max(0, v.length - 4))}${v.slice(-2)}`;

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((f) => f && !SKIP_FILES.has(path.basename(f)) && !BINARY.test(f));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  if (text.includes("\0")) continue; // binary
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const { kind, re, group = 0 } of PATTERNS) {
      for (const m of line.matchAll(re)) {
        const value = m[group];
        if (!ALLOWED.has(value)) findings.push(`${file}:${i + 1}  ${kind}  ${mask(value)}`);
      }
    }
  });
}

if (findings.length > 0) {
  console.error(`PII scan: ${findings.length} possible real identifier(s) in tracked files:\n`);
  for (const f of findings) console.error(`  ${f}`);
  console.error("\nUse a fake value from ALLOWED in scripts/scan-pii.mjs, or add a new fake there.");
  process.exit(1);
}
console.log(`PII scan: ${files.length} tracked files clean.`);
