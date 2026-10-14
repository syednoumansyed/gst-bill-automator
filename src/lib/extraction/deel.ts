import { issue, type Issue } from "../errors";
import { confidenceOf, missing, near, toField } from "./fields";
import { detectKind, matchLayout, newLayoutIssue, noTextIssue, wrongKindIssue } from "./kind";
import { LINE_ITEM_PREFIX, type LabelField } from "./labels";
import { legacyDeel, readBillFrom, readBillTo, readPeriod } from "./legacy";
import { dateValue, isPercent, parseInvoiceNumber, parseLongDate, parseMoney, type Money } from "./shapes";
import {
  anchorOf,
  findLabels,
  readAtLabels,
  readBelow,
  readRight,
  resolve,
  type Candidate,
  type LabelHit,
  type Resolved,
} from "./strategies";
import { sequentialLines, type PdfText, type TextItem } from "./text";
import type { DeelExtraction, DeelLineItem, DocKind, Field, LayoutMatch } from "./types";

/**
 * Deel contractor invoice: every field from the positional strategies and the sequential reader, then the totals
 * cross-check (header = summary = Σ items = subtotal + VAT) chooses between differing candidates or reports them.
 */

type MoneyKey = "header" | "summary" | "subtotal" | "vat";

export interface DeelReading {
  extraction: DeelExtraction;
  /** Currency printed with each amount used, for the legacy `sourceCurrencies` */
  currencyOf: Partial<Record<MoneyKey, string>>;
  /** Currency of each line item's amount (null when unread) */
  itemCurrencies?: (string | null)[];
  /** Every currency other than USD printed with any amount on the page */
  foreignCurrencies?: string[];
}

const DEEL_FIELDS: LabelField[] = [
  "deel.invoiceNumber", "deel.issueDate", "deel.dueDate", "deel.total", "deel.subtotal", "deel.vat", "deel.deelRef",
  "deel.billTo", "deel.billFrom", "deel.itemTable",
];

const moneyEq = (a: Money, b: Money) => a.currency === b.currency && near(a.amount, b.amount);
const seqCandidate = <T>(value: T | null | undefined): Candidate<T>[] =>
  value === null || value === undefined || value === "" ? [] : [{ value, source: "sequential", kind: "sequential" }];

const LABEL_NAMES: Record<string, string> = {
  invoiceNumber: "invoice number",
  issueDate: "issue date",
  dueDate: "due date",
  clientName: "client name",
  total: "total",
  subtotal: "subtotal",
  vat: "VAT amount",
  currency: "currency",
  lineItems: "line items",
  periodStart: "start of the service period",
  periodEnd: "end of the service period",
  clientAddress: "client address",
  clientCountry: "client country",
  clientVatId: "client VAT ID",
  clientRegistrationNumber: "client registration number",
  supplierName: "supplier name",
  supplierAddress: "supplier address",
  deelRef: "Deel reference",
  headerTotal: "total at the top",
  summaryTotal: "total in the summary",
};

const unreadable = (field: string, name = LABEL_NAMES[field] ?? field) =>
  issue("DEEL_FIELD_UNREADABLE", "deel", `Couldn't read the ${name} from the Deel invoice.`, `Check the Deel PDF and enter the ${name} in the field below.`, {
    field: `deel.${field}`,
  });

const conflicting = (field: string, name = LABEL_NAMES[field] ?? field, severity: Issue["severity"] = "error") =>
  issue(
    "DEEL_FIELD_UNREADABLE",
    "deel",
    `The Deel invoice shows more than one ${name}, and the app can't tell which is right.`,
    `Check the Deel PDF and enter the correct ${name} in the field below.`,
    { field: `deel.${field}`, severity },
  );

const notFound = (field: string, severity: Issue["severity"]) =>
  issue(
    "DEEL_FIELD_UNREADABLE",
    "deel",
    `Couldn't find the ${LABEL_NAMES[field] ?? field} on the Deel invoice.`,
    "Check the Deel PDF and fill this in if it's shown.",
    { field: `deel.${field}`, severity },
  );

const usd = (n: number) => n.toFixed(2);

function emptyExtraction(kind: DocKind, layout: LayoutMatch, issues: Issue[]): DeelExtraction {
  return {
    kind,
    layout,
    fields: {
      invoiceNumber: missing(), issueDate: missing(), dueDate: missing(), periodStart: missing(), periodEnd: missing(),
      clientName: missing(), clientAddress: missing(), clientCountry: missing(), clientVatId: missing(),
      clientRegistrationNumber: missing(), supplierName: missing(), supplierAddress: missing(), role: missing(),
      currency: missing(), headerTotal: missing(), summaryTotal: missing(), subtotal: missing(), vat: missing(),
      total: missing(), deelRef: missing(),
    },
    lineItems: [],
    issues,
  };
}

