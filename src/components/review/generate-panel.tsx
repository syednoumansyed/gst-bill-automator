"use client";

import { ArrowRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

type GeneratePanelProps = {
  blockers: string[];
  needsConfirm: boolean;
  confirmed: boolean;
  onConfirmChange: (value: boolean) => void;
  loading: boolean;
  stepLabel: string;
  onGenerate: () => void;
};

export function GeneratePanel({ blockers, needsConfirm, confirmed, onConfirmChange, loading, stepLabel, onGenerate }: GeneratePanelProps) {
  const ready = blockers.length === 0 && (!needsConfirm || confirmed);
  return (
    <section aria-labelledby="generate-heading" className="space-y-4">
      <h2 id="generate-heading" className="text-sm font-black uppercase tracking-[0.16em]">
        Generate
      </h2>

      <div className="flex items-start gap-3 rounded-2xl border-2 border-black bg-[#FFF8D6] p-3">
        <Checkbox
          id="confirm-values"
          checked={confirmed}
          disabled={!needsConfirm || loading}
          onCheckedChange={(v) => onConfirmChange(v === true)}
          className="mt-0.5 h-6 w-6 shrink-0 rounded-md border-2 border-black bg-white data-[state=checked]:bg-black"
        />
        <label htmlFor="confirm-values" className="text-sm leading-6 text-black">
          I&apos;ve checked these values against the PDFs
          <span className="block text-xs leading-5 text-black/60">
            {needsConfirm ? "Required: some values are flagged or were edited." : "Not needed: every value was read with high confidence."}
          </span>
        </label>
      </div>

      <Button
        type="button"
        onClick={onGenerate}
        disabled={!ready || loading}
        aria-describedby={blockers.length ? "generate-blockers" : undefined}
        className="h-14 w-full rounded-2xl border-2 border-black bg-[#FFE36F] px-6 text-base font-black uppercase tracking-[0.12em] text-black hover:bg-[#FFD84A]"
      >
        {loading ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            {stepLabel}
          </>
        ) : (
          <>
            Generate GST invoice
            <ArrowRight className="h-5 w-5" aria-hidden />
          </>
        )}
      </Button>

      {blockers.length > 0 && (
        <div id="generate-blockers" className="rounded-2xl border-2 border-dashed border-black/30 bg-[#F8F7F3] p-3">
          <p className="text-xs font-black uppercase tracking-[0.12em] text-black/60">Fix before generating</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-5 text-black/75">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
