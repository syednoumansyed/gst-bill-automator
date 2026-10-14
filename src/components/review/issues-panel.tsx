"use client";

import { forwardRef } from "react";
import { AlertTriangle, CheckCircle2, Crosshair, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Issue } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { CodeBadge } from "./code-badge";
import { issueTarget } from "./model";

type IssuesPanelProps = {
  /** Errors first */
  issues: Issue[];
  isOpen: (issue: Issue) => boolean;
  onGoToField: (path: string) => void;
};

/** Every issue stays in the list after it is fixed (marked resolved) so the panel never changes height. */
export const IssuesPanel = forwardRef<HTMLElement, IssuesPanelProps>(function IssuesPanel({ issues, isOpen, onGoToField }, ref) {
  const open = issues.filter(isOpen).length;
  const warnings = issues.filter((i) => i.severity === "warning").length;

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby="issues-heading"
      className={cn(
        "rounded-[24px] border-2 border-black p-4 shadow-[6px_6px_0_0_black] outline-none focus-visible:ring-4 focus-visible:ring-[#FFE36F] sm:p-5",
        open > 0 ? "bg-red-50" : issues.length ? "bg-amber-50" : "bg-emerald-50",
      )}
    >
      <h2 id="issues-heading" className="text-sm font-black uppercase tracking-[0.16em]">
        {issues.length === 0
          ? "No issues found"
          : open > 0
            ? `${open} ${open === 1 ? "issue needs" : "issues need"} your action`
            : "All blocking issues resolved"}
      </h2>
      <p className="mt-1 text-sm leading-6 text-black/70" role="status">
        {issues.length === 0
          ? "Everything was read with no problems. Still compare the values with the PDFs before generating."
          : open > 0
            ? `${open} to fix${warnings ? `, ${warnings} ${warnings === 1 ? "warning" : "warnings"} to read` : ""}. Fix the highlighted fields below.`
            : `${warnings} ${warnings === 1 ? "warning" : "warnings"} to read. Everything blocking was fixed; the server checks again when you generate.`}
      </p>

      {issues.length > 0 && (
        <ul className="mt-4 space-y-3">
          {issues.map((issue, i) => {
            const target = issueTarget(issue.field);
            const resolved = issue.severity === "error" && !isOpen(issue);
            const Icon = resolved ? CheckCircle2 : issue.severity === "error" ? XCircle : AlertTriangle;
            return (
              <li
                key={`${issue.code}-${issue.field ?? ""}-${i}`}
                className={cn(
                  "flex flex-col gap-3 rounded-2xl border-2 border-black bg-white p-3 sm:flex-row sm:items-start sm:justify-between",
                  resolved && "opacity-60",
                )}
              >
                <div className="flex min-w-0 gap-3">
                  <Icon
                    className={cn("mt-0.5 h-5 w-5 shrink-0", resolved ? "text-emerald-700" : issue.severity === "error" ? "text-red-700" : "text-amber-700")}
                    aria-hidden
                  />
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-semibold leading-5 text-black">
                      <span className="sr-only">{resolved ? "Resolved. " : issue.severity === "error" ? "Error. " : "Warning. "}</span>
                      {issue.message}
                    </p>
                    <p className="text-sm leading-5 text-black/75">{issue.action}</p>
                    <CodeBadge code={issue.code} />
                  </div>
                </div>
                {target && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onGoToField(target)}
                    className="h-9 shrink-0 self-start rounded-full border-2 border-black bg-[#FFE36F] text-xs font-black uppercase tracking-[0.1em] hover:bg-[#FFD84A]"
                  >
                    <Crosshair className="h-3.5 w-3.5" aria-hidden />
                    Go to field
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
});