/** Is `a` below `b` on the page (or on a later page)? */
const isBelow = (a: { page: number; yMax: number }, b: { page: number; yMin: number }) =>
  a.page > b.page || (a.page === b.page && a.yMax < b.yMin - 1);
const itemBelow = (i: TextItem, b: { page: number; yMin: number }) => isBelow({ page: i.page, yMax: i.y }, b);
const itemAbove = (i: TextItem, b: { page: number; yMax: number }) => i.page < b.page || (i.page === b.page && i.y > b.yMax + 1);

/**
 * The lines of a BILL TO / BILL FROM block: cells left-aligned with the label (and the cells right after them on
 * the same row), top to bottom, until another block or a gap. Cells stay separate lines, as the stream gives them.
 */
function columnBlock(text: PdfText, label: LabelHit, stops: LabelHit[]): string[] {
  const out: string[] = [];
  let lastY = label.yMin;
  for (const row of text.rows) {
    if (row.page !== label.page || row.y >= label.yMin - 1) continue;
    if (lastY - row.y > 30) break;
    const start = row.items.find((i) => Math.abs(i.x - label.x0) <= 6);
    if (!start) continue;
    if (stops.some((s) => s.items.includes(start))) break;
    const cells = [start];
    for (const next of row.items.filter((i) => i.x > start.x).sort((a, b) => a.x - b.x)) {
      const prev = cells[cells.length - 1];
      if (next.x - (prev.x + prev.w) > 14) break;
      cells.push(next);
    }
    out.push(...cells.map((c) => c.str));
    lastY = row.y;
  }
  return out;
}

interface TotalsValues {
  header: number | null;
  summary: number | null;
  subtotal: number | null;
  /** undefined: VAT row present but unreadable (skip the check); null: no VAT row (counts as 0) */
  vat: number | null | undefined;
  items: (number | null)[];
}

type Check = "headerSummary" | "subtotalVat" | "itemsSubtotal" | "itemsTotal";

/** The totals cross-checks that can be evaluated with these values, and which of them fail. */
function totalsChecks(v: TotalsValues): { evaluated: Set<Check>; failed: Set<Check> } {
  const evaluated = new Set<Check>();
  const failed = new Set<Check>();
  const test = (name: Check, ok: boolean) => {
    evaluated.add(name);
    if (!ok) failed.add(name);
  };
  const total = v.summary ?? v.header;
  if (v.header !== null && v.summary !== null) test("headerSummary", near(v.header, v.summary));
  if (v.subtotal !== null && total !== null && v.vat !== undefined) test("subtotalVat", near(v.subtotal + (v.vat ?? 0), total));
  const itemsKnown = v.items.length > 0 && v.items.every((a) => a !== null);
  const sum = itemsKnown ? (v.items as number[]).reduce((a, b) => a + b, 0) : 0;
  if (itemsKnown && v.subtotal !== null) test("itemsSubtotal", near(sum, v.subtotal));
  if (itemsKnown && v.subtotal === null && total !== null && v.vat !== undefined) test("itemsTotal", near(sum + (v.vat ?? 0), total));
  return { evaluated, failed };
}

const MAX_COMBINATIONS = 512;

/**
 * Where a money field has differing candidates, tries every combination and keeps the one under which all the
 * totals cross-checks pass. Several passing combinations that disagree on a field leave it unresolved.
 */
