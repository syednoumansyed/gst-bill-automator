"use client";

import { useEffect, useRef } from "react";
import { RotateCcw } from "lucide-react";

import { StatusBanner } from "@/components/status-banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { GenerateOutcome } from "./api";

const SYNC_LABEL = { success: "Synced", skipped: "Skipped", warning: "Warning", failed: "Failed" } as const;

/** Banner titles for the sync failures that need a specific next step; the message explains it. */
const SYNC_PROBLEM_TITLE: Record<string, string> = {
  AIRTABLE_UNCERTAIN: "Check Airtable before generating again",
  BLOB_CLEANUP_FAILED: "Uploaded PDFs need cleaning up",
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-2xl border border-black/15 bg-[#F8F7F3] px-4 py-3">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-black/55">{label}</p>
      <p className="break-all text-right text-sm font-semibold text-black">{value}</p>
    </div>
  );
}

export function DoneStep({ outcome, invoiceNumber, generatedAt, onStartOver }: { outcome: GenerateOutcome; invoiceNumber: string; generatedAt: string; onStartOver: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  const syncProblem = outcome.syncStatus === "warning" || outcome.syncStatus === "failed";

  return (
    <Card className="mx-auto max-w-2xl overflow-hidden rounded-[28px] border-2 border-black bg-white shadow-[8px_8px_0_0_black]">
      <CardHeader className="border-b-2 border-black bg-[#E8FFE7]">
        <CardTitle>
          <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-black uppercase tracking-[-0.03em] outline-none">
            GST invoice generated
          </h1>
        </CardTitle>
        <CardDescription className="text-sm leading-6 text-black/70">
          The PDF was downloaded. Use this as the confirmation block before you move to the GST portal.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-6">
        <Row label="Invoice file" value={outcome.fileName} />
        <Row label="Invoice number" value={invoiceNumber} />
        <Row label="Generated at" value={generatedAt} />
        <Row label="Airtable status" value={SYNC_LABEL[outcome.syncStatus]} />
        <div role="status">
          {syncProblem ? (
            <StatusBanner
              title={SYNC_PROBLEM_TITLE[outcome.syncCode] ?? "Airtable sync needs attention"}
              description={outcome.syncMessage}
              variant="warning"
            />
          ) : (
            <div className="rounded-2xl border border-black/20 bg-[#F8F7F3] p-4 text-sm leading-6 text-black/70">{outcome.syncMessage}</div>
          )}
        </div>
        {outcome.warnings.length > 0 && (
          <StatusBanner title="Check Before Filing" description={outcome.warnings.join(" ")} variant="warning" />
        )}
        <Button
          type="button"
          onClick={onStartOver}
          className="mt-2 h-14 w-full rounded-2xl border-2 border-black bg-[#FFE36F] px-6 text-base font-black uppercase tracking-[0.12em] text-black hover:bg-[#FFD84A]"
        >
          <RotateCcw className="h-5 w-5" aria-hidden />
          Start over
        </Button>
      </CardContent>
    </Card>
  );
}
