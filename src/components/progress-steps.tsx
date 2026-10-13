"use client";

import { CheckCircle2, Circle, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

type ProgressStepsProps = {
  steps: string[];
  currentStep: number;
  active: boolean;
};

export function ProgressSteps({ steps, currentStep, active }: ProgressStepsProps) {
  return (
    <div className="space-y-3">
      {steps.map((step, index) => {
        const complete = index < currentStep;
        const current = index === currentStep;

        return (
          <div
            key={step}
            className={cn(
              "flex items-center gap-3 rounded-2xl border-2 border-black px-3 py-3 shadow-[3px_3px_0_0_black] transition-colors",
              complete && "bg-emerald-100",
              current && active && "bg-[#FFE36F]",
              !complete && (!current || !active) && "bg-white",
            )}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-black bg-white">
              {complete ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : current && active ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Circle className="h-3 w-3 fill-transparent" />
              )}
            </div>
            <div className="space-y-0.5">
              <p className="text-sm font-semibold text-black">{step}</p>
              <p className="text-xs text-black/60">
                {complete ? "Completed" : current && active ? "In progress" : "Waiting"}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
