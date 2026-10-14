"use client";

import { useEffect, useRef } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fieldId } from "./model";
import { useReview } from "./context";
import { FieldRow } from "./field-row";

export function LineItems() {
  const { draft, disabled, setDraft, edited } = useReview();
  const items = draft.deel.lineItems;
  const previousCount = useRef(items.length);
  const changed = edited.has("deel.lineItems");

  // After "Add line item", move focus to the new description
  useEffect(() => {
    if (items.length > previousCount.current) {
      document.getElementById(fieldId(`deel.lineItems.${items.length - 1}.description`))?.focus();
    }
    previousCount.current = items.length;
  }, [items.length]);

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="mb-1 flex w-full items-center justify-between text-xs font-black uppercase tracking-[0.16em]">
        <span>Line items</span>
        {changed && <span className="rounded-full border border-sky-900/40 bg-sky-100 px-2 py-0.5 text-[10px] text-sky-950">Edited</span>}
      </legend>
      <ul className="space-y-3">
        {items.map((_, i) => (
          <li key={i} className="rounded-2xl border-2 border-black bg-[#F8F7F3] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-black/60">Item {i + 1}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 rounded-full border-2 border-black bg-white text-xs font-semibold"
                disabled={disabled || items.length === 1}
                aria-label={`Remove line item ${i + 1}`}
                onClick={() =>
                  setDraft((d) => ({ ...d, deel: { ...d.deel, lineItems: d.deel.lineItems.filter((_, n) => n !== i) } }))
                }
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Remove
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
              <FieldRow path={`deel.lineItems.${i}.description`} label="Description" srPrefix={`Item ${i + 1}`} required />
              <FieldRow path={`deel.lineItems.${i}.amount`} label="Amount (USD)" srPrefix={`Item ${i + 1}`} kind="amount" required />
            </div>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        className="h-10 rounded-full border-2 border-black bg-white text-xs font-black uppercase tracking-[0.12em]"
        disabled={disabled || items.length >= 20}
        onClick={() =>
          setDraft((d) => ({ ...d, deel: { ...d.deel, lineItems: [...d.deel.lineItems, { description: "", amount: 0 }] } }))
        }
      >
        <Plus className="h-4 w-4" aria-hidden />
        Add line item
      </Button>
    </fieldset>
  );
}
