"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { ProgressSteps } from "@/components/progress-steps";
import { StatusBanner } from "@/components/status-banner";
import { UploadField } from "@/components/upload-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";

const MAX_FILE_SIZE_MB = 5;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

type LastRun = {
  fileName: string;
  invoiceNumber: string;
  generatedAt: string;
  syncStatus: "success" | "warning" | "skipped";
  syncMessage: string;
};

type SetupStatus = { ready: boolean; configExists: boolean; missing: string[] };

export default function Home() {
  const router = useRouter();
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [firaFile, setFiraFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const [notes, setNotes] = useState("");
  const [overrideHsnSac, setOverrideHsnSac] = useState("");
  const [overrideInvoiceNumber, setOverrideInvoiceNumber] = useState("");
  
  // Manual FIRA Fields
  const [manualFiraReceivedUsd, setManualFiraReceivedUsd] = useState("");
  const [manualFiraRate, setManualFiraRate] = useState("");
  const [manualFiraBankCharges, setManualFiraBankCharges] = useState("");
  const [manualFiraRef, setManualFiraRef] = useState("");
  const [manualFiraDate, setManualFiraDate] = useState("");

  const [currentStep, setCurrentStep] = useState(0);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);

  const hasOverrides = Boolean(placeOfSupply || notes || overrideHsnSac || overrideInvoiceNumber);
  const hasManualFira = Boolean(
    manualFiraReceivedUsd || manualFiraRate || manualFiraBankCharges || manualFiraRef || manualFiraDate
  );
  const progressSteps = useMemo(
    () => buildProgressSteps(Boolean(firaFile) || hasManualFira, hasOverrides),
    [firaFile, hasManualFira, hasOverrides],
  );

  const invoiceNumberWarning = useMemo(() => {
    if (!overrideInvoiceNumber) {
      return "";
    }

    return /^INV-\d{2}-\d{2}(-[\w-]+)?$/i.test(overrideInvoiceNumber)
      ? ""
      : "Override invoice numbers should usually follow the INV-YY-YY-XX pattern so Airtable and GST records stay aligned.";
  }, [overrideInvoiceNumber]);

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

  useEffect(() => {
    if (!loading) {
      setCurrentStep(0);
      return;
    }

    setCurrentStep(0);

    const interval = window.setInterval(() => {
      setCurrentStep((step) => Math.min(step + 1, progressSteps.length - 1));
    }, 1400);

    return () => window.clearInterval(interval);
  }, [loading, progressSteps.length]);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();

    const deelValidation = validatePdf(file, "Deel invoice");
    if (deelValidation) {
      setError(deelValidation);
      toast({
        variant: "destructive",
        title: "Deel PDF required",
        description: deelValidation,
      });
      return;
    }

    const firaValidation = validatePdf(firaFile, "FIRA");
    if (firaValidation) {
      setError(firaValidation);
      toast({
        variant: "destructive",
        title: "FIRA PDF invalid",
        description: firaValidation,
      });
      return;
    }

    if (firaFile && hasManualFira) {
      setError("Cannot use both a FIRA PDF and Manual FIRA Data. Please clear one.");
      toast({
        variant: "destructive",
        title: "Conflicting FIRA data",
        description: "Please either upload a FIRA PDF OR enter manual FIRA data, not both.",
      });
      return;
    }

    if (hasManualFira && (!manualFiraRate || !manualFiraReceivedUsd)) {
      setError("Manual FIRA entry needs the USD received and the exchange rate.");
      toast({
        variant: "destructive",
        title: "Missing FIRA details",
        description: "Enter both the USD received and the exchange rate for a manual FIRA.",
      });
      return;
    }

    setLoading(true);
    setError("");
    setNotice("");
    setWarnings([]);
    setLastRun(null);

    try {
      const formData = new FormData();
      formData.append("file", file as File);
      if (firaFile) formData.append("firaFile", firaFile);
      if (placeOfSupply) formData.append("placeOfSupply", placeOfSupply.trim());
      if (notes) formData.append("notes", notes.trim());
      if (overrideHsnSac) formData.append("overrideHsnSac", overrideHsnSac.trim());
      if (overrideInvoiceNumber) formData.append("overrideInvoiceNumber", overrideInvoiceNumber.trim());
      
      if (hasManualFira) {
        if (manualFiraReceivedUsd) formData.append("manualFiraReceivedUsd", manualFiraReceivedUsd.trim());
        if (manualFiraRate) formData.append("manualFiraRate", manualFiraRate.trim());
        if (manualFiraBankCharges) formData.append("manualFiraBankCharges", manualFiraBankCharges.trim());
        if (manualFiraRef) formData.append("manualFiraRef", manualFiraRef.trim());
        if (manualFiraDate) formData.append("manualFiraDate", manualFiraDate.trim());
      }

      const res = await fetch("/api/generate", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to generate invoice");
      }

      const blob = await res.blob();
      const airtableSyncStatus = (res.headers.get("X-Airtable-Sync-Status") || "skipped") as
        | "success"
        | "warning"
        | "skipped";
      const airtableSyncMessage = res.headers.get("X-Airtable-Sync-Message");
      const contentDisposition = res.headers.get("Content-Disposition");
      const invoiceWarnings = parseWarnings(res.headers.get("X-Invoice-Warnings"));
      setWarnings(invoiceWarnings);

      let filename = "Generated-GST-Invoice.pdf";
      if (contentDisposition) {
        const titleMatch = contentDisposition.match(/filename="(.+)"/);
        if (titleMatch && titleMatch.length === 2) {
          filename = titleMatch[1];
        }
      }

      const syncMessage =
        airtableSyncStatus === "warning"
          ? airtableSyncMessage
            ? decodeURIComponent(airtableSyncMessage)
            : "Invoice generated, but Airtable sync needs attention."
          : airtableSyncStatus === "success"
            ? "Airtable sync completed with document links and compliance metadata."
            : "Invoice downloaded. Airtable sync was skipped because integration is not configured.";

      if (airtableSyncStatus === "warning" || invoiceWarnings.length > 0) {
        if (airtableSyncStatus === "warning") setNotice(syncMessage);
        toast({
          title: "Invoice created with warning",
          description: airtableSyncStatus === "warning" ? syncMessage : invoiceWarnings[0],
        });
      } else {
        setNotice("");
        toast({
          title: "GST invoice ready",
          description:
            airtableSyncStatus === "success"
              ? "PDF downloaded and Airtable updated."
              : "PDF downloaded successfully.",
        });
      }

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      setLastRun({
        fileName: filename,
        invoiceNumber: filename.replace(/-GST\.pdf$/i, ""),
        generatedAt: new Date().toLocaleString(),
        syncStatus: airtableSyncStatus,
        syncMessage,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to generate invoice";
      setError(message);
      toast({
        variant: "destructive",
        title: "Generation failed",
        description: message,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#F6F1E8] px-4 py-8 text-black sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="space-y-6">
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

          <div className="overflow-hidden rounded-[32px] border-2 border-black bg-[#FFE36F] shadow-[8px_8px_0_0_black]">
            <div className="grid gap-6 px-6 py-8 md:grid-cols-[1fr_auto] md:px-8">
              <div className="space-y-4">
                <div className="inline-flex items-center gap-2 rounded-full border-2 border-black bg-white px-3 py-1 text-xs font-black uppercase tracking-[0.25em]">
                  <Sparkles className="h-3.5 w-3.5" />
                  Export Invoice Workbench
                </div>
                <div className="space-y-3">
                  <h1 className="max-w-2xl text-4xl font-black uppercase tracking-[-0.04em] sm:text-5xl">
                    Generate the right GST invoice without second-guessing the paperwork.
                  </h1>
                  <p className="max-w-2xl text-base leading-7 text-black/70 sm:text-lg">
                    Upload the Deel invoice, optionally add the matching FIRA, and let the app
                    generate the GST-compliant export invoice, sync it to Airtable, and keep the
                    compliance trail aligned.
                  </p>
                </div>
              </div>

              <div className="rounded-[28px] border-2 border-black bg-white p-4 shadow-[6px_6px_0_0_black]">
                <p className="text-xs font-black uppercase tracking-[0.18em] text-black/55">
                  Mistake Prevention
                </p>
                <ul className="mt-4 space-y-3 text-sm leading-6 text-black/80">
                  <li className="flex gap-2">
                    <CheckCircle2 className="mt-1 h-4 w-4 shrink-0" />
                    Deel PDF is required. FIRA stays optional until you want INR realization data.
                  </li>
                  <li className="flex gap-2">
                    <CheckCircle2 className="mt-1 h-4 w-4 shrink-0" />
                    Mismatched Deel/FIRA documents are blocked before invoice generation.
                  </li>
                  <li className="flex gap-2">
                    <CheckCircle2 className="mt-1 h-4 w-4 shrink-0" />
                    Airtable sync warnings stay visible after the PDF downloads.
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <Card className="overflow-hidden rounded-[28px] border-2 border-black bg-white shadow-[8px_8px_0_0_black]">
            <CardHeader className="border-b-2 border-black bg-[#FFF4C4] pb-6">
              <CardTitle className="text-2xl font-black uppercase tracking-[-0.03em]">
                Generate Invoice
              </CardTitle>
              <CardDescription className="max-w-2xl text-sm leading-6 text-black/70">
                Use defaults for the standard run. Open Advanced Overrides only when you need to
                change place of supply, GST note, SAC code, or invoice number for a specific case.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6 p-6 pt-6">
              <form id="generate-form" onSubmit={handleGenerate} className="space-y-6">
                <div className="grid gap-5">
                  <UploadField
                    id="deel-upload"
                    label="Deel Invoice PDF"
                    description="Primary source document. This drives invoice number matching, client data, and service period."
                    hint={`PDF only. Max ${MAX_FILE_SIZE_MB} MB.`}
                    required
                    file={file}
                    disabled={loading}
                    onSelect={(nextFile) => {
                      const validation = validatePdf(nextFile, "Deel invoice");
                      if (validation) {
                        setFile(null);
                        setError(validation);
                        toast({
                          variant: "destructive",
                          title: "Invalid Deel PDF",
                          description: validation,
                        });
                        return;
                      }
                      setFile(nextFile);
                      setError("");
                    }}
                  />

                  <UploadField
                    id="fira-upload"
                    label="FIRA PDF"
                    description="Optional. Use this only when you want the generated GST invoice in INR using the realized amount."
                    hint={`PDF only. Max ${MAX_FILE_SIZE_MB} MB. Use the FIRA from the same transfer cycle.`}
                    file={firaFile}
                    disabled={loading || hasManualFira}
                    onSelect={(nextFile) => {
                      const validation = validatePdf(nextFile, "FIRA");
                      if (validation) {
                        setFiraFile(null);
                        setError(validation);
                        toast({
                          variant: "destructive",
                          title: "Invalid FIRA PDF",
                          description: validation,
                        });
                        return;
                      }
                      setFiraFile(nextFile);
                      setError("");
                    }}
                  />
                </div>
                
                <div className={`rounded-[24px] border-2 border-black p-4 transition-colors ${firaFile ? "bg-black/5" : "bg-white"}`}>
                  <div className="mb-4">
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-black/55">
                      Manual Realization Data
                    </p>
                    <p className="mt-1 text-sm text-black/70">
                      If your bank FIRA is delayed (e.g., using Skydo), enter the FX details manually to generate an INR invoice. 
                      Cannot be used if a FIRA PDF is attached.
                    </p>
                  </div>
                  
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="manual-received-usd" className="flex flex-col gap-1">
                        <span className="text-xs font-black uppercase tracking-[0.16em]">USD Received in Skydo</span>
                        <span className="text-[10px] uppercase font-bold text-black/50 tracking-wider">Leaves blank to default to Billed - $5</span>
                      </Label>
                      <Input
                        id="manual-received-usd"
                        placeholder="e.g. 3597.00"
                        type="text"
                        inputMode="decimal"
                        value={manualFiraReceivedUsd}
                        disabled={loading || Boolean(firaFile)}
                        onChange={(e) => setManualFiraReceivedUsd(e.target.value)}
                        className="h-11 rounded-2xl border-2 border-black bg-white px-4"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="manual-rate" className="text-xs font-black uppercase tracking-[0.16em]">
                        Exchange Rate <span className="text-red-500">*</span>
                      </Label>
                      <Input
                        id="manual-rate"
                        placeholder="e.g. 91.6601"
                        type="text"
                        inputMode="decimal"
                        value={manualFiraRate}
                        disabled={loading || Boolean(firaFile)}
                        onChange={(e) => setManualFiraRate(e.target.value)}
                        className="h-11 rounded-2xl border-2 border-black bg-white px-4"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="manual-charges" className="text-xs font-black uppercase tracking-[0.16em]">
                        Skydo Fee + GST (INR)
                      </Label>
                      <Input
                        id="manual-charges"
                        placeholder="e.g. 1946.86"
                        type="text"
                        inputMode="decimal"
                        value={manualFiraBankCharges}
                        disabled={loading || Boolean(firaFile)}
                        onChange={(e) => setManualFiraBankCharges(e.target.value)}
                        className="h-11 rounded-2xl border-2 border-black bg-white px-4"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="manual-ref" className="text-xs font-black uppercase tracking-[0.16em]">
                        Reference / FIRA No.
                      </Label>
                      <Input
                        id="manual-ref"
                        placeholder="e.g. SKYDO-6MAR"
                        value={manualFiraRef}
                        disabled={loading || Boolean(firaFile)}
                        onChange={(e) => setManualFiraRef(e.target.value)}
                        className="h-11 rounded-2xl border-2 border-black bg-white px-4"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="manual-date" className="text-xs font-black uppercase tracking-[0.16em]">
                        Processing Date
                      </Label>
                      <Input
                        id="manual-date"
                        type="date"
                        value={manualFiraDate}
                        disabled={loading || Boolean(firaFile)}
                        onChange={(e) => setManualFiraDate(e.target.value)}
                        className="h-11 w-full rounded-2xl border-2 border-black bg-white px-4 uppercase block"
                      />
                    </div>
                  </div>
                </div>

                <div className="rounded-[24px] border-2 border-black bg-[#F8F7F3] p-4">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((value) => !value)}
                    className="flex w-full items-center justify-between gap-3 text-left"
                  >
                    <div>
                      <p className="text-xs font-black uppercase tracking-[0.18em] text-black/55">
                        Advanced Overrides
                      </p>
                      <p className="mt-1 text-sm text-black/70">
                        Use overrides only when this run differs from your standard export setup.
                      </p>
                    </div>
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl border-2 border-black bg-white">
                      <ChevronDown
                        className={`h-5 w-5 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                      />
                    </span>
                  </button>

                  {showAdvanced && (
                    <div className="mt-5 grid gap-4 border-t-2 border-dashed border-black/20 pt-5">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="place" className="text-xs font-black uppercase tracking-[0.16em]">
                            Place of Supply
                          </Label>
                          <Input
                            id="place"
                            placeholder="Outside India (e.g. United States)"
                            value={placeOfSupply}
                            disabled={loading}
                            onChange={(e) => setPlaceOfSupply(e.target.value)}
                            className="h-11 rounded-2xl border-2 border-black bg-white px-4"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="hsn" className="text-xs font-black uppercase tracking-[0.16em]">
                            SAC Code
                          </Label>
                          <Input
                            id="hsn"
                            placeholder="998392"
                            value={overrideHsnSac}
                            disabled={loading}
                            onChange={(e) => setOverrideHsnSac(e.target.value)}
                            className="h-11 rounded-2xl border-2 border-black bg-white px-4"
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="inv-num" className="text-xs font-black uppercase tracking-[0.16em]">
                          Invoice Number Override
                        </Label>
                        <Input
                          id="inv-num"
                          placeholder="INV-25-26-001"
                          value={overrideInvoiceNumber}
                          disabled={loading}
                          onChange={(e) => setOverrideInvoiceNumber(e.target.value)}
                          className="h-11 rounded-2xl border-2 border-black bg-white px-4"
                        />
                        <p className="text-xs text-black/55">
                          Leave blank to let the app derive the invoice number from the Deel issue date.
                        </p>
                        {invoiceNumberWarning && (
                          <p className="rounded-xl border border-amber-900/30 bg-amber-100 px-3 py-2 text-xs text-amber-950">
                            {invoiceNumberWarning}
                          </p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="notes" className="text-xs font-black uppercase tracking-[0.16em]">
                          GST Note Override
                        </Label>
                        <Textarea
                          id="notes"
                          placeholder="Override the export statement only when this shipment needs a custom GST note."
                          value={notes}
                          disabled={loading}
                          onChange={(e) => setNotes(e.target.value)}
                          className="min-h-[110px] rounded-2xl border-2 border-black bg-white px-4 py-3"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </form>
            </CardContent>

            <CardFooter className="flex-col items-stretch gap-4 border-t-2 border-black bg-[#FCFBF7] p-6">
              {error && (
                <StatusBanner
                  title="Action Needed"
                  description={error}
                  variant="error"
                />
              )}

              {notice && !error && (
                <StatusBanner
                  title="Generation Completed With Warning"
                  description={notice}
                  variant="warning"
                />
              )}

              {warnings.length > 0 && !error && (
                <StatusBanner
                  title="Check Before Filing"
                  description={warnings.join(" ")}
                  variant="warning"
                />
              )}

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  form="generate-form"
                  type="submit"
                  disabled={!file || loading}
                  className="h-14 flex-1 rounded-2xl border-2 border-black bg-[#FFE36F] px-6 text-base font-black uppercase tracking-[0.12em] text-black hover:bg-[#FFD84A]"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      {progressSteps[currentStep]}
                    </>
                  ) : (
                    <>
                      Generate GST Invoice
                      <ArrowRight className="h-5 w-5" />
                    </>
                  )}
                </Button>

                {process.env.NEXT_PUBLIC_SHARE_MODE !== "1" && (
                  <Button
                    variant="outline"
                    asChild
                    className="h-14 rounded-2xl border-2 border-black bg-white px-5 text-sm font-black uppercase tracking-[0.12em]"
                  >
                    <Link href="/settings" className="flex items-center justify-center">
                      <Settings className="mr-2 h-4 w-4" />
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
                <ShieldCheck className="h-5 w-5" />
                Live Run Status
              </CardTitle>
              <CardDescription className="text-sm leading-6 text-black/70">
                Follow the run from parsing through Airtable sync so you always know what the app is doing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5 p-6">
              <ProgressSteps
                steps={progressSteps}
                currentStep={currentStep}
                active={loading}
              />

              {!loading && (
                <div className="rounded-2xl border-2 border-dashed border-black/20 bg-[#F8F7F3] p-4 text-sm leading-6 text-black/65">
                  Start a run to see staged progress here. The flow adapts automatically when a FIRA
                  PDF is included.
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="overflow-hidden rounded-[28px] border-2 border-black bg-white shadow-[8px_8px_0_0_black]">
            <CardHeader className="border-b-2 border-black bg-[#F4EDFF]">
              <CardTitle className="text-xl font-black uppercase tracking-[0.04em]">
                Current Run Checklist
              </CardTitle>
              <CardDescription className="text-sm leading-6 text-black/70">
                Use this before you hit generate. It keeps the compliance packet clean.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-6 text-sm leading-6">
              <ChecklistItem
                done={Boolean(file)}
                label={file ? "Deel invoice attached" : "Attach the Deel invoice PDF"}
              />
              <ChecklistItem
                done={!firaFile || Boolean(firaFile)}
                subtle={!firaFile}
                label={
                  firaFile
                    ? "FIRA attached for INR realization"
                    : hasManualFira
                      ? "Manual FIRA data entered for INR realization"
                      : "FIRA/Realization data optional. Add it only when you want INR-based GST values."
                }
              />
              <ChecklistItem
                done={!hasOverrides}
                subtle={!hasOverrides}
                label={
                  hasOverrides
                    ? "Overrides active. Double-check invoice number, SAC code, and note."
                    : "No overrides active. Standard defaults will be used."
                }
              />
              <ChecklistItem
                done={!invoiceNumberWarning}
                subtle={!overrideInvoiceNumber}
                label={
                  invoiceNumberWarning || "Invoice number pattern looks consistent."
                }
              />
            </CardContent>
          </Card>

          {lastRun && (
            <Card className="overflow-hidden rounded-[28px] border-2 border-black bg-white shadow-[8px_8px_0_0_black]">
              <CardHeader className="border-b-2 border-black bg-[#E8FFE7]">
                <CardTitle className="text-xl font-black uppercase tracking-[0.04em]">
                  Latest Output
                </CardTitle>
                <CardDescription className="text-sm leading-6 text-black/70">
                  Your last run completed. Use this as the confirmation block before you move to the GST portal.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 p-6">
                <SummaryRow label="Invoice file" value={lastRun.fileName} />
                <SummaryRow label="Invoice number" value={lastRun.invoiceNumber} />
                <SummaryRow label="Generated at" value={lastRun.generatedAt} />
                <SummaryRow
                  label="Airtable status"
                  value={
                    lastRun.syncStatus === "success"
                      ? "Synced"
                      : lastRun.syncStatus === "warning"
                        ? "Warning"
                        : "Skipped"
                  }
                />
                <div className="rounded-2xl border border-black/20 bg-[#F8F7F3] p-4 text-sm leading-6 text-black/70">
                  {lastRun.syncMessage}
                </div>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </main>
  );
}

function ChecklistItem({
  done,
  label,
  subtle = false,
}: {
  done: boolean;
  label: string;
  subtle?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border-2 border-black px-3 py-3 shadow-[3px_3px_0_0_black]">
      <div
        className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border-2 border-black ${
          done ? "bg-[#FFE36F]" : "bg-white"
        }`}
      >
        {done ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
      </div>
      <p className={`text-sm leading-6 ${subtle ? "text-black/60" : "text-black/85"}`}>{label}</p>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-2xl border border-black/15 bg-[#F8F7F3] px-4 py-3">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-black/55">{label}</p>
      <p className="text-right text-sm font-semibold text-black">{value}</p>
    </div>
  );
}

function buildProgressSteps(hasFira: boolean, hasOverrides: boolean) {
  const steps = ["Preparing files", "Parsing Deel invoice"];

  if (hasFira) {
    steps.push("Validating matching FIRA");
  }

  if (hasOverrides) {
    steps.push("Applying overrides");
  }

  steps.push("Generating GST PDF", "Syncing Airtable");

  return steps;
}

/** X-Invoice-Warnings: URI-encoded JSON array of strings, set by /api/generate. */
function parseWarnings(header: string | null): string[] {
  if (!header) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(header));
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === "string") : [];
  } catch {
    return [];
  }
}

function validatePdf(file: File | null, label: string) {
  if (!file) {
    return label === "Deel invoice" ? "Attach the Deel invoice PDF before generating the GST invoice." : "";
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
