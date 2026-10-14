import { issue, type Issue } from "../errors";
import { confidenceOf, missing, near, toField } from "./fields";
import { detectKind, matchLayout, newLayoutIssue, noTextIssue, wrongKindIssue } from "./kind";
import type { LabelField } from "./labels";
import { legacyFira } from "./legacy";
import { parseAmount, parseCurrencyCode, parseNumericDate, parseReference, REFERENCE_PATTERN, stripColon } from "./shapes";
import { findLabels, readAtLabels, resolve, type Candidate, type LabelHit, type Resolved } from "./strategies";
import { sequentialLines, type PdfText } from "./text";
import type { DocKind, FiraExtraction, LayoutMatch } from "./types";

/**
 * Bank FIRA: reference, processed date and the two amounts, each read at its label (right, below, split or inline),
 * by the sequential reader, and by value shape when no label is found. INR / FCY must be a plausible rate.
 */

const FIRA_FIELDS: LabelField[] = ["fira.firaRef", "fira.processedDate", "fira.fcyAmount", "fira.inrAmount", "fira.currency"];

/** INR per USD the app accepts as a real conversion; anything outside is a misread amount */
export const RATE_MIN = 60;
export const RATE_MAX = 130;

const NAMES: Record<string, string> = {
  firaRef: "reference number",
  processedDate: "processed date",
  fcyAmount: "USD (FCY) amount",
  inrAmount: "INR amount",
  currency: "currency",
};

const unreadable = (field: string, conflict = false) =>
  issue(
    "FIRA_FIELD_UNREADABLE",
    "fira",
    conflict
      ? `The FIRA shows more than one ${NAMES[field]}, and the app can't tell which is right.`
      : `Couldn't read the FIRA's ${NAMES[field]}.`,
    `Check the FIRA PDF and enter the ${NAMES[field]} in the field below.`,
    { field: `fira.${field}` },
  );

function emptyFira(kind: DocKind, layout: LayoutMatch, issues: Issue[]): FiraExtraction {
  return {
    kind,
    layout,
    fields: { firaRef: missing(), processedDate: missing(), fcyAmount: missing(), inrAmount: missing(), currency: missing() },
    issues,
  };
}

const seq = <T>(value: T | null): Candidate<T>[] => (value === null ? [] : [{ value, source: "sequential", kind: "sequential" }]);
const positive = (n: number) => (Number.isFinite(n) && n > 0 ? n : null);
const plausibleRate = (fcy: number, inr: number) => fcy > 0 && inr / fcy >= RATE_MIN && inr / fcy <= RATE_MAX;

/** Strategy (d): values recognised by shape alone, used only for a field whose label isn't on the page. */
function patternCandidates(text: PdfText, labelled: Record<string, boolean>) {
  const values = text.items.map((i) => stripColon(i.str).trim());
  const ref: Candidate<string>[] = labelled.firaRef
    ? []
    : values
        .filter((v) => REFERENCE_PATTERN.test(v) && /\d/.test(v) && /[A-Z]/.test(v))
        .map((value) => ({ value, source: "pattern:reference", kind: "pattern" as const }));
  const date: Candidate<string>[] = labelled.processedDate
    ? []
    : values.flatMap((v) => {
        const d = parseNumericDate(v);
        return d ? [{ value: d, source: "pattern:date", kind: "pattern" as const }] : [];
      });
  // Two bare amounts whose ratio is a plausible INR/USD rate: the smaller is USD, the larger INR
  const amounts: { fcy: Candidate<number>[]; inr: Candidate<number>[] } = { fcy: [], inr: [] };
  if (!labelled.fcyAmount && !labelled.inrAmount) {
    const nums = [...new Set(values.filter((v) => v.includes(".")).map(parseAmount).filter((n): n is number => n !== null && n > 0))];
    for (const fcy of nums) {
      for (const inr of nums) {
        if (fcy !== inr && plausibleRate(fcy, inr)) {
          amounts.fcy.push({ value: fcy, source: "pattern:amount-pair", kind: "pattern" });
          amounts.inr.push({ value: inr, source: "pattern:amount-pair", kind: "pattern" });
        }
      }
    }
  }
  return { ref, date, ...amounts };
}

