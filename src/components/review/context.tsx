"use client";

import { createContext, useContext } from "react";

import type { InvoiceDraft } from "@/lib/draft";
import type { Issue } from "@/lib/errors";
import type { FieldMeta } from "./model";

export type ReviewContextValue = {
  draft: InvoiceDraft;
  meta: Record<string, FieldMeta>;
  edited: ReadonlySet<string>;
  /** Unresolved error issues by the draft path they point at */
  openIssues: ReadonlyMap<string, Issue[]>;
  /** Path currently highlighted by "Go to field" */
  highlight: string | null;
  disabled: boolean;
  setPath: (path: string, value: unknown) => void;
  setDraft: (update: (draft: InvoiceDraft) => InvoiceDraft) => void;
};

export const ReviewContext = createContext<ReviewContextValue | null>(null);

export function useReview() {
  const ctx = useContext(ReviewContext);
  if (!ctx) throw new Error("useReview must be used inside ReviewContext");
  return ctx;
}