function chooseByTotals(
  res: Record<MoneyKey, Resolved<Money>>,
  items: Resolved<Money>[],
): { fields: Partial<Record<MoneyKey, Money>>; items: Map<number, Money> } {
  const slots: { key: MoneyKey | number; values: Money[] }[] = [];
  for (const key of ["header", "summary", "subtotal", "vat"] as MoneyKey[]) if (res[key].conflict) slots.push({ key, values: res[key].distinct });
  items.forEach((r, i) => r.conflict && slots.push({ key: i, values: r.distinct }));
  const out = { fields: {} as Partial<Record<MoneyKey, Money>>, items: new Map<number, Money>() };
  if (slots.length === 0) return out;
  const combos = slots.reduce((n, s) => n * s.values.length, 1);
  if (combos > MAX_COMBINATIONS) return out;

  const passing: Money[][] = [];
  for (let c = 0; c < combos; c++) {
    let rest = c;
    const pick = slots.map((s) => {
      const v = s.values[rest % s.values.length];
      rest = Math.floor(rest / s.values.length);
      return v;
    });
    const at = (key: MoneyKey | number, fallback: Money | null) => {
      const idx = slots.findIndex((s) => s.key === key);
      return idx === -1 ? fallback : pick[idx];
    };
    const amount = (m: Money | null) => (m ? m.amount : null);
    const vatRes = res.vat;
    const vatValue = at("vat", vatRes.value);
    const values: TotalsValues = {
      header: amount(at("header", res.header.value)),
      summary: amount(at("summary", res.summary.value)),
      subtotal: amount(at("subtotal", res.subtotal.value)),
      vat: vatValue ? vatValue.amount : vatRes.conflict ? undefined : null,
      items: items.map((r, i) => amount(at(i, r.value))),
    };
    const { evaluated, failed } = totalsChecks(values);
    if (evaluated.size > 0 && failed.size === 0) passing.push(pick);
  }
  slots.forEach((s, idx) => {
    const choices = passing.map((p) => p[idx]);
    if (choices.length > 0 && choices.every((m) => moneyEq(m, choices[0]))) {
      if (typeof s.key === "number") out.items.set(s.key, choices[0]);
      else out.fields[s.key] = choices[0];
    }
  });
  return out;
}

