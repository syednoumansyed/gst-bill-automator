"use client";

import { forwardRef } from "react";
import { XCircle } from "lucide-react";

import { CodeBadge } from "@/components/review/code-badge";
import type { ApiError } from "@/components/review/model";

type ErrorNoticeProps = { error: ApiError; title?: string };

/** A failed request: what to do (action) is the main line, what went wrong (error) and the code support it. */
export const ErrorNotice = forwardRef<HTMLDivElement, ErrorNoticeProps>(function ErrorNotice({ error, title = "Action needed" }, ref) {
  const others = error.issues.slice(1);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="rounded-2xl border-2 border-red-950 bg-red-100 p-4 text-red-950 shadow-[4px_4px_0_0_black] outline-none focus-visible:ring-4 focus-visible:ring-[#FFE36F]"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border-2 border-current bg-white/60">
          <XCircle className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-black uppercase tracking-[0.16em]">{title}</p>
            <CodeBadge code={error.code} />
          </div>
          {error.action && <p className="text-base font-semibold leading-6">{error.action}</p>}
          <p className="text-sm leading-6 text-red-950/80">{error.error}</p>
          {others.length > 0 && (
            <ul className="space-y-1.5 border-t border-red-950/20 pt-2">
              {others.map((issue, i) => (
                <li key={`${issue.code}-${i}`} className="text-sm leading-5">
                  <CodeBadge code={issue.code} className="mr-2" />
                  {issue.action || issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
});
