"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { DoneStep } from "@/components/review/done-step";
import type { GenerateOutcome } from "@/components/review/api";
import type { ParseResponse } from "@/components/review/model";
import { ReviewStep } from "@/components/review/review-step";
import { UploadStep } from "@/components/upload-step";
import { Button } from "@/components/ui/button";

type SetupStatus = { ready: boolean; configExists: boolean; missing: string[] };

type Flow =
  | { step: "upload" }
  | { step: "review"; parsed: ParseResponse; file: File; firaFile: File | null }
  | { step: "done"; outcome: GenerateOutcome; invoiceNumber: string; generatedAt: string };

export default function Home() {
  const router = useRouter();
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [flow, setFlow] = useState<Flow>({ step: "upload" });
  // Bumped on "Start over" so every step remounts with empty state
  const [run, setRun] = useState(0);

  // First run goes straight to /setup; a half-filled config gets a banner instead
  useEffect(() => {
    fetch("/api/config/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((status: SetupStatus | null) => {
        if (!status) return;
        if (!status.configExists) router.replace("/setup");
        else setSetupStatus(status);
      })
      .catch(() => {});
  }, [router]);

  const startOver = () => {
    setFlow({ step: "upload" });
    setRun((n) => n + 1);
    window.scrollTo({ top: 0 });
  };

  return (
    <main className="min-h-screen bg-[#F6F1E8] px-4 py-8 text-black sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        {setupStatus && !setupStatus.ready && (
          <div role="alert" className="flex flex-col gap-4 rounded-[28px] border-2 border-black bg-red-100 p-6 shadow-[8px_8px_0_0_black] sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-black uppercase tracking-[0.16em] text-red-950">Finish setup first</p>
              <p className="text-sm leading-6 text-red-950">
                Invoices can&apos;t be generated until these are filled in: {setupStatus.missing.join(", ")}.
              </p>
            </div>
            <Button asChild className="h-12 shrink-0 rounded-2xl border-2 border-black bg-white px-5 text-sm font-black uppercase tracking-[0.12em] text-black hover:bg-[#FFE36F]">
              <Link href="/setup">
                Open setup
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        )}

        {flow.step === "upload" && (
          <UploadStep key={run} onParsed={(parsed, file, firaFile) => { setFlow({ step: "review", parsed, file, firaFile }); window.scrollTo({ top: 0 }); }} />
        )}

        {flow.step === "review" && (
          <ReviewStep
            key={run}
            parsed={flow.parsed}
            file={flow.file}
            firaFile={flow.firaFile}
            onStartOver={startOver}
            onDone={(outcome, draftInvoiceNumber) => {
              const invoiceNumber = outcome.fileName.replace(/-GST\.pdf$/i, "") || draftInvoiceNumber;
              setFlow({ step: "done", outcome, invoiceNumber, generatedAt: new Date().toLocaleString() });
              window.scrollTo({ top: 0 });
            }}
          />
        )}

        {flow.step === "done" && (
          <DoneStep outcome={flow.outcome} invoiceNumber={flow.invoiceNumber} generatedAt={flow.generatedAt} onStartOver={startOver} />
        )}
      </div>
    </main>
  );
}
