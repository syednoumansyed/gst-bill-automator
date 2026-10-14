/**
 * Layout-mutation corpus. Synthetic (FAKE) Deel and FIRA documents are bent the ways Deel and the bank have bent
 * (and might bend) their real ones, then fed to the extraction engine and to the legacy parsers.
 *
 * Needs the extraction engine (`extractDeel` / `extractFira`); on the contract stub the engine describes fail.
 * Run with: npm run test:regression
 */
import { describe, expect, it } from "vitest";
import { extractDeel, extractFira } from "@/lib/extraction";
import { parseDeelInvoice } from "@/lib/parseDeelInvoice";
import { parseFiraPdf } from "@/lib/parseFira";
import { pdfText } from "../helpers/pdf";
import {
  allVariants,
  engineOutcome,
  legacyOutcome,
  missedKeyFields,
  neverWrongViolations,
  renderVariant,
  truthFor,
  type EngineLike,
  type Variant,
} from "../helpers/mutations";

const variants = allVariants();

/**
 * The "never wrong" property, with one allowance: a wrong value is acceptable only when the engine itself says
 * so, i.e. its confidence is "low" AND an issue names that exact field (e.g. a client name it flags as possibly
 * wrapped). Wrong at "high" or "medium", or wrong without that issue, still fails.
 */
function violations(v: Variant, res: EngineLike): string[] {
  return neverWrongViolations(v.doc, res).filter((b) => {
    const m = b.match(/^(\w+\.\w+): wrong low-confidence value$/);
    return !(m && res.issues.some((i) => i.field === m[1]));
  });
}

/** Report line for the engine: as engineOutcome, but a wrong value it flagged itself counts as flagged. */
function outcome(v: Variant, res: EngineLike): string {
  if (violations(v, res).length > 0) return engineOutcome(v.doc, res);
  const flagged = Object.keys(truthFor(v.doc)).filter(
    (k) => res.fields[k]?.value == null || neverWrongViolations(v.doc, res).some((b) => b.startsWith(`${v.doc}.${k}:`)),
  );
  return flagged.length ? `ok, flagged(${flagged.join(",")})` : "ok";
}

async function runEngine(v: Variant): Promise<EngineLike> {
  const pdf = renderVariant(v);
  return v.doc === "deel" ? await extractDeel(pdf) : await extractFira(pdf);
}

async function runLegacy(v: Variant): Promise<Record<string, unknown>> {
  const pdf = renderVariant(v);
  return (v.doc === "deel" ? await parseDeelInvoice(pdf) : await parseFiraPdf(pdf)) as unknown as Record<string, unknown>;
}

describe("corpus sanity (no engine needed)", () => {
  it("is big enough and has unique names", () => {
    expect(variants.length).toBeGreaterThanOrEqual(100);
    expect(new Set(variants.map((v) => v.name)).size).toBe(variants.length);
  });

  it("covers every mutation category for both documents", () => {
    for (const doc of ["deel", "fira"] as const) {
      const cats = new Set<string>(variants.filter((v) => v.doc === doc).map((v) => v.category));
      for (const c of ["rename", "split", "same-row", "blank-items", "case-whitespace", "reorder", "removed-value"]) {
        expect(cats.has(c), `${doc} is missing category ${c}`).toBe(true);
      }
    }
    expect(variants.some((v) => v.category === "wrapped-name")).toBe(true);
  });

  it("every variant renders a readable PDF that still contains the values it should", async () => {
    for (const v of variants) {
      const text = (await pdfText(renderVariant(v))).replace(/\s+/g, " ");
      const missing: string[] = [];
      if (v.doc === "fira") {
        for (const [name, value] of Object.entries(truthFor("fira"))) {
          const printed = typeof value === "number" ? value.toFixed(2) : String(value);
          if (!v.removed.includes(name) && !text.includes(printed)) missing.push(name);
        }
      } else {
        if (!v.removed.includes("headerTotal") && !text.includes("2,000.00")) missing.push("amounts");
        if (!v.removed.includes("deelRef") && !text.includes("SYNTHETIC")) missing.push("deelRef");
      }
      expect(missing, `variant ${v.name} lost values it should keep: ${missing.join(",")}`).toEqual([]);
    }
  });
});

describe("engine: never wrong (needs the extraction engine)", () => {
  // Property for every variant: each field is either equal to the truth, or null WITH an UNREADABLE issue for that
  // exact field path. A wrong non-null value fails unless it is low-confidence AND has an issue for its field.
  it.each(variants.map((v) => [v.name, v] as const))("%s", async (_name, v) => {
    const res = await runEngine(v);
    const bad = violations(v, res);
    expect(bad, bad.join("; ")).toEqual([]);
  });
});

describe("engine: layout-only changes stay readable (needs the extraction engine)", () => {
  // A layout change that removes nothing should not cost us the key fields: this is what "resilient" means.
  it.each(variants.filter((v) => v.benign).map((v) => [v.name, v] as const))("%s", async (_name, v) => {
    const res = await runEngine(v);
    const missed = missedKeyFields(v.doc, res);
    expect(missed, `${v.name}: key fields not read: ${missed.join(",")}`).toEqual([]);
  });
});

describe("before/after report: legacy parser vs engine (report only, never fails on a wrong value)", () => {
  it("logs variant -> old result -> engine result", async () => {
    const rows: { variant: string; old: string; engine: string }[] = [];
    for (const v of variants) {
      let old: string;
      try {
        old = legacyOutcome(v.doc, await runLegacy(v), v.removed);
      } catch (e) {
        old = `threw ${(e as Error).name}`;
      }
      let engine: string;
      try {
        engine = outcome(v, await runEngine(v));
      } catch (e) {
        engine = `threw ${(e as Error).message.slice(0, 40)}`;
      }
      rows.push({ variant: v.name, old, engine });
    }

    const oldBad = rows.filter((r) => r.old !== "ok");
    const w = Math.max(...rows.map((r) => r.variant.length));
    const lines = rows.map((r) => `${r.variant.padEnd(w)} | old: ${r.old.padEnd(44)} | engine: ${r.engine}`);
    const summary = [
      `variants: ${rows.length}`,
      `legacy ok: ${rows.length - oldBad.length}, legacy not ok: ${oldBad.length}`,
      `legacy silently WRONG (non-empty, differs): ${rows.filter((r) => r.old.includes("WRONG")).length}`,
      `legacy empty/zero without any warning: ${rows.filter((r) => r.old.includes("empty(")).length}`,
      `engine ok: ${rows.filter((r) => r.engine.startsWith("ok")).length}, engine WRONG or silent-null or threw: ${rows.filter((r) => /WRONG|SILENT|threw/.test(r.engine)).length}`,
    ];
    console.log(`\nLayout-mutation before/after\n${lines.join("\n")}\n${summary.join("\n")}\n`);
    expect(rows.length).toBe(variants.length);
  });
});
