/**
 * Private golden regression over REAL documents. Reads every PDF in fixtures-private/ and compares against
 * golden.json. The folder is git-ignored: this project skips itself when it is absent (public CI).
 *
 * Failure messages name the file and the field, never a value. Do not "improve" them with toEqual diffs.
 *
 *   npm run test:private                           both halves
 *   npx vitest run --project private -t legacy     legacy wrappers only (must always match golden)
 *   npx vitest run --project private -t engine     extraction engine only
 *
 * Folder lookup order: $FIXTURES_PRIVATE_DIR, repo-relative fixtures-private/, then the owner's checkout.
 */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { extractDeel, extractFira } from "@/lib/extraction";
import { parseDeelInvoice } from "@/lib/parseDeelInvoice";
import { parseFiraPdf } from "@/lib/parseFira";

function findFixturesDir(): string | null {
  const candidates = [
    process.env.FIXTURES_PRIVATE_DIR,
    path.resolve(__dirname, "../../../fixtures-private"),
    "/Users/apple/Downloads/gst/fixtures-private",
  ].filter((d): d is string => !!d);
  return candidates.find((d) => fs.existsSync(path.join(d, "golden.json"))) ?? null;
}

const dir = findFixturesDir();
type Golden = Record<string, Record<string, unknown> & { kind: string }>;
const golden: Golden = dir ? JSON.parse(fs.readFileSync(path.join(dir, "golden.json"), "utf8")) : {};
const files = Object.keys(golden).sort();
const deelFiles = files.filter((f) => golden[f].kind === "deel-invoice");
const firaFiles = files.filter((f) => golden[f].kind === "fira");
const otherFiles = files.filter((f) => !deelFiles.includes(f) && !firaFiles.includes(f));

const pdf = (f: string) => fs.readFileSync(path.join(dir as string, f));

function same(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "number" && typeof expected === "number") return Math.abs(actual - expected) < 0.005;
  return isDeepStrictEqual(actual, expected);
}

/** Golden fields (except `kind` / `lineItems`) that differ. Names only. */
function differingFields(file: string, actual: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const [k, expected] of Object.entries(golden[file])) {
    if (k === "kind" || k === "lineItems") continue;
    if (!same(actual[k], expected)) bad.push(k);
  }
  return bad;
}

function lineItemsDiffer(file: string, actual: { description: string; amount: number }[]): boolean {
  const expected = golden[file].lineItems as { description: string; amount: number }[] | undefined;
  if (!expected) return false;
  return (
    expected.length !== actual.length ||
    expected.some((e, i) => e.description !== actual[i].description || !same(actual[i].amount, e.amount))
  );
}

function fieldCount(file: string): number {
  return Object.keys(golden[file]).filter((k) => k !== "kind").length;
}

/** Prints pass/fail per file and names the failing fields; throws with names only. */
function report(file: string, bad: string[], total: number): void {
  console.log(`${bad.length ? "FAIL" : "ok  "} ${file}: ${total - bad.length}/${total} fields${bad.length ? ` (differs: ${bad.join(", ")})` : ""}`);
  if (bad.length) throw new Error(`${file}: field(s) differ from golden: ${bad.join(", ")}`);
}

describe.skipIf(!dir)("private golden", () => {
  it("golden.json lists the expected 21 documents", () => {
    expect(files.length, "golden.json document count").toBe(21);
    expect(deelFiles.length, "deel invoice count").toBe(11);
    expect(firaFiles.length, "fira count").toBe(8);
    expect(otherFiles.length, "non-deel count").toBe(2);
  });

  describe("legacy wrappers (parseDeelInvoice / parseFiraPdf): must always match golden", () => {
    it.each(deelFiles)("%s", async (file) => {
      const parsed = (await parseDeelInvoice(pdf(file))) as unknown as Record<string, unknown>;
      const bad = differingFields(file, parsed);
      if (lineItemsDiffer(file, parsed.lineItems as { description: string; amount: number }[])) bad.push("lineItems");
      report(file, bad, fieldCount(file));
    });

    it.each(firaFiles)("%s", async (file) => {
      const parsed = (await parseFiraPdf(pdf(file))) as unknown as Record<string, unknown>;
      report(file, differingFields(file, parsed), fieldCount(file));
    });

    // The legacy parser has no notion of "wrong document"; it must at least not invent an invoice from these.
    it.each(otherFiles)("%s (not a Deel invoice: yields no invoice data)", async (file) => {
      let invented = false;
      try {
        const p = await parseDeelInvoice(pdf(file));
        invented = p.total > 0 || p.lineItems.length > 0;
      } catch {
        // throwing is fine too
      }
      report(file, invented ? ["total"] : [], 1);
    });
  });

  describe("engine (extractDeel / extractFira): needs the extraction engine merged", () => {
    it.each(deelFiles)("%s", async (file) => {
      const res = await extractDeel(pdf(file));
      const actual: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(res.fields)) actual[k] = f.value;
      const bad = differingFields(file, actual);
      if (res.kind !== golden[file].kind) bad.push("kind");
      const items = res.lineItems.map((l) => ({ description: l.description, amount: l.amount.value ?? Number.NaN }));
      if (lineItemsDiffer(file, items)) bad.push("lineItems");
      report(file, bad, fieldCount(file));
    });

    it.each(firaFiles)("%s", async (file) => {
      const res = await extractFira(pdf(file));
      const actual: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(res.fields)) actual[k] = f.value;
      const bad = differingFields(file, actual);
      if (res.kind !== golden[file].kind) bad.push("kind");
      report(file, bad, fieldCount(file));
    });

    it.each(otherFiles)("%s (wrong kind: kind plus DOC_WRONG_KIND)", async (file) => {
      const res = await extractDeel(pdf(file));
      const bad: string[] = [];
      if (res.kind !== golden[file].kind) bad.push("kind");
      if (!res.issues.some((i) => i.code === "DOC_WRONG_KIND")) bad.push("issues:DOC_WRONG_KIND");
      report(file, bad, 2);
    });
  });
});
