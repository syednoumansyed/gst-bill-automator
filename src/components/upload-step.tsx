"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, Settings, ShieldCheck, Sparkles } from "lucide-react";

import { ErrorNotice } from "@/components/error-notice";
import { ProgressSteps } from "@/components/progress-steps";
import { parseDocuments } from "@/components/review/api";
import type { ApiError, ParseResponse } from "@/components/review/model";
import { StatusBanner } from "@/components/status-banner";
import { UploadField } from "@/components/upload-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";

const MAX_FILE_SIZE_MB = 5;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

const FIELD_CLASS = "h-11 rounded-2xl border-2 border-black bg-white px-4";

type UploadStepProps = {
  onParsed: (parsed: ParseResponse, file: File, firaFile: File | null) => void;
};

export function UploadStep({ onParsed }: UploadStepProps) {
  const [file, setFile] = useState<File | null>(null);
  const [firaFile, setFiraFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [clientError, setClientError] = useState("");
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const errorRef = useRef<HTMLDivElement>(null);

  // Manual FIRA fields
  const [manualFiraReceivedUsd, setManualFiraReceivedUsd] = useState("");
  const [manualFiraRate, setManualFiraRate] = useState("");
  const [manualFiraBankCharges, setManualFiraBankCharges] = useState("");
  const [manualFiraRef, setManualFiraRef] = useState("");
  const [manualFiraDate, setManualFiraDate] = useState("");

  const hasManualFira = Boolean(manualFiraReceivedUsd || manualFiraRate || manualFiraBankCharges || manualFiraRef || manualFiraDate);
  const progressSteps = useMemo(() => buildProgressSteps(Boolean(firaFile) || hasManualFira), [firaFile, hasManualFira]);

  useEffect(() => {
    setCurrentStep(0);
    if (!loading) return;
    const interval = window.setInterval(() => setCurrentStep((step) => Math.min(step + 1, progressSteps.length - 1)), 1400);
    return () => window.clearInterval(interval);
  }, [loading, progressSteps.length]);

  const fail = (message: string, title: string) => {
    setClientError(message);
    toast({ variant: "destructive", title, description: message });
  };

  const handleSelect = (kind: "Deel invoice" | "FIRA", next: File | null) => {
    const validation = validatePdf(next, kind);
    if (validation) {
      if (kind === "FIRA") setFiraFile(null);
      else setFile(null);
      fail(validation, kind === "FIRA" ? "Invalid FIRA PDF" : "Invalid Deel PDF");
      return;
    }
    if (kind === "FIRA") setFiraFile(next);
    else setFile(next);
    setClientError("");
    setApiError(null);
  };

  const handleRead = async (e: React.FormEvent) => {
    e.preventDefault();

    const deelValidation = validatePdf(file, "Deel invoice");
    if (deelValidation) return fail(deelValidation, "Deel PDF required");
    const firaValidation = validatePdf(firaFile, "FIRA");
    if (firaValidation) return fail(firaValidation, "FIRA PDF invalid");
    if (firaFile && hasManualFira) {
      return fail("Cannot use both a FIRA PDF and Manual FIRA Data. Please clear one.", "Conflicting FIRA data");
    }
    if (hasManualFira && (!manualFiraRate || !manualFiraReceivedUsd)) {
      return fail("Manual FIRA entry needs the USD received and the exchange rate.", "Missing FIRA details");
    }

    setLoading(true);
    setClientError("");
    setApiError(null);

    const form = new FormData();
    form.append("file", file as File);
    if (firaFile) form.append("firaFile", firaFile);
    if (hasManualFira) {
      if (manualFiraReceivedUsd) form.append("manualFiraReceivedUsd", manualFiraReceivedUsd.trim());
      if (manualFiraRate) form.append("manualFiraRate", manualFiraRate.trim());
      if (manualFiraBankCharges) form.append("manualFiraBankCharges", manualFiraBankCharges.trim());
      if (manualFiraRef) form.append("manualFiraRef", manualFiraRef.trim());
      if (manualFiraDate) form.append("manualFiraDate", manualFiraDate.trim());
    }

    const result = await parseDocuments(form);
    setLoading(false);

    if (result.ok) {
      onParsed(result.data, file as File, firaFile);
      return;
    }
    setApiError(result.error);
    window.setTimeout(() => errorRef.current?.focus(), 0);
  };

  const manualDisabled = loading || Boolean(firaFile);

  return (
    <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
      <section className="space-y-6">
        <div className="overflow-hidden rounded-[32px] border-2 border-black bg-[#FFE36F] shadow-[8px_8px_0_0_black]">
          <div className="grid gap-6 px-6 py-8 md:grid-cols-[1fr_auto] md:px-8">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border-2 border-black bg-white px-3 py-1 text-xs font-black uppercase tracking-[0.25em]">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                Export Invoice Workbench
              </div>
              <div className="space-y-3">
                <h1 className="max-w-2xl text-4xl font-black uppercase tracking-[-0.04em] sm:text-5xl">
                  Generate the right GST invoice without second-guessing the paperwork.
                </h1>
                <p className="max-w-2xl text-base leading-7 text-black/70 sm:text-lg">
                  Upload the Deel invoice and the matching FIRA. The app reads them, shows you every value for review, and only
                  then generates the GST-compliant export invoice and syncs it to Airtable.
                </p>
              </div>
            </div>

            <div className="rounded-[28px] border-2 border-black bg-white p-4 shadow-[6px_6px_0_0_black]">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-black/55">Mistake Prevention</p>
              <ul className="mt-4 space-y-3 text-sm leading-6 text-black/80">
                <li className="flex gap-2">
                  <CheckCircle2 className="mt-1 h-4 w-4 shrink-0" aria-hidden />
                  Nothing is issued or saved until you have reviewed the values.
                </li>
                <li className="flex gap-2">
                  <CheckCircle2 className="mt-1 h-4 w-4 shrink-0" aria-hidden />
                  If a layout changes, you get the exact field to fix instead of a failure.
                </li>
                <li className="flex gap-2">
                  <CheckCircle2 className="mt-1 h-4 w-4 shrink-0" aria-hidden />
                  Airtable sync warnings stay visible after the PDF downloads.
                </li>
              </ul>
            </div>
          </div>
        </div>

        <Card className="overflow-hidden rounded-[28px] border-2 border-black bg-white shadow-[8px_8px_0_0_black]">
          <CardHeader className="border-b-2 border-black bg-[#FFF4C4] pb-6">
            <CardTitle className="text-2xl font-black uppercase tracking-[-0.03em]">Upload Documents</CardTitle>
            <CardDescription className="max-w-2xl text-sm leading-6 text-black/70">
              Attach the Deel invoice and either the FIRA PDF or manual FIRA details. Place of supply, SAC code, notes and
              invoice number can be changed on the review screen.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6 p-6 pt-6">
            <form id="read-form" onSubmit={handleRead} className="space-y-6">
              <div className="grid gap-5">
                <UploadField
                  id="deel-upload"
                  label="Deel Invoice PDF"
                  description="Primary source document. This drives invoice number matching, client data, and service period."
                  hint={`PDF only. Max ${MAX_FILE_SIZE_MB} MB.`}
                  required
                  file={file}
                  disabled={loading}
                  onSelect={(next) => handleSelect("Deel invoice", next)}
                />
                <UploadField
                  id="fira-upload"
                  label="FIRA PDF"
                  description="Optional. Use this only when you want the generated GST invoice in INR using the realized amount."
                  hint={`PDF only. Max ${MAX_FILE_SIZE_MB} MB. Use the FIRA from the same transfer cycle.`}
                  file={firaFile}
                  disabled={loading || hasManualFira}
                  onSelect={(next) => handleSelect("FIRA", next)}
                />
              </div>

              <div className={`rounded-[24px] border-2 border-black p-4 transition-colors ${firaFile ? "bg-black/5" : "bg-white"}`}>
                <div className="mb-4">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-black/55">Manual Realization Data</p>
                  <p className="mt-1 text-sm text-black/70">
                    If your bank FIRA is delayed (e.g., using Skydo), enter the FX details manually to generate an INR invoice.
                    Cannot be used if a FIRA PDF is attached.
                  </p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="manual-received-usd" className="flex flex-col gap-1">
                      <span className="text-xs font-black uppercase tracking-[0.16em]">USD Received in Skydo</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-black/50">Required with the exchange rate</span>
                    </Label>
                    <Input id="manual-received-usd" placeholder="e.g. 3597.00" type="text" inputMode="decimal" value={manualFiraReceivedUsd} disabled={manualDisabled} onChange={(e) => setManualFiraReceivedUsd(e.target.value)} className={FIELD_CLASS} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="manual-rate" className="text-xs font-black uppercase tracking-[0.16em]">
                      Exchange Rate <span className="text-red-500">*</span>
                    </Label>
                    <Input id="manual-rate" placeholder="e.g. 91.6601" type="text" inputMode="decimal" value={manualFiraRate} disabled={manualDisabled} onChange={(e) => setManualFiraRate(e.target.value)} className={FIELD_CLASS} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="manual-charges" className="text-xs font-black uppercase tracking-[0.16em]">
                      Skydo Fee + GST (INR)
                    </Label>
                    <Input id="manual-charges" placeholder="e.g. 1946.86" type="text" inputMode="decimal" value={manualFiraBankCharges} disabled={manualDisabled} onChange={(e) => setManualFiraBankCharges(e.target.value)} className={FIELD_CLASS} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="manual-ref" className="text-xs font-black uppercase tracking-[0.16em]">
                      Reference / FIRA No.
                    </Label>
                    <Input id="manual-ref" placeholder="e.g. SKYDO-6MAR" value={manualFiraRef} disabled={manualDisabled} onChange={(e) => setManualFiraRef(e.target.value)} className={FIELD_CLASS} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="manual-date" className="text-xs font-black uppercase tracking-[0.16em]">
                      Processing Date
                    </Label>
                    <Input id="manual-date" type="date" value={manualFiraDate} disabled={manualDisabled} onChange={(e) => setManualFiraDate(e.target.value)} className={`${FIELD_CLASS} block w-full uppercase`} />
                  </div>
                </div>
              </div>
            </form>
          </CardContent>

          <CardFooter className="flex-col items-stretch gap-4 border-t-2 border-black bg-[#FCFBF7] p-6">
            {clientError && <StatusBanner title="Action Needed" description={clientError} variant="error" />}
            {apiError && <ErrorNotice ref={errorRef} error={apiError} title="Could not read the documents" />}

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                form="read-form"
                type="submit"
                disabled={!file || loading}
                className="h-14 flex-1 rounded-2xl border-2 border-black bg-[#FFE36F] px-6 text-base font-black uppercase tracking-[0.12em] text-black hover:bg-[#FFD84A]"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                    {progressSteps[currentStep]}
                  </>
                ) : (
                  <>
                    Read documents
                    <ArrowRight className="h-5 w-5" aria-hidden />
                  </>
                )}
              </Button>

              {process.env.NEXT_PUBLIC_SHARE_MODE !== "1" && (
                <Button variant="outline" asChild className="h-14 rounded-2xl border-2 border-black bg-white px-5 text-sm font-black uppercase tracking-[0.12em]">
                  <Link href="/settings" className="flex items-center justify-center">
                    <Settings className="mr-2 h-4 w-4" aria-hidden />
                    Review Settings
                  </Link>
                </Button>
              )}
            </div>
          </CardFooter>
        </Card>
      </section>

      <aside className="space-y-6">
        <Card className="overflow-hidden rounded-[28px] border-2 border-black bg-white shadow-[8px_8px_0_0_black]">
          <CardHeader className="border-b-2 border-black bg-[#E9F6FF]">
            <CardTitle className="flex items-center gap-2 text-xl font-black uppercase tracking-[0.04em]">
              <ShieldCheck className="h-5 w-5" aria-hidden />
              Live Run Status
            </CardTitle>
            <CardDescription className="text-sm leading-6 text-black/70">
              Follow the reading step so you always know what the app is doing. Nothing is saved at this stage.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 p-6">
            <ProgressSteps steps={progressSteps} currentStep={currentStep} active={loading} />
            {!loading && (
              <div className="rounded-2xl border-2 border-dashed border-black/20 bg-[#F8F7F3] p-4 text-sm leading-6 text-black/65">
                Start a run to see staged progress here. The flow adapts automatically when a FIRA is included.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden rounded-[28px] border-2 border-black bg-white shadow-[8px_8px_0_0_black]">
          <CardHeader className="border-b-2 border-black bg-[#F4EDFF]">
            <CardTitle className="text-xl font-black uppercase tracking-[0.04em]">Current Run Checklist</CardTitle>
            <CardDescription className="text-sm leading-6 text-black/70">Use this before you read the documents.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 p-6 text-sm leading-6">
            <ChecklistItem done={Boolean(file)} label={file ? "Deel invoice attached" : "Attach the Deel invoice PDF"} />
            <ChecklistItem
              done={Boolean(firaFile) || hasManualFira}
              subtle={!firaFile && !hasManualFira}
              label={
                firaFile
                  ? "FIRA attached for INR realization"
                  : hasManualFira
                    ? "Manual FIRA data entered for INR realization"
                    : "FIRA or manual realization data is optional. Add it only when you want INR-based GST values."
              }
            />
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function ChecklistItem({ done, label, subtle = false }: { done: boolean; label: string; subtle?: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border-2 border-black px-3 py-3 shadow-[3px_3px_0_0_black]">
      <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-black ${done ? "bg-[#FFE36F]" : "bg-white"}`}>
        {done ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <AlertCircle className="h-4 w-4" aria-hidden />}
      </div>
      <p className={`text-sm leading-6 ${subtle ? "text-black/60" : "text-black/85"}`}>{label}</p>
    </div>
  );
}

function buildProgressSteps(hasFira: boolean) {
  const steps = ["Preparing files", "Reading Deel invoice"];
  if (hasFira) steps.push("Reading FIRA");
  steps.push("Cross-checking values");
  return steps;
}

function validatePdf(file: File | null, label: string) {
  if (!file) {
    return label === "Deel invoice" ? "Attach the Deel invoice PDF before reading the documents." : "";
  }

  const name = file.name.toLowerCase();
  const looksLikePdf = file.type === "application/pdf" || name.endsWith(".pdf");
  if (!looksLikePdf) {
    return `${label} must be uploaded as a PDF.`;
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `${label} exceeds ${MAX_FILE_SIZE_MB} MB. Compress the file or export a smaller PDF before uploading.`;
  }

  return "";
}