export function extractFiraFromText(text: PdfText): FiraExtraction {
  if (text.items.length === 0) return emptyFira("unknown", { id: "none", isNew: false }, [noTextIssue("fira")]);
  const detected = detectKind(text);
  if (detected === "deel-invoice" || detected === "gst-invoice" || detected === "lut-form") {
    return emptyFira(detected, matchLayout(text, detected), [wrongKindIssue(detected, "fira")]);
  }

  const layout = matchLayout(text, "fira");
  const knownLayout = !layout.isNew;
  const legacy = legacyFira(sequentialLines(text));
  const hits = findLabels(text, FIRA_FIELDS);
  const hitsFor = (f: LabelField): LabelHit[] => hits.filter((h) => h.field === f);
  const issues: Issue[] = [];

  const ref = readAtLabels(text, hitsFor("fira.firaRef"), parseReference);
  const date = readAtLabels(text, hitsFor("fira.processedDate"), parseNumericDate);
  const fcy = readAtLabels(text, hitsFor("fira.fcyAmount"), parseAmount);
  const inr = readAtLabels(text, hitsFor("fira.inrAmount"), parseAmount);
  const cur = readAtLabels(text, hitsFor("fira.currency"), parseCurrencyCode);
  const labelled = {
    firaRef: hitsFor("fira.firaRef").length > 0,
    processedDate: hitsFor("fira.processedDate").length > 0,
    fcyAmount: hitsFor("fira.fcyAmount").length > 0,
    inrAmount: hitsFor("fira.inrAmount").length > 0,
  };
  const pattern = patternCandidates(text, labelled);

  // The sequential reader takes whatever follows ": ", and its values pass the same shape checks. It is not
  // used for a label that is on the page with nothing readable beside or below it: that "next line" is another cell.
  const seqIf = <T>(r: { candidates: unknown[]; unreadable: unknown[] }, value: T | null) =>
    r.candidates.length === 0 && r.unreadable.length > 0 ? [] : seq(value);
  const refRes = resolve([...ref.candidates, ...seqIf(ref, parseReference(legacy.firaRef)), ...pattern.ref]);
  const dateRes = resolve([...date.candidates, ...seqIf(date, parseNumericDate(legacy.processedDate)), ...pattern.date]);
  const seqAmount = (raw: string | undefined) => positive(parseAmount(raw ?? "") ?? NaN);
  const fcyCands = [...fcy.candidates, ...seqIf(fcy, seqAmount(legacy.raw.fcyAmount)), ...pattern.fcy];
  const inrCands = [...inr.candidates, ...seqIf(inr, seqAmount(legacy.raw.inrAmount)), ...pattern.inr];
  let fcyRes: Resolved<number> = resolve(fcyCands, near);
  let inrRes: Resolved<number> = resolve(inrCands, near);

  // Differing amounts: keep the pair that makes a plausible rate, if exactly one does. Only amounts read beside
  // their label can be chosen; the check never promotes the sequential reader's guess over a label's value.
  if (fcyRes.conflict || inrRes.conflict) {
    const atLabel = (cands: Candidate<number>[]) => (n: number) => cands.some((c) => c.kind === "label" && near(c.value, n));
    const fcys = fcyRes.conflict ? fcyRes.distinct.filter(atLabel(fcyCands)) : fcyRes.value !== null ? [fcyRes.value] : [];
    const inrs = inrRes.conflict ? inrRes.distinct.filter(atLabel(inrCands)) : inrRes.value !== null ? [inrRes.value] : [];
    const pairs = fcys.flatMap((f) => inrs.filter((i) => plausibleRate(f, i)).map((i) => [f, i] as const));
    if (pairs.length === 1) {
      fcyRes = resolve(fcyCands, near, () => pairs[0][0]);
      inrRes = resolve(inrCands, near, () => pairs[0][1]);
    }
  }

  const fcyValue = fcyRes.value;
  const inrValue = inrRes.value;
  const rateChecked = fcyValue !== null && inrValue !== null && plausibleRate(fcyValue, inrValue);
  const rateFailed = fcyValue !== null && inrValue !== null && !rateChecked;

  const idConfidence = (r: Resolved<string>) => confidenceOf(r, { knownLayout, checked: r.agreeing >= 2 });
  const firaRef = toField(refRes, idConfidence(refRes), ref.unreadable[0]?.text);
  const processedDate = toField(dateRes, idConfidence(dateRes), date.unreadable[0]?.text);
  const fcyAmount = toField(fcyRes, confidenceOf(fcyRes, { knownLayout, checked: rateChecked, failed: rateFailed }), fcy.unreadable[0]?.text);
  const inrAmount = toField(inrRes, confidenceOf(inrRes, { knownLayout, checked: rateChecked, failed: rateFailed }), inr.unreadable[0]?.text);
  const curRes = resolve(cur.candidates);
  const currency = toField(curRes, confidenceOf(curRes, { knownLayout, checked: rateChecked && curRes.value === "USD" }), cur.unreadable[0]?.text);

  if (currency.value !== null && currency.value !== "USD") {
    issues.push(
      issue(
        "FIRA_CURRENCY_UNSUPPORTED",
        "fira",
        `The FIRA is for ${currency.value}; only USD remittances are supported.`,
        "Check that this is the FIRA for the Deel invoice; only USD remittances can be matched.",
        { field: "fira.currency" },
      ),
    );
  } else if (currency.value === null) {
    // Every bank FIRA prints its currency; without it the amounts can't be taken as USD
    issues.push({ ...unreadable("currency", curRes.conflict), severity: cur.unreadable.length > 0 || curRes.conflict ? "error" : "warning" });
  }
  if (firaRef.value === null) issues.push(unreadable("firaRef", refRes.conflict));
  if (processedDate.value === null) issues.push(unreadable("processedDate", dateRes.conflict));
  if (fcyAmount.value === null) issues.push(unreadable("fcyAmount", fcyRes.conflict));
  if (inrAmount.value === null) issues.push(unreadable("inrAmount", inrRes.conflict));
  if (rateFailed) {
    issues.push(
      issue(
        "FIRA_RATE_IMPLAUSIBLE",
        "fira",
        `The FIRA's INR amount (${inrValue}) for ${fcyValue} USD is a rate of ${(inrValue! / fcyValue!).toFixed(2)}, outside ${RATE_MIN} to ${RATE_MAX}; one of the amounts was probably misread.`,
        "Check both amounts against the FIRA PDF and correct them below.",
        { field: "fira.inrAmount" },
      ),
    );
  }

  // Not a FIRA we can recognise and nothing read: say so instead of returning scraps
  const found = [firaRef, processedDate, fcyAmount, inrAmount].filter((f) => f.value !== null).length;
  if (detected === "unknown" && found === 0) return emptyFira("unknown", layout, [wrongKindIssue("unknown", "fira")]);

  if (layout.isNew) issues.unshift(newLayoutIssue("fira"));
  issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return { kind: "fira", layout, fields: { firaRef, processedDate, fcyAmount, inrAmount, currency }, issues };
}
