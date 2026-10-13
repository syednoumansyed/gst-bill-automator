"use client";

import { useRef } from "react";
import { FileCheck2, FileText, RefreshCw, Trash2, UploadCloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type UploadFieldProps = {
  id: string;
  label: string;
  description: string;
  hint: string;
  required?: boolean;
  file: File | null;
  disabled?: boolean;
  onSelect: (file: File | null) => void;
};

export function UploadField({
  id,
  label,
  description,
  hint,
  required = false,
  file,
  disabled = false,
  onSelect,
}: UploadFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleOpenPicker = () => {
    if (disabled) {
      return;
    }

    inputRef.current?.click();
  };

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        disabled={disabled}
        onChange={(event) => onSelect(event.target.files?.[0] || null)}
      />

      <div
        className={cn(
          "rounded-2xl border-2 border-black bg-white p-4 shadow-[4px_4px_0_0_black] transition-all",
          file ? "bg-[#FFF8D6]" : "bg-white",
          disabled && "opacity-70",
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="rounded-full border-2 border-black bg-black px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em] text-white">
                {required ? "Required" : "Optional"}
              </span>
              <p className="text-sm font-black uppercase tracking-[0.18em] text-black">
                {label}
              </p>
            </div>
            <p className="text-sm text-black/75">{description}</p>
          </div>

          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border-2 border-black bg-[#FFE36F]">
            {file ? <FileCheck2 className="h-5 w-5" /> : <UploadCloud className="h-5 w-5" />}
          </div>
        </div>

        <div className="mt-4 rounded-2xl border-2 border-dashed border-black/30 bg-black/[0.03] p-4">
          {file ? (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl border-2 border-black bg-white">
                    <FileText className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <p className="break-all text-sm font-semibold text-black">{file.name}</p>
                    <p className="text-xs text-black/60">{formatFileSize(file.size)} PDF ready</p>
                  </div>
                </div>

                <span className="rounded-full border border-black/20 bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-900">
                  Attached
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="rounded-full border-2 border-black bg-white text-xs font-semibold"
                  disabled={disabled}
                  onClick={handleOpenPicker}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Replace
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="rounded-full border-2 border-black bg-white text-xs font-semibold"
                  disabled={disabled}
                  onClick={() => {
                    if (inputRef.current) {
                      inputRef.current.value = "";
                    }
                    onSelect(null);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-black">Choose a PDF from your machine</p>
                <p className="text-xs text-black/60">{hint}</p>
              </div>
              <Button
                type="button"
                className="rounded-full border-2 border-black bg-[#FFE36F] px-5 text-black hover:bg-[#FFD84A]"
                onClick={handleOpenPicker}
                disabled={disabled}
              >
                Select PDF
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
