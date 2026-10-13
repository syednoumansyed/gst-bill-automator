"use client";

import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";

type StatusBannerProps = {
  title: string;
  description: string;
  variant?: "success" | "warning" | "error" | "info";
};

const VARIANT_STYLES = {
  success: {
    wrapper: "border-emerald-950 bg-emerald-100 text-emerald-950",
    icon: CheckCircle2,
  },
  warning: {
    wrapper: "border-amber-950 bg-amber-100 text-amber-950",
    icon: AlertTriangle,
  },
  error: {
    wrapper: "border-red-950 bg-red-100 text-red-950",
    icon: XCircle,
  },
  info: {
    wrapper: "border-sky-950 bg-sky-100 text-sky-950",
    icon: Info,
  },
} as const;

export function StatusBanner({
  title,
  description,
  variant = "info",
}: StatusBannerProps) {
  const styles = VARIANT_STYLES[variant];
  const Icon = styles.icon;

  return (
    <div className={cn("rounded-2xl border-2 p-4 shadow-[4px_4px_0_0_black]", styles.wrapper)}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl border-2 border-current bg-white/60">
          <Icon className="h-4 w-4" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-black uppercase tracking-[0.16em]">{title}</p>
          <p className="text-sm leading-6">{description}</p>
        </div>
      </div>
    </div>
  );
}
