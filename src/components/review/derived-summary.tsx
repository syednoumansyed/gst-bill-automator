"use client";

import { CheckCircle2, XCircle } from "lucide-react";

import type { InvoiceDraft } from "@/lib/draft";
import { cn } from "@/lib/utils";
import { derive, inr, inrSplit, usd, type CheckResult } from "./model";

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-xs font-black uppercase tracking-[0.12em] text-black/55">{label}</dt>
      <dd className={cn("text-right font-mono text-sm font-semibold tabular-nums", bad && "text-red-700")}>{value}</dd>
    </div>
  );
}

export function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <ul className="space-y-1.5" aria-label="Cross-checks">
      {checks.map((c) => (
        <li key={c.id} className="flex items-start gap-2 text-xs leading-5">
          {c.ok ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700" aria-hidden />
          )}
          <span className={c.ok ? "text-black/70" : "font-semibold text-red-800"}>
            <span className="sr-only">{c.ok ? "Passed: " : "Failed: "}</span>
            {c.label}
            {c.detail ? ` (${c.detail})` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Values the server derives, recomputed live as the draft changes. */
export function DerivedSummary({ draft, checks }: { draft: InvoiceDraft; checks: CheckResult[] }) {
  const { itemsSum, rate, bankChargesUsd } = derive(draft);
  const { deel, fira } = draft;
  const split = inrSplit(draft);
  const check = (id: string) => checks.find((c) => c.id === id);
  const sumOk = check("items-subtotal")?.ok !== false;
  const totalOk = check("subtotal-total")?.ok !== false;
  const rateOk = check("fira-rate")?.ok !== false;
  const chargesOk = check("fira-amount")?.ok !== false;

  return (
    <section aria-labelledby="derived-heading" className="space-y-4">
      <h2 id="derived-heading" className="text-sm font-black uppercase tracking-[0.16em]">
        Live check
      </h2>

      <div
        className={cn(
          "rounded-2xl border-2 p-3",
          sumOk && totalOk ? "border-emerald-900 bg-emerald-50" : "border-red-900 bg-red-50",
        )}
      >
        <p className="text-xs font-black uppercase tracking-[0.14em]">
          {sumOk && totalOk ? "Totals reconcile" : "Totals do not reconcile"}
        </p>
        <dl className="mt-1 divide-y divide-black/10">
          <Row label="Sum of line items" value={usd(itemsSum)} bad={!sumOk} />
          <Row label="Subtotal" value={usd(deel.subtotal)} bad={!sumOk} />
          <Row label="VAT" value={usd(deel.vat)} />
          <Row label="Total" value={usd(deel.total)} bad={!totalOk} />
        </dl>
      </div>

      {fira ? (
        <dl className="divide-y divide-black/10 rounded-2xl border-2 border-black bg-white px-3">
          <Row label="Exchange rate" value={rate === null ? "n/a" : `${rate.toFixed(4)} INR/USD`} bad={!rateOk} />
          <Row label="Bank charges" value={bankChargesUsd === null ? "n/a" : usd(bankChargesUsd)} bad={!chargesOk} />
          <Row label="INR invoice total" value={inr(fira.inrAmount)} />
        </dl>
      ) : (
        <p className="rounded-2xl border-2 border-dashed border-black/30 bg-[#F8F7F3] p-3 text-xs leading-5 text-black/65">
          No FIRA attached, so the invoice will be issued in USD.
        </p>
      )}

      {split && (
        <div>
          <p className="mb-1 text-xs font-black uppercase tracking-[0.12em] text-black/55">INR split per line</p>
          <ol className="divide-y divide-black/10 rounded-2xl border-2 border-black bg-white px-3">
            {split.map((amount, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                <span className="min-w-0 truncate text-black/70">Item {i + 1}</span>
                <span className="font-mono font-semibold tabular-nums">{inr(amount)}</span>
              </li>
            ))}
          </ol>
          <p className="mt-1 text-[11px] leading-4 text-black/55">
            Proportional to each USD amount; any paise left over go on the largest line.
          </p>
        </div>
      )}

      <CheckList checks={checks} />
    </section>
  );
}
