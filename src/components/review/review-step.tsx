"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

import { ErrorNotice } from "@/components/error-notice";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";
import type { InvoiceDraft } from "@/lib/draft";
import type { Issue } from "@/lib/errors";
import { downloadBlob, generateInvoice, type GenerateOutcome } from "./api";
import { ReviewContext } from "./context";
import { DerivedSummary } from "./derived-summary";
import { DiagnosticsButton } from "./diagnostics-button";
import { GeneratePanel } from "./generate-panel";
import { IssuesPanel } from "./issues-panel";
import {
  buildMeta,
  crossChecks,
  diffEdited,
  fieldId,
  isErrorUnresolved,
  issueTarget,
  issuesFromError,
  needsConfirmation,
  setAt,
  sortIssues,
  type ApiError,
  type ParseResponse,
} from "./model";
import { DeelGroup, FiraGroup, OptionsGroup } from "./review-fields";

const GENERATE_STEPS = ["Checking values", "Generating GST PDF", "Syncing Airtable"];

type ReviewStepProps = {
  parsed: ParseResponse;
  file: File;
  firaFile: File | null;
  onStartOver: () => void;
  onDone: (outcome: GenerateOutcome, invoiceNumber: string) => void;
};

export function ReviewStep({ parsed, file, firaFile, onStartOver, onDone }: ReviewStepProps) {
  const [baseline] = useState<InvoiceDraft>(parsed.draft);
  const [draft, setDraftState] = useState<InvoiceDraft>(parsed.draft);
  const [issues, setIssues] = useState<Issue[]>(() => sortIssues(parsed.issues));
  /** Paths the user changed since the current issue list arrived; an issue counts as resolved once its field is in here */
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [genError, setGenError] = useState<ApiError | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const issuesRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const highlightTimer = useRef<number | undefined>(undefined);

  const meta = useMemo(() => buildMeta(parsed), [parsed]);
  const edited = useMemo(() => new Set(diffEdited(baseline, draft)), [baseline, draft]);
  const checks = useMemo(() => crossChecks(draft), [draft]);
  const checksOk = checks.every((c) => c.ok);
  const needsConfirm = needsConfirmation(meta, edited, draft);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!loading) return;
    setStepIndex(0);
    const timer = window.setInterval(() => setStepIndex((s) => Math.min(s + 1, GENERATE_STEPS.length - 1)), 1400);
    return () => window.clearInterval(timer);
  }, [loading]);

  useEffect(() => () => window.clearTimeout(highlightTimer.current), []);

  const unresolved = useMemo(() => issues.filter((i) => isErrorUnresolved(i, touched, checksOk)), [issues, touched, checksOk]);

  const openIssues = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const issue of unresolved) {
      const target = issueTarget(issue.field);
      if (target) map.set(target, [...(map.get(target) ?? []), issue]);
    }
    return map;
  }, [unresolved]);

  const blockers = useMemo(() => {
    const list: string[] = [];
    if (unresolved.length) list.push(`${unresolved.length} ${unresolved.length === 1 ? "issue is" : "issues are"} still open in the panel above.`);
    for (const c of checks) if (!c.ok) list.push(c.label);
    return list;
  }, [unresolved, checks]);

  const markChanged = useCallback((path: string) => {
    setTouched((prev) => new Set(prev).add(path));
    setConfirmed(false);
  }, []);

  const setPath = useCallback(
    (path: string, value: unknown) => {
      setDraftState((d) => setAt(d, path, value));
      markChanged(path);
    },
    [markChanged],
  );

  const setDraft = useCallback(
    (update: (d: InvoiceDraft) => InvoiceDraft) => {
      setDraftState(update);
      markChanged("deel.lineItems");
    },
    [markChanged],
  );

  const goToField = useCallback((path: string) => {
    const el =
      document.getElementById(fieldId(path)) ??
      document.querySelector<HTMLElement>(`[data-field-path^="${path}."]`) ??
      document.getElementById(`group-${path.split(".")[0]}`);
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
    setHighlight(el.getAttribute("data-field-path") ?? path);
    window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlight(null), 3000);
  }, []);

  const handleGenerate = async () => {
    setLoading(true);
    setGenError(null);
    const form = new FormData();
    form.append("draft", JSON.stringify({ ...draft, edited: [...edited] }));
    form.append("file", file);
    if (firaFile) form.append("firaFile", firaFile);

    const result = await generateInvoice(form);
    setLoading(false);

    if (result.ok) {
      downloadBlob(result.data.blob, result.data.fileName);
      toast({
        title: result.data.syncStatus === "success" ? "GST invoice ready" : "Invoice created",
        description: result.data.syncStatus === "success" ? "PDF downloaded and Airtable updated." : "PDF downloaded. Check the sync result.",
      });
      onDone(result.data, draft.options.overrideInvoiceNumber || draft.deel.invoiceNumber);
      return;
    }

    // Nothing was issued or stored. Map the server's issues back onto the fields and let the user fix them.
    const fresh = issuesFromError(result.error);
    const kept = issues.filter((old) => old.severity === "warning" && !fresh.some((n) => n.code === old.code && n.field === old.field));
    setIssues(sortIssues([...fresh, ...kept]));
    setTouched(new Set());
    setConfirmed(false);
    setGenError(result.error);
    toast({ variant: "destructive", title: "Nothing was issued", description: result.error.action || result.error.error });
    window.setTimeout(() => errorRef.current?.focus(), 0);
  };

  return (
    <ReviewContext.Provider value={{ draft, meta, edited, openIssues, highlight, disabled: loading, setPath, setDraft }}>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 ref={headingRef} tabIndex={-1} className="text-3xl font-black uppercase tracking-[-0.03em] outline-none sm:text-4xl">
              Review before generating
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-black/70">
              Nothing has been issued or saved yet. Check each value against the PDFs, fix what is flagged, then generate.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={onStartOver}
            disabled={loading}
            className="h-11 shrink-0 rounded-2xl border-2 border-black bg-white px-4 text-xs font-black uppercase tracking-[0.12em]"
          >
            <RotateCcw className="h-4 w-4" aria-hidden />
            Start over
          </Button>
        </div>

        {genError && <ErrorNotice ref={errorRef} error={genError} title="Nothing was issued" />}

        <IssuesPanel ref={issuesRef} issues={issues} isOpen={(i) => unresolved.includes(i)} onGoToField={goToField} />

        <div className="grid gap-6 lg:grid-cols-[1.3fr_0.7fr] lg:items-start">
          <div className="min-w-0 space-y-6">
            <DeelGroup />
            <FiraGroup />
            <OptionsGroup />
          </div>

          <aside className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto" aria-label="Summary and generate">
            <Card className="rounded-[28px] border-2 border-black bg-white shadow-[8px_8px_0_0_black]">
              <CardContent className="space-y-6 p-4 sm:p-6">
                <DerivedSummary draft={draft} checks={checks} />
                <GeneratePanel
                  blockers={blockers}
                  needsConfirm={needsConfirm}
                  confirmed={confirmed}
                  onConfirmChange={setConfirmed}
                  loading={loading}
                  stepLabel={GENERATE_STEPS[stepIndex]}
                  onGenerate={handleGenerate}
                />
                <DiagnosticsButton parsed={parsed} issues={issues} />
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </ReviewContext.Provider>
  );
}
