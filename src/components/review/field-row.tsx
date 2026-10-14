"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Pencil, XCircle } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useReview } from "./context";
import { cleanAmountText, fieldId, fieldState, getAt, parseAmount, type FieldState } from "./model";

export const INPUT_CLASS = "h-11 rounded-2xl border-2 border-black bg-white px-4";

const BADGES: Record<Exclude<FieldState, "none">, { text: string; className: string; Icon: typeof XCircle; title: string }> = {
  high: { text: "", className: "text-emerald-700/70", Icon: CheckCircle2, title: "High confidence" },
  medium: { text: "Check", className: "border-amber-900/40 bg-amber-100 text-amber-950", Icon: AlertTriangle, title: "Medium confidence: check against the PDF" },
  low: { text: "Needs input", className: "border-red-900/40 bg-red-100 text-red-950", Icon: XCircle, title: "Low confidence or not found: enter the value from the PDF" },
  edited: { text: "Edited", className: "border-sky-900/40 bg-sky-100 text-sky-950", Icon: Pencil, title: "You changed this value" },
};

export function ConfidenceBadge({ state }: { state: FieldState }) {
  if (state === "none") return null;
  const { text, className, Icon, title } = BADGES[state];
  if (state === "high") {
    return (
      <span title={title} className={cn("inline-flex items-center", className)}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
        <span className="sr-only">{title}</span>
      </span>
    );
  }
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em]", className)}>
      <Icon className="h-3 w-3" aria-hidden />
      {text}
    </span>
  );
}

type FieldRowProps = {
  path: string;
  label: string;
  kind?: "text" | "amount" | "textarea";
  placeholder?: string;
  hint?: string;
  required?: boolean;
  /** Read only by screen readers, e.g. "Item 2" before "Amount" */
  srPrefix?: string;
  inputMode?: "text" | "decimal" | "numeric";
};

export function FieldRow({ path, label, kind = "text", placeholder, hint, required, srPrefix, inputMode }: FieldRowProps) {
  const { draft, meta, edited, openIssues, highlight, disabled, setPath } = useReview();
  const id = fieldId(path);
  const captionId = `${id}-note`;
  const raw = getAt(draft, path);
  const state = fieldState(path, meta, edited);
  const issues = openIssues.get(path) ?? [];
  const invalid = issues.length > 0;
  const m = meta[path];
  const highlighted = highlight === path;

  const caption = invalid
    ? `${issues[0].code}${m ? ` · ${m.source}` : ""}`
    : state === "edited"
      ? "Edited by you"
      : m?.missing
        ? "Not found in the document"
        : m
        ? `Read via ${m.source}`
        : (hint ?? "");

  const inputProps = {
    id,
    "data-field-path": path,
    disabled,
    required,
    "aria-invalid": invalid || undefined,
    "aria-describedby": captionId,
    placeholder,
  };
  const stateClass = cn(
    INPUT_CLASS,
    invalid && "border-red-700",
    !invalid && state === "medium" && "border-amber-700",
    highlighted && "bg-[#FFF8D6] ring-4 ring-[#FFE36F]",
  );

  return (
    <div className="space-y-1.5">
      <div className={"flex min-h-6 items-end justify-between gap-2"}>
        <Label htmlFor={id} className="text-xs font-black uppercase tracking-[0.16em]">
          {srPrefix && <span className="sr-only">{srPrefix} </span>}
          {label}
          {required && <span aria-hidden className="text-red-600"> *</span>}
        </Label>
        <ConfidenceBadge state={state} />
      </div>
      {kind === "amount" ? (
        <AmountInput {...inputProps} value={typeof raw === "number" ? raw : 0} onValue={(n) => setPath(path, n)} className={stateClass} inputMode={inputMode ?? "decimal"} />
      ) : kind === "textarea" ? (
        <Textarea {...inputProps} value={String(raw ?? "")} onChange={(e) => setPath(path, e.target.value)} className={cn(stateClass, "h-auto min-h-[88px] py-3")} />
      ) : (
        <Input {...inputProps} type="text" inputMode={inputMode} value={String(raw ?? "")} onChange={(e) => setPath(path, e.target.value)} className={stateClass} />
      )}
      <p id={captionId} title={caption} className={cn("min-h-4 truncate font-mono text-[11px] leading-4", invalid ? "text-red-800" : "text-black/50")}>
        {caption}
      </p>
    </div>
  );
}

type AmountInputProps = Omit<React.ComponentProps<"input">, "value" | "onChange"> & { value: number; onValue: (n: number) => void };

/** Text input for money: keeps what the user typed ("12.", "0.50") while the draft holds the number. */
function AmountInput({ value, onValue, ...rest }: AmountInputProps) {
  const [text, setText] = useState(() => String(value));

  useEffect(() => {
    // The draft changed from outside (a line item was removed, a value reverted): show it
    setText((current) => (parseAmount(current) === value ? current : String(value)));
  }, [value]);

  return (
    <Input
      {...rest}
      type="text"
      value={text}
      onChange={(e) => {
        const cleaned = cleanAmountText(e.target.value);
        if (cleaned === null) return;
        setText(cleaned);
        onValue(parseAmount(cleaned));
      }}
    />
  );
}