export function extractDeelFromText(text: PdfText): DeelReading {
  if (text.items.length === 0) {
    return { extraction: emptyExtraction("unknown", { id: "none", isNew: false }, [noTextIssue("deel")]), currencyOf: {} };
  }
  const detected = detectKind(text);
  if (detected === "fira" || detected === "gst-invoice" || detected === "lut-form") {
    return { extraction: emptyExtraction(detected, matchLayout(text, detected), [wrongKindIssue(detected, "deel")]), currencyOf: {} };
  }

  const layout = matchLayout(text, "deel-invoice");
  const knownLayout = !layout.isNew;
  const legacy = legacyDeel(sequentialLines(text));
  const hits = findLabels(text, DEEL_FIELDS);
  const hitsFor = (f: LabelField) => hits.filter((h) => h.field === f);
  const issues: Issue[] = [];

  // ─── Where the item table starts and ends ───
  const table = hitsFor("deel.itemTable")[0];
  const totalHits = hitsFor("deel.total");
  const subHits = hitsFor("deel.subtotal");
  // The summary block is Subtotal, VAT, Total, wherever it sits (normally under the items, sometimes above them):
  // a total under the subtotal is the summary total, any other is the header total. With no subtotal on the
  // page, a total under the item table is the summary.
  const summaryStart = subHits[0] ?? table;
  const headerHits = summaryStart ? totalHits.filter((h) => !isBelow(h, summaryStart)) : totalHits.slice(0, 1);
  const summaryHits = summaryStart ? totalHits.filter((h) => isBelow(h, summaryStart)) : totalHits.slice(1);
  const vatHits = hitsFor("deel.vat").filter((h) => !summaryStart || isBelow(h, summaryStart));

  // ─── Money: label strategies, then the sequential reader ───
  const moneyOpts = { skip: isPercent };
  const readMoney = (hs: LabelHit[]) => readAtLabels(text, hs, parseMoney, moneyOpts);
  const seqMoney = (amount: number | undefined, currency: string | undefined): Candidate<Money>[] =>
    amount !== undefined && Number.isFinite(amount) && currency ? seqCandidate<Money>({ currency, amount }) : [];
  const reads = {
    header: readMoney(headerHits),
    summary: readMoney(summaryHits),
    subtotal: readMoney(subHits),
    vat: readMoney(vatHits),
  };
  const keys: MoneyKey[] = ["header", "summary", "subtotal", "vat"];
  const seq: Record<MoneyKey, Candidate<Money>[]> = {
    header: seqMoney(legacy.headerTotal, legacy.currencyOf.header),
    summary: seqMoney(legacy.summaryTotal, legacy.currencyOf.summary),
    subtotal: seqMoney(legacy.subtotal, legacy.currencyOf.subtotal),
    vat: seqMoney(legacy.vat, legacy.currencyOf.vat),
  };
  // A label that is on the page with no readable amount beside or below it stays unreadable: the sequential
  // reader's "next line" is then some other cell, even when its amount happens to fit
  for (const k of keys) if (reads[k].candidates.length === 0 && reads[k].unreadable.length > 0) seq[k] = [];
  const moneyRes = Object.fromEntries(keys.map((k) => [k, resolve([...reads[k].candidates, ...seq[k]], moneyEq)])) as Record<
    MoneyKey,
    Resolved<Money>
  >;
  const labelSeen: Record<MoneyKey, string | undefined> = {
    header: reads.header.unreadable[0]?.text ?? (Number.isNaN(legacy.headerTotal) ? "TOTAL" : undefined),
    summary: reads.summary.unreadable[0]?.text ?? (Number.isNaN(legacy.summaryTotal) ? "Total" : undefined),
    subtotal: reads.subtotal.unreadable[0]?.text,
    vat: reads.vat.unreadable[0]?.text,
  };

  // ─── Line items: rows in the table that start with a known item kind ───
  // The table ends at the first summary row under it (the summary block may also sit above the table)
  const tableEnd = [...subHits, ...summaryHits].find((h) => !table || isBelow(h, table));
  const itemCells = text.items
    .filter((i) => LINE_ITEM_PREFIX.test(i.str) && (!table || itemBelow(i, table)) && (!tableEnd || itemAbove(i, tableEnd)))
    .sort((a, b) => a.page - b.page || b.y - a.y);
  const positional = itemCells.map((cell) => {
    const anchor = anchorOf([cell]);
    const raw = readRight(text, anchor, moneyOpts) ?? readBelow(text, anchor, moneyOpts);
    const money = raw ? parseMoney(raw.text) : null;
    return { description: cell.str, money, source: raw ? `label-${raw.how}:${cell.str}` : "missing" };
  });
  // Pair the two readings by description (the stream may list the rows in another order than they're printed)
  const sequentialItems = legacy.lineItems;
  const unpaired = [...sequentialItems];
  const pairs = positional.map((p) => {
    const at = unpaired.findIndex((s) => s.description === p.description);
    return at === -1 ? null : unpaired.splice(at, 1)[0];
  });
  const sameItems = unpaired.length === 0 && pairs.every((s) => s !== null);
  const seqItem = (s: { amount: number }) => (Number.isFinite(s.amount) ? seqCandidate<Money>({ currency: "USD", amount: s.amount }) : []);
  const posItem = (p: (typeof positional)[number]) => (p.money ? [{ value: p.money, source: p.source, kind: "label" as const }] : []);
  let itemsDisagree = false;
  let itemList: { description: string; cands: Candidate<Money>[] }[];
  if (sameItems) {
    itemList = positional.map((p, i) => ({ description: p.description, cands: p.money ? [...posItem(p), ...seqItem(pairs[i]!)] : [] }));
  } else if (positional.length === 0) {
    itemList = sequentialItems.map((s) => ({ description: s.description, cands: seqItem(s) }));
  } else if (sequentialItems.length === 0) {
    itemList = positional.map((p) => ({ description: p.description, cands: posItem(p) }));
  } else {
    // The two readers found different rows: keep the positional ones, but say so
    itemsDisagree = true;
    itemList = positional.map((p) => ({ description: p.description, cands: p.money ? [{ value: p.money, source: p.source, kind: "label" as const }] : [] }));
  }
  const itemRes = itemList.map((it) => resolve(it.cands, moneyEq));

  // ─── Cross-checks choose between differing amounts ───
  // A check may confirm an amount read beside its label, never promote the sequential reader's guess over it
  const atLabel = (cands: Candidate<Money>[], pick: Money) => cands.some((c) => c.kind === "label" && moneyEq(c.value, pick));
  const chosen = chooseByTotals(moneyRes, itemRes);
  for (const k of keys) {
    const pick = chosen.fields[k];
    if (pick && atLabel(reads[k].candidates, pick)) moneyRes[k] = resolve([...reads[k].candidates, ...seq[k]], moneyEq, () => pick);
  }
  chosen.items.forEach((pick, i) => {
    if (atLabel(itemList[i].cands, pick)) itemRes[i] = resolve(itemList[i].cands, moneyEq, () => pick);
  });

  const amount = (r: Resolved<Money>) => (r.value ? r.value.amount : null);
  const vatUnreadable = moneyRes.vat.value === null && (moneyRes.vat.conflict || labelSeen.vat !== undefined);
  const checks = totalsChecks({
    header: amount(moneyRes.header),
    summary: amount(moneyRes.summary),
    subtotal: amount(moneyRes.subtotal),
    vat: vatUnreadable ? undefined : amount(moneyRes.vat),
    items: itemRes.map(amount),
  });
  const passed = (c: Check) => checks.evaluated.has(c) && !checks.failed.has(c);
  // "high" needs the whole web: no failed check, and no amount whose label is there but whose value isn't
  // and no amount the strategies read differently, even if a check chose between them
  const gaps =
    keys.some((k) => (moneyRes[k].value === null && (moneyRes[k].conflict || labelSeen[k] !== undefined)) || moneyRes[k].distinct.length > 1) ||
    itemRes.some((r) => r.value === null || r.distinct.length > 1);
  const allPassed = checks.failed.size === 0 && !itemsDisagree && !gaps;

  const moneyField = (k: MoneyKey, checked: boolean, failed: boolean): Field<number> => {
    const r = moneyRes[k];
    const conf = confidenceOf(r, { knownLayout, checked: checked && allPassed, failed });
    const f = toField(r, conf, labelSeen[k]);
    return { ...f, value: r.value ? r.value.amount : null };
  };
  const totalsChecked = passed("headerSummary") || passed("subtotalVat") || passed("itemsTotal");
  const headerTotal = moneyField("header", totalsChecked, checks.failed.has("headerSummary"));
  const summaryTotal = moneyField("summary", totalsChecked, checks.failed.has("headerSummary"));
  const subtotal = moneyField(
    "subtotal",
    passed("subtotalVat") || passed("itemsSubtotal"),
    checks.failed.has("subtotalVat") || checks.failed.has("itemsSubtotal"),
  );
  const vat = moneyField("vat", passed("subtotalVat") || passed("itemsTotal"), checks.failed.has("subtotalVat"));

  // The total: header and summary must agree; one alone is used as it is
  let total: Field<number>;
  if (checks.failed.has("headerSummary")) {
    total = { value: null, confidence: "low", source: "conflict:header-vs-summary" };
    issues.push(
      issue(
        "DEEL_TOTALS_DISAGREE",
        "deel",
        `Deel invoice totals disagree: the header shows ${usd(headerTotal.value!)} but the summary shows ${usd(summaryTotal.value!)}.`,
        "Check the Deel PDF and enter the correct total in the field below.",
        { field: "deel.total" },
      ),
    );
  } else {
    const from = summaryTotal.value !== null ? summaryTotal : headerTotal;
    const bothAgree = summaryTotal.value !== null && headerTotal.value !== null;
    total =
      from.value === null
        ? { value: null, confidence: "low", source: summaryTotal.source !== "missing" ? summaryTotal.source : headerTotal.source }
        : {
            value: from.value,
            confidence: checks.failed.size > 0 ? "low" : from.confidence,
            source: bothAgree ? `cross-check:header=summary(${from.source})` : from.source,
          };
    if (total.value === null) {
      issues.push(moneyRes.header.conflict || moneyRes.summary.conflict ? conflicting("total") : unreadable("total"));
    }
  }
  if (subtotal.value === null) issues.push(moneyRes.subtotal.conflict ? conflicting("subtotal") : unreadable("subtotal"));
  if (vatUnreadable) issues.push(moneyRes.vat.conflict ? conflicting("vat") : unreadable("vat"));
  if (checks.failed.has("subtotalVat")) {
    issues.push(
      issue(
        "DEEL_TOTALS_DISAGREE",
        "deel",
        `Deel invoice subtotal (${usd(subtotal.value!)}) plus VAT (${usd(vat.value ?? 0)}) does not match its total (${usd((summaryTotal.value ?? headerTotal.value)!)}).`,
        "Check the Deel PDF and correct the subtotal, VAT or total below.",
        { field: "deel.subtotal" },
      ),
    );
  }

  // ─── Line items ───
  const itemsPassed = passed("itemsSubtotal") || passed("itemsTotal");
  const itemsFailed = checks.failed.has("itemsSubtotal") || checks.failed.has("itemsTotal") || itemsDisagree;
  const lineItems: DeelLineItem[] = itemList.map((it, i) => {
    const r = itemRes[i];
    const conf = confidenceOf(r, { knownLayout, checked: itemsPassed && allPassed, failed: itemsFailed });
    const f = toField(r, conf, it.cands.length === 0 ? it.description : undefined);
    if (r.value === null) issues.push(r.conflict ? conflicting(`lineItems.${i}.amount`, `amount of "${it.description}"`) : unreadable(`lineItems.${i}.amount`, `amount of "${it.description}"`));
    return { description: it.description, amount: { ...f, value: r.value ? r.value.amount : null } };
  });
  if (lineItems.length === 0) issues.push(unreadable("lineItems", "line items (Fixed rate, Bonus, Other)"));
  if (itemsDisagree) issues.push(conflicting("lineItems", "set of line items"));
  if (checks.failed.has("itemsSubtotal") || checks.failed.has("itemsTotal")) {
    const sum = lineItems.reduce((a, it) => a + (it.amount.value ?? 0), 0);
    const target = subtotal.value ?? total.value ?? 0;
    issues.push(
      issue(
        "DEEL_ITEMS_DONT_SUM",
        "deel",
        `Deel line items add up to ${usd(sum)}, but the invoice ${subtotal.value !== null ? "subtotal" : "total"} is ${usd(target)}.`,
        "Check the Deel PDF and correct the line items below.",
        { field: "deel.lineItems" },
      ),
    );
  }

  // ─── Currency: every amount must be in one currency ───
  const used = [
    ...keys.map((k) => moneyRes[k].value?.currency),
    ...itemRes.map((r) => r.value?.currency),
  ].filter((c): c is string => !!c);
  const currencySet = [...new Set(used)];
  // Every money token printed anywhere, a cell or two neighbouring cells ("EUR" "2,000.00"), items included,
  // so a foreign amount is caught even where no field was read from it ("INV" "2026" is an invoice number)
  const printed = new Set<string>();
  for (const row of text.rows) {
    row.items.forEach((item, i) => {
      for (const t of [item.str, `${item.str} ${row.items[i + 1]?.str ?? ""}`]) {
        const m = parseMoney(t);
        if (m && m.currency !== "INV") printed.add(m.currency);
      }
    });
  }
  const foreignCurrencies = [...new Set([...currencySet, ...printed])].filter((c) => c !== "USD");
  let currency: Field<string>;
  if (currencySet.length === 1) {
    currency = {
      value: currencySet[0],
      // A USD reading next to a foreign amount elsewhere on the page is not a sure reading
      confidence: foreignCurrencies.length > 0 && currencySet[0] === "USD" ? "low" : knownLayout && allPassed && totalsChecked ? "high" : "medium",
      source: "amounts",
    };
  } else if (currencySet.length > 1) {
    currency = { value: null, confidence: "low", source: `conflict:${currencySet.join("|")}` };
    issues.push(
      issue(
        "DEEL_CURRENCY_UNSUPPORTED",
        "deel",
        `The Deel invoice shows amounts in more than one currency (${currencySet.join(", ")}).`,
        "Only single-currency USD invoices are supported; check the Deel PDF.",
        { field: "deel.currency" },
      ),
    );
  } else {
    currency = missing();
  }
  if (currencySet.length <= 1 && foreignCurrencies.length > 0) {
    issues.push(
      issue(
        "DEEL_CURRENCY_UNSUPPORTED",
        "deel",
        `The Deel invoice shows amounts in ${foreignCurrencies.join(", ")}; only USD invoices are supported.`,
        "Check the Deel PDF; only USD invoices can be issued.",
        { field: "deel.currency" },
      ),
    );
  }
  const currencyOf: Partial<Record<MoneyKey, string>> = {};
  for (const k of keys) if (moneyRes[k].value) currencyOf[k] = moneyRes[k].value!.currency;

  // ─── Invoice number, dates, reference ───
  const invoiceNumber = textField(
    [
      ...readAtLabels(text, hitsFor("deel.invoiceNumber"), parseInvoiceNumber).candidates,
      ...invoiceNumberPattern(text),
      ...seqCandidate(legacy.invoiceNumber),
    ],
    { knownLayout, needsAgreement: true },
  );

  const dateRes = (field: LabelField, seqValue: string) => {
    const labelled = readAtLabels(text, hitsFor(field), parseLongDate);
    // The sequential reader takes the first and second date on the page, whatever their labels. When this
    // field's label is there but has no date beside it, that guess is some other date, so it isn't used.
    const labelEmpty = labelled.candidates.length === 0 && labelled.unreadable.length > 0;
    const cands = [...labelled.candidates, ...(labelEmpty ? [] : seqCandidate(seqValue))];
    // A date printed at its label wins over the positional guess
    const labelValues = [...new Set(labelled.candidates.map((c) => c.value))];
    return {
      res: resolve(cands, undefined, labelValues.length === 1 ? () => labelValues[0] : undefined),
      unreadable: labelled.unreadable[0]?.text,
      atLabel: labelled.candidates.length > 0,
    };
  };
  const issue_ = dateRes("deel.issueDate", legacy.issueDate);
  const due = dateRes("deel.dueDate", legacy.dueDate);
  const issueMs = issue_.res.value ? dateValue(issue_.res.value) : null;
  const dueMs = due.res.value ? dateValue(due.res.value) : null;
  const datesOrdered = issueMs !== null && dueMs !== null && issueMs <= dueMs;
  const datesBackwards = issueMs !== null && dueMs !== null && issueMs > dueMs;
  // "high" needs both dates read at their labels and in order
  const datesChecked = datesOrdered && issue_.atLabel && due.atLabel;
  const issueDate = toField(issue_.res, confidenceOf(issue_.res, { knownLayout, checked: datesChecked, failed: datesBackwards }), issue_.unreadable);
  const dueDate = toField(due.res, confidenceOf(due.res, { knownLayout, checked: datesChecked, failed: datesBackwards }), due.unreadable);
  // The issue date is required (below); a due date whose label is there but unreadable is flagged too
  if (dueDate.value === null && due.unreadable) issues.push(unreadable("dueDate"));

  // Period: "Invoice for work between <date> to <date>"
  const periodCell = text.items.map((i) => ({ i, p: readPeriod(i.str) })).find((x) => x.p !== null);
  const periodCands = (pick: (p: { start: string; end: string }) => string, seqValue: string | undefined) => [
    ...(periodCell ? [{ value: pick(periodCell.p!), source: "label-inline:Invoice for work between", kind: "label" as const }] : []),
    ...seqCandidate(seqValue),
  ];
  const startRes = resolve(periodCands((p) => p.start, legacy.periodStart));
  const endRes = resolve(periodCands((p) => p.end, legacy.periodEnd));
  const startMs = startRes.value ? dateValue(startRes.value) : null;
  const endMs = endRes.value ? dateValue(endRes.value) : null;
  const periodOk = startMs !== null && endMs !== null && startMs <= endMs;
  const periodStart = toField(startRes, confidenceOf(startRes, { knownLayout, checked: periodOk, failed: !periodOk && startRes.value !== null }));
  const periodEnd = toField(endRes, confidenceOf(endRes, { knownLayout, checked: periodOk, failed: !periodOk && endRes.value !== null }));

  const deelRef = textField(
    [...readAtLabels(text, hitsFor("deel.deelRef"), (s) => (/^[A-Za-z0-9][A-Za-z0-9\-/_.]{2,39}$/.test(s) ? s : null)).candidates, ...seqCandidate(legacy.deelRef)],
    { knownLayout, needsAgreement: true },
  );

  // ─── Bill To / Bill From blocks ───
  const stops = hits.filter((h) => ["deel.total", "deel.itemTable", "deel.billTo", "deel.billFrom", "deel.subtotal"].includes(h.field));
  // The first BILL TO / BILL FROM label with anything under it
  const block = (f: LabelField) => hitsFor(f).map((h) => columnBlock(text, h, stops)).find((lines) => lines.length > 0);
  const billToLines = block("deel.billTo");
  const billFromLines = block("deel.billFrom");
  const billTo = billToLines ? readBillTo(billToLines) : null;
  const billFrom = billFromLines ? readBillFrom(billFromLines) : null;
  const blockField = (positionalValue: string | undefined, seqValue: string | undefined, label: string) =>
    textField(
      [...(positionalValue ? [{ value: positionalValue, source: `label-below:${label}`, kind: "label" as const }] : []), ...seqCandidate(seqValue)],
      // Free text with no cross-check: never more than medium
      { knownLayout, needsAgreement: true, max: "medium" },
    );
  let clientName = blockField(billTo?.clientName, legacy.clientName, "BILL TO");
  // A name can't be cross-checked: when the name/address split is a guess, say so
  if (clientName.value !== null && (billTo?.nameAmbiguous || (!billTo && legacy.nameAmbiguous))) {
    clientName = { ...clientName, confidence: "low" };
    issues.push(
      issue("DEEL_FIELD_UNREADABLE", "deel", "The client name may be wrapped or incomplete.", "Check the client name against the Deel PDF.", {
        field: "deel.clientName",
        severity: "warning",
      }),
    );
  }
  const clientAddress = blockField(billTo?.clientAddress, legacy.clientAddress, "BILL TO");
  const clientCountry = blockField(billTo?.clientCountry, legacy.clientCountry, "BILL TO");
  const clientVatId = blockField(billTo?.clientVatId, legacy.clientVatId, "BILL TO");
  const clientRegistrationNumber = blockField(billTo?.clientRegistrationNumber, legacy.clientRegistrationNumber, "BILL TO");
  const supplierName = blockField(billFrom?.supplierName, legacy.supplierName, "BILL FROM");
  const supplierAddress = blockField(billFrom?.supplierAddress, legacy.supplierAddress, "BILL FROM");
  const role = textField(seqCandidate(legacy.role), { knownLayout, needsAgreement: true, max: "medium" });

  const required: [string, Field<unknown>][] = [
    ["invoiceNumber", invoiceNumber],
    ["issueDate", issueDate],
    ["clientName", clientName],
  ];
  for (const [name, f] of required) if (f.value === null) issues.push(f.source.startsWith("conflict:") ? conflicting(name) : unreadable(name));
  // Any other field the strategies read differently is flagged too; a warning, since the invoice can be issued without it
  const optional = { dueDate, periodStart, periodEnd, clientAddress, clientCountry, clientVatId, clientRegistrationNumber, supplierName, supplierAddress, deelRef };
  const flagged = new Set(issues.map((i) => i.field));
  for (const [name, f] of Object.entries(optional)) {
    if (f.source.startsWith("conflict:") && !flagged.has(`deel.${name}`)) issues.push(conflicting(name, undefined, "warning"));
  }
  // Never silently empty: a field Deel always prints that came back empty is flagged. A warning where the
  // invoice maths doesn't need it, an error where it does.
  const expected: [string, Field<unknown>, Issue["severity"]][] = [
    ["dueDate", dueDate, "warning"],
    ["periodStart", periodStart, "warning"],
    ["periodEnd", periodEnd, "warning"],
    ["deelRef", deelRef, "warning"],
    ["clientCountry", clientCountry, "warning"],
    ["clientAddress", clientAddress, "warning"],
    ["vat", vat, "warning"],
    ["headerTotal", headerTotal, summaryTotal.value !== null ? "warning" : "error"],
    ["summaryTotal", summaryTotal, headerTotal.value !== null ? "warning" : "error"],
    ["currency", currency, "error"],
  ];
  const flaggedNow = new Set(issues.map((i) => i.field));
  for (const [name, f, severity] of expected) {
    if (f.value === null && !flaggedNow.has(`deel.${name}`)) issues.push(notFound(name, severity));
  }

  const fields: DeelExtraction["fields"] = {
    invoiceNumber, issueDate, dueDate, periodStart, periodEnd, clientName, clientAddress, clientCountry, clientVatId,
    clientRegistrationNumber, supplierName, supplierAddress, role, currency, headerTotal, summaryTotal, subtotal, vat,
    total, deelRef,
  };

  // Not recognisably a Deel invoice and next to nothing read: say so instead of returning scraps
  if (detected === "unknown" && [total, subtotal, invoiceNumber].filter((f) => f.value !== null).length < 2) {
    return { extraction: emptyExtraction("unknown", layout, [wrongKindIssue("unknown", "deel")]), currencyOf: {} };
  }
  if (layout.isNew) issues.unshift(newLayoutIssue("deel"));
  issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return {
    extraction: { kind: "deel-invoice", layout, fields, lineItems, issues },
    currencyOf,
    itemCurrencies: itemRes.map((r) => r.value?.currency ?? null),
    foreignCurrencies,
  };
}

