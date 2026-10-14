import { describe, expect, it } from "vitest";
import { extractDeel, extractFira } from "@/lib/extraction";
import type { Field } from "@/lib/extraction/types";
import { cellsToPdf, deelCells, FAKE_DEEL, firaCells, rng, usd, type Cell, type DeelValues } from "./layouts";

/**
 * Property: across many generated variants of the real layouts (renamed, split, wrapped, moved, dropped, garbled,
 * conflicting, decoyed, shuffled), a value returned with "high" confidence always equals what the document says.
 * A field whose value is missing, garbled or contradicted on the page has no truth: it must never be "high".
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface Check {
  name: string;
  field: Field<unknown>;
  truth: unknown;
}

function highMismatches(checks: Check[]): string[] {
  return checks.filter((c) => c.field.confidence === "high" && c.field.value !== c.truth).map((c) => `${c.name}: ${String(c.field.value)} ≠ ${String(c.truth)}`);
}

const SYNONYMS: Record<string, string[]> = {
  "label:header": ["Amount due", "Balance Due", "TOTAL", "TOTAL DUE"],
  "label:subtotal": ["Sub-total", "Subtotal", "Sub total"],
  "label:summary": ["TOTAL", "Total Amount"],
  "label:issueDate": ["Invoice Date", "Date issued"],
  "label:dueDate": ["Payment due", "Due on"],
  "label:invoiceNumber": ["Invoice No.", "Invoice number"],
};

function deelVariant(seed: number) {
  const r = rng(seed);
  const layout = r.pick(["deel-2025", "deel-2026-07"] as const);
  const month = r.int(0, 11);
  const items = [
    { description: "Fixed rate: Monthly payment", amount: r.pick([1500, 2000, 2250.5, 3000]) },
    ...(r.chance(0.4) ? [{ description: "Bonus: Annual bonus", amount: r.int(1, 2000) }] : []),
    ...(r.chance(0.3) ? [{ description: "Other: adjustment", amount: r.pick([0, 12.34, 250]) }] : []),
  ];
  const sum = Math.round(items.reduce((a, i) => a + i.amount, 0) * 100) / 100;
  const v: DeelValues = {
    ...FAKE_DEEL,
    invoiceYear: "2026",
    invoiceSeq: String(r.int(1, 12)),
    issueDate: `${MONTHS[month]} ${r.int(10, 20)}, 2026`,
    dueDate: `${MONTHS[month]} ${r.int(21, 28)}, 2026`,
    periodStart: `${MONTHS[month]} 1, 2026`,
    periodEnd: `${MONTHS[month]} 28, 2026`,
    items,
    deelRef: `DLR${r.int(1000, 9999)}X`,
  };
  const truth: Record<string, unknown> = {
    invoiceNumber: `INV-2026-${v.invoiceSeq}`,
    issueDate: v.issueDate,
    dueDate: v.dueDate,
    periodStart: v.periodStart,
    periodEnd: v.periodEnd,
    deelRef: v.deelRef,
    currency: "USD",
    headerTotal: sum,
    summaryTotal: sum,
    subtotal: sum,
    vat: 0,
  };
  const itemTruth: Record<string, number | null> = Object.fromEntries(items.map((i) => [i.description, i.amount]));
  if (r.chance(0.15)) {
    v.header = sum + r.pick([1, 100, 0.01 * r.int(2, 99)]);
    truth.headerTotal = v.header;
  }
  if (r.chance(0.1)) {
    // A subtotal that the items don't add up to; header and summary follow the subtotal
    v.subtotal = sum + 10;
    truth.subtotal = v.subtotal;
    if (v.header === undefined) truth.headerTotal = v.subtotal;
    truth.summaryTotal = v.subtotal;
  }
  let cells = deelCells(layout, v);
  const value = (role: string) => cells.find((c) => c.role === role);
  const truthKey: Record<string, string> = {
    "value:header": "headerTotal",
    "value:summary": "summaryTotal",
    "value:subtotal": "subtotal",
    "value:vat": "vat",
    "value:issueDate": "issueDate",
    "value:dueDate": "dueDate",
  };

  // Perturbations, each independent
  for (const [role, names] of Object.entries(SYNONYMS)) if (r.chance(0.08)) cells = cells.map((c) => (c.role === role ? { ...c, text: r.pick(names) } : c));
  if (r.chance(0.15)) {
    const role = r.pick(Object.keys(truthKey));
    cells = cells.filter((c) => c.role !== role);
    truth[truthKey[role]] = null;
  }
  if (r.chance(0.15)) {
    const role = r.pick(["value:header", "value:summary", "value:subtotal", "value:item:0"]);
    cells = cells.map((c) => (c.role === role ? { ...c, text: c.text.replace(/0/, "O") } : c));
    if (role === "value:item:0") itemTruth[items[0].description] = null;
    else if (value(role)?.text.includes("O")) truth[truthKey[role]] = null;
  }
  if (r.chance(0.1)) {
    const role = r.pick(["label:subtotal", "label:header"]);
    cells = cells.flatMap((c) => (c.role === role && c.text.includes(" ") ? c.text.split(" ").map((t, k) => ({ ...c, text: t, x: c.x + k * 22 })) : [c]));
  }
  if (r.chance(0.1)) cells = cells.map((c) => (c.role?.startsWith("label:") ? { ...c, text: r.chance(0.5) ? c.text.toUpperCase() : c.text.toLowerCase() } : c));
  if (r.chance(0.2)) cells.push({ text: usd(r.pick([9.99, sum, sum + 1])), x: r.int(40, 500), y: r.int(40, 120) }); // decoy amount in the footer
  if (r.chance(0.15)) {
    const decoyAfter = r.pick(["label:subtotal", "label:summary", "label:issueDate"]);
    cells = cells.flatMap((c) =>
      c.role === decoyAfter ? [c, { text: decoyAfter === "label:issueDate" ? "March 3, 2026" : usd(sum + 5), x: 300, y: 60 }] : [c],
    );
  }
  if (r.chance(0.15)) cells = [...cells].sort(() => r.next() - 0.5); // stream order unrelated to the page
  if (r.chance(0.2)) cells = cells.map((c) => ({ ...c, x: c.x + (r.next() - 0.5) * 2, y: c.y + (r.next() - 0.5) * 2 }));

  // A total exists only when header and summary agree (or only one is printed)
  const h = truth.headerTotal as number | null;
  const s = truth.summaryTotal as number | null;
  truth.total = h !== null && s !== null ? (Math.abs(h - s) < 0.005 ? s : null) : (s ?? h);
  return { cells, truth, itemTruth };
}

function firaVariant(seed: number) {
  const r = rng(seed);
  const layout = r.pick(["fira-bank-2026", "fira-bank-2026-10"] as const);
  const fcy = r.pick([1995, 2000, 3597.5, 1234.56]);
  const rate = r.pick([83.12, 88.4, 90.01]);
  const inr = Math.round(fcy * rate * 100) / 100;
  const v = {
    ref: `${r.pick(["SYN", "FAKE", "TEST"])}${r.int(100000, 999999)}REF`,
    date: `${String(r.int(10, 28)).padStart(2, "0")}-${String(r.int(1, 12)).padStart(2, "0")}-2026`,
    currency: "USD",
    fcy: fcy.toFixed(2),
    inr: inr.toFixed(2),
  };
  const truth: Record<string, unknown> = { firaRef: v.ref, processedDate: v.date, fcyAmount: fcy, inrAmount: inr, currency: "USD" };
  if (r.chance(0.1)) {
    v.inr = (inr / 100).toFixed(2); // a misplaced decimal: no plausible rate, so the amounts can't both be right
    truth.inrAmount = Number(v.inr);
  }
  let cells = firaCells(layout, v);
  const fields = ["firaRef", "processedDate", "fcyAmount", "inrAmount"];
  if (r.chance(0.15)) {
    const f = r.pick(fields);
    cells = cells.filter((c) => c.role !== `value:${f}`);
    truth[f] = null;
  }
  if (r.chance(0.1)) {
    const f = r.pick(fields);
    cells = cells.map((c) => (c.role === `value:${f}` ? { ...c, text: ": ???" } : c));
    truth[f] = null;
  }
  if (r.chance(0.1)) cells = cells.map((c) => (c.role === "label:firaRef" && c.text.endsWith("No") ? { ...c, text: "Transaction Reference No." } : c));
  if (r.chance(0.1)) cells = cells.map((c) => (c.role === "label:processedDate" ? { ...c, text: "Value Date" } : c));
  if (r.chance(0.1)) cells = cells.map((c) => (c.role?.startsWith("value:") ? { ...c, x: 60, y: c.y - 9 } : c));
  if (r.chance(0.15)) cells.push({ text: `: ${(fcy + 5).toFixed(2)}`, x: 300, y: 120 }, { text: `: ${r.int(10, 28)}-01-2026`, x: 300, y: 100 });
  if (r.chance(0.15)) cells = [...cells].sort(() => r.next() - 0.5);
  if (r.chance(0.2)) cells = cells.map((c) => ({ ...c, x: c.x + (r.next() - 0.5) * 2, y: c.y + (r.next() - 0.5) * 2 }));
  return { cells: cells as Cell[], truth };
}

describe("property: high confidence means right", () => {
  it("Deel invoices", async () => {
    const wrong: string[] = [];
    let highs = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const { cells, truth, itemTruth } = deelVariant(seed);
      const d = await extractDeel(cellsToPdf(cells));
      const checks: Check[] = [
        ...Object.keys(truth).map((k) => ({ name: k, field: d.fields[k as keyof typeof d.fields] as Field<unknown>, truth: truth[k] })),
        ...d.lineItems.map((it) => ({ name: `item ${it.description}`, field: it.amount as Field<unknown>, truth: itemTruth[it.description] ?? null })),
      ];
      highs += checks.filter((c) => c.field.confidence === "high").length;
      wrong.push(...highMismatches(checks).map((m) => `seed ${seed}: ${m}`));
    }
    expect(wrong).toEqual([]);
    expect(highs).toBeGreaterThan(500); // the property isn't vacuous: most variants still read with high confidence
  });

  it("FIRAs", async () => {
    const wrong: string[] = [];
    let highs = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const { cells, truth } = firaVariant(seed);
      const f = await extractFira(cellsToPdf(cells));
      const checks = Object.keys(truth).map((k) => ({ name: k, field: f.fields[k as keyof typeof f.fields] as Field<unknown>, truth: truth[k] }));
      highs += checks.filter((c) => c.field.confidence === "high").length;
      wrong.push(...highMismatches(checks).map((m) => `seed ${seed}: ${m}`));
    }
    expect(wrong).toEqual([]);
    expect(highs).toBeGreaterThan(200);
  });
});
