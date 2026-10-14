"use client";

import { useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Issue } from "@/lib/errors";
import { buildDiagnostics, type ParseResponse } from "./model";

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs https or localhost; fall back to a temporary textarea
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** Copies issue codes, layout ids and the masked layout skeleton. Field values and messages are never included. */
export function DiagnosticsButton({ parsed, issues }: { parsed: ParseResponse; issues: Issue[] }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  const handleCopy = async () => {
    const ok = await copyText(buildDiagnostics(parsed, issues));
    setStatus(ok ? "copied" : "failed");
    window.setTimeout(() => setStatus("idle"), 2500);
  };

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        onClick={handleCopy}
        className="h-11 rounded-2xl border-2 border-black bg-white px-4 text-xs font-black uppercase tracking-[0.12em]"
      >
        {status === "copied" ? <Check className="h-4 w-4" aria-hidden /> : <ClipboardCopy className="h-4 w-4" aria-hidden />}
        Copy diagnostics
      </Button>
      <p className="min-h-4 text-[11px] leading-4 text-black/55" role="status" aria-live="polite">
        {status === "copied" && "Copied. Contains codes and layout only, no invoice values."}
        {status === "failed" && "Copy failed. Select the text manually or try again."}
        {status === "idle" && "For bug reports. Never includes invoice values."}
      </p>
    </div>
  );
}