/**
 * A text field from its candidates. With `needsAgreement`, "high" needs two different strategies to agree on a
 * known layout (an ID has no arithmetic cross-check, so independent readings are the check).
 */
function textField(
  cands: Candidate<string>[],
  opts: { knownLayout: boolean; needsAgreement: boolean; max?: "medium" },
): Field<string> {
  const r = resolve(cands);
  const conf = confidenceOf(r, { knownLayout: opts.knownLayout, checked: !opts.needsAgreement || r.agreeing >= 2, max: opts.max });
  return toField(r, conf);
}

/** Strategy (d) for the invoice number: "INV" followed by its number tokens on one row, anywhere on the page. */
function invoiceNumberPattern(text: PdfText): Candidate<string>[] {
  const out: Candidate<string>[] = [];
  for (const row of text.rows) {
    row.items.forEach((item, idx) => {
      if (!/^INV/.test(item.str)) return;
      const tokens = [item.str];
      for (let j = idx + 1; j < row.items.length && tokens.length < 4; j++) {
        if (row.items[j].x - (row.items[j - 1].x + row.items[j - 1].w) > 14) break;
        tokens.push(row.items[j].str);
      }
      for (let n = tokens.length; n >= 1; n--) {
        const value = parseInvoiceNumber(tokens.slice(0, n).join(" "));
        if (value) {
          out.push({ value, source: "pattern:invoice-number", kind: "pattern" });
          break;
        }
      }
    });
  }
  return out;
}
